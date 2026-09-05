import { verifyPassword, hashPassword } from "../_shared.js";

// ログイン中のユーザー自身のパスワードを変更する。
// 必ず「現在のパスワード」の照合を行ってから更新するため、
// 他人になりすまして変更することはできない(本人確認は認証セッション自体が担う)。
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const currentPassword = String(body?.current_password || "");
  const newPassword = String(body?.new_password || "");

  if (!currentPassword || !newPassword) {
    return Response.json(
      { error: "現在のパスワードと新しいパスワードを入力してください" },
      { status: 400 }
    );
  }
  if (newPassword.length < 8) {
    return Response.json(
      { error: "新しいパスワードは8文字以上で入力してください" },
      { status: 400 }
    );
  }

  const user = await env.DB.prepare(
    "SELECT id, password_hash FROM users WHERE id = ?"
  ).bind(userId).first();

  if (!user) {
    // 通常はミドルウェアの認証チェックを通っているため到達しないはずだが、念のため。
    return Response.json({ error: "ユーザーが見つかりません" }, { status: 404 });
  }

  const currentOk = await verifyPassword(currentPassword, user.password_hash);
  if (!currentOk) {
    return Response.json({ error: "現在のパスワードが正しくありません" }, { status: 401 });
  }

  if (newPassword === currentPassword) {
    return Response.json(
      { error: "新しいパスワードは現在のパスワードと異なるものを入力してください" },
      { status: 400 }
    );
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(newHash, userId)
    .run();

  return Response.json({ ok: true });
}