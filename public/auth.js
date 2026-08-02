// 全ページ共通: ログイン画面⇔アプリ画面の切り替えと、ログイン/新規登録/ログアウト処理。
// 各ページは setupAuth(onReady) を呼び、ログイン済みになったら onReady() が実行される。
//
// 2026-08-01 複数ユーザー対応: パスワードのみの入場制から、ユーザー名+パスワードの
// 個別ログイン制に変更。ログイン画面に「新規ユーザー登録」も統合する(招待コード等は無し)。
// ログイン後のユーザー名・管理者フラグは window.currentUser に格納し、他のスクリプトから
// 参照できるようにする(管理者向けメニューの出し分け等に使う)。

window.currentUser = { username: null, isAdmin: false };

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
        await refreshCurrentUser();
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
      window.currentUser = { username: null, isAdmin: false };
      showLogin();
    });
  }

  async function refreshCurrentUser() {
    const res = await fetch("/api/auth/check");
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      window.currentUser = { username: data.username || null, isAdmin: Boolean(data.is_admin) };
      applyAdminVisibility();
    }
    return res.ok;
  }

  function applyAdminVisibility() {
    document.querySelectorAll("[data-admin-only]").forEach((el) => {
      el.hidden = !window.currentUser.isAdmin;
    });
    document.querySelectorAll("[data-nonadmin-only]").forEach((el) => {
      el.hidden = window.currentUser.isAdmin;
    });
    const nameEl = document.getElementById("current-username");
    if (nameEl) nameEl.textContent = window.currentUser.username || "";
  }

  (async function init() {
    const ok = await refreshCurrentUser();
    if (ok) {
      showApp();
    } else {
      showLogin();
    }
  })();
}

// 認証必須のfetchラッパー。401が返ったらログイン画面に戻す。
async function authedFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    document.getElementById("login-screen").hidden = false;
    document.getElementById("app-screen").hidden = true;
  }
  return res;
}
