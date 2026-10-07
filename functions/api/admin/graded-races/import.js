import { requireAdmin, gradedRaceNameKey, normalizeScheduleMd, readJsonBody, jsonError, runBatchInChunks, invalidateMemo, MEMO_GRADED_RACES } from "../../_shared.js";

const VALID_GRADES = new Set(["G1", "G2", "G3"]);

// 管理者向け: JRA公式サイト「N年 重賞レース一覧」ページ(PDF)から解析した重賞レースを
// まとめて登録する(public/jra-graded-races-pdf.js がクライアント側でPDFを解析し、
// ここへ構造化済みJSONを送る)。name_key の一致で既存行はUPDATE、無ければINSERTする
// (グレードが年度によって変わりうる=昇格・降格があるため、再インポートで上書きする
// 方針。docs/design/graded-races.md 参照)。
//
// レース数は年間150件程度で自然にバウンドされるため、db.batch()でのUPDATE/INSERT
// 自体は1回で収まる(サブリクエスト数上限には該当しない)。既存行の突き合わせ用SELECTは、
// 以前はIN句(年間140件前後のため90件ずつチャンク分割。2026-09-19にバインド数上限超過で
// 登録に失敗する障害があった)だったが、2026-10-06からIN句を使わず全件(140件前後)を読む形にした
// (下記「既存行を取得し」参照)。

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  invalidateMemo(MEMO_GRADED_RACES); // この実行環境で使い回している分を捨てる(2026-10-07。_lib/memo-cache.js)

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
      // 解釈できない月日は捨てる(null。登録自体は止めない)
      scheduleMd: normalizeScheduleMd(r.schedule_md) ?? null,
    });
  }

  if (!valid.length) return Response.json({ ok: true, results });

  // 既存行を取得し、UPDATE/INSERTを振り分ける。
  // 2026-10-06: 以前は name_key IN (...) で引いていたが、正規化ルール(gradedRaceNameKey)を変えると
  // 保存済みの name_key と今のキーがずれ(例: 「⻘葉賞」〈部首補助の字形〉の保存済みキー ⻘葉賞 と
  // 今のキー 青葉賞)、同じ重賞を別物として重複登録してしまう。重賞一覧は年間140件前後の小さい表のため
  // 全件を読み、保存済みの name_key と、名前から今のルールで計算し直したキーの両方で照合する。
  // UPDATE 時は name_key も今のキーに揃える。
  const existingIdByKey = new Map();
  const { results: existingRows } = await env.DB.prepare("SELECT id, name, name_key FROM graded_races").all();
  for (const r of existingRows || []) {
    existingIdByKey.set(r.name_key, r.id);
    const fresh = gradedRaceNameKey(r.name);
    if (fresh && !existingIdByKey.has(fresh)) existingIdByKey.set(fresh, r.id);
  }

  const now = new Date().toISOString();
  const stmts = [];
  for (const v of valid) {
    const existingId = existingIdByKey.get(v.nameKey);
    if (existingId) {
      stmts.push(
        env.DB.prepare(
          `UPDATE graded_races
           SET name = ?, name_key = ?, grade = ?, is_jump = ?, track = ?, course_type = ?, distance = ?, age_condition = ?, schedule_md = ?, source = 'jra_import', updated_at = ?
           WHERE id = ?`
        ).bind(v.name, v.nameKey, v.grade, v.isJump ? 1 : 0, v.track, v.courseType, v.distance, v.ageCondition, v.scheduleMd, now, existingId)
      );
      results.push({ name: v.name, status: "updated" });
    } else {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO graded_races (name, name_key, grade, is_jump, track, course_type, distance, age_condition, schedule_md, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'jra_import', ?, ?)`
        ).bind(v.name, v.nameKey, v.grade, v.isJump ? 1 : 0, v.track, v.courseType, v.distance, v.ageCondition, v.scheduleMd, now, now)
      );
      results.push({ name: v.name, status: "created" });
    }
  }

  // 年間140件前後のため runBatchInChunks で分割して流す(CLAUDE.md「db.batch に積む
  // 文の数」の不変条件。2026-10-02の schedule_md 追加時にあわせて切り替えた)。
  if (stmts.length) await runBatchInChunks(env.DB, stmts);

  return Response.json({ ok: true, results });
}
