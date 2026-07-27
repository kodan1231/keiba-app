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

  for (const key of ["race_date", "track", "race_number", "race_name"]) {
    if (key in data) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if ("entries" in data) {
    if (!Array.isArray(data.entries)) {
      return new Response(JSON.stringify({ error: "entriesの形式が不正です" }), { status: 400 });
    }
    fields.push("entries = ?");
    values.push(JSON.stringify(data.entries));
  }
  if ("finish_order" in data) {
    fields.push("finish_order = ?");
    values.push(data.finish_order ? JSON.stringify(data.finish_order) : null);
  }
  if ("payouts" in data) {
    fields.push("payouts = ?");
    values.push(data.payouts ? JSON.stringify(data.payouts) : null);
  }

  if (fields.length === 0) {
    return new Response(JSON.stringify({ error: "更新する項目がありません" }), { status: 400 });
  }

  values.push(params.id);
  await env.DB.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  // このレースに紐づく購入履歴も一緒に削除する(参照整合性を保つため)
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM prediction_marks WHERE race_id = ?`).bind(params.id),
    env.DB.prepare(`DELETE FROM prediction_notes WHERE race_id = ?`).bind(params.id),
    env.DB.prepare(`DELETE FROM tickets WHERE race_id = ?`).bind(params.id),
    env.DB.prepare(`DELETE FROM races WHERE id = ?`).bind(params.id),
  ]);
  return Response.json({ ok: true });
}
