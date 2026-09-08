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
  const NAV_ITEMS = [
    { page: "buy", href: "index.html", label: "馬券購入" },
    { page: "history", href: "history.html", label: "馬券履歴" },
    { page: "stats", href: "stats.html", label: "集計" },
    { page: "races", href: "races.html", label: "レース管理", adminOnly: true },
    { page: "admin", href: "admin.html", label: "管理", adminOnly: true },
  ];

  // ページ固有のヘッダーアクションボタン(かごバッジと退場ボタンの間に挿入)。
  // ボタンのidは従来のHTMLと同一。イベント登録は各ページのJS(app.js/races.js等)が
  // 実行時に getElementById で行うため、ここで生成しても従来通り動作する。
  const PAGE_ACTIONS = {
    history:
      '<input type="file" id="csv-import-input" accept=".csv,text/csv" hidden />' +
      '<button id="csv-import-btn" class="ghost-btn">CSVインポート</button>',
    races:
      '<button id="jra-entries-import-btn" class="ghost-btn" data-admin-only hidden>出走馬一覧PDFをインポート</button>' +
      '<button id="jra-result-import-btn" class="ghost-btn" data-admin-only hidden>JRAレース結果PDFをインポート</button>' +
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

  const navHtml = NAV_ITEMS.map((item) => {
    const cls = "nav-link" + (item.page === currentPage ? " active" : "");
    const adminAttr = item.adminOnly ? " data-admin-only hidden" : "";
    return `<a href="${item.href}" class="${cls}"${adminAttr}>${item.label}</a>`;
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
