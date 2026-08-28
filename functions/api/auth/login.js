import { verifyPassword, createSessionToken } from "../_shared.js";

// usersテーブルに登録された個別のユーザー名+パスワードと照合する。
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.APP_PASSWORD) {
    return new Response(
      JSON.stringify({ error: "サーバー側にAPP_PASSWORDが設定されていません" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    return Response.json({ error: "ユーザー名とパスワードを入力してください" }, { status: 400 });
  }

  const user = await env.DB.prepare(
    "SELECT id, username, password_hash FROM users WHERE username = ?"
  ).bind(username).first();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "ユーザー名またはパスワードが違います" }, { status: 401 });
  }

  // 2026-08-30追加: 管理画面の登録ユーザー一覧で「最終ログイン日時」を表示するため、
  // ログイン成功のたびに更新する(datetime('now')はUTCで保存され、表示側で
  // Asia/Tokyoへ変換する。既存のcreated_atと同じ考え方。docs/DESIGN.md
  // 「日時表示のタイムゾーン」参照)。この更新に失敗してもログイン自体は
  // 失敗させない(致命的な処理ではないため)。
  try {
    await env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
  } catch (e) {
    console.error("last_login_at update failed", e);
  }

  const { token, maxAgeSeconds } = await createSessionToken(env, { userId: user.id, username: user.username });

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
  );

  return new Response(JSON.stringify({ ok: true, username: user.username }), { headers });
}