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

// ---------- APIトークン(2026-09-13追加) ----------
// docs/design/results-import.md「ユーザースクリプトによるHTML取込み」参照。

async function loadApiTokenStatus() {
  const statusEl = document.getElementById("api-token-status");
  const issueBtn = document.getElementById("api-token-issue-btn");
  const revokeBtn = document.getElementById("api-token-revoke-btn");
  if (!statusEl) return;

  const res = await authedFetch("/api/admin/api-token");
  if (!res.ok) { statusEl.textContent = "読み込みに失敗しました"; return; }
  const data = await res.json();

  statusEl.textContent = data.hasToken
    ? `発行済み(${formatDateTime(data.createdAt)})`
    : "未発行";
  if (revokeBtn) revokeBtn.hidden = !data.hasToken;
  if (issueBtn) issueBtn.textContent = data.hasToken ? "トークンを再発行する" : "トークンを発行する";
}

function setupApiTokenButtons() {
  const issueBtn = document.getElementById("api-token-issue-btn");
  const revokeBtn = document.getElementById("api-token-revoke-btn");
  const valueEl = document.getElementById("api-token-value");
  if (!issueBtn) return;

  issueBtn.addEventListener("click", async () => {
    if (!confirm("トークンを発行しますか？既存のトークンがあれば無効になり、ユーザースクリプト側の設定も更新が必要になります。")) return;
    issueBtn.disabled = true;
    const res = await authedFetch("/api/admin/api-token", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    issueBtn.disabled = false;
    if (!res.ok) {
      alert(data.error || "発行に失敗しました。");
      return;
    }
    if (valueEl) {
      valueEl.hidden = false;
      valueEl.innerHTML = `新しいトークン(この画面を離れると二度と表示されません): <code>${escapeHtml(data.token)}</code>`;
    }
    await loadApiTokenStatus();
  });

  if (revokeBtn) {
    revokeBtn.addEventListener("click", async () => {
      if (!confirm("トークンを無効化しますか？ユーザースクリプトからの送信ができなくなります。")) return;
      revokeBtn.disabled = true;
      const res = await authedFetch("/api/admin/api-token", { method: "DELETE" });
      revokeBtn.disabled = false;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "無効化に失敗しました。");
        return;
      }
      if (valueEl) { valueEl.hidden = true; valueEl.innerHTML = ""; }
      await loadApiTokenStatus();
    });
  }
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

// ---------- 重賞管理(2026-09-19追加) ----------
// 集計画面(stats.html)の「総合成績」「レース別」タブの「重賞のみ」フィルタで使う
// 重賞(G1/G2/G3)レース名マスタの一覧表示・手入力での追加/編集/削除、および
// JRA公式「N年 重賞レース一覧」ページ(PDF)からの一括インポート。
// 詳細はdocs/design/graded-races.md参照。horse_aliases管理と同じ構図。

async function loadGradedRaces() {
  const table = document.getElementById("graded-races-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/graded-races");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; return; }
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) {
    table.innerHTML = "<tr><td>登録済みの重賞はありません</td></tr>";
    return;
  }
  table.innerHTML = `
    <thead><tr><th>レース名</th><th>グレード</th><th>障害</th><th>参考情報</th><th></th></tr></thead>
    <tbody>
      ${items.map((g) => {
        const ref = [g.track, g.course_type, g.distance ? `${g.distance}m` : null, g.age_condition]
          .filter(Boolean).join(" / ");
        return `
        <tr data-id="${g.id}">
          <td>${escapeHtml(g.name)}</td>
          <td>${escapeHtml(g.grade)}</td>
          <td>${g.is_jump ? "○" : "—"}</td>
          <td>${escapeHtml(ref || "—")}</td>
          <td>
            <button type="button" class="ghost-btn graded-race-edit-btn">編集</button>
            <button type="button" class="icon-btn delete graded-race-delete-btn" title="削除">×</button>
          </td>
        </tr>`;
      }).join("")}
    </tbody>
  `;
  table.querySelectorAll(".graded-race-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.closest("tr")?.dataset.id;
      const item = items.find((g) => String(g.id) === id);
      if (item) prefillGradedRaceForm(item);
    });
  });
  table.querySelectorAll(".graded-race-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("tr")?.dataset.id;
      if (!id) return;
      if (!confirm("この重賞マスタを削除しますか？")) return;
      const res2 = await authedFetch(`/api/admin/graded-races/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res2.ok) {
        const data2 = await res2.json().catch(() => ({}));
        alert(data2.error || "削除に失敗しました。");
        return;
      }
      await loadGradedRaces();
    });
  });
}

function prefillGradedRaceForm(item) {
  document.getElementById("graded-race-id").value = item.id;
  document.getElementById("graded-race-name").value = item.name;
  document.getElementById("graded-race-grade").value = item.grade;
  document.getElementById("graded-race-jump").checked = !!item.is_jump;
  const cancelBtn = document.getElementById("graded-race-cancel-btn");
  const submitBtn = document.getElementById("graded-race-submit-btn");
  if (cancelBtn) cancelBtn.hidden = false;
  if (submitBtn) submitBtn.textContent = "更新";
  document.getElementById("graded-race-name").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetGradedRaceForm() {
  document.getElementById("graded-race-id").value = "";
  document.getElementById("graded-race-name").value = "";
  document.getElementById("graded-race-grade").value = "G1";
  document.getElementById("graded-race-jump").checked = false;
  const cancelBtn = document.getElementById("graded-race-cancel-btn");
  const submitBtn = document.getElementById("graded-race-submit-btn");
  if (cancelBtn) cancelBtn.hidden = true;
  if (submitBtn) submitBtn.textContent = "登録";
}

function setupGradedRaceForm() {
  const form = document.getElementById("graded-race-form");
  const messageEl = document.getElementById("graded-race-form-message");
  const cancelBtn = document.getElementById("graded-race-cancel-btn");
  if (!form) return;

  cancelBtn?.addEventListener("click", () => resetGradedRaceForm());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("graded-race-id").value;
    const name = document.getElementById("graded-race-name").value.trim();
    const grade = document.getElementById("graded-race-grade").value;
    const is_jump = document.getElementById("graded-race-jump").checked;
    if (!name) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    messageEl.hidden = true;

    const body = JSON.stringify({ name, grade, is_jump });
    const res = id
      ? await authedFetch(`/api/admin/graded-races/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body })
      : await authedFetch("/api/admin/graded-races", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const data = await res.json().catch(() => ({}));

    messageEl.hidden = false;
    if (res.ok) {
      messageEl.className = "submit-message success";
      messageEl.textContent = id ? `「${name}」を更新しました。` : `「${name}」(${grade})を登録しました。`;
      resetGradedRaceForm();
      await loadGradedRaces();
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "登録に失敗しました。";
    }
    submitBtn.disabled = false;
  });
}

// JRA公式「N年 重賞レース一覧」ページ(PDF)を選択すると、その場でクライアント側解析
// (public/jra-graded-races-pdf.js)して検出件数をプレビュー表示し、確認ボタンを押したら
// POST /api/admin/graded-races/import へまとめて送信する(結果PDFインポート等と同じ
// 「解析→プレビュー→確定登録」の2段階フロー)。
function setupGradedRacesImport() {
  const fileInput = document.getElementById("graded-races-pdf-file");
  const statusEl = document.getElementById("graded-races-import-status");
  const previewEl = document.getElementById("graded-races-import-preview");
  if (!fileInput) return;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    previewEl.innerHTML = "";
    statusEl.textContent = "解析中…";
    fileInput.disabled = true;

    try {
      const extracted = await jraGradedRacesExtractPdfPages(file);
      const parsed = jraGradedRacesParseExtractedPages(extracted.pages);

      if (parsed.diagnostics.errors.length) {
        statusEl.textContent = "";
        previewEl.innerHTML = `<p class="submit-message error">${parsed.diagnostics.errors.map(escapeHtml).join("<br>")}</p>`;
        return;
      }

      statusEl.textContent = `${parsed.records.length}件のレースを検出しました。内容を確認して登録してください。`;
      previewEl.innerHTML = `
        <div class="table-wrap"><table class="stats-table">
          <thead><tr><th>レース名</th><th>グレード</th><th>競馬場</th><th>コース</th></tr></thead>
          <tbody>
            ${parsed.records.map((r) => `
              <tr>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.is_jump ? "J・" : ""}${escapeHtml(r.grade)}</td>
                <td>${escapeHtml(r.track || "")}</td>
                <td>${escapeHtml(formatCourseText(r.course_type, r.distance) || "")}</td>
              </tr>`).join("")}
          </tbody>
        </table></div>
        <button type="button" class="stamp-btn" id="graded-races-import-confirm-btn">この内容で一括登録する(${parsed.records.length}件)</button>
        <p id="graded-races-import-message" class="submit-message" hidden></p>
      `;

      document.getElementById("graded-races-import-confirm-btn")?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        const msgEl = document.getElementById("graded-races-import-message");
        btn.disabled = true;
        const res = await authedFetch("/api/admin/graded-races/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ races: parsed.records }),
        });
        const data = await res.json().catch(() => ({}));
        msgEl.hidden = false;
        if (res.ok) {
          const created = (data.results || []).filter((r) => r.status === "created").length;
          const updated = (data.results || []).filter((r) => r.status === "updated").length;
          const invalid = (data.results || []).filter((r) => r.status === "invalid").length;
          msgEl.className = "submit-message success";
          msgEl.textContent = `登録が完了しました(新規${created}件・更新${updated}件${invalid ? `・スキップ${invalid}件` : ""})。`;
          await loadGradedRaces();
        } else {
          msgEl.className = "submit-message error";
          msgEl.textContent = data.error || "登録に失敗しました。";
          btn.disabled = false;
        }
      });
    } catch (e) {
      statusEl.textContent = "";
      previewEl.innerHTML = `<p class="submit-message error">解析に失敗しました: ${escapeHtml(e && e.message ? e.message : String(e))}</p>`;
    } finally {
      fileInput.disabled = false;
      fileInput.value = "";
    }
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
  setupApiTokenButtons();
  setupGradedRaceForm();
  setupGradedRacesImport();
  await Promise.all([
    loadUnregisteredRaces(),
    loadUsers(),
    loadJockeyAliases(),
    loadHorseAliases(),
    setupHorseIndex(),
    loadApiTokenStatus(),
    loadGradedRaces(),
  ]);
}

setupAuth(onReady);