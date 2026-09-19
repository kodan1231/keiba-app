import { requireAdmin, gradedRaceNameKey, readJsonBody, jsonError } from "../../_shared.js";

const VALID_GRADES = new Set(["G1", "G2", "G3"]);

// 管理者向け: JRA公式サイト「N年 重賞レース一覧」ページ(PDF)から解析した重賞レースを
// まとめて登録する(public/jra-graded-races-pdf.js がクライアント側でPDFを解析し、
// ここへ構造化済みJSONを送る)。name_key の一致で既存行はUPDATE、無ければINSERTする
// (グレードが年度によって変わりうる=昇格・降格があるため、再インポートで上書きする
// 方針。docs/design/graded-races.md 参照)。
//
// レース数は年間150件程度で自然にバウンドされるため、db.batch()でのUPDATE/INSERT
// 自体は1回で収まる(サブリクエスト数上限には該当しない)。ただし既存行の突き合わせ用
// SELECTのIN句は、年間の重賞レース数(140件前後)がD1の「1クエリ100バインドパラメータ」
// 上限を超えるため、90件ずつチャンク分割する(CLAUDE.md参照。2026-09-19に実際に
// この上限超過で登録に失敗する障害が発生した)。
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const races = Array.isArray(data?.races) ? data.races : [];
  if (!races.length) return jsonError("インポート対象のレースがありません", 400);

  try {
    return await importGradedRaces(env, races);
  } catch (e) {
    // 想定外のDBエラー時も、クライアント側に汎用文言だけでなく実際のエラー内容を
    // 返す(2026-09-19にIN句の100バインド上限超過で登録に失敗した際、原因がすぐに
    // 分からなかった教訓)。
    console.error("graded_races import error", e);
    return jsonError(e?.message || "登録に失敗しました", 500);
  }
}

async function importGradedRaces(env, races) {
  const results = [];
  const valid = [];
  for (const r of races) {
    const name = String(r?.name || "").trim();
    const grade = String(r?.grade || "").trim();
    if (!name || !VALID_GRADES.has(grade)) {
      results.push({ name: name || null, status: "invalid" });
      continue;
    }
    const nameKey = gradedRaceNameKey(name);
    if (!nameKey) {
      results.push({ name, status: "invalid" });
      continue;
    }
    valid.push({
      name,
      nameKey,
      grade,
      isJump: !!r.is_jump,
      track: r.track ? String(r.track).trim() : null,
      courseType: r.course_type ? String(r.course_type).trim() : null,
      distance: Number.isInteger(r.distance) ? r.distance : null,
      ageCondition: r.age_condition ? String(r.age_condition).trim() : null,
    });
  }

  if (!valid.length) return Response.json({ ok: true, results });

  // 既存行をname_keyでまとめて取得し、UPDATE/INSERTを振り分ける(90件ずつチャンク分割)。
  const nameKeys = valid.map((v) => v.nameKey);
  const existingIdByKey = new Map();
  for (const keysChunk of chunk(nameKeys, 90)) {
    if (!keysChunk.length) continue;
    const placeholders = keysChunk.map(() => "?").join(",");
    const { results: existingRows } = await env.DB
      .prepare(`SELECT id, name_key FROM graded_races WHERE name_key IN (${placeholders})`)
      .bind(...keysChunk)
      .all();
    for (const r of existingRows || []) existingIdByKey.set(r.name_key, r.id);
  }

  const now = new Date().toISOString();
  const stmts = [];
  for (const v of valid) {
    const existingId = existingIdByKey.get(v.nameKey);
    if (existingId) {
      stmts.push(
        env.DB.prepare(
          `UPDATE graded_races
           SET name = ?, grade = ?, is_jump = ?, track = ?, course_type = ?, distance = ?, age_condition = ?, source = 'jra_import', updated_at = ?
           WHERE id = ?`
        ).bind(v.name, v.grade, v.isJump ? 1 : 0, v.track, v.courseType, v.distance, v.ageCondition, now, existingId)
      );
      results.push({ name: v.name, status: "updated" });
    } else {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO graded_races (name, name_key, grade, is_jump, track, course_type, distance, age_condition, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'jra_import', ?, ?)`
        ).bind(v.name, v.nameKey, v.grade, v.isJump ? 1 : 0, v.track, v.courseType, v.distance, v.ageCondition, now, now)
      );
      results.push({ name: v.name, status: "created" });
    }
  }

  if (stmts.length) await env.DB.batch(stmts);

  return Response.json({ ok: true, results });
}
