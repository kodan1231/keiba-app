import { requireAdmin } from "../_shared.js";

// 管理者向け: CSVインポートで参照されたが、まだ races に登録されていない
// (race_id が NULL のままの) 日付・競馬場・レース番号の一覧。
// 全ユーザーのインポートデータが対象(レース登録は全ユーザー共有のため)。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT race_date, track, race_number, race_name,
            COUNT(*) AS group_count, SUM(total_amount) AS total_amount
     FROM imported_ticket_groups
     WHERE race_id IS NULL AND race_date IS NOT NULL AND race_date <> ''
     GROUP BY race_date, track, race_number
     ORDER BY race_date DESC, track ASC, race_number ASC`
  ).all();

  return Response.json({ ok: true, items: results || [] });
}
