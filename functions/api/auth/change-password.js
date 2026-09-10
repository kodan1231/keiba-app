import { verifyPassword, hashPassword, readJsonBody, jsonError } from "../_shared.js";

// ログイン中のユーザー自身のパスワードを変更する。
// 必ず「現在のパスワード」の照合を行ってから更新するため、
// 他人になりすまして変更することはできない(本人確認は認証セッション自体が担う)。
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;

  const { data: body, error } = await readJsonBody(request);
  if (error) return error;

  const currentPassword = String(body?.current_password || "");
  const newPassword = String(body?.new_password || "");

  if (!currentPassword || !newPassword) {
    return jsonError("現在のパスワードと新しいパスワードを入力してください", 400);
  }
  if (newPassword.length < 8) {
    return jsonError("新しいパスワードは8文字以上で入力してください", 400);
  }

  const user = await env.DB.prepare(
    "SELECT id, password_hash FROM users WHERE id = ?"
  ).bind(userId).first();

  if (!user) {
    // 通常はミドルウェアの認証チェックを通っているため到達しないはずだが、念のため。
    return jsonError("ユーザーが見つかりません", 404);
  }

  const currentOk = await verifyPassword(currentPassword, user.password_hash);
  if (!currentOk) {
    return jsonError("現在のパスワードが正しくありません", 401);
  }

  if (newPassword === currentPassword) {
    return jsonError("新しいパスワードは現在のパスワードと異なるものを入力してください", 400);
  }

  // password_reset_pending も0へ戻す(管理者リセット後に本人が変更した場合、
  // 全画面共通の「パスワード変更を促すバナー」を消すため。通常の自主変更では
  // 元から0なので影響なし)。詳細はdocs/design/auth-multiuser.md参照。
  const newHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ?, password_reset_pending = 0 WHERE id = ?")
    .bind(newHash, userId)
    .run();

  return Response.json({ ok: true });
}