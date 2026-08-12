import { requireAdmin } from "../../_shared.js";

// レース結果詳細(race_results)の一覧取得。全ユーザー共有データのため、
// ログインしていれば誰でも閲覧できる(races本体と同じ扱い)。
export async function onRequestGet(context) {
  const { env, params } = context;
  const raceId = Number(params.id);
  if (!Number.isInteger(raceId) || raceId <= 0) return Response.json({ error: "IDが不正です" }, { status: 400 });

  const { results } = await env.DB.prepare(
    `SELECT * FROM race_results WHERE race_id = ? ORDER BY
       CASE WHEN finish_position IS NULL THEN 1 ELSE 0 END, finish_position, horse_number`
  ).bind(raceId).all();

  return Response.json({ ok: true, items: results || [] });
}

// incident_note(競走中の出来事メモ)の編集のみ管理者専用で受け付ける。
// 他のカラム(着順・タイム等)はPDFインポート経由でのみ更新する想定のため、
// このエンドポイントでは編集対象にしない。
export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env, params } = context;
  const raceId = Number(params.id);
  if (!Number.isInteger(raceId) || raceId <= 0) return Response.json({ error: "IDが不正です" }, { status: 400 });

  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const horseNumber = Number(data?.horse_number);
  if (!Number.isInteger(horseNumber) || horseNumber <= 0) {
    return Response.json({ error: "horse_numberが不正です" }, { status: 400 });
  }
  const incidentNote = typeof data?.incident_note === "string" ? data.incident_note.trim() : "";
  if (incidentNote.length > 2000) {
    return Response.json({ error: "メモは2000文字以内で入力してください" }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM race_results WHERE race_id = ? AND horse_number = ?"
  ).bind(raceId, horseNumber).first();
  if (!existing) {
    return Response.json({ error: "該当する結果レコードが見つかりません(先にPDFインポートで結果を登録してください)" }, { status: 404 });
  }

  await env.DB.prepare(
    "UPDATE race_results SET incident_note = ?, updated_at = ? WHERE id = ?"
  ).bind(incidentNote || null, new Date().toISOString(), existing.id).run();

  return Response.json({ ok: true });
}
