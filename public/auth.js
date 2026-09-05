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