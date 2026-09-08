const raceList = document.getElementById("race-list");
const emptyState = document.getElementById("empty-state");
const summaryBar = document.getElementById("summary-bar");
let expandedGroups = new Set();
let expandedRaces = new Set();
let races = [];
let allItems = [];
// 一括削除(通常購入 tickets のみ・CSV取込分は対象外)の選択モード。
// selectedTicketIds は数値の tickets.id。applyHistoryFilter() のたびにクリアするため、
// 選択は「今表示している一覧の中でだけ」有効(日付切り替え・再読込で失われる)。
let selectionMode = false;
let selectedTicketIds = new Set();
// 2026-08-21: 画面を開いた直後から当日を選択済みの状態にする(必ずどこかの日付が
// 選択されている状態を保つ方針に変更。同じ日付の再クリックによる選択解除は廃止した)。
// 2026-08-24: 「今日」の判定ロジック(todayDateKey())は public/buy.js(馬券購入画面)と
// 共有するため、public/utils.js へ移動した(docs/design/screens.md「『今日』ボタンの日付判定」
// 参照)。以前はこのファイル内にローカル定義を持っており、buy.js側は別のロジック
// (UTC基準のtoISOString())を使っていたため、日付が変わってから午前9時頃までの間、
// 画面によって「今日」の判定がずれる不具合があった。

let selectedHistoryDate = todayDateKey();
let historyCalendarMonth = new Date();
historyCalendarMonth.setDate(1);

const historyCalendar = document.getElementById("history-calendar");
const historyCalendarGrid = document.getElementById("history-calendar-grid");
const historyCalendarMonthLabel = document.getElementById("history-calendar-month-label");
const historyFilterLabel = document.getElementById("history-filter-label");

document.getElementById("history-prev-month-btn")?.addEventListener("click", () => {
  historyCalendarMonth.setMonth(historyCalendarMonth.getMonth() - 1);
  renderHistoryCalendar();
});
document.getElementById("history-next-month-btn")?.addEventListener("click", () => {
  historyCalendarMonth.setMonth(historyCalendarMonth.getMonth() + 1);
  renderHistoryCalendar();
});
document.getElementById("history-today-btn")?.addEventListener("click", () => {
  const now = new Date();
  historyCalendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  selectedHistoryDate = todayDateKey(now);
  renderHistoryCalendar();
  applyHistoryFilter();
});
// 2026-08-20: 「選択解除」ボタンは、選択中の日付を再クリックすると同じ挙動になり
// 機能が重複していたため廃止した。フィルタ解除は renderHistoryCalendar() 内の
// カレンダー日付クリックハンドラ(同じ日付を再クリックするとselectedHistoryDateを
// nullに戻す処理)がそのまま担う。

// 日付ごとの購入金額・払戻金額・収支を集計する。
// 収支の考え方はREADME/集計ページと同じく「未確定分も購入時点で支払い済みとして計上」する。
function computeDailyTotals(items) {
  const byDate = new Map();
  for (const t of items) {
    const date = t.race_date;
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, { amount: 0, payout: 0 });
    const d = byDate.get(date);
    d.amount += Number(t.amount || 0);
    if (t.payout !== null && t.payout !== undefined) d.payout += Number(t.payout || 0);
  }
  return byDate;
}

function renderHistoryCalendar() {
  if (!historyCalendarGrid || !historyCalendarMonthLabel) return;
  const year = historyCalendarMonth.getFullYear();
  const month = historyCalendarMonth.getMonth();
  historyCalendarMonthLabel.textContent = `${year}年${month + 1}月`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dailyTotals = computeDailyTotals(allItems);

  const headers = ["日", "月", "火", "水", "木", "金", "土"];
  let html = headers.map((h) => `<span class="calendar-weekday">${h}</span>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<span class="calendar-day empty"></span>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const totals = dailyTotals.get(key);
    const profit = totals ? totals.payout - totals.amount : null;
    const moneyHtml = totals
      ? `<span class="calendar-day-money ${profit >= 0 ? "profit-plus" : "profit-minus"}">${formatSignedNum(profit)}</span>`
      : "";
    html += `<button type="button" class="calendar-day money-cell ${key === selectedHistoryDate ? "selected" : ""} ${totals ? "has-race" : ""}" data-date="${key}">
      <span>${d}</span>${moneyHtml}
    </button>`;
  }
  historyCalendarGrid.innerHTML = html;
  historyCalendarGrid.querySelectorAll("button[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // 2026-08-21: 選択解除機能を廃止したため、クリックした日付を常に選択する
      // (再クリックしても解除されない。必ずどこかの日付が選択された状態を保つ)。
      selectedHistoryDate = btn.dataset.date;
      renderHistoryCalendar();
      applyHistoryFilter();
    });
  });
}

// 2026-08-21: 必ずどこかの日付が選択されている前提に変更したため、未選択時の分岐
// (案内文表示等)は廃止した。サマリーも全期間ではなく選択中の日付の合計に変更する
// (「集計」画面の総合成績とは別に、その日の収支だけを見たいという要望のため)。
function applyHistoryFilter() {
  // 選択(一括削除)は再描画をまたいで保持しない。表示中の日付が切り替わったり、
  // 削除後に再読込したりしたタイミングで必ずクリアする(見えていない選択が
  // 残って誤削除されるのを防ぐ)。チェックは syncBulkSelectionUi() が付け直す。
  selectedTicketIds.clear();
  const dayItems = allItems.filter((t) => t.race_date === selectedHistoryDate);
  renderSummary(dayItems);
  historyFilterLabel.hidden = false;
  historyFilterLabel.textContent = `${formatDate(selectedHistoryDate)}の履歴を表示中`;
  renderList(dayItems);
  if (selectionMode) syncBulkSelectionUi();
}

async function loadTickets() {
  const [ticketsRes, racesRes, importedRes] = await Promise.all([
    authedFetch("/api/tickets"),
    authedFetch("/api/races"),
    authedFetch("/api/ticket-imports"),
  ]);
  if (!ticketsRes.ok) return;
  const items = await ticketsRes.json();
  const importedPayload = importedRes.ok ? await importedRes.json() : { items: [] };
    const imported = Array.isArray(importedPayload)
      ? importedPayload
      : (Array.isArray(importedPayload.items) ? importedPayload.items : []);
  races = racesRes.ok ? await racesRes.json() : [];
  allItems = [...(Array.isArray(items) ? items : []), ...imported];
  renderHistoryCalendar();
  applyHistoryFilter();
}

function groupByRace(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.race_date}__${item.track}__${item.race_number}`;
    if (!map.has(key)) {
      map.set(key, {
        race_id: item.race_id,
        race_date: item.race_date,
        track: item.track,
        race_number: item.race_number,
        race_name: item.race_name,
        tickets: [],
      });
    }
    map.get(key).tickets.push(item);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.race_date !== b.race_date) return a.race_date < b.race_date ? 1 : -1;
    const trackCompare = String(a.track ?? "").localeCompare(String(b.track ?? ""), "ja");
    if (trackCompare !== 0) return trackCompare;
    return Number(a.race_number ?? 0) - Number(b.race_number ?? 0);
  });
}

// group_id 単位のグルーピング・金額集計・買い目セル markup は public/ticket-view.js の
// 共通実装(groupTicketsByGroupId / sumTicketAmount / sumSettledPayout / ticketMoneyText /
// ticketGroupStatus / selectionCellHtml)を使う。

function renderList(items) {
  raceList.innerHTML = "";
  emptyState.hidden = items.length !== 0;

  const raceGroups = groupByRace(items);

  for (const race of raceGroups) {
    raceList.appendChild(renderRaceCard(race));
  }
}

function renderSummary(items) {
  const settled = items.filter((t) => t.payout !== null && t.payout !== undefined);
  const totalAmount = items.reduce((s, t) => s + t.amount, 0);
  const totalPayout = settled.reduce((s, t) => s + t.payout, 0);
  const profit = totalPayout - totalAmount;
  const rate = totalAmount > 0 ? Math.round((totalPayout / totalAmount) * 1000) / 10 : null;

  summaryBar.innerHTML = `
    <div class="summary-item">
      <span class="summary-label">総購入</span>
      <span class="summary-value">${formatYen(totalAmount)}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">総払戻(確定分)</span>
      <span class="summary-value">${formatYen(totalPayout)}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">収支</span>
      <span class="summary-value ${profit >= 0 ? "profit-plus" : "profit-minus"}">${formatSignedYen(profit)}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">回収率</span>
      <span class="summary-value">${rate !== null ? rate + "%" : "-"}</span>
    </div>
  `;
}

// ---------- レースごとのカード(初期状態は閉じており、開くと購入グループが見える) ----------
//
// 2026-08-16: モバイル(700px以下)でヘッダーが縦長になりすぎる問題への対応として、
// 開閉矢印(.expand-arrow)を .race-card-head-main の外(head の直接の子)に出した。
// HTML構造自体はPC・モバイル共通で、見た目の並び替え(モバイルでの2行化・矢印の
// 行末への移動)は public/style.css の @media (max-width: 700px) 内で
// flexboxの order / flex-basis / margin-right:auto を使って行う
// (docs/design/screens.md「馬券履歴画面：レースカード表示」参照)。
function renderRaceCard(race) {
  const raceKey = `${race.race_date}__${race.track}__${race.race_number}`;
  const isExpanded = expandedRaces.has(raceKey);

  const settledTickets = race.tickets.filter((t) => t.payout !== null && t.payout !== undefined);
  const totalAmount = sumTicketAmount(race.tickets);
  const totalPayout = sumSettledPayout(race.tickets);
  const profit = totalPayout - totalAmount;

  // レース内の通常購入(非CSV取込)の tickets.id 一覧。1件以上あれば選択モードで
  // レース単位のチェックボックスを出す(そのレースの通常購入グループを全選択/解除する)。
  const raceTicketIds = race.tickets
    .filter((t) => !t.imported)
    .map((t) => Number(t.id))
    .filter((n) => Number.isInteger(n));
  const showRaceCheck = selectionMode && raceTicketIds.length > 0;

  const card = document.createElement("div");
  card.className = "race-card";

  const head = document.createElement("div");
  head.className = "race-card-head";
  head.innerHTML = `
    ${showRaceCheck ? `<label class="bulk-check-wrap"><input type="checkbox" class="bulk-check bulk-check-race" data-ids="${raceTicketIds.join(",")}" /></label>` : ""}
    <span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>
    <div class="race-card-head-main">
      <span class="race-date">${formatDate(race.race_date)}</span>
      <span class="track">${escapeHtml(race.track)}</span>
      <span class="r-num">${race.race_number}R</span>
      ${race.race_name ? `<span class="race-name">${escapeHtml(race.race_name)}</span>` : ""}
    </div>
    <div class="race-total">
      購入${formatYen(totalAmount)}
      ${settledTickets.length > 0 ? ` / 払戻${formatYen(totalPayout)} / ` : ""}
      ${settledTickets.length > 0 ? `<span class="${profit >= 0 ? "profit-plus" : "profit-minus"}">${formatSignedYen(profit)}</span>` : ""}
    </div>
  `;
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "race-card-body";
  body.hidden = !isExpanded;

  const purchaseGroups = groupTicketsByGroupId(race.tickets);
  for (const group of purchaseGroups) {
    body.appendChild(renderGroupRow(group));
  }
  card.appendChild(body);

  head.addEventListener("click", (e) => {
    if (e.target.closest(".bulk-check-wrap")) return; // チェックボックス操作では開閉しない
    const nowHidden = !body.hidden;
    body.hidden = nowHidden;
    if (nowHidden) expandedRaces.delete(raceKey);
    else expandedRaces.add(raceKey);
    head.querySelector(".expand-arrow").textContent = body.hidden ? "▸" : "▾";
  });

  const raceCheck = head.querySelector(".bulk-check-race");
  if (raceCheck) {
    raceCheck.addEventListener("change", () => {
      for (const id of raceTicketIds) {
        if (raceCheck.checked) selectedTicketIds.add(id);
        else selectedTicketIds.delete(id);
      }
      syncBulkSelectionUi();
    });
  }

  return card;
}

function renderGroupRow(group) {
  const first = group[0];
  const status = ticketGroupStatus(group);

  const wrap = document.createElement("div");
  wrap.className = "group-card";

  const groupKey = first.group_id;
  const isExpanded = expandedGroups.has(groupKey);

  // 一括削除の対象は通常購入のみ。CSV取込・レガシー取込グループにはチェックボックスを出さない。
  const groupTicketIds = first.imported ? [] : group.map((t) => Number(t.id)).filter((n) => Number.isInteger(n));
  const showGroupCheck = selectionMode && groupTicketIds.length > 0;

  const head = document.createElement("div");
  head.className = "group-card-head";
  head.innerHTML = `
    ${showGroupCheck ? `<label class="bulk-check-wrap"><input type="checkbox" class="bulk-check bulk-check-group" data-ids="${groupTicketIds.join(",")}" /></label>` : ""}
    <span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>
    <span class="bet-badge">${betTypeLabel(first.bet_type)}</span>
    <span class="method-badge">${methodLabel(first.method)}</span>
    <span class="point-count">${group.length}点</span>
    <span class="group-money">${ticketMoneyText(group)}</span>
    <span class="status-badge ${status === "確定済み" ? "settled" : ""}">${status}</span>
  `;
  wrap.appendChild(head);

  const detail = document.createElement("div");
  detail.className = "group-detail";
  detail.hidden = !isExpanded;
  detail.innerHTML = `
    <div class="group-detail-rows">
      ${group
        .map(
          (t) => `
      <div class="group-detail-row" data-id="${t.id}" data-imported="${t.imported ? "1" : ""}">
              <div class="sel-line">${selectionCellHtml(t.bet_type, t.selections)}</div>
              ${t.imported
                ? `<span class="import-source-badge">CSV取込</span><label class="payout-label">購入額 <input type="number" class="amount-edit-input import-edit-input" min="0" step="100" value="${t.amount}" /></label><label class="payout-label">払戻 <input type="number" class="payout-edit-input import-edit-input" min="0" step="1" value="${t.payout ?? ""}" placeholder="未確定" /></label>`
                : `<label class="payout-label">購入額
                    <input type="number" class="amount-edit-input" min="100" step="100" value="${t.amount}" />
                  </label>`
              }
              <span class="detail-payout">${t.payout !== null && t.payout !== undefined ? `${t.refunded ? "返還" : "払戻"}${formatYen(t.payout)}` : "未確定"}</span>
              ${t.imported && !t.legacy_import ? `<button type="button" class="icon-btn delete detail-delete-btn" title="削除">×</button>` : (t.imported ? "" : `<button type="button" class="icon-btn delete detail-delete-btn" title="削除">×</button>`)}
            </div>
          `
        )
        .join("")}
    </div>
    ${first.imported || !(window.currentUser && window.currentUser.isAdmin) ? "" : `<div class="group-detail-actions">
      <a href="races.html?edit=${encodeURIComponent(first.race_id)}" class="ghost-btn">払戻を編集(レース管理へ)</a>
    </div>`}
  `;
  wrap.appendChild(detail);

  head.addEventListener("click", (e) => {
    if (e.target.closest(".bulk-check-wrap")) return; // チェックボックス操作では開閉しない
    const nowHidden = !detail.hidden;
    detail.hidden = nowHidden;
    if (nowHidden) expandedGroups.delete(groupKey);
    else expandedGroups.add(groupKey);
    head.querySelector(".expand-arrow").textContent = detail.hidden ? "▸" : "▾";
  });

  const groupCheck = head.querySelector(".bulk-check-group");
  if (groupCheck) {
    groupCheck.checked = groupTicketIds.every((id) => selectedTicketIds.has(id));
    groupCheck.addEventListener("change", () => {
      for (const id of groupTicketIds) {
        if (groupCheck.checked) selectedTicketIds.add(id);
        else selectedTicketIds.delete(id);
      }
      syncBulkSelectionUi();
    });
  }

  detail.querySelectorAll(".import-edit-input").forEach((input) => {
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", async () => {
      const row = input.closest(".group-detail-row"); const id = row?.dataset.id; if (!id || String(id).startsWith("legacy-import-")) return;
      const amount = row.querySelector(".amount-edit-input")?.value; const payoutInput = row.querySelector(".payout-edit-input");
      const payout = payoutInput && payoutInput.value !== "" ? Number(payoutInput.value) : null;
      await authedFetch(`/api/ticket-imports/${encodeURIComponent(id)}`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount:Number(amount),payout})});
      loadTickets();
    });
  });

  detail.querySelectorAll(".amount-edit-input:not(.import-edit-input)").forEach((input) => {
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", async () => {
      const id = input.closest(".group-detail-row").dataset.id;
      const ticket = group.find((t) => String(t.id) === String(id));
      const newAmount = Number(input.value);

      // 払戻率が既に入力されているレースなら、新しい購入額で払戻金額も再計算する。
      // 払戻率データがまだない場合は、既存の払戻金額をそのまま維持する。
      const race = races.find((r) => r.id === ticket.race_id);
      let newPayout = ticket.payout ?? null;
      if (race && race.payouts && race.payouts[ticket.bet_type]) {
        newPayout = computeTicketPayout({ ...ticket, amount: newAmount }, race);
      }

      await authedFetch(`/api/tickets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: newAmount, payout: newPayout }),
      });
      loadTickets();
    });
  });

  detail.querySelectorAll(".detail-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("この購入を削除しますか？")) return;

      try {
        const row = btn.closest(".group-detail-row");
        const id = row.dataset.id;
        const isImported = row.dataset.imported === "1";
        // CSV取込分は imported_ticket_items テーブル管理のため、通常購入とはAPIエンドポイントが異なる。
        const endpoint = isImported ? `/api/ticket-imports/${encodeURIComponent(id)}` : `/api/tickets/${id}`;
        const res = await authedFetch(endpoint, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          alert(data.error || "削除に失敗しました。");
          return;
        }

        loadTickets();
      } catch (e) {
        alert("削除に失敗しました: " + (e.message || e));
      }
    });
  });

  return wrap;
}

const csvImportBtn = document.getElementById("csv-import-btn");
const csvImportInput = document.getElementById("csv-import-input");
csvImportBtn?.addEventListener("click", () => csvImportInput?.click());
csvImportInput?.addEventListener("change", async () => {
  const file = csvImportInput.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  csvImportBtn.disabled = true;
  csvImportBtn.textContent = "取込中…";
  try {
    const res = await authedFetch("/api/ticket-imports", { method:"POST", body:form });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || "CSVの取り込みに失敗しました");
    let message = `${result.imported || 0}件の購入履歴を取り込みました。`;
    if (result.conflicted) {
      message += `\n${result.conflicted}件は別のユーザーが登録済みのデータと衝突したため取り込めませんでした。`;
    }
    alert(message);
    await loadTickets();
  } catch (e) {
    alert(e.message || "CSVの取り込みに失敗しました");
  } finally {
    csvImportBtn.disabled = false;
    csvImportBtn.textContent = "CSVインポート";
    csvImportInput.value = "";
  }
});

// ---------- 一括削除(選択モード) ----------
// 通常購入(tickets)のみが対象。CSV取込分(imported_ticket_items 等)はチェックボックスを
// 出さない。着順・払戻は削除の影響を受けないため、サーバ側でも recomputeTicketPayouts* は呼ばない。
const historySelectBtn = document.getElementById("history-select-btn");

const bulkBar = document.createElement("div");
bulkBar.id = "bulk-action-bar";
bulkBar.hidden = true;
bulkBar.innerHTML = `
  <span id="bulk-count">選択中 0 点</span>
  <span class="bulk-bar-spacer"></span>
  <button type="button" id="bulk-cancel-btn" class="ghost-btn">キャンセル</button>
  <button type="button" id="bulk-delete-btn" class="stamp-btn" disabled>削除する</button>
`;
document.getElementById("app-screen")?.appendChild(bulkBar);

function setSelectionMode(on) {
  selectionMode = on;
  selectedTicketIds.clear();
  bulkBar.hidden = !on;
  if (historySelectBtn) historySelectBtn.textContent = on ? "選択削除を終了" : "選択削除";
  document.body.classList.toggle("history-selection-mode", on);
  applyHistoryFilter();
}

function syncBulkSelectionUi() {
  raceList.querySelectorAll(".bulk-check-group").forEach((cb) => {
    const ids = (cb.dataset.ids || "").split(",").filter(Boolean).map(Number);
    cb.checked = ids.length > 0 && ids.every((id) => selectedTicketIds.has(id));
  });
  raceList.querySelectorAll(".bulk-check-race").forEach((cb) => {
    const ids = (cb.dataset.ids || "").split(",").filter(Boolean).map(Number);
    const sel = ids.filter((id) => selectedTicketIds.has(id)).length;
    cb.checked = sel > 0 && sel === ids.length;
    cb.indeterminate = sel > 0 && sel < ids.length;
  });
  const n = selectedTicketIds.size;
  const countEl = document.getElementById("bulk-count");
  const delBtn = document.getElementById("bulk-delete-btn");
  if (countEl) countEl.textContent = `選択中 ${n} 点`;
  if (delBtn) delBtn.disabled = n === 0;
}

historySelectBtn?.addEventListener("click", () => setSelectionMode(!selectionMode));
document.getElementById("bulk-cancel-btn")?.addEventListener("click", () => setSelectionMode(false));

document.getElementById("bulk-delete-btn")?.addEventListener("click", async () => {
  const ids = [...selectedTicketIds];
  if (ids.length === 0) return;
  if (!confirm(`${ids.length} 件の買い目を削除します。元に戻せません。`)) return;
  const btn = document.getElementById("bulk-delete-btn");
  btn.disabled = true;
  btn.textContent = "削除中…";
  try {
    const res = await authedFetch("/api/tickets/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || "削除に失敗しました。");
      return;
    }
    selectionMode = false;
    document.body.classList.remove("history-selection-mode");
    bulkBar.hidden = true;
    if (historySelectBtn) historySelectBtn.textContent = "選択削除";
    await loadTickets();
  } catch (e) {
    alert("削除に失敗しました: " + (e.message || e));
  } finally {
    btn.textContent = "削除する";
  }
});

setupAuth(loadTickets);
