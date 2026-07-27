const EDITABLE_FIELDS = ["payout", "amount", "memo"];

export async function onRequestPut(context) {
  const { request, env, params } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  const fields = [];
  const values = [];
  for (const key of EDITABLE_FIELDS) {
    if (key in data) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }

  if (fields.length === 0) {
    return new Response(JSON.stringify({ error: "更新する項目がありません" }), { status: 400 });
  }

  values.push(params.id);
  await env.DB.prepare(`UPDATE tickets SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.DB.prepare(`DELETE FROM tickets WHERE id = ?`).bind(params.id).run();
  return Response.json({ ok: true });
}
