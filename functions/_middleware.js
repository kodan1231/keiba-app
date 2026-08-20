// /api/* 以下すべてのリクエストで認証Cookieを検証するミドルウェア。
// /api/auth/login と /api/auth/register だけは未認証でもアクセス可能
// (ログイン・新規登録そのものなので)。
//
// セッションにはuser_id・usernameを含め、検証後は context.data.userId /
// context.data.username / context.data.isAdmin として後続のAPIハンドラへ引き渡す。
// 管理者判定は環境変数ADMIN_USERNAMESで行う。
//
// 2026-08-16追加→同日中に撤回: 以前このミドルウェアには、ルートURL("/")への
// アクセスを"/buy.html"へ302リダイレクトする処理があった(「ログイン後の初期画面を
// 馬券購入にしたい」という要望への対応)。しかしCloudflare Pagesには
// 「*.html付きURLへのアクセスを拡張子なしURLへ自動的に308リダイレクトする」という
// 別の標準挙動があり、この2つが衝突して意図しないリダイレクトの連鎖
// (/index.html → / → /buy.html → /buy)が発生し、「馬券履歴」ナビリンクを
// クリックしても馬券購入画面に遷移してしまう不具合が生じていた。
//
// この問題を回避するため、ミドルウェアによるHTTPリダイレクトは廃止し、代わりに
// ファイル名を実際の画面の役割に合わせてリネームする方式に変更した
// (public/buy.html → public/index.html、旧public/index.html(購入履歴) →
// public/history.html)。これにより、サイトのルートURL("/")へのアクセスには
// Cloudflare Pagesの標準挙動(「/」には index.html を返す)がそのまま働き、
// 追加のリダイレクト処理は一切不要になった。詳細はdocs/DESIGN.md
// 「トップページ(/)の表示について」参照。
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
