const EDITABLE_FIELDS = ["payout", "amount", "memo"];

async function getTicket(env, id) {
  return env.DB.prepare(`SELECT id, race_id, payout FROM tickets WHERE id = ?`).bind(id).first();
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  let data; try { data = await request.json(); } catch { return Response.json({ error: "リクエストが不正です" }, { status: 400 }); }
  const ticket = await getTicket(env, params.id);
  if (!ticket) return Response.json({ error: "購入履歴が見つかりません" }, { status: 404 });
  // ロック仕様は2026-07-31に全面撤廃。着順・払戻確定後でも変更できる(docs/DESIGN.md「ロック仕様」参照)。
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
  // ロック仕様は2026-07-31に全面撤廃。着順・払戻確定後でも削除できる(docs/DESIGN.md「ロック仕様」参照)。
  await env.DB.prepare(`DELETE FROM tickets WHERE id = ?`).bind(params.id).run();
  return Response.json({ ok: true });
}
