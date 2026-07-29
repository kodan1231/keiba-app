export async function onRequestGet(context) {
  const { env } = context;
  // race_finish_order / race_payouts: 集計画面で「着順または払戻のいずれかが確定していれば
  // 判定対象に含める」ためにレース側の確定情報も一緒に返す(購入履歴自身のpayoutだけでは
  // 着順は確定しているが払戻レート未入力のレースを判定対象にできないため)。
  const { results } = await env.DB.prepare(
    `SELECT t.*, r.finish_order AS race_finish_order, r.payouts AS race_payouts
     FROM tickets t
     LEFT JOIN races r ON r.id = t.race_id
     ORDER BY t.race_date DESC, t.track ASC, t.race_number ASC, t.created_at ASC`
  ).all();

  const items = results.map((row) => ({
    ...row,
    selections: JSON.parse(row.selections),
  }));

  return Response.json(items);
}
