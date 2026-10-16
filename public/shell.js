// マストヘッド(ヘッダーナビ)とログイン画面のマークアップを実行時に生成して注入する。
//
// 2026-09-08新設: 以前は6つのHTML(index/history/stats/prediction/races/admin)が
// ログイン画面(#login-screen)とヘッダー(header.masthead)を丸ごと重複保持しており、
// ナビ項目の追加・並べ替えやログイン画面の文言変更のたびに6ファイルを編集する必要が
// あった。ESモジュールを使わないグローバルスクリプト構成のため、各HTMLで utils.js の
// 直後・auth.js より前に読み込む(auth.js は #login-username 等・data-admin-only 要素を
// 参照するため、それらが生成済みである必要がある)。
//
// 各HTMLが持つべきものは以下だけ:
//   <body data-page="stats">                         ... 現在ページ(ナビのactive判定用)
//   <div id="login-screen" class="screen" hidden></div>  ... 空プレースホルダ
//   <div id="app-screen" class="screen" hidden>
//     <header class="masthead"></header>              ... 空。中身はここで生成
//     <main> ... ページ本体 ... </main>
//   </div>
//
// すでに中身が入っている場合(移行途中等)は上書きしないため、段階的な移行も安全。

(function () {
  // ナビ項目。順序=表示順。page はHTML側 <body data-page="..."> と一致させる。
  // adminOnly:true の項目には data-admin-only hidden を付け、auth.js が
  // ログインユーザーの管理者判定に応じて表示/非表示を切り替える。
  // guestOnly: ゲスト(ゲスト用URLから入った閲覧専用の利用者。2026-10-14。docs/design/guest.md)にだけ出す。
  // guestOk: ゲストにも出す(それ以外はゲストには出さない。body.guest-mode の CSS で隠す)。
  // app: その画面があるアプリ(2026-10-14。アプリの入口の分離。docs/design/app-split.md)。別のアプリの画面は utils.js の appUrl で
  // そのアプリのURLへのリンクにする。roles: そのアプリ(currentAppRole)のときだけナビに出す(省略は全部。手元の "all" は全部出す)
  const NAV_ITEMS = [
    { page: "guest", href: "guest.html", app: "search", label: "今週のレース", guestOnly: true, guestOk: true, roles: ["search"] },
    { page: "buy", href: "index.html", app: "main", label: "馬券購入", roles: ["main"] },
    { page: "history", href: "history.html", app: "main", label: "馬券履歴", roles: ["main"] },
    { page: "stats", href: "stats.html", app: "main", label: "集計", roles: ["main"] },
    { page: "data-search", href: "data-search.html", app: "search", label: "データ検索", guestOk: true, roles: ["main", "search"] },
    { page: "races", href: "races.html", app: "admin", label: "レース管理", adminOnly: true, roles: ["main", "admin"] },
    { page: "admin", href: "admin.html", app: "admin", label: "管理", adminOnly: true, roles: ["main", "admin"] },
    // 予想・擬似購入用アプリへ戻るリンク。データ検索用にも出す(2026-10-15 ユーザー要望。ゲストにも出すので guestOk)。
    // データ検索用では、馬券帳の画面から移ってきたとき(=馬券帳にログインしている人)だけ出す(下の cameFromMain)
    { page: "main-home", href: "index.html", app: "main", label: "馬券帳へ", guestOk: true, roles: ["admin", "search"] },
  ];
  const appRole = typeof currentAppRole === "function" ? currentAppRole() : "all";
  // データ検索用アプリ: 馬券帳(予想・擬似購入用)の画面から移ってきたか(2026-10-15)。データ検索用は別のURLなので馬券帳のログイン状態は
  // 見られない。代わりに、移ってきたときの referrer(どのサイトから来たか)が馬券帳なら、このタブの間だけ印(sessionStorage)を付ける。
  // 馬券帳はログインしないと開けないので、実質「馬券帳にログインしている人」だけ。直接・ブックマークから開いたゲストには出さない
  const cameFromMain = (() => {
    if (appRole !== "search") return false;
    const KEY = "kb_from_main";
    try {
      const main = typeof APP_URLS === "object" ? APP_URLS.main : "";
      if (main && document.referrer && document.referrer.startsWith(main)) sessionStorage.setItem(KEY, "1");
      return sessionStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  })();

  // ページ固有のヘッダーアクションボタン(かごバッジと退場ボタンの間に挿入)。
  // ボタンのidは従来のHTMLと同一。イベント登録は各ページのJS(app.js/races.js等)が
  // 実行時に getElementById で行うため、ここで生成しても従来通り動作する。
  const PAGE_ACTIONS = {
    // history の「CSVインポート」は 2026-10-15 に馬券履歴画面のカレンダーの並びへ移した(history.html。ヘッダーの段がずれるため)
    // races の「出走馬一覧PDFをインポート」「JRAレース結果PDFをインポート」は 2026-10-16 に削除(使っていないため)
    races:
      '<button id="new-race-btn" class="stamp-btn" data-admin-only hidden>＋ レースを登録</button>',
  };

  const LOGIN_HTML = `
    <div class="ticket">
      <p class="ticket-eyebrow">MEMBERS ONLY</p>
      <h1 class="ticket-title">馬券帳</h1>
      <p class="ticket-sub">ユーザー名とパスワードを入力して入場してください</p>
      <form id="login-form">
        <input type="text" id="login-username" placeholder="ユーザー名" autocomplete="username" required />
        <input type="password" id="login-password" placeholder="パスワード" autocomplete="current-password" required />
        <button type="submit" id="login-submit-btn">入場する</button>
      </form>
      <p id="login-error" class="error-text" hidden></p>
      <p id="login-mode-hint" class="ticket-sub" style="font-size:.8em"></p>
      <button type="button" id="login-mode-toggle" class="ghost-btn">初めての方はこちら(新規登録)</button>
    </div>`;

  const currentPage = (document.body && document.body.dataset.page) || "";

  const navHtml = NAV_ITEMS.filter((item) => {
    if (appRole === "all") return item.page !== "main-home";
    if (item.page === "main-home" && appRole === "search" && !cameFromMain) return false;
    return !item.roles || item.roles.includes(appRole);
  }).map((item) => {
    const cls = "nav-link" + (item.page === currentPage ? " active" : "");
    // 管理者用アプリでは全員が管理者なので adminOnly で隠さない
    const adminAttr = item.adminOnly && appRole !== "admin" ? " data-admin-only hidden" : "";
    const guestAttr = (item.guestOnly && appRole !== "search" ? " data-guest-only hidden" : "") + (item.guestOk ? " data-guest-ok" : "");
    const href = typeof appUrl === "function" && item.app ? appUrl(item.app, item.href) : item.href;
    return `<a href="${href}" class="${cls}"${adminAttr}${guestAttr}>${item.label}</a>`;
  }).join("");

  const mastheadHtml = `
    <div class="masthead-inner">
      <h1 class="masthead-title">馬券帳</h1>
      <nav class="masthead-nav">${navHtml}</nav>
    </div>
    <div class="masthead-actions">
      <span id="current-username" class="current-username"></span>
      <button type="button" id="cart-badge-btn" class="ghost-btn cart-badge-btn">かご<span id="cart-badge-count" class="cart-badge-count" hidden>0</span></button>
      ${PAGE_ACTIONS[currentPage] || ""}
      <button id="logout-btn" class="ghost-btn">退場</button>
    </div>`;

  const loginScreen = document.getElementById("login-screen");
  if (loginScreen && loginScreen.children.length === 0) {
    loginScreen.innerHTML = LOGIN_HTML;
  }

  const masthead = document.querySelector("#app-screen .masthead");
  if (masthead && masthead.children.length === 0) {
    masthead.innerHTML = mastheadHtml;
  }
})();
