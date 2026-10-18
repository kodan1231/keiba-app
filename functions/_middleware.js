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
import {
  verifySessionToken, isAdminUsername, verifyApiToken, serviceGuardResponse, resolveGuest,
  appRoleOf, pageRedirect, blockedOnMain, adminPublicApi, notFoundJson, readGuestCookie, createGuestCookie, getGuestSettings, randomToken,
  isD1LimitError, isD1LimitReached, d1LimitResponse,
} from "./api/_shared.js";

// アプリの入口の分離(2026-10-14。_lib/app-role.js・docs/design/app-split.md)。
// どのURLで来たか(role)で、画面の振り分け・使えるAPI・ログインの扱いを変える。
//   main: ログイン要。管理・取り込み・データ検索(予想登録画面の2つを除く)の API は 404。ゲストの Cookie は見ない
//   search: ログイン不要。ログインの Cookie・トークンは見ず、全員ゲスト(使える API は _lib/guest.js の GUEST_API_RULES)。
//           画面を開いたときにゲストの Cookie(kbg)が無ければ渡す(合言葉は廃止)。検索エンジンには載せない
//   admin: 管理者だけ。ログイン・ログアウト以外の API は管理者でなければ 403(admin_only)。新規登録は不可
//   all: 手元の開発用(以前と同じ)

// D1 の1日の上限を超えたときの案内(2026-10-16。_lib/d1-limit.js)。API が失敗したとき(500番台・例外。データ検索用アプリの
// ゲストの 401 は、設定が読めずに「無効」と判定されることがあるため含める)だけ、D1 が上限で断っているかを確かめ、
// そうなら案内の 503 に置き換える。成功した応答では何もしない
export async function onRequest(context) {
  const isApi = new URL(context.request.url).pathname.startsWith("/api/");
  if (!isApi) return handle(context);
  try {
    const res = await handle(context);
    const suspicious = (res.status >= 500 && res.headers.get("X-Service-Guard") !== "1") ||
      (res.status === 401 && context.data.appRole === "search");
    if (suspicious && (await isD1LimitReached(context.env.DB))) return d1LimitResponse();
    return res;
  } catch (e) {
    if (isD1LimitError(e) || (await isD1LimitReached(context.env.DB))) return d1LimitResponse();
    throw e;
  }
}

// 夜間の比率の計算(GitHub Actions)が秘密情報で呼べる管理の API(2026-10-18)
const CRON_ADMIN_PATHS = new Set(["/api/admin/pace-queue", "/api/admin/pace-backtest", "/api/admin/pace-weights/auto-result"]);

async function handle(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const role = appRoleOf(url, env);
  context.data.appRole = role;

  const isApi = url.pathname.startsWith("/api/");

  if (!isApi) {
    const moved = pageRedirect(role, url);
    if (moved) return moved;
    if (role === "search") return searchPage(context, url);
    // 手元の開発環境(all): ゲストの画面(/guest)を開いたときだけゲストの Cookie を渡す(2026-10-15。以前の /g/<合言葉> の代わり)。
    // ログインしている人はセッションが優先されるので、見え方は変わらない
    if (role === "all" && /^\/guest(\.html)?$/.test(url.pathname)) {
      const res = await next();
      const out = new Response(res.body, res);
      await issueGuestCookie(context, out);
      return out;
    }
    return next();
  }
  if (role === "main" && blockedOnMain(request, url)) return notFoundJson();
  if (role === "search") return searchApi(context, url);

  // logout はセッション内容を一切参照せず常にCookieクリアを返すだけ(logout.js 参照)。
  // 認証チェックを通すと、セッション切れ状態で「退場」を押したとき401で弾かれ
  // Set-Cookie(Max-Age=0)まで到達しないため、未認証でも通す。
  const isPublicAuthRoute =
    url.pathname === "/api/auth/login" ||
    url.pathname === "/api/auth/register" ||
    url.pathname === "/api/auth/logout";

  // 夜間の計算(2026-10-18〜 GitHub Actions。以前は Cloudflare の定時起動 workers/pace-cron〈削除済み〉)からの呼び出し(2026-10-14):
  // ログインの代わりに秘密情報 PACE_CRON_SECRET で確かめる。
  // /api/cron/ の下だけ。秘密情報が設定されていない・違うときは 401。
  if (url.pathname.startsWith("/api/cron/")) {
    if (role === "main") return notFoundJson(); // 夜間計算の受け口は管理者用アプリだけ
    const secret = request.headers.get("X-Cron-Secret") || "";
    if (!env.PACE_CRON_SECRET || secret !== env.PACE_CRON_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    context.data.isCron = true;
    // 使用量が多い日は止める(2026-10-18。重い機能の自動一時停止の「夜間の計算」。止めた分は次の晩に続きから)
    try {
      const guarded = await serviceGuardResponse(context);
      if (guarded) return guarded;
    } catch (e) {
      console.error("service guard failed (ignored)", e);
    }
    return next();
  }

  // 夜間の比率の計算(GitHub Actions の scripts/pace-nightly.mjs。2026-10-18): 秘密情報 PACE_CRON_SECRET(ヘッダー X-Cron-Secret)で、
  // 比率の計算に要る管理の API(計算待ち・採点・保存)だけを管理者として通す。管理者用アプリ(と手元の all)だけ
  if (CRON_ADMIN_PATHS.has(url.pathname) && request.headers.get("X-Cron-Secret")) {
    if (role === "main") return notFoundJson();
    if (!env.PACE_CRON_SECRET || request.headers.get("X-Cron-Secret") !== env.PACE_CRON_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    context.data.isCron = true;
    context.data.isAdmin = true;
    context.data.userId = null;
    context.data.username = null;
    try {
      const guarded = await serviceGuardResponse(context);
      if (guarded) return guarded;
    } catch (e) {
      console.error("service guard failed (ignored)", e);
    }
    return next();
  }

  if (role === "admin" && url.pathname === "/api/auth/register") return notFoundJson();
  const isPublic = role === "admin" ? adminPublicApi(url) : isPublicAuthRoute;

  if (isApi && !isPublic) {
    if (!env.APP_PASSWORD) {
      return new Response(
        JSON.stringify({ error: "サーバー側にAPP_PASSWORDが設定されていません" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    let session = await verifySessionToken(request.headers.get("Cookie"), env.APP_PASSWORD);

    // セッションCookieが無い場合、Authorization: Bearer <個人用アクセストークン>を
    // 代替の認証手段として受け付ける(JRAレース結果ページ上のユーザースクリプトなど、
    // このアプリと同一オリジンでない呼び出し元向け。docs/design/results-import.md
    // 「ユーザースクリプトによるHTML取込み」参照)。
    if (!session) {
      const authHeader = request.headers.get("Authorization") || "";
      if (authHeader.startsWith("Bearer ")) {
        const tokenUser = await verifyApiToken(env.DB, authHeader.slice(7).trim());
        if (tokenUser) session = { userId: tokenUser.id, username: tokenUser.username };
      }
    }

    // ゲスト閲覧(2026-10-14。_lib/guest.js・docs/design/guest.md): ログインしていなくても、ゲスト用URLで渡した
    // Cookie(kbg)があれば、決まった読み取りのAPIだけ通す。ログインしている人はセッションを優先する。
    // 2026-10-14: ゲストはデータ検索用アプリ(search。下の searchApi)だけ。main・admin ではゲストの Cookie を見ない
    // (手元の all は以前どおり。Cookie は /guest を開いたときに渡す)
    let guest = null;
    if (!session && role === "all") {
      guest = await resolveGuest(context);
      if (guest instanceof Response) return guest;
    }

    if (!session && !guest) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (guest) {
      context.data.isGuest = true;
      context.data.guestDeviceId = guest.deviceId;
      context.data.guestNickname = guest.nickname || null; // ニックネーム(2026-10-16。未登録なら null)
      context.data.guestVersion = guest.version;
      context.data.userId = null;
      context.data.username = null;
      context.data.isAdmin = false;
    } else {
      context.data.userId = session.userId;
      context.data.username = session.username;
      context.data.isAdmin = isAdminUsername(env, session.username);
      // 管理者用アプリは管理者だけ(画面はログイン画面に戻し「管理者のアカウントで」と出す。public/auth.js)
      if (role === "admin" && !context.data.isAdmin) {
        return new Response(JSON.stringify({ error: "admin_only" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    }

    // D1 の使用量が増えたときの重い機能の自動一時停止(2026-10-08。_lib/service-guard.js)。
    // 止める対象の機能へのリクエストのときだけ判定する(それ以外の操作には影響しない)。判定に失敗したら止めない。
    try {
      const guarded = await serviceGuardResponse(context);
      if (guarded) return guarded;
    } catch (e) {
      console.error("service guard failed (ignored)", e);
    }
  }

  return next();
}

// ---- データ検索用アプリ(search) ----
const NO_INDEX = "noindex, nofollow";

// 画面: ゲストの Cookie(今の版)が無ければ渡す(DB には書かない。端末の行はAPIを使ったときに _lib/guest.js の recordGuestAccess が作る)。
// 検索エンジンには載せない(robots.txt と X-Robots-Tag)
async function searchPage(context, url) {
  const { next } = context;
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain", "X-Robots-Tag": NO_INDEX } });
  }
  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", NO_INDEX);
  if (/\.html$|^\/[a-z-]*$/.test(url.pathname)) await issueGuestCookie(context, out);
  return out;
}

// ゲストの Cookie(今の版)が無ければ応答に付ける(公開中のときだけ。端末IDは持っていればそのまま)
async function issueGuestCookie(context, out) {
  const { request, env } = context;
  if (!env.APP_PASSWORD) return;
  const settings = await getGuestSettings(env.DB);
  const cookie = await readGuestCookie(env, request.headers.get("Cookie"));
  if (settings.enabled && (!cookie || cookie.version !== settings.version)) {
    // 版を作り直すときも、登録済みのニックネームは引き継ぐ(2026-10-16)
    out.headers.append("Set-Cookie", await createGuestCookie(env, cookie?.deviceId || randomToken(16), settings.version, cookie?.nickname || null));
  }
}

// API: 全員ゲスト(ログインの Cookie・トークンは見ない)。ログイン・登録・夜間計算は無い
async function searchApi(context, url) {
  if (url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/auth/check") return notFoundJson();
  if (url.pathname.startsWith("/api/cron/")) return notFoundJson();
  const guest = await resolveGuest(context);
  if (guest instanceof Response) return guest;
  if (!guest) {
    return new Response(JSON.stringify({ error: "guest_invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  context.data.isGuest = true;
  context.data.guestDeviceId = guest.deviceId;
  context.data.guestNickname = guest.nickname || null; // ニックネーム(2026-10-16。未登録なら null)
  context.data.guestVersion = guest.version;
  context.data.userId = null;
  context.data.username = null;
  context.data.isAdmin = false;
  try {
    const guarded = await serviceGuardResponse(context);
    if (guarded) return guarded;
  } catch (e) {
    console.error("service guard failed (ignored)", e);
  }
  return context.next();
}
