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
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "IDが不正です" }, { status: 400 });
  const race = await env.DB.prepare("SELECT id FROM races WHERE id = ?").bind(id).first();
  if (!race) return Response.json({ error: "レースが見つかりません" }, { status: 404 });
  const counts = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM tickets WHERE race_id = ?").bind(id).first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM imported_ticket_groups WHERE race_id = ?").bind(id).first().catch(()=>({c:0})),
    env.DB.prepare("SELECT COUNT(*) AS c FROM races WHERE id = ? AND (finish_order IS NOT NULL OR payouts IS NOT NULL)").bind(id).first(),
  ]);
  const hasRelated = Number(counts[0]?.c || 0) > 0 || Number(counts[1]?.c || 0) > 0;
  const hasResult = Number(counts[2]?.c || 0) > 0;
  const url = new URL(context.request.url);
  const force = url.searchParams.get("force") === "1";
  if ((hasRelated || hasResult) && !force) {
    return Response.json({ error: "購入履歴または結果が紐付いたレースです。削除する場合は明示的に確認してください。", requires_confirmation: true, has_related: hasRelated, has_result: hasResult }, { status: 409 });
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM prediction_marks WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM prediction_notes WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM imported_ticket_items WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM imported_ticket_groups WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tickets WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM races WHERE id = ?").bind(id),
  ]);
  return Response.json({ ok: true });
}
