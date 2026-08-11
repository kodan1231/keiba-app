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

  const { token, maxAgeSeconds } = await createSessionToken(env, { userId: user.id, username: user.username });

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
  );

  return new Response(JSON.stringify({ ok: true, username: user.username }), { headers });
}
