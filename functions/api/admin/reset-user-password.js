import { requireAdmin, hashPassword, readJsonBody, jsonError, parsePositiveIntId } from "../_shared.js";

// 管理者向け: 指定ユーザーのパスワードを、管理者が入力した新しいパスワードへ強制的に置き換える。
// 本人による現在のパスワード照合は行わない(管理者権限そのものが本人確認を兼ねる)。
// パスワードを忘れたユーザーの救済用。詳細はdocs/design/auth-multiuser.md
// 「管理者によるパスワードリセット」参照。
//
// リセット後は users.password_reset_pending = 1 をセットする。これにより本人の
// 次回以降のログイン中、全画面共通のバナーで「パスワードを変更してください」と促す
// (強制はしない)。本人がfunctions/api/auth/change-password.jsで自分でパスワードを
// 変更すると0へ戻り、バナーは消える。
//
// セッションはenv.APP_PASSWORD署名のステートレストークンでDBに保存していないため、
// パスワードを変更しても対象ユーザーの既存ログインセッションは失効しない(本人の
// パスワード変更(change-password.js)と同じ挙動)。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const { data: body, error } = await readJsonBody(request);
  if (error) return error;

  const { id: userId, error: idError } = parsePositiveIntId(body?.user_id, "user_id");
  if (idError) return idError;

  const newPassword = String(body?.new_password || "");
  if (newPassword.length < 8) {
    return jsonError("新しいパスワードは8文字以上で入力してください", 400);
  }

  if (userId === context.data.userId) {
    return jsonError("自分自身のパスワードは、ヘッダーのユーザー名から変更してください", 400);
  }

  const user = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?")
    .bind(userId).first();
  if (!user) {
    return jsonError("対象のユーザーが見つかりません", 404);
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_reset_pending = 1 WHERE id = ?"
  ).bind(newHash, userId).run();

  return Response.json({ ok: true, username: user.username });
}
