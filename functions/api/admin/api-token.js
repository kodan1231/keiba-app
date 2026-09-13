import { requireAdmin, generateApiToken, hashApiToken } from "../_shared.js";

// 管理者向け: JRAレース結果ページ上で動くユーザースクリプト(docs/design/results-import.md
// 「ユーザースクリプトによるHTML取込み」参照)が使う個人用アクセストークンの発行・状態確認・無効化。
// トークンは発行者(管理者本人)のusersレコードに紐付ける。平文は発行直後のレスポンスにしか
// 含まれず、DBにはSHA-256ハッシュのみ保存する(パスワードと同じ考え方。ただしトークン自体が
// 高エントロピーな乱数のため低速ハッシュ化は不要)。

// GET: 発行状況(発行済みかどうか・発行日時)だけを返す。平文トークンはここでは返せない。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, data } = context;
  const row = await env.DB
    .prepare("SELECT api_token_created_at FROM users WHERE id = ?")
    .bind(data.userId)
    .first();

  return Response.json({
    ok: true,
    hasToken: !!row?.api_token_created_at,
    createdAt: row?.api_token_created_at || null,
  });
}

// POST: 新しいトークンを発行する(既存があれば無効化して置き換える)。
// 平文トークンはこのレスポンスでしか返さない。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, data } = context;
  const token = generateApiToken();
  const hash = await hashApiToken(token);
  const now = new Date().toISOString();

  await env.DB
    .prepare("UPDATE users SET api_token_hash = ?, api_token_created_at = ? WHERE id = ?")
    .bind(hash, now, data.userId)
    .run();

  return Response.json({ ok: true, token, createdAt: now });
}

// DELETE: トークンを無効化する。
export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, data } = context;
  await env.DB
    .prepare("UPDATE users SET api_token_hash = NULL, api_token_created_at = NULL WHERE id = ?")
    .bind(data.userId)
    .run();

  return Response.json({ ok: true });
}
