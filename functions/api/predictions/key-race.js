import { readJsonBody, parsePositiveIntId, jsonError } from "../_shared.js";

// 「勝負レース」フラグの切り替え専用エンドポイント。
// 予想印・予想メモの保存(POST /api/predictions)とは独立させている。あちらは
// marks/memo を毎回まとめて上書きする設計のため、同じ経路に載せると印を1つ変えるたびに
// このフラグ用の状態も毎回渡す必要が生じ、実装・呼び出し側の双方が煩雑になる。
export async function onRequestPut(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const { id: raceId, error: raceIdError } = parsePositiveIntId(data?.race_id, "race_id");
  if (raceIdError) return raceIdError;
  if (typeof data?.is_key_race !== "boolean") {
    return jsonError("is_key_raceはboolean で指定してください", 400);
  }

  const race = await env.DB.prepare("SELECT id FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO prediction_notes (race_id, user_id, is_key_race, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(race_id, user_id) DO UPDATE SET is_key_race = excluded.is_key_race, updated_at = excluded.updated_at`
  ).bind(raceId, userId, data.is_key_race ? 1 : 0, now, now).run();

  return Response.json({ ok: true, race_id: raceId, is_key_race: data.is_key_race });
}
