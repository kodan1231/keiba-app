import { requireAdmin, getD1Usage } from "../_shared.js";

// 管理者向け: 今日の D1 の使用量(合計・データベースごと・このアプリの重い問い合わせ)。2026-10-08追加。
// 管理画面の「D1の使用量(今日)」と、一括補正などの重い操作の前の確認に使う(docs/design/ops.md「D1の使用量の確認」)。
// 取得の中身は _lib/d1-usage.js。CF_ANALYTICS_TOKEN が未設定なら { configured: false }。?fresh=1 で取り直す。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const token = context.env.CF_ANALYTICS_TOKEN;
  if (!token) return Response.json({ configured: false });
  const fresh = new URL(context.request.url).searchParams.get("fresh") === "1";
  return Response.json(await getD1Usage(token, { fresh }));
}
