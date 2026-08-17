import { requireAdmin, normalizeExistingJockeyNames } from "../../_shared.js";

// 管理者向け: jockey_aliasesに登録済みのエイリアスと一致する騎手名を、
// races.entries / race_results.jockey / tickets.selections /
// imported_ticket_items.selections から検索し、一致するものだけをまとめて
// 正しい表記へ書き換える(未登録の表記ゆれは変更しない=誤爆防止)。
// 詳細はdocs/DESIGN.md「騎手名エイリアス管理(jockey_aliases)」参照。
//
// 明示的にこのエンドポイントを呼んだ時だけ実行される(自動実行はしない)。
// 何度実行しても安全(冪等)。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  try {
    const result = await normalizeExistingJockeyNames(env.DB);
    return Response.json({ ok: true, updated: result });
  } catch (e) {
    console.error("jockey alias bulk normalize error", e);
    return Response.json({ error: "一括補正に失敗しました" }, { status: 500 });
  }
}
