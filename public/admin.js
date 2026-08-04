// 管理者向け画面(admin.html)。
// 「未登録レース一覧」: CSVインポートで参照されたがまだレース登録されていない
// 日付・競馬場・レース番号を一覧表示し、レース登録画面へ事前入力付きで遷移できる。
// 「登録ユーザー一覧」: users テーブルの閲覧のみ(編集・削除機能は無し)。

// escapeHtml は utils.js のものを使用する(2026-08-04: 重複定義を統合)
function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}(${"日月火水木金土"[d.getDay()]})`;
}
function formatDateTime(s) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
    <thead><tr><th>ユーザー名</th><th>登録日時</th></tr></thead>
    <tbody>
      ${items.map((u) => `
        <tr>
          <td>${escapeHtml(u.username)}${u.username === window.currentUser?.username ? "(自分)" : ""}</td>
          <td>${formatDateTime(u.created_at)}</td>
        </tr>
      `).join("")}
    </tbody>
  `;
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
  await Promise.all([loadUnregisteredRaces(), loadUsers()]);
}

setupAuth(onReady);
