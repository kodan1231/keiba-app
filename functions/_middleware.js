// /api/* 以下すべてのリクエストで認証Cookieを検証するミドルウェア。
// /api/auth/login と /api/auth/register だけは未認証でもアクセス可能
// (ログイン・新規登録そのものなので)。
//
// セッションにはuser_id・usernameを含め、検証後は context.data.userId /
// context.data.username / context.data.isAdmin として後続のAPIハンドラへ引き渡す。
// 管理者判定は環境変数ADMIN_USERNAMESで行う。
//
// 2026-08-16追加: このミドルウェアはサイト全体の全リクエスト(/api/*以外の静的
// ファイル配信も含む)に対して呼び出されるため、ルートURL("/")へのアクセスを
// 「馬券購入」画面(buy.html)へリダイレクトする処理もここに追加した。各画面
// (buy.html/index.html/prediction.html/stats.html/races.html/admin.html)は
// それぞれ独立してログイン画面を内包しており、ページ間の自動遷移は行わない設計の
// ため、「ログイン後の初期画面」は実質的に「ルートURLにアクセスした際にどの
// ファイルが表示されるか」で決まる。詳細はdocs/DESIGN.md「画面仕様」内
// 「ルートURLのリダイレクト」参照。
import { verifySessionToken, isAdminUsername } from "./api/_shared.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // ルートURL("/")へのアクセスは馬券購入画面へリダイレクトする。
  // ログイン前後を問わず常にリダイレクトし(buy.html自身がログイン画面の
  // 出し分けを行うため)、/以外のパス(/index.html等への直接アクセス)は
  // 対象外とする。
  if (url.pathname === "/") {
    return Response.redirect(new URL("/buy.html", url), 302);
  }

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
