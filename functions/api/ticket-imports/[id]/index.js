export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = Number(String(params.id).replace(/^import-/, ""));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "IDが不正です" }, { status: 400 });
  let data; try { data = await request.json(); } catch { return Response.json({ error: "リクエストが不正です" }, { status: 400 }); }
  const fields = []; const values = [];
  if ("amount" in data) { if (!Number.isInteger(Number(data.amount)) || Number(data.amount) < 0) return Response.json({ error: "購入金額が不正です" }, { status: 400 }); fields.push("amount=?"); values.push(Number(data.amount)); }
  if ("payout" in data) { if (data.payout !== null && (!Number.isInteger(Number(data.payout)) || Number(data.payout) < 0)) return Response.json({ error: "払戻金額が不正です" }, { status: 400 }); fields.push("payout=?"); values.push(data.payout === null ? null : Number(data.payout)); }
  if (!fields.length) return Response.json({ error: "更新する項目がありません" }, { status: 400 });
  values.push(id); await env.DB.prepare(`UPDATE imported_ticket_items SET ${fields.join(",")} WHERE id=?`).bind(...values).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = Number(String(params.id).replace(/^import-/, ""));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "IDが不正です" }, { status: 400 });
  const item = await env.DB.prepare("SELECT group_id FROM imported_ticket_items WHERE id=?").bind(id).first();
  if (!item) return Response.json({ error: "購入履歴が見つかりません" }, { status: 404 });
  await env.DB.prepare("DELETE FROM imported_ticket_items WHERE id=?").bind(id).run();
  return Response.json({ ok: true });
}
