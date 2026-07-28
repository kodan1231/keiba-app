const EDITABLE_FIELDS = ["payout", "amount", "memo"];

async function getTicket(env, id) {
  return env.DB.prepare(`SELECT t.id, t.race_id, t.payout, r.finish_order, r.payouts FROM tickets t LEFT JOIN races r ON r.id=t.race_id WHERE t.id = ?`).bind(id).first();
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  let data; try { data = await request.json(); } catch { return Response.json({ error: "リクエストが不正です" }, { status: 400 }); }
  const ticket = await getTicket(env, params.id);
  if (!ticket) return Response.json({ error: "購入履歴が見つかりません" }, { status: 404 });
  // Once either result-side payout or a payout value has been recorded, the ticket is locked.
  if (ticket.payout !== null && ticket.payout !== undefined || ticket.finish_order !== null && ticket.finish_order !== undefined || ticket.payouts !== null && ticket.payouts !== undefined) {
    return Response.json({ error: "着順または払戻が確定した馬券は変更できません" }, { status: 409 });
  }
  const fields=[]; const values=[];
  for (const key of EDITABLE_FIELDS) {
    if (key in data) {
      if (key === "amount" && (!Number.isInteger(Number(data[key])) || Number(data[key]) <= 0)) return Response.json({ error: "購入金額が不正です" }, { status: 400 });
      if (key === "payout" && data[key] !== null && (!Number.isInteger(Number(data[key])) || Number(data[key]) < 0)) return Response.json({ error: "払戻金額が不正です" }, { status: 400 });
      fields.push(`${key} = ?`); values.push(data[key] === undefined ? null : data[key]);
    }
  }
  if (!fields.length) return Response.json({ error: "更新する項目がありません" }, { status: 400 });
  values.push(params.id);
  await env.DB.prepare(`UPDATE tickets SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const ticket = await getTicket(env, params.id);
  if (!ticket) return Response.json({ error: "購入履歴が見つかりません" }, { status: 404 });
  if (ticket.payout !== null && ticket.payout !== undefined || ticket.finish_order !== null && ticket.finish_order !== undefined || ticket.payouts !== null && ticket.payouts !== undefined) return Response.json({ error: "着順または払戻が確定した馬券は削除できません" }, { status: 409 });
  await env.DB.prepare(`DELETE FROM tickets WHERE id = ?`).bind(params.id).run();
  return Response.json({ ok: true });
}
