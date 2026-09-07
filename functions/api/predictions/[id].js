import { parsePositiveIntId } from "../_shared.js";

export async function onRequestDelete(context) {
  const { env, params } = context;
  const userId = context.data.userId;
  const { id: raceId, error } = parsePositiveIntId(params.id);
  if (error) return error;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM prediction_marks WHERE race_id = ? AND user_id = ?").bind(raceId, userId),
    env.DB.prepare("DELETE FROM prediction_notes WHERE race_id = ? AND user_id = ?").bind(raceId, userId),
  ]);

  return Response.json({ ok: true });
}
