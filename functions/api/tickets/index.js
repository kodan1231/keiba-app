export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT * FROM tickets ORDER BY race_date DESC, track ASC, race_number ASC, created_at ASC`
  ).all();

  const items = results.map((row) => ({
    ...row,
    selections: JSON.parse(row.selections),
  }));

  return Response.json(items);
}
