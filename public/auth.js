// 全ページ共通: ログイン画面⇔アプリ画面の切り替えと、ログイン/ログアウト処理。
// 各ページは setupAuth(onReady) を呼び、ログイン済みになったら onReady() が実行される。

function setupAuth(onReady) {
  const loginScreen = document.getElementById("login-screen");
  const appScreen = document.getElementById("app-screen");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const logoutBtn = document.getElementById("logout-btn");

  function showApp() {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    onReady();
  }

  function showLogin() {
    loginScreen.hidden = false;
    appScreen.hidden = true;
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const password = document.getElementById("login-password").value;

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      showApp();
    } else {
      const data = await res.json().catch(() => ({}));
      loginError.textContent = data.error || "ログインに失敗しました";
      loginError.hidden = false;
    }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      showLogin();
    });
  }

  (async function init() {
    const res = await fetch("/api/auth/check");
    if (res.ok) {
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
