import { readJsonBody, jsonError } from "../_shared.js";

// 1文の IN 句に入れる id 数の上限。tickets は自ユーザー分のみが対象で、
// 実際の選択数はせいぜい数百のため通常はチャンク分割されないが、想定外に
// 大量の id が送られてきた場合に備えて分割する(1チャンク = 1 サブリクエスト)。
const CHUNK_SIZE = 100;

// 購入履歴(通常購入 tickets)の一括削除。
// CSV取込分(imported_ticket_items 等)は対象外(履歴画面側でチェックボックスを出さない)。
// 着順・払戻は削除の影響を受けないため recomputeTicketPayouts* は呼ばない
// (削除したレースを購入した他ユーザーの tickets.payout に影響しない)。
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;

  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const rawIds = Array.isArray(data?.ids) ? data.ids : null;
  if (!rawIds || rawIds.length === 0) return jsonError("削除対象が指定されていません", 400);

  const ids = [...new Set(
    rawIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
  )];
  if (ids.length === 0) return jsonError("削除対象のIDが不正です", 400);

  const statements = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    // user_id 条件で自分の購入のみを削除対象にする(他ユーザーの id を混ぜても無視される)。
    statements.push(
      env.DB.prepare(`DELETE FROM tickets WHERE user_id = ? AND id IN (${placeholders})`)
        .bind(userId, ...chunk)
    );
  }

  const results = await env.DB.batch(statements);
  const deleted = results.reduce((sum, r) => sum + (r?.meta?.changes || 0), 0);

  return Response.json({ ok: true, deleted });
}
