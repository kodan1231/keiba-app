// 管理者向け画面(admin.html)。
// 「未登録レース一覧」: CSVインポートで参照されたがまだレース登録されていない
// 日付・競馬場・レース番号を一覧表示し、レース登録画面へ事前入力付きで遷移できる。
// 「登録ユーザー一覧」: users テーブルの閲覧のみ(編集・削除機能は無し)。
//   2026-08-30追加: 登録日時に加えて最終ログイン日時(JST)も表示する。
// 「騎手名エイリアス管理」(2026-08-16追加): 表記ゆれの騎手名を正しい表記へ統一するための
// 対応表(jockey_aliases)の一覧表示・追加・削除、および既存データへの一括補正。
// 詳細はdocs/design/jockey-aliases.md「騎手名エイリアス管理」参照。

// escapeHtml / formatDateMdW は utils.js のものを使用する
// (2026-09-07: ローカルの formatDate("8/24(日)"形式)を撤去し utils.js の
//  formatDateMdW に統合。呼び出し側も formatDateMdW へ変更済み)

// D1の created_at (datetime('now')) はUTCの "YYYY-MM-DD HH:MM:SS" 形式(タイムゾーン情報なし)
// で保存されている。この文字列をそのまま new Date() に渡すと、末尾にタイムゾーン指定が
// 無い形式の解釈がブラウザによって異なる(UTCとして解釈されるとは限らない)ため、
// 常に明示的にUTCとして解釈したうえで日本時間(JST)に変換して表示する。
// last_login_at(2026-08-30追加)も同じ形式・同じ関数で表示する。
function formatDateTime(s) {
  if (!s) return "";
  const hasTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = hasTz ? s : `${s.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(s);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  // 一部環境ではhour12:falseでも24時が"24"表記になることがあるため、"00"に正規化する。
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}/${parts.month}/${parts.day} ${hour}:${parts.minute}`;
}

async function loadUnregisteredRaces() {
  const table = document.getElementById("unregistered-races-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/unregistered-races");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; return; }
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) {
    table.innerHTML = "<tr><td>未登録のレースはありません</td></tr>";
    return;
  }
  table.innerHTML = `
    <thead><tr><th>日付</th><th>競馬場</th><th>R</th><th>レース名</th><th>取込件数</th><th>購入額合計</th><th></th></tr></thead>
    <tbody>
      ${items.map((it) => `
        <tr>
          <td>${formatDateMdW(it.race_date)}</td>
          <td>${escapeHtml(it.track || "")}</td>
          <td>${it.race_number}R</td>
          <td>${escapeHtml(it.race_name || "")}</td>
          <td>${it.group_count}件</td>
          <td>${formatYen(it.total_amount)}</td>
          <td><a class="ghost-btn" href="races.html?new_date=${encodeURIComponent(it.race_date)}&new_track=${encodeURIComponent(it.track || "")}&new_race_number=${encodeURIComponent(it.race_number)}">登録する</a></td>
        </tr>
      `).join("")}
    </tbody>
  `;
}

async function loadUsers() {
  const table = document.getElementById("users-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/users");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; return; }
  const data = await res.json();
  const items = data.items || [];
  table.innerHTML = `
    <thead><tr><th>ユーザー名</th><th>登録日時(JST)</th><th>最終ログイン日時(JST)</th><th>操作</th></tr></thead>
    <tbody>
      ${items.map((u) => {
        const isSelf = u.username === window.currentUser?.username;
        return `
        <tr>
          <td>${escapeHtml(u.username)}${isSelf ? "(自分)" : ""}${u.password_reset_pending ? '<span class="ticket-sub" style="display:block">パスワードリセット済み(本人の変更待ち)</span>' : ""}</td>
          <td>${formatDateTime(u.created_at)}</td>
          <td>${u.last_login_at ? formatDateTime(u.last_login_at) : "未ログイン"}</td>
          <td>${isSelf ? "" : `<button type="button" class="ghost-btn user-reset-pw-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">パスワードリセット</button>`}</td>
        </tr>`;
      }).join("")}
    </tbody>
  `;

  table.querySelectorAll(".user-reset-pw-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      openResetPasswordModal(btn.dataset.userId, btn.dataset.username);
    });
  });
}

// ---------- パスワードリセットモーダル(管理者用) ----------
// 指定ユーザーのパスワードを、管理者が入力した新しいパスワードへ置き換える。
// 本人へは全画面共通のバナーでパスワード変更を促す(functions/api/auth/check.js +
// public/auth.js。強制ではない)。詳細はdocs/design/auth-multiuser.md参照。

function ensureResetPasswordModal() {
  let overlay = document.getElementById("reset-password-modal");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "reset-password-modal";
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal">
      <h2>パスワードリセット</h2>
      <p class="ticket-sub">対象ユーザー: <strong id="reset-pw-target-name"></strong></p>
      <p class="ticket-sub">ここで設定した新しいパスワードを、本人に別途伝えてください。既存のログインセッションは維持されます。</p>
      <form id="reset-password-form">
        <label class="full">新しいパスワード(8文字以上)
          <input type="password" id="reset-pw-new" autocomplete="new-password" minlength="8" required />
        </label>
        <label class="full">新しいパスワード(確認)
          <input type="password" id="reset-pw-new-confirm" autocomplete="new-password" minlength="8" required />
        </label>
        <p id="reset-password-message" class="submit-message" hidden></p>
        <div class="modal-actions">
          <button type="button" id="reset-password-cancel-btn" class="ghost-btn">キャンセル</button>
          <button type="submit" class="stamp-btn">リセットする</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#reset-password-form");
  const messageEl = overlay.querySelector("#reset-password-message");
  const newInput = overlay.querySelector("#reset-pw-new");
  const confirmInput = overlay.querySelector("#reset-pw-new-confirm");

  function close() {
    overlay.hidden = true;
    form.reset();
    messageEl.hidden = true;
    delete overlay.dataset.userId;
  }

  overlay.querySelector("#reset-password-cancel-btn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  if (typeof registerEscToClose === "function") registerEscToClose(overlay, close);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    messageEl.hidden = true;

    const userId = overlay.dataset.userId;
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

    const res = await authedFetch("/api/admin/reset-user-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: Number(userId), new_password: next }),
    });
    const data = await res.json().catch(() => ({}));

    submitButton.disabled = false;
    messageEl.hidden = false;

    if (res.ok) {
      messageEl.className = "submit-message success";
      messageEl.textContent = `${data.username || ""} のパスワードをリセットしました。本人に新しいパスワードを伝え、ログイン後に変更するよう促してください。`;
      await loadUsers();
      setTimeout(close, 2000);
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "リセットに失敗しました。";
    }
  });

  return overlay;
}

function openResetPasswordModal(userId, username) {
  const overlay = ensureResetPasswordModal();
  overlay.dataset.userId = userId;
  overlay.querySelector("#reset-pw-target-name").textContent = username || "";
  overlay.hidden = false;
  const newInput = overlay.querySelector("#reset-pw-new");
  if (newInput) newInput.focus();
}

// ---------- 騎手名エイリアス管理(2026-08-16追加) ----------

async function loadJockeyAliases() {
  const table = document.getElementById("jockey-aliases-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/jockey-aliases");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; return; }
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) {
    table.innerHTML = "<tr><td>登録済みのエイリアスはありません</td></tr>";
    return;
  }
  table.innerHTML = `
    <thead><tr><th>表記ゆれ側</th><th>正しい表記</th><th>登録日時</th><th></th></tr></thead>
    <tbody>
      ${items.map((a) => `
        <tr data-id="${a.id}">
          <td>${escapeHtml(a.alias_display)}</td>
          <td>${escapeHtml(a.canonical_name)}</td>
          <td>${formatDateTime(a.created_at)}</td>
          <td><button type="button" class="icon-btn delete jockey-alias-delete-btn" title="削除">×</button></td>
        </tr>
      `).join("")}
    </tbody>
  `;

  table.querySelectorAll(".jockey-alias-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const id = row?.dataset.id;
      if (!id) return;
      if (!confirm("このエイリアスを削除しますか？")) return;
      const res2 = await authedFetch(`/api/admin/jockey-aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res2.ok) {
        const data2 = await res2.json().catch(() => ({}));
        alert(data2.error || "削除に失敗しました。");
        return;
      }
      await loadJockeyAliases();
    });
  });
}

function setupJockeyAliasForm() {
  const form = document.getElementById("jockey-alias-form");
  const messageEl = document.getElementById("jockey-alias-form-message");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const displayInput = document.getElementById("jockey-alias-display");
    const canonicalInput = document.getElementById("jockey-alias-canonical");
    const alias_display = displayInput.value.trim();
    const canonical_name = canonicalInput.value.trim();

    if (!alias_display || !canonical_name) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    messageEl.hidden = true;

    const res = await authedFetch("/api/admin/jockey-aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias_display, canonical_name }),
    });
    const data = await res.json().catch(() => ({}));

    messageEl.hidden = false;
    if (res.ok) {
      messageEl.className = "submit-message success";
      messageEl.textContent = `「${alias_display}」→「${canonical_name}」を登録しました。`;
      displayInput.value = "";
      canonicalInput.value = "";
      await loadJockeyAliases();
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "登録に失敗しました。";
    }
    submitBtn.disabled = false;
  });
}

function setupJockeyAliasNormalizeButton() {
  const btn = document.getElementById("jockey-alias-normalize-btn");
  const messageEl = document.getElementById("jockey-alias-normalize-message");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!confirm("登録済みのエイリアスと一致する騎手名を、既存の出走馬表・レース結果・購入履歴・CSV取込履歴からまとめて書き換えます。実行しますか？")) return;

    btn.disabled = true;
    messageEl.hidden = true;

    const res = await authedFetch("/api/admin/jockey-aliases/normalize-existing", { method: "POST" });
    const data = await res.json().catch(() => ({}));

    messageEl.hidden = false;
    if (res.ok) {
      const u = data.updated || {};
      messageEl.className = "submit-message success";
      messageEl.textContent = `一括補正が完了しました(レース ${u.races || 0}件 / レース結果 ${u.race_results || 0}件 / 購入履歴 ${u.tickets || 0}件 / CSV取込 ${u.imported_ticket_items || 0}件を更新)。`;
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "一括補正に失敗しました。";
    }
    btn.disabled = false;
  });
}

// ---------- 馬名エイリアス管理(2026-09-11追加) ----------

async function loadHorseAliases() {
  const table = document.getElementById("horse-aliases-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/horse-aliases");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; return; }
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) {
    table.innerHTML = "<tr><td>登録済みのエイリアスはありません</td></tr>";
    return;
  }
  table.innerHTML = `
    <thead><tr><th>表記ゆれ側</th><th>正しい馬名</th><th>登録日時</th><th></th></tr></thead>
    <tbody>
      ${items.map((a) => `
        <tr data-id="${a.id}">
          <td>${escapeHtml(a.alias_display)}</td>
          <td>${escapeHtml(a.canonical_name)}</td>
          <td>${formatDateTime(a.created_at)}</td>
          <td><button type="button" class="icon-btn delete horse-alias-delete-btn" title="削除">×</button></td>
        </tr>
      `).join("")}
    </tbody>
  `;
  table.querySelectorAll(".horse-alias-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const id = row?.dataset.id;
      if (!id) return;
      if (!confirm("このエイリアスを削除しますか？")) return;
      const res2 = await authedFetch(`/api/admin/horse-aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res2.ok) {
        const data2 = await res2.json().catch(() => ({}));
        alert(data2.error || "削除に失敗しました。");
        return;
      }
      await loadHorseAliases();
    });
  });
}

function prefillHorseAlias(display) {
  const displayInput = document.getElementById("horse-alias-display");
  const canonicalInput = document.getElementById("horse-alias-canonical");
  if (!displayInput) return;
  displayInput.value = display;
  displayInput.scrollIntoView({ behavior: "smooth", block: "center" });
  if (canonicalInput) canonicalInput.focus();
}

function renderHorseIndexTable(horses) {
  const table = document.getElementById("horse-index-table");
  if (!table) return;
  if (!horses.length) {
    table.innerHTML = "<tr><td>該当する馬はいません</td></tr>";
    return;
  }
  table.innerHTML = `
    <thead><tr><th>馬名</th><th>出走表</th><th>結果</th><th>メモ</th><th>表記ゆれ</th><th></th></tr></thead>
    <tbody>
      ${horses.map((h) => {
        const variantChips = h.mismatch
          ? h.variants.map((v) => `<button type="button" class="horse-variant-chip" data-variant="${escapeAttr(v)}">${escapeHtml(v)}</button>`).join(" ")
          : "";
        return `
        <tr${h.mismatch ? ' class="horse-row-mismatch"' : ""}>
          <td>${escapeHtml(h.name)}</td>
          <td>${h.entryRaceCount ? `${h.entryRaceCount}R` : "—"}</td>
          <td>${h.resultRaceCount ? `${h.resultRaceCount}R` : "—"}</td>
          <td>${h.hasNote ? "あり" : "—"}</td>
          <td>${variantChips || "—"}</td>
          <td><button type="button" class="ghost-btn horse-alias-prefill-btn" data-name="${escapeAttr(h.name)}">エイリアス登録</button></td>
        </tr>`;
      }).join("")}
    </tbody>
  `;
  table.querySelectorAll(".horse-alias-prefill-btn").forEach((btn) => {
    btn.addEventListener("click", () => prefillHorseAlias(btn.dataset.name || ""));
  });
  table.querySelectorAll(".horse-variant-chip").forEach((btn) => {
    btn.addEventListener("click", () => prefillHorseAlias(btn.dataset.variant || ""));
  });
}

async function fetchHorseIndex(params) {
  const status = document.getElementById("horse-index-status");
  const res = await authedFetch(`/api/admin/horses${params}`);
  if (!res.ok) { if (status) status.textContent = "読み込みに失敗しました。"; return null; }
  return res.json();
}

async function setupHorseIndex() {
  const rowsEl = document.getElementById("horse-index-rows");
  const searchEl = document.getElementById("horse-index-search");
  const status = document.getElementById("horse-index-status");
  if (!rowsEl) return;

  const initial = await fetchHorseIndex("");
  if (!initial) return;
  const order = initial.rowOrder || [];
  const counts = initial.rowCounts || {};
  let activeRow = "";

  rowsEl.innerHTML = order
    .map((label) => `<button type="button" class="horse-row-btn" data-row="${escapeAttr(label)}">${escapeHtml(label)}<span class="horse-row-count">${counts[label] || 0}</span></button>`)
    .join("");

  function setActive(label) {
    activeRow = label;
    rowsEl.querySelectorAll(".horse-row-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.row === label);
    });
  }

  rowsEl.querySelectorAll(".horse-row-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (searchEl) searchEl.value = "";
      setActive(btn.dataset.row);
      if (status) status.textContent = "読み込み中…";
      const data = await fetchHorseIndex(`?row=${encodeURIComponent(btn.dataset.row)}`);
      if (!data) return;
      renderHorseIndexTable(data.horses || []);
      if (status) status.textContent = `「${btn.dataset.row}」行: ${(data.horses || []).length}件`;
    });
  });

  if (searchEl) {
    let timer;
    searchEl.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = searchEl.value.trim();
        if (!q) {
          renderHorseIndexTable([]);
          if (status) status.textContent = "50音の行を選ぶか、馬名で検索してください。";
          return;
        }
        setActive("");
        if (status) status.textContent = "検索中…";
        const data = await fetchHorseIndex(`?q=${encodeURIComponent(q)}`);
        if (!data) return;
        renderHorseIndexTable(data.horses || []);
        if (status) status.textContent = `検索「${q}」: ${(data.horses || []).length}件`;
      }, 300);
    });
  }
}

function setupHorseAliasForm() {
  const form = document.getElementById("horse-alias-form");
  const messageEl = document.getElementById("horse-alias-form-message");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const displayInput = document.getElementById("horse-alias-display");
    const canonicalInput = document.getElementById("horse-alias-canonical");
    const alias_display = displayInput.value.trim();
    const canonical_name = canonicalInput.value.trim();
    if (!alias_display || !canonical_name) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    messageEl.hidden = true;

    const res = await authedFetch("/api/admin/horse-aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias_display, canonical_name }),
    });
    const data = await res.json().catch(() => ({}));

    messageEl.hidden = false;
    if (res.ok) {
      messageEl.className = "submit-message success";
      messageEl.textContent = `「${alias_display}」→「${canonical_name}」を登録しました。反映するには下の「一括補正」も実行してください。`;
      displayInput.value = "";
      canonicalInput.value = "";
      await loadHorseAliases();
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "登録に失敗しました。";
    }
    submitBtn.disabled = false;
  });
}

function setupHorseAliasNormalizeButton() {
  const btn = document.getElementById("horse-alias-normalize-btn");
  const messageEl = document.getElementById("horse-alias-normalize-message");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!confirm("登録済みのエイリアスと一致する馬名を、既存の出走馬表・レース結果・馬メモ・購入履歴・CSV取込履歴からまとめて書き換えます。実行しますか？")) return;

    btn.disabled = true;
    messageEl.hidden = true;

    const res = await authedFetch("/api/admin/horse-aliases/normalize-existing", { method: "POST" });
    const data = await res.json().catch(() => ({}));

    messageEl.hidden = false;
    if (res.ok) {
      const u = data.updated || {};
      messageEl.className = "submit-message success";
      messageEl.textContent = `一括補正が完了しました(レース ${u.races || 0}件 / レース結果 ${u.race_results || 0}件 / 馬メモ ${u.horse_notes || 0}件 / 購入履歴 ${u.tickets || 0}件 / CSV取込 ${u.imported_ticket_items || 0}件を更新)。`;
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "一括補正に失敗しました。";
    }
    btn.disabled = false;
  });
}

async function onReady() {
  const denied = document.getElementById("admin-denied-notice");
  const content = document.getElementById("admin-content");
  if (!window.currentUser || !window.currentUser.isAdmin) {
    if (denied) denied.hidden = false;
    if (content) content.hidden = true;
    return;
  }
  if (denied) denied.hidden = true;
  if (content) content.hidden = false;
  setupJockeyAliasForm();
  setupJockeyAliasNormalizeButton();
  setupHorseAliasForm();
  setupHorseAliasNormalizeButton();
  await Promise.all([
    loadUnregisteredRaces(),
    loadUsers(),
    loadJockeyAliases(),
    loadHorseAliases(),
    setupHorseIndex(),
  ]);
}

setupAuth(onReady);