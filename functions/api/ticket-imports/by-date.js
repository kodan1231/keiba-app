import { jsonError } from "../_shared.js";

// CSV取り込み分の、開催日ごとの一覧と削除(2026-11-16追加。docs/design/csv-import.md「取り込みの削除」)。
// 別の人の CSV を間違えて取り込んだときなどに、開催日ごとにまとめて消す。自分の取り込み分だけが対象。
// 削除は CSV の元の行(imported_tickets)も一緒に消す(残すと、同じ CSV の取り込み直しが「取り込み済み」で飛ばされる)。
// レースの着順・払戻(races)は取り込みで入った分もそのまま残す(全員共有の結果のため)。

// GET: 開催日ごとの件数・購入額。読み取りはそのユーザーの CSV 元の行の件数(使い込むと数千行)。一覧を開いたときだけ呼ぶ
export async function onRequestGet(context) {
  const userId = context.data.userId;
  const { results } = await context.env.DB.prepare(
    `SELECT race_date, COUNT(*) AS rows_count, SUM(purchase_amount) AS amount, MAX(imported_at) AS imported_at
       FROM imported_tickets WHERE user_id = ? AND source = 'club_jra_net'
      GROUP BY race_date ORDER BY race_date DESC`
  ).bind(userId).all();
  return Response.json({ ok: true, items: results || [] });
}

// DELETE ?race_date=YYYY-MM-DD: その開催日の取り込み分(買い目・グループ・元の行)を消す
export async function onRequestDelete(context) {
  const userId = context.data.userId;
  const raceDate = new URL(context.request.url).searchParams.get("race_date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) return jsonError("開催日の指定が不正です", 400);
  const db = context.env.DB;
  // 3文。IN 句は副問い合わせなのでバインドは2つずつ(件数の上限に関係しない)
  const res = await db.batch([
    db.prepare(
      `DELETE FROM imported_ticket_items
        WHERE group_id IN (SELECT id FROM imported_ticket_groups WHERE user_id = ? AND race_date = ?)`
    ).bind(userId, raceDate),
    db.prepare(`DELETE FROM imported_ticket_groups WHERE user_id = ? AND race_date = ?`).bind(userId, raceDate),
    db.prepare(`DELETE FROM imported_tickets WHERE +user_id = ? AND race_date = ? AND source = 'club_jra_net'`).bind(userId, raceDate),
  ]);
  return Response.json({
    ok: true,
    deleted: { items: res[0].meta?.changes ?? 0, groups: res[1].meta?.changes ?? 0, rows: res[2].meta?.changes ?? 0 },
  });
}
