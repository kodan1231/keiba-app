import { hashPassword, createSessionToken } from "../_shared.js";

// ログイン画面から誰でも自己登録できる新規ユーザー登録API。
// 招待コード等の制限は設けない(アプリのURLを知っている前提でオープンに登録可能)。
// 登録に成功したらそのままログイン状態にする(セッションCookieを発行する)。
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

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

  if (!USERNAME_RE.test(username)) {
    return Response.json(
      { error: "ユーザー名は半角英数字とアンダースコアのみ、3〜20文字で入力してください" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return Response.json({ error: "パスワードは8文字以上で入力してください" }, { status: 400 });
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (existing) {
    return Response.json({ error: "そのユーザー名は既に使われています" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  // 2026-08-30追加: 新規登録は成功と同時にログイン状態になる(下記createSessionToken)ため、
  // 登録時点の日時をそのまま最終ログイン日時としても記録しておく(管理画面の登録ユーザー
  // 一覧で「最終ログイン日時」欄が、初回登録直後は常に空欄になってしまうのを避けるため)。
  const result = await env.DB.prepare(
    "INSERT INTO users (username, password_hash, last_login_at) VALUES (?, ?, datetime('now'))"
  ).bind(username, passwordHash).run();

  const { token, maxAgeSeconds } = await createSessionToken(env, {
    userId: result.meta.last_row_id,
    username,
  });

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
  );

  return new Response(JSON.stringify({ ok: true, username }), { headers });
}