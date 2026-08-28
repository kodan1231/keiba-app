// 管理者向け画面(admin.html)。
// 「未登録レース一覧」: CSVインポートで参照されたがまだレース登録されていない
// 日付・競馬場・レース番号を一覧表示し、レース登録画面へ事前入力付きで遷移できる。
// 「登録ユーザー一覧」: users テーブルの閲覧のみ(編集・削除機能は無し)。
//   2026-08-30追加: 登録日時に加えて最終ログイン日時(JST)も表示する。
// 「騎手名エイリアス管理」(2026-08-16追加): 表記ゆれの騎手名を正しい表記へ統一するための
// 対応表(jockey_aliases)の一覧表示・追加・削除、および既存データへの一括補正。
// 詳細はdocs/DESIGN.md「騎手名エイリアス管理」参照。

// escapeHtml は utils.js のものを使用する
function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}(${"日月火水木金土"[d.getDay()]})`;
}

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
          <td>${formatDate(it.race_date)}</td>
          <td>${escapeHtml(it.track || "")}</td>
          <td>${it.race_number}R</td>
          <td>${escapeHtml(it.race_name || "")}</td>
          <td>${it.group_count}件</td>
          <td>¥${Number(it.total_amount || 0).toLocaleString()}</td>
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
    <thead><tr><th>ユーザー名</th><th>登録日時(JST)</th><th>最終ログイン日時(JST)</th></tr></thead>
    <tbody>
      ${items.map((u) => `
        <tr>
          <td>${escapeHtml(u.username)}${u.username === window.currentUser?.username ? "(自分)" : ""}</td>
          <td>${formatDateTime(u.created_at)}</td>
          <td>${u.last_login_at ? formatDateTime(u.last_login_at) : "未ログイン"}</td>
        </tr>
      `).join("")}
    </tbody>
  `;
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
  await Promise.all([loadUnregisteredRaces(), loadUsers(), loadJockeyAliases()]);
}

setupAuth(onReady);