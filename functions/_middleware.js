// /api/* 以下すべてのリクエストで認証Cookieを検証するミドルウェア。
// /api/auth/login と /api/auth/register だけは未認証でもアクセス可能
// (ログイン・新規登録そのものなので)。
//
// 2026-08-01 複数ユーザー対応: セッションにuser_id・usernameを含めるように変更し、
// 検証後は context.data.userId / context.data.username / context.data.isAdmin として
// 後続のAPIハンドラへ引き渡す。管理者判定は環境変数ADMIN_USERNAMESで行う。
import { verifySessionToken, isAdminUsername } from "./api/_shared.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const isApi = url.pathname.startsWith("/api/");
  const isPublicAuthRoute =
    url.pathname === "/api/auth/login" || url.pathname === "/api/auth/register";

  if (isApi && !isPublicAuthRoute) {
    if (!env.APP_PASSWORD) {
      return new Response(
        JSON.stringify({ error: "サーバー側にAPP_PASSWORDが設定されていません" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    const session = await verifySessionToken(request.headers.get("Cookie"), env.APP_PASSWORD);
    if (!session) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    context.data.userId = session.userId;
    context.data.username = session.username;
    context.data.isAdmin = isAdminUsername(env, session.username);
  }

  return next();
}
