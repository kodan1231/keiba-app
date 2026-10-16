// 全ページ共通: ログイン画面⇔アプリ画面の切り替えと、ログイン/新規登録/ログアウト処理。
// 各ページは setupAuth(onReady) を呼び、ログイン済みになったら onReady() が実行される。
//
// ユーザー名+パスワードによる個別ログイン制。ログイン画面に「新規ユーザー登録」も統合する
// (招待コード等は無し)。ログイン後のユーザー名・管理者フラグは window.currentUser に
// 格納し、他のスクリプトから参照できるようにする(管理者向けメニューの出し分け等に使う)。
//
// パスワード変更(2026-09追加): ヘッダーのユーザー名(#current-username)をクリックすると
// モーダルが開き、現在のパスワードを確認したうえで自分のパスワードを変更できる。
// 本人確認は「現在のパスワードの照合」で行うため、他ユーザーのパスワードを
// 変更することはできない。全画面共通のこのファイルに実装することで、
// 各HTMLファイルを個別に編集せずに済む(モーダルのDOMはJSで動的に生成しbodyへ追加する)。
//
// 馬券かご連携(2026-09-06追加): ログイン成功時に "keiba-auth-ready"、ログアウト時に
// "keiba-logout" のカスタムイベントをdocumentへ発火する。public/cart.js(全ページ共通で
// 読み込まれる馬券かご機能)は、ログイン確定後(window.currentUser.username確定後)で
// なければlocalStorageのキー(ユーザーごとに分離)を正しく組み立てられないため、この
// イベントを合図にヘッダーバッジの初期描画を行う。ログアウト時はカゴのパネルを
// 閉じる(パネルはdocument.body直下に生成され#app-screenの外側にあるため)。

window.currentUser = { username: null, isAdmin: false, isGuest: false, passwordResetPending: false };

// ゲスト(ゲスト用URLから入った閲覧専用の利用者。2026-10-14。docs/design/guest.md)が見られる画面(body の data-page)
const GUEST_PAGES = ["guest", "data-search"];
const GUEST_ERROR_TEXT = {
  // 2026-10-14: 合言葉を廃止し、データ検索用アプリ(keiba-search)は公開中なら誰でも見られる。使えないのは公開を止めたとき
  guest_invalid: "現在、公開を停止しています。",
  guest_blocked: "この端末からは利用できません。",
};
// 管理者用アプリ(keiba-admin)に管理者以外でログインしたとき(2026-10-14。docs/design/app-split.md)
const ADMIN_ONLY_TEXT = "管理者のアカウントでログインしてください。";

function setupAuth(onReady) {
  const loginScreen = document.getElementById("login-screen");
  const appScreen = document.getElementById("app-screen");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const logoutBtn = document.getElementById("logout-btn");
  const usernameInput = document.getElementById("login-username");
  const passwordInput = document.getElementById("login-password");
  const submitBtn = document.getElementById("login-submit-btn");
  const modeToggle = document.getElementById("login-mode-toggle");
  const modeHint = document.getElementById("login-mode-hint");

  let mode = "login"; // "login" | "register"
  // 管理者用アプリでは新規登録を出さない(アカウントは予想・擬似購入用アプリで作る。2026-10-14)
  if (modeToggle && typeof currentAppRole === "function" && currentAppRole() === "admin") modeToggle.hidden = true;

  function applyMode() {
    if (!submitBtn || !modeToggle) return;
    if (mode === "login") {
      submitBtn.textContent = "入場する";
      modeToggle.textContent = "初めての方はこちら(新規登録)";
      if (modeHint) modeHint.textContent = "";
      if (passwordInput) passwordInput.autocomplete = "current-password";
    } else {
      submitBtn.textContent = "登録する";
      modeToggle.textContent = "既にアカウントをお持ちの方はこちら(ログイン)";
      if (modeHint) modeHint.textContent = "ユーザー名は半角英数字とアンダースコアのみ・3〜20文字、パスワードは8文字以上で登録してください。";
      if (passwordInput) passwordInput.autocomplete = "new-password";
    }
  }
  applyMode();

  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      mode = mode === "login" ? "register" : "login";
      if (loginError) loginError.hidden = true;
      applyMode();
    });
  }

  function showApp() {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    onReady();
    document.dispatchEvent(new CustomEvent("keiba-auth-ready"));
  }

  function showLogin() {
    loginScreen.hidden = false;
    appScreen.hidden = true;
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError.hidden = true;
      const username = usernameInput ? usernameInput.value.trim() : "";
      const password = passwordInput ? passwordInput.value : "";

      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        window.currentUser.username = data.username || username;
        const ok = await refreshCurrentUser();
        if (!ok && lastAuthError === "admin_only") {
          await fetch("/api/auth/logout", { method: "POST" });
          loginError.textContent = ADMIN_ONLY_TEXT;
          loginError.hidden = false;
          return;
        }
        showApp();
      } else {
        const data = await res.json().catch(() => ({}));
        loginError.textContent = data.error || (mode === "login" ? "ログインに失敗しました" : "登録に失敗しました");
        loginError.hidden = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.currentUser = { username: null, isAdmin: false, isGuest: false, passwordResetPending: false };
      removePasswordResetBanner();
      showLogin();
      document.dispatchEvent(new CustomEvent("keiba-logout"));
    });
  }

  let lastAuthError = null; // ゲストのURLが無効・ブロック等("guest_invalid" 等)
  async function refreshCurrentUser() {
    const res = await fetch("/api/auth/check");
    lastAuthError = null;
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      window.currentUser = {
        username: data.username || null,
        isAdmin: Boolean(data.is_admin),
        isGuest: Boolean(data.is_guest),
        passwordResetPending: Boolean(data.password_reset_pending),
        guestNickname: data.guest_nickname || null, // ゲストのニックネーム(2026-10-16)
        needNickname: Boolean(data.need_nickname),
      };
      applyAdminVisibility();
      renderPasswordResetBanner();
    } else {
      const data = await res.json().catch(() => ({}));
      lastAuthError = data.d1_limit ? "d1_limit" : data.error || null;
      if (data.d1_limit) showD1LimitNotice(data.error);
    }
    return res.ok;
  }

  function applyAdminVisibility() {
    const isGuest = Boolean(window.currentUser.isGuest);
    document.body.classList.toggle("guest-mode", isGuest);
    document.querySelectorAll("[data-guest-only]").forEach((el) => {
      el.hidden = !isGuest;
    });
    document.querySelectorAll("[data-admin-only]").forEach((el) => {
      el.hidden = !window.currentUser.isAdmin;
    });
    document.querySelectorAll("[data-nonadmin-only]").forEach((el) => {
      el.hidden = window.currentUser.isAdmin;
    });
    const nameEl = document.getElementById("current-username");
    if (nameEl) {
      nameEl.textContent = window.currentUser.username || "";
      // クリックでパスワード変更モーダルを開く。イベントリスナーの二重登録を防ぐため、
      // 一度だけバインドする(applyAdminVisibilityはログイン確認のたびに呼ばれるため)。
      if (!nameEl.dataset.pwChangeBound) {
        nameEl.dataset.pwChangeBound = "1";
        nameEl.classList.add("current-username-clickable");
        nameEl.title = "クリックしてパスワードを変更";
        nameEl.addEventListener("click", openPasswordChangeModal);
      }
    }
  }

  (async function init() {
    const ok = await refreshCurrentUser();
    if (ok && window.currentUser.isGuest && window.currentUser.needNickname) {
      // ニックネームが未登録のゲストは、登録画面を出す(2026-10-16。docs/design/guest.md「ニックネーム」)
      showGuestNicknameForm();
      return;
    }
    if (ok) {
      // ゲストは閲覧用の画面だけ(それ以外の画面を開いたらゲスト用のレース一覧へ)
      if (window.currentUser.isGuest && !GUEST_PAGES.includes(document.body.dataset.page)) {
        location.replace("guest.html");
        return;
      }
      showApp();
    } else if (lastAuthError === "d1_limit") {
      // D1 の1日の上限(2026-10-16): ログイン画面ではなく案内だけを出す(ログインしても使えないため)
      loginScreen.innerHTML = `<div class="ticket"><h1 class="ticket-title">馬券帳</h1><p class="ticket-sub"></p></div>`;
      loginScreen.querySelector(".ticket-sub").textContent = d1LimitText;
      showLogin();
    } else if (lastAuthError === "admin_only") {
      await fetch("/api/auth/logout", { method: "POST" });
      showLogin();
      const err = document.getElementById("login-error");
      if (err) { err.textContent = ADMIN_ONLY_TEXT; err.hidden = false; }
    } else if (GUEST_ERROR_TEXT[lastAuthError]) {
      loginScreen.innerHTML = `<div class="ticket"><h1 class="ticket-title">馬券帳</h1><p class="ticket-sub">${GUEST_ERROR_TEXT[lastAuthError]}</p></div>`;
      showLogin();
    } else {
      showLogin();
    }
  })();
}

// ゲストのニックネーム登録画面(2026-10-16)。名前だけ(1〜10文字・パスワードなし)。登録できたら読み込み直す。
// ログイン画面の場所(#login-screen)に出す。名前は重複できない(サーバーが 409 を返す)
function showGuestNicknameForm() {
  const loginScreen = document.getElementById("login-screen");
  const appScreen = document.getElementById("app-screen");
  if (!loginScreen) return;
  loginScreen.innerHTML = `
    <div class="ticket guest-nickname">
      <h1 class="ticket-title">馬券帳 データ検索</h1>
      <p class="ticket-sub">はじめに、ニックネームを登録してください(1〜10文字・パスワードは要りません)。このブラウザでは次から自動で使われます。</p>
      <form id="guest-nickname-form" class="guest-nickname-form">
        <input type="text" id="guest-nickname-input" maxlength="10" autocomplete="nickname" placeholder="ニックネーム" required />
        <button type="submit" class="stamp-btn">登録</button>
      </form>
      <p id="guest-nickname-error" class="submit-message error" hidden></p>
    </div>`;
  loginScreen.hidden = false;
  if (appScreen) appScreen.hidden = true;
  const form = document.getElementById("guest-nickname-form");
  const input = document.getElementById("guest-nickname-input");
  const err = document.getElementById("guest-nickname-error");
  input.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      const res = await fetch("/api/guest/nickname", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { location.reload(); return; }
      err.textContent = data.error || "登録できませんでした";
      err.hidden = false;
    } catch {
      err.textContent = "通信に失敗しました。もう一度お試しください";
      err.hidden = false;
    }
    btn.disabled = false;
  });
}

// 認証必須のfetchラッパー。401が返ったらログイン画面に戻す。
async function authedFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    document.getElementById("login-screen").hidden = false;
    document.getElementById("app-screen").hidden = true;
  }
  // 重い機能の自動一時停止(2026-10-08。functions/api/_lib/service-guard.js)で止められた場合は、控えめなお知らせを出す
  if (res.status === 503 && res.headers.get("X-Service-Guard") === "1") showServiceGuardNotice();
  // D1 の1日の上限(2026-10-16。functions/api/_lib/d1-limit.js)で断られた場合は、画面の上に案内を出し続ける
  if (res.status === 503 && res.headers.get("X-D1-Limit") === "1") {
    const data = await res.clone().json().catch(() => ({}));
    showD1LimitNotice(data.error);
  }
  return res;
}

// D1 の1日の上限を超えたときの案内(2026-10-16)。画面が空のままで何が起きているか分からない、という声への対応。
// 画面の上に固定で出し、閉じるまで出し続ける(同じページで何度断られても1つだけ)。文はサーバーが作る(次に使える時刻入り)
let d1LimitText = "ただいまデータベースの1日の利用上限に達したため、データを表示・保存できません。朝9時以降にもう一度アクセスしてください。";
function showD1LimitNotice(text) {
  if (text) d1LimitText = text;
  if (document.getElementById("d1-limit-notice")) return;
  const el = document.createElement("div");
  el.id = "d1-limit-notice";
  el.className = "d1-limit-notice";
  el.setAttribute("role", "alert");
  el.innerHTML = `<span class="d1-limit-notice-text"></span><button type="button" class="d1-limit-notice-close" aria-label="閉じる">×</button>`;
  el.querySelector(".d1-limit-notice-text").textContent = d1LimitText;
  el.querySelector("button").addEventListener("click", () => el.remove());
  document.body.prepend(el);
}

// 画面下に数秒だけ出すお知らせ(同じページで何度止められても1つだけ)。不安を与えないよう短い文にする。
function showServiceGuardNotice() {
  if (document.getElementById("service-guard-notice")) return;
  const el = document.createElement("div");
  el.id = "service-guard-notice";
  el.className = "service-guard-notice";
  el.setAttribute("role", "status");
  el.textContent = "ただいま混雑のため、この機能を一時的に停止しています。時間をおいてお試しください。";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

// ---------- 管理者リセット通知バナー(全画面共通) ----------
// 管理者に自分のパスワードをリセットされたユーザーへ、全画面の本文冒頭で
// パスワード変更を促す(強制はしない。閉じるボタンも設けず、本人がパスワードを
// 変更するまで表示し続ける)。詳細はdocs/design/auth-multiuser.md参照。

function removePasswordResetBanner() {
  const el = document.getElementById("password-reset-banner");
  if (el) el.remove();
}

function renderPasswordResetBanner() {
  if (!window.currentUser || !window.currentUser.passwordResetPending) {
    removePasswordResetBanner();
    return;
  }
  if (document.getElementById("password-reset-banner")) return;

  const appScreen = document.getElementById("app-screen");
  if (!appScreen) return;

  const banner = document.createElement("div");
  banner.id = "password-reset-banner";
  banner.className = "password-reset-banner";
  banner.innerHTML = `
    <span>管理者によってパスワードがリセットされました。新しいパスワードにご自身で変更してください。</span>
    <button type="button" id="password-reset-banner-btn" class="ghost-btn">パスワードを変更する</button>
  `;
  // マストヘッドの直後・本文の前に差し込む。
  const masthead = appScreen.querySelector(".masthead");
  if (masthead && masthead.nextSibling) {
    appScreen.insertBefore(banner, masthead.nextSibling);
  } else {
    appScreen.insertBefore(banner, appScreen.firstChild);
  }

  banner.querySelector("#password-reset-banner-btn").addEventListener("click", openPasswordChangeModal);
}

// ---------- パスワード変更モーダル(全画面共通) ----------
// モーダルのDOM自体は各HTMLファイルに書かず、初回オープン時にJSで動的に生成して
// document.bodyへ追加する(全6画面のHTMLを個別に編集せずに済ませるため)。
// スタイルは既存の .modal-overlay / .modal / .form-row 等のクラスをそのまま再利用する。

function ensurePasswordChangeModal() {
  let overlay = document.getElementById("password-change-modal");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "password-change-modal";
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal">
      <h2>パスワード変更</h2>
      <form id="password-change-form">
        <label class="full">現在のパスワード
          <input type="password" id="pw-change-current" autocomplete="current-password" required />
        </label>
        <label class="full">新しいパスワード(8文字以上)
          <input type="password" id="pw-change-new" autocomplete="new-password" minlength="8" required />
        </label>
        <label class="full">新しいパスワード(確認)
          <input type="password" id="pw-change-new-confirm" autocomplete="new-password" minlength="8" required />
        </label>
        <p id="password-change-message" class="submit-message" hidden></p>
        <div class="modal-actions">
          <button type="button" id="password-change-cancel-btn" class="ghost-btn">キャンセル</button>
          <button type="submit" class="stamp-btn">変更する</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#password-change-form");
  const messageEl = overlay.querySelector("#password-change-message");
  const currentInput = overlay.querySelector("#pw-change-current");
  const newInput = overlay.querySelector("#pw-change-new");
  const confirmInput = overlay.querySelector("#pw-change-new-confirm");

  function closePasswordChangeModal() {
    overlay.hidden = true;
    form.reset();
    messageEl.hidden = true;
  }

  overlay.querySelector("#password-change-cancel-btn").addEventListener("click", closePasswordChangeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePasswordChangeModal();
  });
  // utils.js の共通ヘルパー。存在する画面(全画面でutils.jsを読み込んでいる)でのみ有効。
  if (typeof registerEscToClose === "function") {
    registerEscToClose(overlay, closePasswordChangeModal);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    messageEl.hidden = true;

    const current = currentInput.value;
    const next = newInput.value;
    const confirmVal = confirmInput.value;

    if (next !== confirmVal) {
      messageEl.hidden = false;
      messageEl.className = "submit-message error";
      messageEl.textContent = "新しいパスワード(確認)が一致しません。";
      return;
    }
    if (next.length < 8) {
      messageEl.hidden = false;
      messageEl.className = "submit-message error";
      messageEl.textContent = "新しいパスワードは8文字以上で入力してください。";
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    const res = await authedFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    const data = await res.json().catch(() => ({}));

    submitButton.disabled = false;
    messageEl.hidden = false;

    if (res.ok) {
      messageEl.className = "submit-message success";
      messageEl.textContent = "パスワードを変更しました。";
      // 管理者リセット後のバナーを出していた場合は消す(サーバー側でも
      // password_reset_pending が0に戻っている)。
      window.currentUser.passwordResetPending = false;
      removePasswordResetBanner();
      setTimeout(closePasswordChangeModal, 1200);
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "変更に失敗しました。";
    }
  });

  return overlay;
}

function openPasswordChangeModal() {
  const overlay = ensurePasswordChangeModal();
  overlay.hidden = false;
  const modalBox = overlay.querySelector(".modal");
  if (modalBox) modalBox.scrollTop = 0;
  const currentInput = overlay.querySelector("#pw-change-current");
  if (currentInput) currentInput.focus();
}
