import { requireAdmin, gradedRaceNameKey, readJsonBody, jsonError } from "../../_shared.js";

const VALID_GRADES = new Set(["G1", "G2", "G3"]);

// 管理者向け: 重賞マスタ(graded_races)の一覧取得・手入力での追加。
// 詳細な設計方針は docs/design/graded-races.md 参照。horse_aliases と同じ構図。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT id, name, name_key, grade, is_jump, track, course_type, distance, age_condition, source, created_at, updated_at
     FROM graded_races ORDER BY name ASC, id DESC`
  ).all();

  return Response.json({ ok: true, items: results || [] });
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const name = String(data?.name || "").trim();
  const grade = String(data?.grade || "").trim();
  const isJump = !!data?.is_jump;
  const track = data?.track ? String(data.track).trim() : null;
  const courseType = data?.course_type ? String(data.course_type).trim() : null;
  const distance = data?.distance != null && data.distance !== "" ? Number(data.distance) : null;
  const ageCondition = data?.age_condition ? String(data.age_condition).trim() : null;

  if (!name) return jsonError("レース名を入力してください", 400);
  if (name.length > 100) return jsonError("レース名が長すぎます", 400);
  if (!VALID_GRADES.has(grade)) return jsonError("グレードはG1/G2/G3のいずれかを指定してください", 400);
  if (distance != null && (!Number.isInteger(distance) || distance <= 0)) {
    return jsonError("距離が不正です", 400);
  }

  const nameKey = gradedRaceNameKey(name);
  if (!nameKey) return jsonError("レース名が不正です", 400);

  try {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `INSERT INTO graded_races (name, name_key, grade, is_jump, track, course_type, distance, age_condition, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
    ).bind(name, nameKey, grade, isJump ? 1 : 0, track, courseType, distance, ageCondition, now, now).run();

    return Response.json({ ok: true, id: result.meta.last_row_id });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return jsonError("この突き合わせキー(表記ゆれ違いを含む)は既に登録されています。既存の行を編集してください。", 409);
    }
    console.error("graded_races insert error", e);
    return jsonError("登録に失敗しました", 500);
  }
}
