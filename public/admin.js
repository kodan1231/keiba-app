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

// netkeiba取込ブックマークレット(2026-10-08。docs/design/netkeiba-bookmarklet.md)。
// 開いている netkeiba のページの HTML を、馬券帳のレース管理画面(?nk=1)へ postMessage で渡す。
// 受け取り側(races-netkeiba-import.js)が準備できたら "nk-ready" を送ってくるので、それを待ってから送る。
// 自動で渡せなかったときのため、同じ内容をクリップボードにもコピーする。
// 2026-10-10: JRA公式(PC版 www.jra.go.jp/JRADB/…)の出走馬一覧・結果ページも対象にした(URL は共通のため、
// どのページかは受け取り側が中身で判定する)。対象を変えたので、登録済みのブックマークは登録し直す必要がある。
// 2026-10-13: netkeiba の過去レースのデータベース(db.netkeiba.com/race/<レースID 12桁>/)も対象にした(登録し直しが必要)。
function setupNetkeibaBookmarklet() {
  const link = document.getElementById("netkeiba-bookmarklet-link");
  if (!link) return;
  const origin = window.location.origin;
  const code = `(()=>{const o=${JSON.stringify(origin)};` +
    `const ok=(["race.netkeiba.com","nar.netkeiba.com"].includes(location.hostname)&&["/race/shutuba_past.html","/race/result.html"].includes(location.pathname))||(location.hostname==="db.netkeiba.com"&&/^\\/race\\/\\d{12}\\/?$/.test(location.pathname))||(location.hostname==="www.jra.go.jp"&&location.pathname.startsWith("/JRADB/"));` +
    `if(!ok){alert("netkeibaの馬柱(5走)・結果・過去レース(db.netkeiba.com)のページ、またはJRAの出走馬一覧・レース結果のページで押してください");return;}` +
    `const d={type:"nk-page",url:location.href,html:document.documentElement.outerHTML};` +
    `try{navigator.clipboard.writeText(JSON.stringify(d)).catch(()=>{});}catch(e){}` +
    `const w=window.open(o+"/races.html?nk=1","_blank");` +
    `const h=e=>{if(e.origin===o&&e.data==="nk-ready"&&w){w.postMessage(d,o);removeEventListener("message",h);}};` +
    `addEventListener("message",h);})()`;
  link.href = "javascript:" + encodeURIComponent(code);
  link.addEventListener("click", (e) => {
    e.preventDefault();
    alert("このリンクはブックマークバーへドラッグして登録してください(ここで押しても動きません)。");
  });
}

// ---------- D1の使用量(2026-10-08) ----------
// GET /api/admin/d1-usage(Cloudflare の分析API。D1 の読み取りには数えられない)。管理画面だけに出す
// (一般の利用者に不安を与えないため)。一括補正などの重い操作の前にも確認を出す(confirmHeavyOperation)。
const D1_WARN_RATIO = 0.5;
const D1_DANGER_RATIO = 0.8;

async function fetchD1Usage(fresh) {
  try {
    const res = await authedFetch(`/api/admin/d1-usage${fresh ? "?fresh=1" : ""}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function d1UsageLevel(ratio) {
  return ratio >= D1_DANGER_RATIO ? "danger" : ratio >= D1_WARN_RATIO ? "warn" : "ok";
}

function renderD1Usage(u) {
  const el = document.getElementById("d1-usage");
  if (!el) return;
  if (!u) { el.innerHTML = `<p class="submit-message error">使用量を取得できませんでした。</p>`; return; }
  if (!u.configured) {
    el.innerHTML = `<p class="ticket-sub">未設定です。Cloudflare で API トークン(権限「Account Analytics: Read」と「D1: Read」)を作り、Pages の秘密情報 <code>CF_ANALYTICS_TOKEN</code> に登録してください(手順は docs/design/ops.md「D1の使用量の確認」)。</p>`;
    return;
  }
  if (!u.ok) { el.innerHTML = `<p class="submit-message error">${escapeHtml(u.error || "取得に失敗しました")}</p>`; return; }
  const meter = (label, used, limit) => {
    const ratio = limit ? used / limit : 0;
    const pct = Math.min(100, ratio * 100);
    return `<div class="d1-meter d1-${d1UsageLevel(ratio)}">
      <div class="d1-meter-head"><span>${label}</span><b>${pct.toFixed(1)}%</b><span class="ticket-sub">${used.toLocaleString()} / ${limit.toLocaleString()}行</span></div>
      <div class="d1-meter-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
    </div>`;
  };
  const rows = (u.databases || []).map((d) => `<tr>
      <td>${escapeHtml(d.name)}${d.isThisApp ? "(このアプリ)" : ""}</td>
      <td class="num">${d.rowsRead.toLocaleString()}</td><td class="num">${d.rowsWritten.toLocaleString()}</td></tr>`).join("");
  el.innerHTML = `
    ${meter("読み取り", u.total.rowsRead, u.limits.rowsRead)}
    ${meter("書き込み", u.total.rowsWritten, u.limits.rowsWritten)}
    <p class="ticket-sub">リセット: ${escapeHtml(formatDateTime(u.resetAt))}(日本時間) / 取得: ${escapeHtml(formatDateTime(u.fetchedAt))}</p>
    ${rows ? `<div class="table-wrap"><table class="stats-table"><thead><tr><th>データベース</th><th>読み取り</th><th>書き込み</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    ${d1TopQueriesHtml(u.topQueries)}`;
}

// 今日の重い問い合わせ(このアプリのDB。読み取り行数の多い順に10件)。1回あたりの行数が大きいものは要注意。
function d1TopQueriesHtml(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const rows = list.map((q) => `<tr>
      <td class="num">${q.rowsRead.toLocaleString()}</td>
      <td class="num">${q.count.toLocaleString()}</td>
      <td class="num">${Math.round(q.rowsRead / Math.max(1, q.count)).toLocaleString()}</td>
      <td class="d1-query-text">${escapeHtml(q.query)}</td></tr>`).join("");
  return `<details class="d1-top-queries"><summary>重い問い合わせ(今日・読み取り行数の多い順に10件)</summary>
    <div class="table-wrap"><table class="stats-table"><thead><tr><th>読み取り</th><th>回数</th><th>1回あたり</th><th>問い合わせ</th></tr></thead><tbody>${rows}</tbody></table></div>
  </details>`;
}

async function loadD1Usage(fresh) {
  renderD1Usage(await fetchD1Usage(fresh));
}

function setupD1UsageButton() {
  document.getElementById("d1-usage-refresh-btn")?.addEventListener("click", () => loadD1Usage(true));
}

// 一括補正など、D1 の読み取り・書き込みを大きく消費する操作の前の確認。今日の使用量を添え、
// 半分を超えていれば明日(日本時間9時以降)に回すよう促す。使用量が取れなくても確認だけは出す。
async function confirmHeavyOperation(message) {
  const u = await fetchD1Usage(true);
  let usageText = "";
  if (u && u.configured && u.ok) {
    renderD1Usage(u);
    const r = u.total.rowsRead / u.limits.rowsRead;
    const w = u.total.rowsWritten / u.limits.rowsWritten;
    usageText = `\n\n今日のD1使用量: 読み取り ${(r * 100).toFixed(1)}% / 書き込み ${(w * 100).toFixed(1)}%`;
    if (Math.max(r, w) >= D1_WARN_RATIO) {
      usageText += "\n※ 既に半分を超えています。上限を超えると翌朝9時まで全画面が止まるため、日本時間9時以降に回すことをおすすめします。";
    }
  }
  return confirm(message + usageText);
}

// ---------- 重い機能の自動一時停止(2026-10-08) ----------
// API: GET/PUT /api/admin/service-guard(functions/api/admin/service-guard.js)。仕様は docs/design/ops.md「重い機能の自動一時停止」。
function renderServiceGuard(d) {
  const statusEl = document.getElementById("guard-status");
  if (!statusEl) return;
  if (!d || !d.settings) { statusEl.textContent = "設定を読み込めませんでした。"; return; }
  const s = d.settings;
  const pct = d.state.ratio === null || d.state.ratio === undefined ? null : (d.state.ratio * 100).toFixed(1);
  const overriding = s.overrideUntil && Date.parse(s.overrideUntil) > Date.now();
  let text;
  if (d.state.active && d.state.reason === "manual") text = "現在: 手動で一時停止中です。";
  else if (d.state.active) text = `現在: 一時停止中です(使用量 ${pct}% がしきい値 ${s.thresholdPercent}% 以上)。`;
  else if (overriding) text = `現在: 解除中です(${formatDateTime(s.overrideUntil)}まで自動では止めません)。`;
  else if (!s.enabled) text = "現在: 自動一時停止は使っていません。";
  else text = `現在: 動作中です${pct !== null ? `(使用量 ${pct}%)` : ""}。`;
  if (!d.tokenConfigured) text += " ※ CF_ANALYTICS_TOKEN が未設定のため、使用量による自動停止は働きません(手動停止は使えます)。";
  statusEl.textContent = text;
  document.getElementById("guard-enabled").checked = s.enabled;
  document.getElementById("guard-threshold").value = s.thresholdPercent;
  document.getElementById("guard-manual").checked = s.manualPause;
  document.getElementById("guard-targets").innerHTML = d.features.map((f) => `
    <label style="display:block"><input type="checkbox" name="guard-target" value="${escapeAttr(f.key)}" ${s.targets.includes(f.key) ? "checked" : ""}/> ${escapeHtml(f.label)}</label>`).join("");
  document.getElementById("guard-clear-override-btn").hidden = !overriding;
}

async function loadServiceGuard() {
  try {
    const res = await authedFetch("/api/admin/service-guard");
    renderServiceGuard(res.ok ? await res.json() : null);
  } catch { renderServiceGuard(null); }
}

async function putServiceGuard(body, okText) {
  const msg = document.getElementById("guard-message");
  const res = await authedFetch("/api/admin/service-guard", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  msg.hidden = false;
  if (res.ok) {
    msg.className = "submit-message success";
    msg.textContent = okText;
    renderServiceGuard(data);
  } else {
    msg.className = "submit-message error";
    msg.textContent = data.error || "保存に失敗しました。";
  }
}

function setupServiceGuardForm() {
  const form = document.getElementById("guard-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    putServiceGuard({
      enabled: document.getElementById("guard-enabled").checked,
      thresholdPercent: Number(document.getElementById("guard-threshold").value),
      targets: [...form.querySelectorAll('input[name="guard-target"]:checked')].map((i) => i.value),
      manualPause: document.getElementById("guard-manual").checked,
    }, "保存しました(反映まで最大1分かかります)。");
  });
  document.getElementById("guard-override-btn").addEventListener("click", () => {
    if (!confirm("今日のリセット(日本時間9時)まで、使用量による自動一時停止をしません。使用量が上限を超えると全画面が止まるおそれがあります。解除しますか?")) return;
    putServiceGuard({ action: "override" }, "解除しました(反映まで最大1分かかります)。");
  });
  document.getElementById("guard-clear-override-btn").addEventListener("click", () => {
    putServiceGuard({ action: "clear_override" }, "解除をやめました(自動一時停止が有効です)。");
  });
}

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

// ---------- 登録済み一覧の開閉(2026-10-02追加) ----------
// 騎手名エイリアス・馬名エイリアス・重賞の登録済み一覧は件数が増えてきたため、
// <details class="admin-collapsible">(初期状態は閉じる。開閉状態は保存しない)で囲み、
// 見出しに件数を出す。一覧の再読み込み(追加・削除後)は<table>の中身だけを書き換えるため、
// 開閉状態はそのまま保たれる。null は読み込み失敗(件数を出さない)。
function setCollapsibleCount(tableId, count) {
  const el = document.querySelector(`.admin-collapsible-count[data-count-for="${tableId}"]`);
  if (el) el.textContent = count === null ? "" : `(${count}件)`;
}

// ---------- 騎手名エイリアス管理(2026-08-16追加) ----------

async function loadJockeyAliases() {
  const table = document.getElementById("jockey-aliases-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/jockey-aliases");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; setCollapsibleCount("jockey-aliases-table", null); return; }
  const data = await res.json();
  const items = data.items || [];
  setCollapsibleCount("jockey-aliases-table", items.length);
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
    if (!(await confirmHeavyOperation("登録済みのエイリアスと一致する騎手名を、既存の出走馬表・レース結果・購入履歴・CSV取込履歴からまとめて書き換えます。実行しますか？"))) return;

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
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; setCollapsibleCount("horse-aliases-table", null); return; }
  const data = await res.json();
  const items = data.items || [];
  setCollapsibleCount("horse-aliases-table", items.length);
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
    if (!(await confirmHeavyOperation("登録済みのエイリアスと一致する馬名を、既存の出走馬表・レース結果・馬メモ・購入履歴・CSV取込履歴からまとめて書き換えます。実行しますか？"))) return;

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
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; setCollapsibleCount("graded-races-table", null); return; }
  const data = await res.json();
  const items = data.items || [];
  setCollapsibleCount("graded-races-table", items.length);
  if (!items.length) {
    table.innerHTML = "<tr><td>登録済みの重賞はありません</td></tr>";
    return;
  }
  table.innerHTML = `
    <thead><tr><th>レース名</th><th>グレード</th><th>障害</th><th>開催月日</th><th>参考情報</th><th></th></tr></thead>
    <tbody>
      ${items.map((g) => {
        const ref = [g.track, g.course_type, g.distance ? `${g.distance}m` : null, g.age_condition]
          .filter(Boolean).join(" / ");
        return `
        <tr data-id="${g.id}">
          <td>${escapeHtml(g.name)}</td>
          <td>${escapeHtml(g.grade)}</td>
          <td>${g.is_jump ? "○" : "—"}</td>
          <td>${escapeHtml(g.schedule_md || "—")}</td>
          <td>${escapeHtml(ref || "—")}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="ghost-btn graded-race-edit-btn">編集</button>
              <button type="button" class="icon-btn delete graded-race-delete-btn" title="削除">×</button>
            </div>
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

// 編集中の行。手入力フォームに無い参考情報(競馬場・コース・距離・年齢条件)を
// PUT時にそのまま送り返して保持するために使う(PUTは全項目を上書きするため、
// 送らないとPDFインポートで入った参考情報が消える。2026-10-02に開催月日の項目を
// 追加した際にあわせて修正)。
let editingGradedRace = null;

function prefillGradedRaceForm(item) {
  editingGradedRace = item;
  document.getElementById("graded-race-id").value = item.id;
  document.getElementById("graded-race-schedule").value = item.schedule_md || "";
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
  editingGradedRace = null;
  document.getElementById("graded-race-id").value = "";
  document.getElementById("graded-race-schedule").value = "";
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
    const schedule_md = document.getElementById("graded-race-schedule").value.trim();
    if (!name) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    messageEl.hidden = true;

    const ref = id && editingGradedRace ? {
      track: editingGradedRace.track,
      course_type: editingGradedRace.course_type,
      distance: editingGradedRace.distance,
      age_condition: editingGradedRace.age_condition,
    } : {};
    const body = JSON.stringify({ name, grade, is_jump, schedule_md, ...ref });
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

      // 実機未検証のパーサーのため、成否にかかわらず抽出結果を確認できる診断パネルを
      // 常に出す(jra-result-pdf.js等の他インポート機能と同じ考え方)。
      const diagHtml = `
        <details style="margin-top:10px">
          <summary>解析診断情報(重賞一覧PDFパーサー ${escapeHtml(JRA_GRADED_RACES_PARSER_VERSION)})</summary>
          <div class="picker-hint">
            ページ数: ${parsed.diagnostics.pages}<br>
            抽出行数: ${parsed.diagnostics.rows}<br>
            検出したレース行数: ${parsed.diagnostics.raceRows}
          </div>
          <details style="margin-top:6px"><summary>抽出した生テキスト</summary>
            <pre style="white-space:pre-wrap;font-size:11px;max-height:400px;overflow:auto">${escapeHtml(parsed.diagnostics.rawText)}</pre>
          </details>
        </details>
      `;

      if (parsed.diagnostics.errors.length) {
        statusEl.textContent = "";
        previewEl.innerHTML = `<p class="submit-message error">${parsed.diagnostics.errors.map(escapeHtml).join("<br>")}</p>${diagHtml}`;
        return;
      }

      statusEl.textContent = `${parsed.records.length}件のレースを検出しました。内容を確認して登録してください。`;
      previewEl.innerHTML = `
        <div class="table-wrap"><table class="stats-table">
          <thead><tr><th>開催</th><th>レース名</th><th>グレード</th><th>競馬場</th><th>コース</th></tr></thead>
          <tbody>
            ${parsed.records.map((r) => `
              <tr>
                <td>${escapeHtml(r.schedule_md || "")}</td>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.is_jump ? "J・" : ""}${escapeHtml(r.grade)}</td>
                <td>${escapeHtml(r.track || "")}</td>
                <td>${escapeHtml(formatCourseText(r.course_type, r.distance) || "")}</td>
              </tr>`).join("")}
          </tbody>
        </table></div>
        <button type="button" class="stamp-btn" id="graded-races-import-confirm-btn">この内容で一括登録する(${parsed.records.length}件)</button>
        <p id="graded-races-import-message" class="submit-message" hidden></p>
        ${diagHtml}
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

// ---------- 総合推奨馬の比率(2026-10-13追加) ----------
// 予想登録画面「展開・時計」タブの総合推奨馬で使う、展開・馬番・騎手の比率(%)。全ユーザー共通。
// API: GET/PUT/DELETE /api/admin/pace-weights、POST /api/admin/pace-weights/auto。仕様は docs/design/screens.md「総合推奨馬」。
// 2026-10-14: 性齢・馬体重・同コースを追加
const PACE_W_KEYS = [["w_pace", "展開"], ["w_number", "馬番"], ["w_jockey", "騎手"], ["w_time", "補正タイム"],
  ["w_sexage", "性齢"], ["w_weight", "馬体重"], ["w_course", "同コース"], ["w_week", "週目"]]; // 週目は2026-10-15追加
// ペース予想ごとの比率(2026-10-14追加)。"" は全ペース共通
const PACE_W_TYPES = [["high", "ハイ"], ["middle", "ミドル"], ["slow", "スロー"]];

// 評価点(2026-10-14追加。docs/design/screens.md「評価点(初距離・初競馬場・継続騎乗)」): [キー, 名前, 符号]
// 前年掲示板・前年1着(2026-10-14追加)は重賞で前年の同じ重賞を2〜5着・1着の馬の「同コース」の点に足す
const PACE_ADJ_KEYS = [["first_distance", "初距離", "−"], ["first_track", "初競馬場", "−"], ["same_jockey", "継続騎乗", "+"],
  ["prev_board", "前年掲示板", "+"], ["prev_win", "前年1着", "+"], ["layoff", "間隔", "−"]];
// 間隔(2026-10-15追加)は前走から6か月以上空いた馬の総合点から引く。全レース共通なので「評価点の既定値」だけに出す
const PACE_ADJ_GLOBAL = ["layoff"];
const PACE_ADJ_ROW_KEYS = PACE_ADJ_KEYS.filter(([k]) => !PACE_ADJ_GLOBAL.includes(k));
// 評価点の入力欄は開閉できる(2026-10-15 ユーザー要望)。開いている欄のキー(保存後の読み直しでも開いたままにする)
const paceAdjOpen = new Set();
let paceAdjustDefault = { first_distance: 10, first_track: 5, same_jockey: 5, prev_board: 5, prev_win: 10, layoff: 5 }; // 設定の既定値(loadPaceWeights で入れ直す)

function paceAdjustText(a) {
  return PACE_ADJ_KEYS.filter(([k]) => a[k] != null).map(([k, label, sign]) => `${label}${sign}${a[k]}`).join("・");
}

// 評価点の入力1行。a: その重賞・コースの評価点(無ければ null)。空欄は薄く出す既定値を使う。openKey: 開閉の状態を覚えるキー
// 閉じているときは見出しに今の値(無ければ「既定値」)を出す(2026-10-15)
function paceAdjustLineHtml(a, openKey) {
  const src = a ? (a.source === "auto" ? "自動" : "手動") : "";
  const rowText = (x) => PACE_ADJ_ROW_KEYS.filter(([k]) => x[k] != null).map(([k, label, sign]) => `${label}${sign}${x[k]}`).join("・");
  return `<details class="pace-w-kind pace-adj-line pace-adj-fold" data-open-key="${escapeAttr(openKey)}" ${paceAdjOpen.has(openKey) ? "open" : ""}>
    <summary><span class="pace-w-admin-title">評価点(展開・タイム・騎手・同コースの点に足し引き)</span>
      <small class="pace-w-line-source">${a ? `${escapeHtml(rowText(a))}(${src})` : "既定値"}</small></summary>
    <div class="pace-w-line">
      ${PACE_ADJ_ROW_KEYS.map(([k, label, sign]) => `<label class="pace-w-input">${label}${sign}<input type="number" min="0" max="50" step="1" data-akey="${k}" value="${a?.[k] ?? ""}" placeholder="${paceAdjustDefault[k]}">点</label>`).join("")}
      <small class="pace-w-line-source">${src}</small>
      <button type="button" class="ghost-btn pace-adj-save">保存</button>
      ${a ? `<button type="button" class="icon-btn delete pace-adj-clear" title="この評価点を消す(既定値を使う。次の計算で自動の値が入る)">×</button>` : ""}
    </div></details>`;
}

// 評価点の成績の表示(並びの一致〈2026-10-14〜〉があればそれ、古い結果は軸の3着以内の数)
function paceAdjustStatText(best, base) {
  const p = (v) => `${(v * 100).toFixed(1)}%`;
  if (best?.agree != null && base?.agree != null) return `並びの一致 ${p(best.agree)}(既定値なら ${p(base.agree)})`;
  return `軸3着以内${best?.show}回(既定値なら${base?.show}回)`;
}

// 最後に「評価点の既定値」を自動で計算した結果(設定の adjust_auto)の1行
function paceAdjustAutoText(a) {
  if (!a) return "まだ自動で計算していません";
  return `最後の自動計算: ${formatDateTime(a.computed_at)} ${a.races}レース → ${paceAdjustText(a.values)}。${paceAdjustStatText(a.best, a.base)}`;
}

function paceAdjustReadInputs(container) {
  const out = {};
  for (const input of container.querySelectorAll("input[data-akey]")) out[input.dataset.akey] = Number(input.value === "" ? input.placeholder : input.value);
  return out;
}

function paceWeightsMsg(text, ok) {
  const el = document.getElementById("pace-weights-message");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `submit-message ${ok ? "success" : "error"}`;
}

function paceWeightsInputsHtml(w, placeholder) {
  return PACE_W_KEYS.map(([k, label]) =>
    `<label class="pace-w-input">${label}<input type="number" min="0" max="100" step="1" data-wkey="${k}" value="${w ? w[k] : ""}" placeholder="${placeholder ? placeholder[k] : ""}">%</label>`
  ).join("");
}

function paceWeightsReadInputs(container) {
  const out = {};
  // 空欄は薄く表示している標準の比率(placeholder)を使う
  for (const input of container.querySelectorAll("input[data-wkey]")) out[input.dataset.wkey] = Number(input.value === "" ? input.placeholder : input.value);
  return out;
}

function paceAutoSummaryText(detail) {
  if (!detail) return "";
  const s = detail.summary;
  if (detail.method === "backtest" && detail.best) {
    // 軸指数・相手指数(2026-10-14): 軸が3着以内・1着の年数 / 軸+相手に1着馬が入った年数
    const ta = (b) => `軸3着以内${b.show}・1着${b.win}`;
    const tp = (b) => (b ? `相手に1着馬${b.win}` : "");
    const pt = detail.partner || {};
    const paces = PACE_W_TYPES.filter(([p]) => detail.by_pace?.[p])
      .map(([p, label]) => `${label}${detail.by_pace[p].races}レース: ${ta(detail.by_pace[p].best)}・${tp(pt.by_pace?.[p]?.best)}`).join(" / ");
    // 評価点(2026-10-14): 選んだ値と、既定の評価点のときとの軸の成績の比較
    const adj = detail.adjust ? `。評価点 ${paceAdjustText(detail.adjust)}(${paceAdjustStatText(detail.adjust.best, detail.adjust.base)})` : "";
    return `${detail.races}レース分 ${ta(detail.best)}・${tp(pt.best)}回(均等なら ${ta(detail.equal)}・${tp(pt.equal)})${paces ? `。${paces}` : ""}${adj}`;
  }
  if (!s) return "";
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  return `${detail.races}年分 ` + PACE_W_KEYS.map(([k, label]) => {
    const f = k.replace("w_", "");
    return `${label}${pct(s[f]?.hit_rate)}(偶然${pct(s[f]?.chance_rate)})`;
  }).join(" ");
}

// 全ペース共通+ハイ・ミドル・スローの4段の入力(2026-10-14)。w: その重賞(または標準)の比率の行(無ければ null)、
// fallback: 未設定のときに薄く出す比率(重賞は標準、標準は既定値)。kind: "axis"(軸指数)/ "partner"(相手指数。w.partner を使う)
function paceWeightsLinesHtml(w, fallback, kind = "axis") {
  // 相手指数(2026-10-14): w.partner = { common, by_pace }。未設定なら軸指数の比率を薄く出す(使われるのは軸指数のため)
  const kindRow = kind === "partner"
    ? (w?.partner ? { ...(w.partner.common || {}), source: w.partner.common ? w.partner.common.source || "manual" : "none", by_pace: w.partner.by_pace || {} } : null)
    : w;
  const hasCommon = kindRow && kindRow.source !== "none";
  const sourceText = (s) => (s === "auto" ? "自動" : s === "manual" ? "手動" : "");
  const line = (pace, label, val, placeholder, source, clearable) => `
    <div class="pace-w-line" data-pace="${pace}">
      <span class="pace-w-line-label">${label}</span>
      ${paceWeightsInputsHtml(val, placeholder)}
      <small class="pace-w-line-source">${sourceText(source)}</small>
      <button type="button" class="ghost-btn pace-w-line-save">保存</button>
      ${clearable ? `<button type="button" class="icon-btn delete pace-w-line-clear" title="この比率を消す">×</button>` : ""}
    </div>`;
  const common = hasCommon ? kindRow : null;
  const commonFallback = kind === "partner" && w && w.source !== "none" ? w : fallback;
  return `<div class="pace-w-kind" data-kind="${kind}"><span class="pace-w-admin-title">${kind === "partner" ? "相手指数" : "軸指数"}</span>`
    + line("", "共通", common, commonFallback, common?.source, kind === "partner" && Boolean(common))
    + PACE_W_TYPES.map(([p, label]) => {
      const e = kindRow?.by_pace?.[p] || null;
      return line(p, label, e, common || commonFallback, e?.source, Boolean(e));
    }).join("")
    + `</div>`;
}

// 4段の入力の「保存」「×」(container の中の [data-id] が重賞のID。標準は0)
function setupPaceWeightsLines(container) {
  const kindOf = (btn) => btn.closest("[data-kind]")?.dataset.kind || "axis"; // 軸指数 / 相手指数(2026-10-14)
  // 保存先: コースの一覧は data-course-key、重賞・標準は data-id(2026-10-14)
  const targetOf = (btn) => {
    const ck = btn.closest("[data-course-key]")?.dataset.courseKey;
    return ck ? { course_key: ck } : { graded_race_id: Number(btn.closest("[data-id]").dataset.id) };
  };
  const targetQuery = (t) => (t.course_key ? `course_key=${encodeURIComponent(t.course_key)}` : `graded_race_id=${encodeURIComponent(t.graded_race_id)}`);
  container.querySelectorAll(".pace-w-line-save").forEach((btn) => btn.addEventListener("click", () => {
    const line = btn.closest(".pace-w-line");
    paceWeightsRequest("/api/admin/pace-weights", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...targetOf(btn), pace_type: line.dataset.pace, kind: kindOf(btn), ...paceWeightsReadInputs(line) }),
    }, "保存しました");
  }));
  // 評価点の欄の開閉を覚える(2026-10-15)
  container.querySelectorAll("details.pace-adj-fold").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) paceAdjOpen.add(d.dataset.openKey);
    else paceAdjOpen.delete(d.dataset.openKey);
  }));
  // 評価点(2026-10-14)
  container.querySelectorAll(".pace-adj-save").forEach((btn) => btn.addEventListener("click", () => {
    paceWeightsRequest("/api/admin/pace-weights", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...targetOf(btn), kind: "adjust", ...paceAdjustReadInputs(btn.closest(".pace-adj-line")) }),
    }, "評価点を保存しました");
  }));
  container.querySelectorAll(".pace-adj-clear").forEach((btn) => btn.addEventListener("click", () => {
    paceWeightsRequest(`/api/admin/pace-weights?${targetQuery(targetOf(btn))}&kind=adjust`, { method: "DELETE" }, "評価点を消しました");
  }));
  container.querySelectorAll(".pace-w-line-clear").forEach((btn) => btn.addEventListener("click", () => {
    const line = btn.closest(".pace-w-line");
    paceWeightsRequest(`/api/admin/pace-weights?${targetQuery(targetOf(btn))}&pace_type=${encodeURIComponent(line.dataset.pace)}&kind=${kindOf(btn)}`,
      { method: "DELETE" }, "消しました");
  }));
}

async function paceWeightsRequest(url, init, okText) {
  const res = await authedFetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    paceWeightsMsg(data.error || "保存に失敗しました", false);
    return null;
  }
  paceWeightsMsg(okText, true);
  await loadPaceWeights();
  return data;
}

async function loadPaceWeights() {
  const list = document.getElementById("pace-weights-list");
  const defBox = document.getElementById("pace-weights-default");
  if (!list || !defBox) return;
  const res = await authedFetch("/api/admin/pace-weights");
  if (!res.ok) { list.innerHTML = `<p class="ticket-sub">読み込みに失敗しました</p>`; return; }
  const data = await res.json();
  const std = data.default && data.default.source !== "none" ? data.default : data.builtin;
  defBox.dataset.id = "0";
  // データの無い馬の点(偏差値。2026-10-14追加。API: PUT /api/admin/pace-weights/settings)
  const missing = data.score_settings?.missing_score ?? 40;
  // 補正タイムの斤量の補正(1kgあたりの秒数。2026-10-15追加)
  const secPerKg = data.score_settings?.weight_sec_per_kg ?? 0.1;
  // 評価点の既定値(2026-10-14追加): 重賞・コースの評価点(自動・手動)が無いときに使う
  paceAdjustDefault = { ...paceAdjustDefault, ...(data.score_settings?.adjust || {}) };
  defBox.innerHTML = `
    <div class="pace-w-line">
      <span class="pace-w-admin-title">データ無しの点(偏差値)</span>
      <label class="pace-w-input"><input type="number" min="0" max="100" step="1" id="pace-missing-score" value="${missing}">点</label>
      <button type="button" class="ghost-btn" id="pace-missing-score-save">保存</button>
    </div>
    <div class="pace-w-line">
      <span class="pace-w-admin-title" title="補正タイムに、今回とその走の斤量の差 × この秒数を足します(重くなれば遅く)。総合推奨馬と補正タイム順位の両方">斤量の補正(1kgあたり)</span>
      <label class="pace-w-input"><input type="number" min="0" max="1" step="0.01" id="pace-sec-per-kg" value="${secPerKg}">秒</label>
      <button type="button" class="ghost-btn" id="pace-sec-per-kg-save">保存</button>
    </div>
    <details class="pace-adj-fold" data-open-key="default" ${paceAdjOpen.has("default") ? "open" : ""}>
    <summary><span class="pace-w-admin-title">評価点の既定値</span> <small class="pace-w-line-source">${escapeHtml(paceAdjustText(paceAdjustDefault))}</small></summary>
    <div class="pace-w-line" id="pace-adjust-default">
      ${PACE_ADJ_KEYS.map(([k, label, sign]) => `<label class="pace-w-input">${label}${sign}<input type="number" min="0" max="50" step="1" data-akey="${k}" value="${paceAdjustDefault[k]}">点</label>`).join("")}
      <button type="button" class="ghost-btn" id="pace-adjust-default-save">保存</button>
      <button type="button" class="ghost-btn" id="pace-adjust-default-auto" title="全コースの直近1年(最大600レース)から評価点を選び、そのまま保存します">自動で計算</button>
    </div>
    <p class="ticket-sub" id="pace-adjust-auto-info">${escapeHtml(paceAdjustAutoText(data.score_settings?.adjust_auto))}</p>
    <p class="ticket-sub">間隔は全レース共通(前走から6か月以上空いた馬の軸指数・相手指数から引く)。重賞・コースごとの評価点には出ません</p>
    </details>
    <span class="pace-w-admin-title">標準の比率${data.default ? "" : "(未設定のため既定値)"}</span>
    ${paceWeightsLinesHtml(data.default, data.builtin)}
    ${paceWeightsLinesHtml(data.default, data.builtin, "partner")}`;
  document.getElementById("pace-missing-score-save").addEventListener("click", () => {
    paceWeightsRequest("/api/admin/pace-weights/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missing_score: Number(document.getElementById("pace-missing-score").value) }),
    }, "データ無しの点を保存しました(保存済みの比率は、次の計算からこの点で採点します)");
  });
  document.getElementById("pace-sec-per-kg-save").addEventListener("click", () => {
    paceWeightsRequest("/api/admin/pace-weights/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weight_sec_per_kg: Number(document.getElementById("pace-sec-per-kg").value) }),
    }, "斤量の補正を保存しました(推奨馬・補正タイム順位に2分以内に反映。保存済みの比率は次の計算からこの値で採点します)");
  });
  document.getElementById("pace-adjust-default-auto").addEventListener("click", (e) => paceAdjustDefaultAuto(e.currentTarget));
  document.getElementById("pace-adjust-default-save").addEventListener("click", () => {
    paceWeightsRequest("/api/admin/pace-weights/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adjust: paceAdjustReadInputs(document.getElementById("pace-adjust-default")) }),
    }, "評価点の既定値を保存しました(評価点の無い重賞・コースの推奨馬に2分以内に反映されます)");
  });
  setupPaceWeightsLines(defBox);

  paceWeightsList = { items: data.items || [], std };
  renderPaceWeightsList();
  courseWeightsList = { courses: data.courses || [], std };
  renderCourseWeightsList();
  loadPaceQueue();
}

// 評価点の既定値を自動で出す(2026-10-14。docs/design/screens.md「評価点の既定値の自動計算」): 全コースの直近1年から最大600レースを
// 採点し(GET /api/admin/pace-backtest?kind=all)、比率と同じ計算(public/pace-search.js)で評価点を選ぶ。選んだ値をそのまま既定値として保存し、
// 計算の結果(日時・レース数・成績)も設定の adjust_auto に保存して入力欄の下に出す(2026-10-14 ユーザー要望。以前は入力欄に入れるだけで、
// 保存し忘れや一覧の読み直しで消えていた)。前年の同レース(重賞だけの項目)はこの計算では選べないので、今の値のまま。
// D1: 1回の計算全体で約16万行を読む(1日の上限の約3%)。
// 「自動で計算」ボタンのすぐ下の行(#pace-adjust-auto-info)に進み具合・結果・エラーを出す(2026-10-14 ユーザー要望。
// 以前は「総合推奨馬の比率」の欄の下のメッセージに出していて気づけなかった)。ok: true=成功 / false=失敗 / null=途中
function paceAdjustAutoMsg(text, ok) {
  const el = document.getElementById("pace-adjust-auto-info");
  if (!el) return;
  el.textContent = text;
  el.className = ok === true ? "submit-message success" : ok === false ? "submit-message error" : "ticket-sub";
  el.hidden = false;
}

async function paceAdjustDefaultAuto(btn) {
  if (!(await confirmHeavyOperation("全コースの直近1年(最大600レース)を採点して、評価点の既定値を計算し、そのまま保存します(約12万行を読みます。1〜2分かかります)。実行しますか？"))) return;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const { collectAndChoose } = await import("./pace-search.js");
    const { result } = await collectAndChoose((offset) => paceFetchBacktestChunk("all", "all", offset), (done, total) => {
      btn.textContent = `採点中…(${done}/${total})`;
      paceAdjustAutoMsg(`採点中です(${done}/${total}レース)。画面を閉じずにお待ちください`, null);
    });
    if (result.error || !result.adjust) {
      paceAdjustAutoMsg(`計算できませんでした: ${result.error || "評価点を選べませんでした"}`, false);
      return;
    }
    paceAdjustAutoMsg("計算できました。保存しています…", null);
    const d = result.detail.adjust;
    const pick = { first_distance: result.adjust.first_distance, first_track: result.adjust.first_track, same_jockey: result.adjust.same_jockey, layoff: result.adjust.layoff };
    // 前年の同レースは今の既定値のまま、4つだけ置き換えて保存する(間隔は 2026-10-15 追加)
    const saved = await paceWeightsRequest("/api/admin/pace-weights/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adjust: { ...paceAdjustDefault, ...pick },
        adjust_auto: { computed_at: new Date().toISOString(), races: result.detail.races, values: pick, best: d.best, base: d.base },
      }),
    }, `${result.detail.races}レースで計算して保存しました: ${paceAdjustText(pick)}(${paceAdjustStatText(d.best, d.base)})`);
    // 保存後に一覧ごと描き直されるので、描き直した後のボタンの下に結果を出す
    if (saved) paceAdjustAutoMsg(`${result.detail.races}レースで計算して保存しました: ${paceAdjustText(pick)}(${paceAdjustStatText(d.best, d.base)})`, true);
    else paceAdjustAutoMsg("計算はできましたが、保存に失敗しました", false);
  } catch (e) {
    paceAdjustAutoMsg(`計算できませんでした: ${e.message}`, false);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---- 自動計算: 計算待ち(2026-10-14。API: GET/DELETE /api/admin/pace-queue)----
// 「計算待ちを今すぐ計算」は夜間の定時起動(workers/pace-cron)と同じ規則で、このブラウザで処理する(pace-runner.js の runPaceQueueInBrowser)。
let paceQueueItems = [];

function paceQueueLabel(it) {
  if (it.kind === "course") {
    const [track, ct, dist] = String(it.key).split("|");
    return `${track} ${ct}${dist}m`;
  }
  const g = (paceWeightsList?.items || []).find((x) => String(x.graded_race_id) === String(it.key));
  return g ? `${g.name}(重賞)` : `重賞 ${it.key}`;
}

async function loadPaceQueue() {
  const summary = document.getElementById("pace-queue-summary");
  const listEl = document.getElementById("pace-queue-list");
  if (!summary || !listEl) return;
  const res = await authedFetch("/api/admin/pace-queue");
  if (!res.ok) { summary.textContent = "読み込みに失敗しました"; return; }
  paceQueueItems = (await res.json()).items || [];
  summary.textContent = paceQueueItems.length ? `${paceQueueItems.length}件` : "ありません";
  listEl.textContent = paceQueueItems.map(paceQueueLabel).join(" / ");
}

async function runPaceQueue(btn) {
  if (!paceQueueItems.length) { paceWeightsMsg("計算待ちはありません", true); return; }
  const label = btn.textContent;
  btn.disabled = true;
  const r = await runPaceQueueInBrowser((text) => { btn.textContent = text; });
  btn.disabled = false;
  btn.textContent = label;
  if (r.busy) { paceWeightsMsg("別の計算が動いています。終わってからもう一度押してください", false); return; }
  paceWeightsMsg(`計算待ちを処理しました(計算${r.done}件・7日未満などで省略${r.skipped}件${r.failed ? `・失敗${r.failed}件(計算待ちに残しました)` : ""})`, !r.failed);
  await loadPaceWeights();
}

function setupPaceCompute() {
  const trackSel = document.getElementById("course-compute-track");
  if (trackSel && !trackSel.options.length) {
    trackSel.innerHTML = TRACK_DISPLAY_ORDER.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("");
  }
  document.getElementById("pace-queue-run-btn")?.addEventListener("click", (e) => runPaceQueue(e.currentTarget));
  document.getElementById("course-compute-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const dist = Number(document.getElementById("course-compute-distance").value);
    if (!(dist > 0)) return;
    const key = `${trackSel.value}|${document.getElementById("course-compute-type").value}|${dist}`;
    paceComputeAdmin("course", key, document.getElementById("course-compute-btn"));
  });
}

// ---- 重賞ごとの比率の一覧(2026-10-14: 1重賞1行の要約+タップで入力を開く。最初は今月・来月の重賞だけ) ----
let paceWeightsList = null; // { items, std }(GET /api/admin/pace-weights の結果。絞り込みの変更では読み直さない)
const paceWeightsOpen = new Set(); // 開いている重賞のID(保存後の読み直しでも開いたままにする)

function paceWeightsVisibleItems() {
  const q = (document.getElementById("pace-weights-search")?.value || "").normalize("NFKC").trim().toLowerCase();
  const all = document.getElementById("pace-weights-all")?.checked;
  const items = paceWeightsList?.items || [];
  if (q) return items.filter((g) => String(g.name || "").normalize("NFKC").toLowerCase().includes(q));
  if (all) return items;
  // 今月・来月(日本時間)。開催月日が無い重賞は出さない(検索・すべて表示で出る)
  const m = Number(new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(5, 7));
  const months = new Set([m, (m % 12) + 1]);
  return items.filter((g) => g.schedule_md && months.has(Number(String(g.schedule_md).slice(0, 2))));
}

// 一覧の要約の行に出す最終更新日時(2026-10-14。開かなくても分かるように。比率の値は開いた中で見る)
function paceUpdatedDateHtml(w) {
  const text = formatDateTime(w?.updated_at);
  return text ? ` <span class="pace-w-item-date">更新 ${escapeHtml(text)}</span>` : "";
}

function renderPaceWeightsList() {
  const list = document.getElementById("pace-weights-list");
  const count = document.getElementById("pace-weights-count");
  if (!list || !paceWeightsList) return;
  const { items, std } = paceWeightsList;
  const shown = paceWeightsVisibleItems();
  const filtered = document.getElementById("pace-weights-search")?.value.trim() || document.getElementById("pace-weights-all")?.checked;
  if (count) count.textContent = `${shown.length}件${filtered ? "" : "(今月・来月)"} / 全${items.length}件`;
  if (!shown.length) {
    list.innerHTML = `<p class="ticket-sub">該当する重賞はありません</p>`;
    return;
  }
  const sourceText = (w) => (!w ? "標準" : w.source === "auto" ? "自動" : w.source === "none" ? "ペースのみ手動" : "手動");
  list.innerHTML = shown.map((g) => {
    const w = g.weights;
    const paces = PACE_W_TYPES.filter(([p]) => w?.by_pace?.[p]).map(([, label]) => label).join("・");
    const id = Number(g.graded_race_id);
    return `
      <details class="pace-w-item" data-id="${id}" ${paceWeightsOpen.has(id) ? "open" : ""}>
        <summary>
          <span class="pace-w-item-name">${escapeHtml(g.schedule_md || "—")} ${escapeHtml(g.name)} <small>${escapeHtml(g.is_jump ? "J・" + g.grade : g.grade)}</small></span>
          <span class="pace-w-item-sub">${escapeHtml(sourceText(w))}${paces ? `(ペース別: ${escapeHtml(paces)})` : ""}${paceUpdatedDateHtml(w)}</span>
        </summary>
        <div class="pace-w-item-body">
          ${paceWeightsLinesHtml(w, std)}
          ${paceWeightsLinesHtml(w, std, "partner")}
          ${paceAdjustLineHtml(w?.adjust || null, `g${id}`)}
          ${w?.source === "auto" ? `<p class="ticket-sub">${escapeHtml(paceAutoSummaryText(w.detail))}</p>` : ""}
          <div class="row-actions">
            <button type="button" class="ghost-btn pace-w-row-auto">今すぐ計算(過去10年)</button>
            ${w ? `<button type="button" class="icon-btn delete pace-w-row-clear" title="この重賞の比率を消す(次に開いたときに自動で選び直す)">×</button>` : ""}
          </div>
        </div>
      </details>`;
  }).join("");
  list.querySelectorAll(".pace-w-item").forEach((d) => d.addEventListener("toggle", () => {
    const id = Number(d.dataset.id);
    if (d.open) paceWeightsOpen.add(id);
    else paceWeightsOpen.delete(id);
  }));
  setupPaceWeightsLines(list);
  const itemOf = (btn) => btn.closest(".pace-w-item");
  list.querySelectorAll(".pace-w-row-auto").forEach((btn) => btn.addEventListener("click", () => paceComputeAdmin("graded", itemOf(btn).dataset.id, btn)));
  list.querySelectorAll(".pace-w-row-clear").forEach((btn) => btn.addEventListener("click", () => {
    if (!confirm("この重賞の比率を消しますか?(コース・標準の比率を使うようになります。次に出馬表を取り込んだ夜に計算し直します)")) return;
    paceWeightsRequest(`/api/admin/pace-weights?graded_race_id=${encodeURIComponent(itemOf(btn).dataset.id)}`, { method: "DELETE" }, "消しました");
  }));
}

// 「今すぐ計算」(2026-10-14。docs/design/screens.md「比率の計算(夜間・今すぐ計算)」): サーバーから採点を数レースずつ受け取り、
// このブラウザで比率を選んで(public/pace-search.js。夜間の定時実行と同じ計算)保存する。kind: "graded" | "course"
// btn: 進み具合を出すボタン(無ければ出さない)、opts.reload: 保存後に一覧を読み直すか。戻り値: 保存できたか
//(採点できる過去のレースが無いときも true〈計算待ちから外してよい〉)
async function paceComputeAdmin(kind, key, btn, { reload = true } = {}) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "採点中…"; }
  let ok = false;
  try {
    const { collectAndChoose } = await import("./pace-search.js");
    const { result, info } = await collectAndChoose((offset) => paceFetchBacktestChunk(kind, key, offset),
      (done, total) => { if (btn) btn.textContent = `採点中…(${done}/${total})`; });
    if (result.error) {
      paceWeightsMsg(`${info?.label || key}: ${result.error}`, false);
      ok = true;
    } else {
      const d = result.detail;
      const res = await authedFetch("/api/admin/pace-weights/auto-result", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, key, result }),
      });
      ok = res.ok;
      paceWeightsMsg(ok
        ? `${info?.label || key}: 計算して保存しました(${d.races}レース: 軸の3着以内${d.best.show}・1着${d.best.win}回 / 軸+相手に1着馬${d.partner.best.win}回)`
        : `${info?.label || key}: 保存できませんでした`, ok);
      if (ok && reload) await loadPaceWeights();
    }
  } catch (e) {
    paceWeightsMsg(`計算できませんでした: ${e.message}`, false);
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  return ok;
}

// ---- コースごとの比率の一覧(2026-10-14。計算・保存したコースだけ。重賞の一覧と同じ形) ----
let courseWeightsList = null; // { courses, std }
const courseWeightsOpen = new Set();

function renderCourseWeightsList() {
  const list = document.getElementById("course-weights-list");
  const count = document.getElementById("course-weights-count");
  if (!list || !courseWeightsList) return;
  const { courses, std } = courseWeightsList;
  const q = (document.getElementById("course-weights-search")?.value || "").normalize("NFKC").replace(/\s/g, "").toLowerCase();
  const labelOf = (c) => `${c.track} ${c.course_type}${c.distance}m`;
  const shown = q ? courses.filter((c) => labelOf(c).replace(/\s/g, "").toLowerCase().includes(q)) : courses;
  if (count) count.textContent = `${shown.length}件 / 全${courses.length}件`;
  if (!shown.length) {
    list.innerHTML = courses.length ? `<p class="ticket-sub">該当するコースはありません</p>` : ""; // 説明文は2026-10-14に外した
    return;
  }
  list.innerHTML = shown.map((c) => {
    const w = c.weights;
    return `
      <details class="pace-w-item" data-course-key="${escapeAttr(c.course_key)}" ${courseWeightsOpen.has(c.course_key) ? "open" : ""}>
        <summary class="pace-w-summary-row">
          <span class="pace-w-summary-text">
            <span class="pace-w-item-name">${escapeHtml(labelOf(c))}</span>
            <span class="pace-w-item-sub">${escapeHtml(w?.source === "auto" ? "自動" : w?.source === "none" ? "ペースのみ手動" : "手動")}${paceUpdatedDateHtml(w)}</span>
          </span>
          <!-- 開かずに計算し直せるよう、閉じた行にもボタンを置く(2026-10-16 ユーザー要望) -->
          <button type="button" class="ghost-btn course-w-auto pace-w-summary-btn" title="このコースの直近1年から比率を計算して保存します">今すぐ計算</button>
        </summary>
        <div class="pace-w-item-body">
          ${paceWeightsLinesHtml(w, std)}
          ${paceWeightsLinesHtml(w, std, "partner")}
          ${paceAdjustLineHtml(w?.adjust || null, `c${c.course_key}`)}
          ${w?.detail?.method === "backtest" ? `<p class="ticket-sub">${escapeHtml(paceAutoSummaryText(w.detail))}</p>` : ""}
          <div class="row-actions">
            <button type="button" class="ghost-btn course-w-auto">今すぐ計算(直近1年)</button>
            <button type="button" class="icon-btn delete course-w-clear" title="このコースの比率を消す">×</button>
          </div>
        </div>
      </details>`;
  }).join("");
  list.querySelectorAll(".pace-w-item").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) courseWeightsOpen.add(d.dataset.courseKey);
    else courseWeightsOpen.delete(d.dataset.courseKey);
  }));
  setupPaceWeightsLines(list);
  const keyOf = (btn) => btn.closest(".pace-w-item").dataset.courseKey;
  // 閉じた行(summary)のボタンも同じ処理。押しても行は開閉しない(summary の既定の動きを止める)
  list.querySelectorAll(".course-w-auto").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    paceComputeAdmin("course", keyOf(btn), btn);
  }));
  list.querySelectorAll(".course-w-clear").forEach((btn) => btn.addEventListener("click", () => {
    if (!confirm("このコースの比率を消しますか?(標準の比率を使うようになります)")) return;
    paceWeightsRequest(`/api/admin/pace-weights?course_key=${encodeURIComponent(keyOf(btn))}`, { method: "DELETE" }, "消しました");
  }));
}

function setupPaceWeightsFilter() {
  document.getElementById("pace-weights-search")?.addEventListener("input", renderPaceWeightsList);
  document.getElementById("pace-weights-all")?.addEventListener("change", renderPaceWeightsList);
  document.getElementById("course-weights-search")?.addEventListener("input", renderCourseWeightsList);
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
  setupNetkeibaBookmarklet();
  setupD1UsageButton();
  setupServiceGuardForm();
  setupGradedRaceForm();
  setupGradedRacesImport();
  setupTrainerAliasForm();
  setupPaceWeightsFilter();
  setupPaceCompute();
  setupGuestIpForm();
  setupAdminTabs();
}

// ---------- ゲスト閲覧(2026-10-14。docs/design/guest.md。API: /api/admin/guest) ----------
function guestMsg(text, ok) {
  const el = document.getElementById("guest-message");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `submit-message ${ok ? "success" : "error"}`;
}

async function guestRequest(method, body, okText) {
  const res = await authedFetch("/api/admin/guest", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { guestMsg(data.error || "失敗しました", false); return false; }
  guestMsg(okText, true);
  await loadGuestAdmin();
  return true;
}

async function loadGuestAdmin() {
  const box = document.getElementById("guest-settings");
  const table = document.getElementById("guest-devices-table");
  const ipTable = document.getElementById("guest-ips-table");
  if (!box || !table || !ipTable) return;
  const res = await authedFetch("/api/admin/guest");
  if (!res.ok) { box.innerHTML = `<p class="ticket-sub">読み込みに失敗しました</p>`; return; }
  const data = await res.json();
  const s = data.settings || {};
  // 2026-10-14: 合言葉を廃止し、データ検索用アプリ(keiba-search)の今週のレースのURLを出す(docs/design/app-split.md)
  const url = `${APP_URLS.search}/guest`;
  box.innerHTML = `
    <p><label><input type="checkbox" id="guest-enabled" ${s.enabled ? "checked" : ""} /> ゲスト閲覧を公開する</label></p>
    ${s.enabled && url ? `
      <p class="guest-url" id="guest-url">${escapeHtml(url)}</p>
      <div class="row-actions">
        <button type="button" class="ghost-btn" id="guest-copy-btn">URLをコピー</button>
      </div>` : `<p class="ticket-sub">公開すると、データ検索用アプリ(今週のレース・データ検索)を誰でも見られるようになります。止めている間は「公開を停止しています」と出ます。</p>`}
    <p class="ticket-sub">今見られるレース: ${escapeHtml(formatDateMdW(data.window.from))} 〜 ${escapeHtml(formatDateMdW(data.window.to))} の中央のレース</p>`;
  document.getElementById("guest-enabled").addEventListener("change", (e) => {
    guestRequest("PUT", { enabled: e.target.checked }, e.target.checked ? "公開しました" : "公開を止めました");
  });
  document.getElementById("guest-copy-btn")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); guestMsg("コピーしました", true); } catch { guestMsg("コピーできませんでした。URLを選択してコピーしてください", false); }
  });
  // 「URLを作り直す」は合言葉の廃止(2026-10-14)で外した(端末の止め方はブロック)

  const devices = data.devices || [];
  table.innerHTML = devices.length ? `
    <thead><tr><th>最終アクセス</th><th>回数</th><th>IP</th><th>ブラウザ</th><th>初回</th><th>メモ</th><th></th></tr></thead>
    <tbody>${devices.map((d) => `
      <tr data-device="${escapeAttr(d.device_id)}" data-ip="${escapeAttr(d.ip || "")}" class="${d.blocked ? "guest-device-blocked" : ""}">
        <td>${escapeHtml(formatDateTime(d.last_seen))}</td>
        <td>${Number(d.hits || 0)}</td>
        <td>${escapeHtml(d.ip || "")}</td>
        <td title="${escapeAttr(d.user_agent || "")}"><small>${escapeHtml(guestUaLabel(d.user_agent))}</small></td>
        <td><small>${escapeHtml(formatDateTime(d.first_seen))}</small></td>
        <td><input type="text" class="guest-note-input" value="${escapeAttr(d.note || "")}" placeholder="誰の端末か等" style="width:9em" /></td>
        <td><div class="row-actions">
          <button type="button" class="ghost-btn guest-block-btn">${d.blocked ? "解除" : "ブロック"}</button>
          ${d.ip ? `<button type="button" class="ghost-btn guest-block-ip-btn">IPをブロック</button>` : ""}
        </div></td>
      </tr>`).join("")}
    </tbody>` : `<tr><td>まだアクセスはありません</td></tr>`;
  const rowOf = (el) => el.closest("tr");
  table.querySelectorAll(".guest-block-btn").forEach((btn) => btn.addEventListener("click", () => {
    const tr = rowOf(btn);
    const block = !tr.classList.contains("guest-device-blocked");
    guestRequest("POST", { action: block ? "block_device" : "unblock_device", device_id: tr.dataset.device }, block ? "ブロックしました(反映まで最大1分)" : "解除しました(反映まで最大1分)");
  }));
  table.querySelectorAll(".guest-block-ip-btn").forEach((btn) => btn.addEventListener("click", () => {
    const tr = rowOf(btn);
    if (!confirm(`IP ${tr.dataset.ip} をブロックしますか?(同じIPの他の端末も使えなくなります)`)) return;
    guestRequest("POST", { action: "block_ip", ip: tr.dataset.ip }, "IPをブロックしました(反映まで最大1分)");
  }));
  table.querySelectorAll(".guest-note-input").forEach((input) => input.addEventListener("change", () => {
    guestRequest("POST", { action: "note_device", device_id: rowOf(input).dataset.device, note: input.value }, "メモを保存しました");
  }));

  const ips = data.ip_blocks || [];
  ipTable.innerHTML = ips.length ? `
    <thead><tr><th>IP</th><th>ブロックした日時</th><th></th></tr></thead>
    <tbody>${ips.map((x) => `
      <tr data-ip="${escapeAttr(x.ip)}"><td>${escapeHtml(x.ip)}</td><td><small>${escapeHtml(formatDateTime(x.created_at))}</small></td>
        <td><button type="button" class="ghost-btn guest-unblock-ip-btn">解除</button></td></tr>`).join("")}
    </tbody>` : `<tr><td>ブロックしたIPはありません</td></tr>`;
  ipTable.querySelectorAll(".guest-unblock-ip-btn").forEach((btn) => btn.addEventListener("click", () => {
    guestRequest("POST", { action: "unblock_ip", ip: rowOf(btn).dataset.ip }, "IPのブロックを解除しました(反映まで最大1分)");
  }));
}

// ブラウザの表示を短くする(端末の見分け用)
function guestUaLabel(ua) {
  const s = String(ua || "");
  const os = /iPhone|iPad/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS/.test(s) ? "Mac" : "";
  const br = /Edg\//.test(s) ? "Edge" : /CriOS|Chrome\//.test(s) ? "Chrome" : /Firefox|FxiOS/.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" ") || s.slice(0, 30);
}

function setupGuestIpForm() {
  document.getElementById("guest-ip-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("guest-ip-input");
    const ip = input.value.trim();
    if (!ip) return;
    guestRequest("POST", { action: "block_ip", ip }, "IPをブロックしました(反映まで最大1分)").then((ok) => { if (ok) input.value = ""; });
  });
}

// ---------- タブ(2026-10-14。docs/design/screens.md「管理画面」) ----------
// 開いたタブの欄だけ表示し、データはそのタブを初めて開いたときに読む(以前は画面を開くと全部の欄を読んでいた)。
// 開くタブ: URL の #タブ名 → 前回開いたタブ(この端末の localStorage)→ 状況。
const ADMIN_TAB_LOADERS = {
  status: () => [loadD1Usage(false), loadServiceGuard()],
  import: () => [loadUnregisteredRaces(), loadApiTokenStatus()], // 未登録レース一覧は取り込みタブ(2026-10-14)
  alias: () => [loadJockeyAliases(), loadHorseAliases(), setupHorseIndex(), loadTrainerAliases()],
  graded: () => [loadGradedRaces(), loadPaceWeights()],
  users: () => [loadUsers(), loadGuestAdmin()], // ゲスト閲覧もユーザータブ(2026-10-14。当初は「ゲスト」タブ)
};
// 以前のタブ名(ブックマーク・前回のタブの復元用)
const ADMIN_TAB_ALIASES = { guest: "users" };
const ADMIN_TAB_STORAGE_KEY = "admin_tab";
const adminTabLoaded = new Set();

function showAdminTab(tab) {
  tab = ADMIN_TAB_ALIASES[tab] || tab;
  if (!ADMIN_TAB_LOADERS[tab]) tab = "status";
  document.querySelectorAll("[data-admin-tab-btn]").forEach((b) => {
    const on = b.dataset.adminTabBtn === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-admin-tab]").forEach((s) => { s.hidden = s.dataset.adminTab !== tab; });
  try { localStorage.setItem(ADMIN_TAB_STORAGE_KEY, tab); } catch { /* 保存できなくても表示はできる */ }
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  if (!adminTabLoaded.has(tab)) {
    adminTabLoaded.add(tab);
    Promise.all(ADMIN_TAB_LOADERS[tab]()).catch((e) => console.error("admin tab load failed", e));
  }
}

function setupAdminTabs() {
  document.querySelectorAll("[data-admin-tab-btn]").forEach((b) => b.addEventListener("click", () => showAdminTab(b.dataset.adminTabBtn)));
  window.addEventListener("hashchange", () => showAdminTab(location.hash.slice(1)));
  let saved = null;
  try { saved = localStorage.getItem(ADMIN_TAB_STORAGE_KEY); } catch { /* 読めなければ状況タブ */ }
  showAdminTab(location.hash.slice(1) || saved || "status");
}

// ---------- 調教師名エイリアス管理(2026-10-06追加) ----------
// netkeiba馬柱テキストの貼り付け取り込みで、調教師の略称を正しい調教師名に変換するため。
// 騎手名エイリアス管理(loadJockeyAliases/setupJockeyAliasForm)と同じ形。
// API: GET/POST /api/admin/trainer-aliases、DELETE /api/admin/trainer-aliases/:id。

async function loadTrainerAliases() {
  const table = document.getElementById("trainer-aliases-table");
  if (!table) return;
  const res = await authedFetch("/api/admin/trainer-aliases");
  if (!res.ok) { table.innerHTML = "<tr><td>読み込みに失敗しました</td></tr>"; setCollapsibleCount("trainer-aliases-table", null); return; }
  const data = await res.json();
  const items = data.items || [];
  setCollapsibleCount("trainer-aliases-table", items.length);
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
          <td><button type="button" class="icon-btn delete trainer-alias-delete-btn" title="削除">×</button></td>
        </tr>
      `).join("")}
    </tbody>
  `;
  table.querySelectorAll(".trainer-alias-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("tr")?.dataset.id;
      if (!id) return;
      if (!confirm("このエイリアスを削除しますか？")) return;
      const res2 = await authedFetch(`/api/admin/trainer-aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res2.ok) {
        const data2 = await res2.json().catch(() => ({}));
        alert(data2.error || "削除に失敗しました。");
        return;
      }
      await loadTrainerAliases();
    });
  });
}

function setupTrainerAliasForm() {
  const form = document.getElementById("trainer-alias-form");
  const messageEl = document.getElementById("trainer-alias-form-message");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const displayInput = document.getElementById("trainer-alias-display");
    const canonicalInput = document.getElementById("trainer-alias-canonical");
    const alias_display = displayInput.value.trim();
    const canonical_name = canonicalInput.value.trim();
    if (!alias_display || !canonical_name) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    messageEl.hidden = true;
    const res = await authedFetch("/api/admin/trainer-aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias_display, canonical_name }),
    });
    const data = await res.json().catch(() => ({}));
    submitBtn.disabled = false;
    messageEl.hidden = false;
    if (res.ok) {
      messageEl.className = "submit-message success";
      messageEl.textContent = `「${alias_display}」→「${canonical_name}」を登録しました。`;
      displayInput.value = "";
      canonicalInput.value = "";
      await loadTrainerAliases();
    } else {
      messageEl.className = "submit-message error";
      messageEl.textContent = data.error || "登録に失敗しました。";
    }
  });
}

setupAuth(onReady);