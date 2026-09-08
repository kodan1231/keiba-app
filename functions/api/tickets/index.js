export async function onRequestGet(context) {
  const { env } = context;
  const userId = context.data.userId;
  // race_finish_order / race_payouts: 集計画面で「着順または払戻のいずれかが確定していれば
  // 判定対象に含める」ためにレース側の確定情報も一緒に返す(購入履歴自身のpayoutだけでは
  // 着順は確定しているが払戻レート未入力のレースを判定対象にできないため)。
  // race_course_type / race_distance: 集計画面の「コース別収支」でレースのコース種別
  // (芝/ダート/障害)・距離ごとに集計するために付与する(購入履歴自身は持たないため
  // レースをJOINして返す)。未入力のレースは NULL のまま返る。
  const { results } = await env.DB.prepare(
    `SELECT t.*, r.finish_order AS race_finish_order, r.payouts AS race_payouts,
            r.course_type AS race_course_type, r.distance AS race_distance
     FROM tickets t
     LEFT JOIN races r ON r.id = t.race_id
     WHERE t.user_id = ?
     ORDER BY t.race_date DESC, t.track ASC, t.race_number ASC, t.created_at ASC`
  ).bind(userId).all();

  const items = results.map((row) => ({
    ...row,
    selections: JSON.parse(row.selections),
  }));

  return Response.json(items);
}
