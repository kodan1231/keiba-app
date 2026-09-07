import { readJsonBody, parsePositiveIntId, jsonError } from "../../_shared.js";

// imported_ticket_items 自体は user_id を持たないため、常に imported_ticket_groups と
// JOIN して所有者(=取り込んだユーザー)を確認する。他ユーザーの取込データは
// 「存在しない(404)」として扱う。
async function getOwnedItem(env, id, userId) {
  return env.DB.prepare(
    `SELECT i.id, i.group_id FROM imported_ticket_items i
     JOIN imported_ticket_groups g ON g.id = i.group_id
     WHERE i.id = ? AND g.user_id = ?`
  ).bind(id, userId).first();
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const userId = context.data.userId;
  const { id, error: idError } = parsePositiveIntId(String(params.id).replace(/^import-/, ""));
  if (idError) return idError;
  const { data, error } = await readJsonBody(request);
  if (error) return error;
  const item = await getOwnedItem(env, id, userId);
  if (!item) return jsonError("購入履歴が見つかりません", 404);
  const fields = []; const values = [];
  if ("amount" in data) { if (!Number.isInteger(Number(data.amount)) || Number(data.amount) < 0) return jsonError("購入金額が不正です", 400); fields.push("amount=?"); values.push(Number(data.amount)); }
  if ("payout" in data) { if (data.payout !== null && (!Number.isInteger(Number(data.payout)) || Number(data.payout) < 0)) return jsonError("払戻金額が不正です", 400); fields.push("payout=?"); values.push(data.payout === null ? null : Number(data.payout)); }
  if (!fields.length) return jsonError("更新する項目がありません", 400);
  values.push(id); await env.DB.prepare(`UPDATE imported_ticket_items SET ${fields.join(",")} WHERE id=?`).bind(...values).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const userId = context.data.userId;
  const { id, error } = parsePositiveIntId(String(params.id).replace(/^import-/, ""));
  if (error) return error;
  const item = await getOwnedItem(env, id, userId);
  if (!item) return jsonError("購入履歴が見つかりません", 404);
  await env.DB.prepare("DELETE FROM imported_ticket_items WHERE id=?").bind(id).run();
  return Response.json({ ok: true });
}
