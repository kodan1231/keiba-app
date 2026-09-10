import { requireAdmin, normalizeExistingHorseNames, jsonError } from "../../_shared.js";

// 管理者向け: horse_aliases に登録済みのエイリアスと一致する馬名を、
// races.entries / race_results.horse_name / horse_notes.horse_name /
// tickets.selections / imported_ticket_items.selections からまとめて正しい馬名へ
// 書き換える(未登録の表記ゆれは変更しない=誤爆防止)。
// horse_notes は UNIQUE(horse_name, user_id) 衝突時、集約先へメモを改行連結して寄せる。
// 明示的にこのエンドポイントを呼んだ時だけ実行される。何度実行しても安全(冪等)。
// 詳細は docs/design/horse-aliases.md 参照。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  try {
    const result = await normalizeExistingHorseNames(env.DB);
    return Response.json({ ok: true, updated: result });
  } catch (e) {
    console.error("horse alias bulk normalize error", e);
    return jsonError("一括補正に失敗しました", 500);
  }
}
