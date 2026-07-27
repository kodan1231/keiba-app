export async function onRequestDelete(context) {
  const { env, params } = context;
  const raceId = Number(params.id);

  if (!Number.isInteger(raceId) || raceId <= 0) {
    return new Response(JSON.stringify({ error: "IDが不正です" }), { status: 400 });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM prediction_marks WHERE race_id = ?").bind(raceId),
    env.DB.prepare("DELETE FROM prediction_notes WHERE race_id = ?").bind(raceId),
  ]);

  return Response.json({ ok: true });
}
