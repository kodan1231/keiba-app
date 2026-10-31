// アプリの入口の分離(2026-10-14 ユーザー要望。仕様は docs/design/app-split.md)。
// 同じリポジトリ・同じ D1 を、3つの Pages プロジェクト(URL)で公開し、どのURLで来たかでできることを分ける:
//   - main  (予想・擬似購入用 https://keiba-yosou-app.pages.dev): 馬券購入・履歴・集計・予想登録。ログイン要
//   - search(データ検索用   https://keiba-search.pages.dev)   : 今週のレース(ゲスト画面)・データ検索。ログイン不要。
//            ログインの Cookie は届かない(ドメインが別)ので、管理者が開いても未ログインの人と同じ見え方
//   - admin (管理者用       https://keiba-admin.pages.dev)    : 管理画面・レース管理(取り込み)。管理者だけ
//   - all   (手元の wrangler pages dev 等。分けない。以前と同じ動き)
// 判定はホスト名(プレビューの <hash>.keiba-search.pages.dev も含む)。環境変数 APP_ROLE があればそちらを使う。
// 画面: 他のアプリの画面を開いたら、そのアプリの同じ画面へ移す(302)。API: そのアプリで使わないものは 404。
// ファイル自体は3つとも同じものが公開されるが、画面・APIへは必ずこの入口(functions/_middleware.js)を通る。

export const APP_URLS = {
  main: "https://keiba-yosou-app.pages.dev",
  search: "https://keiba-search.pages.dev",
  admin: "https://keiba-admin.pages.dev",
};

export function appRoleOf(url, env) {
  const forced = env && env.APP_ROLE;
  if (forced && (forced === "all" || APP_URLS[forced])) return forced;
  const h = url.hostname;
  if (h === "keiba-search.pages.dev" || h.endsWith(".keiba-search.pages.dev")) return "search";
  if (h === "keiba-admin.pages.dev" || h.endsWith(".keiba-admin.pages.dev")) return "admin";
  if (h === "keiba-yosou-app.pages.dev" || h.endsWith(".keiba-yosou-app.pages.dev")) return "main";
  return "all";
}

// 画面(HTML)がどのアプリのものか。キーは "/x.html" "/x" の x("/" は "")
const PAGE_APP = {
  "": "main", index: "main", history: "main", stats: "main", prediction: "main",
  guest: "search", "data-search": "search",
  admin: "admin", races: "admin",
};
// 各アプリの "/" の行き先(main は index.html のまま)
const HOME = { search: "/guest", admin: "/admin" };

function pageNameOf(pathname) {
  if (pathname === "/") return "";
  const m = pathname.match(/^\/([a-z-]+)(?:\.html)?$/);
  return m ? m[1] : null;
}

// 画面の振り分け。移す必要があれば 302 の Response、無ければ null
export function pageRedirect(role, url) {
  if (role === "all") return null;
  // 以前のゲスト用URL(/g/<合言葉>)はデータ検索用アプリの今週のレースへ(合言葉は2026-10-14に廃止。
  // 受け口の functions/g/[key].js は 2026-10-15 に削除。手元の all では /guest を開く)
  if (url.pathname.startsWith("/g/")) return redirect(`${APP_URLS.search}/guest`);
  const name = pageNameOf(url.pathname);
  if (name === null || !(name in PAGE_APP)) return null;
  if (name === "" && HOME[role]) return redirect(`${url.origin}${HOME[role]}${url.search}`);
  const owner = PAGE_APP[name];
  if (owner !== role) return redirect(`${APP_URLS[owner]}${url.pathname}${url.search}`);
  return null;
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

// main で使えない API(管理・取り込み・レースの編集・夜間計算。データ検索は予想登録画面で使う2つだけ)
export function blockedOnMain(request, url) {
  const p = url.pathname, m = request.method;
  if (p.startsWith("/api/admin/") || p.startsWith("/api/cron/")) return true;
  if (p.startsWith("/api/guest/")) return true; // ゲストのニックネーム登録(2026-10-16)はデータ検索用アプリ(search)だけ
  if (p === "/api/races/entries-import" || p === "/api/races/results-import") return true;
  if (p === "/api/races" && m !== "GET") return true;
  if (/^\/api\/races\/\d+$/.test(p) && m !== "GET") return true;
  if (/^\/api\/races\/\d+\/results$/.test(p) && m !== "GET") return true;
  // race-signal(s): 馬券購入画面のレース一覧の目印「複」「ワ」(2026-11-01)
  if (p.startsWith("/api/data-search/") && !/^\/api\/data-search\/(race-factors|jockey-course|race-signals?)$/.test(p)) return true;
  return false;
}

// admin でログインなしに使える API(ログイン・ログアウトだけ。新規登録は不可)
export function adminPublicApi(url) {
  return url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout";
}

export const notFoundJson = () =>
  new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
