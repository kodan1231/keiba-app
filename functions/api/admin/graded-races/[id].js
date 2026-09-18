import { requireAdmin, gradedRaceNameKey, parsePositiveIntId, readJsonBody, jsonError } from "../../_shared.js";

const VALID_GRADES = new Set(["G1", "G2", "G3"]);

// 管理者向け: 重賞マスタ(graded_races)の編集・削除。
export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env, params } = context;
  const { id, error: idError } = parsePositiveIntId(params.id);
  if (idError) return idError;

  const existing = await env.DB.prepare("SELECT id FROM graded_races WHERE id = ?").bind(id).first();
  if (!existing) return jsonError("重賞マスタが見つかりません", 404);

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
    await env.DB.prepare(
      `UPDATE graded_races
       SET name = ?, name_key = ?, grade = ?, is_jump = ?, track = ?, course_type = ?, distance = ?, age_condition = ?, updated_at = ?
       WHERE id = ?`
    ).bind(name, nameKey, grade, isJump ? 1 : 0, track, courseType, distance, ageCondition, now, id).run();

    return Response.json({ ok: true });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return jsonError("この突き合わせキー(表記ゆれ違いを含む)は既に他の行で登録されています。", 409);
    }
    console.error("graded_races update error", e);
    return jsonError("更新に失敗しました", 500);
  }
}

export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, params } = context;
  const { id, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const existing = await env.DB.prepare("SELECT id FROM graded_races WHERE id = ?").bind(id).first();
  if (!existing) return jsonError("重賞マスタが見つかりません", 404);

  await env.DB.prepare("DELETE FROM graded_races WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
