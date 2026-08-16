import { recomputeTicketPayoutsForRace } from "../_shared.js";

const VALID_BET_TYPES = [
  "tan", "fuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan",
];
const VALID_METHODS = ["normal", "box", "nagashi", "axis1", "axis2", "multi", "axis2_multi", "formation"];

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  const { race_id, race_date, track, race_number, race_name, bet_type, method, memo, combos } = data;

  if (!race_id || !race_date || !track || !race_number || !bet_type || !Array.isArray(combos) || combos.length === 0) {
    return new Response(
      JSON.stringify({ error: "必須項目が不足しているか、組み合わせが生成されていません" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!VALID_BET_TYPES.includes(bet_type)) {
    return new Response(JSON.stringify({ error: "馬券種類が不正です" }), { status: 400 });
  }
  if (method && !VALID_METHODS.includes(method)) {
    return new Response(JSON.stringify({ error: "購入方式が不正です" }), { status: 400 });
  }
  if (combos.some((c) => !c.amount || !Array.isArray(c.selections))) {
    return new Response(JSON.stringify({ error: "組み合わせごとの金額が不正です" }), { status: 400 });
  }

  const groupId = crypto.randomUUID();

  const stmts = combos.map((c) =>
    env.DB.prepare(
      `INSERT INTO tickets
        (user_id, group_id, race_id, race_date, track, race_number, race_name, bet_type, method, selections, amount, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      userId,
      groupId,
      race_id,
      race_date,
      track,
      race_number,
      race_name || null,
      bet_type,
      method || "normal",
      JSON.stringify(c.selections),
      c.amount,
      memo || null
    )
  );

  await env.DB.batch(stmts);

  // 2026-08-16追加: 過去に購入した馬券の履歴を残す目的で、既に着順・払戻が
  // 確定済みのレースへ後から購入した場合でも、購入直後に払戻を即時計算・反映する。
  // 以前は保存時点ではpayoutがnull(未確定)のままとなり、レース管理画面で払戻を
  // 再保存するまで購入履歴・集計画面に「未確定」表示が残り続ける不具合があった。
  // 既存の recomputeTicketPayoutsForRace() (races.finish_order/payouts確定時に
  // 全ユーザーのtickets.payoutを再計算するサーバー側ロジック。詳細はdocs/DESIGN.md
  // 「払戻確定時のticket反映」参照)をそのまま再利用し、このレースが既に確定済みの
  // 場合のみ呼び出す。未確定レースの場合は何もしない(従来通りpayout: nullのまま)。
  try {
    const race = await env.DB.prepare(
      "SELECT entries, finish_order, payouts FROM races WHERE id = ?"
    ).bind(race_id).first();
    if (race && (race.finish_order || race.payouts)) {
      const entries = race.entries ? JSON.parse(race.entries) : [];
      const finishOrder = race.finish_order ? JSON.parse(race.finish_order) : null;
      const payoutsObj = race.payouts ? JSON.parse(race.payouts) : null;
      await recomputeTicketPayoutsForRace(env.DB, race_id, finishOrder, payoutsObj, entries);
    }
  } catch (e) {
    // 払戻の即時反映に失敗しても、購入自体(履歴の記録)は既に成功しているため、
    // ここでのエラーは購入処理全体を失敗させない。ログのみ残す。
    console.error("recomputeTicketPayoutsForRace after bulk purchase failed", e);
  }

  return Response.json({ ok: true, group_id: groupId, count: combos.length });
}
