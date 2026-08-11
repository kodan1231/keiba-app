const EDITABLE_FIELDS = ["payout", "amount", "memo"];

async function getTicket(env, id, userId) {
  // user_id も条件に含めることで、自分以外のユーザーの購入履歴は
  // 「存在しない(404)」として扱う(他人のデータへのアクセス・改変を防ぐ)。
  return env.DB.prepare(`SELECT id, race_id, payout FROM tickets WHERE id = ? AND user_id = ?`).bind(id, userId).first();
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const userId = context.data.userId;
  let data; try { data = await request.json(); } catch { return Response.json({ error: "リクエストが不正です" }, { status: 400 }); }
  const ticket = await getTicket(env, params.id, userId);
  if (!ticket) return Response.json({ error: "購入履歴が見つかりません" }, { status: 404 });
  // 通常購入は着順・払戻の確定有無にかかわらず常に編集できる(ロック無し。docs/DESIGN.md「ロック仕様」参照)。
  const fields=[]; const values=[];
  for (const key of EDITABLE_FIELDS) {
    if (key in data) {
      if (key === "amount" && (!Number.isInteger(Number(data[key])) || Number(data[key]) <= 0)) return Response.json({ error: "購入金額が不正です" }, { status: 400 });
      if (key === "payout" && data[key] !== null && (!Number.isInteger(Number(data[key])) || Number(data[key]) < 0)) return Response.json({ error: "払戻金額が不正です" }, { status: 400 });
      fields.push(`${key} = ?`); values.push(data[key] === undefined ? null : data[key]);
    }
  }
  if (!fields.length) return Response.json({ error: "更新する項目がありません" }, { status: 400 });
  values.push(params.id, userId);
  await env.DB.prepare(`UPDATE tickets SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const userId = context.data.userId;
  const ticket = await getTicket(env, params.id, userId);
  if (!ticket) return Response.json({ error: "購入履歴が見つかりません" }, { status: 404 });
  await env.DB.prepare(`DELETE FROM tickets WHERE id = ? AND user_id = ?`).bind(params.id, userId).run();
  return Response.json({ ok: true });
}
