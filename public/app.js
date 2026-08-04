const raceList = document.getElementById("race-list");
const emptyState = document.getElementById("empty-state");
const summaryBar = document.getElementById("summary-bar");
let expandedGroups = new Set();
let expandedRaces = new Set();
let races = [];
let allItems = [];
let selectedHistoryDate = null;
let historyCalendarMonth = new Date();
historyCalendarMonth.setDate(1);

const historyCalendar = document.getElementById("history-calendar");
const historyCalendarGrid = document.getElementById("history-calendar-grid");
const historyCalendarMonthLabel = document.getElementById("history-calendar-month-label");
const historyFilterLabel = document.getElementById("history-filter-label");
const historyEmptyHint = document.getElementById("history-empty-hint");
const historyClearFilterBtn = document.getElementById("history-clear-filter-btn");

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
  selectedHistoryDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  renderHistoryCalendar();
  applyHistoryFilter();
});
historyClearFilterBtn?.addEventListener("click", () => {
  selectedHistoryDate = null;
  renderHistoryCalendar();
  applyHistoryFilter();
});

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
      ? `<span class="calendar-day-money ${profit >= 0 ? "profit-plus" : "profit-minus"}">${profit >= 0 ? "+" : ""}${profit.toLocaleString()}</span>`
      : "";
    html += `<button type="button" class="calendar-day money-cell ${key === selectedHistoryDate ? "selected" : ""} ${totals ? "has-race" : ""}" data-date="${key}">
      <span>${d}</span>${moneyHtml}
    </button>`;
  }
  historyCalendarGrid.innerHTML = html;
  historyCalendarGrid.querySelectorAll("button[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedHistoryDate = selectedHistoryDate === btn.dataset.date ? null : btn.dataset.date;
      renderHistoryCalendar();
      applyHistoryFilter();
    });
  });
}

// 初期表示(日付未選択)ではサマリー(総購入・総払戻・収支・回収率)とカレンダーのみを表示し、
// 個々の購入履歴はカレンダーで日付を選択したときだけ表示する。
// サマリーの集計は常に全期間(全購入)を対象とする(選択日だけの集計ではない)。
function applyHistoryFilter() {
  renderSummary(allItems);
  historyClearFilterBtn.hidden = !selectedHistoryDate;

  if (selectedHistoryDate) {
    historyFilterLabel.hidden = false;
    historyFilterLabel.textContent = `${formatDate(selectedHistoryDate)}の履歴を表示中`;
    historyEmptyHint.hidden = true;
    renderList(allItems.filter((t) => t.race_date === selectedHistoryDate));
  } else {
    historyFilterLabel.hidden = true;
    raceList.innerHTML = "";
    emptyState.hidden = true;
    historyEmptyHint.hidden = false;
  }
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
  allItems = [...(Array.isArray(items) ? items : []), ...(Array.isArray(imported) ? imported : [])];
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

function groupByGroupId(tickets) {
  const map = new Map();
  for (const t of tickets) {
    if (!map.has(t.group_id)) map.set(t.group_id, []);
    map.get(t.group_id).push(t);
  }
  return Array.from(map.values());
}

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
      <span class="summary-value">¥${totalAmount.toLocaleString()}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">総払戻(確定分)</span>
      <span class="summary-value">¥${totalPayout.toLocaleString()}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">収支</span>
      <span class="summary-value ${profit >= 0 ? "profit-plus" : "profit-minus"}">${profit >= 0 ? "+" : ""}¥${profit.toLocaleString()}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">回収率</span>
      <span class="summary-value">${rate !== null ? rate + "%" : "-"}</span>
    </div>
  `;
}

// ---------- レースごとのカード(初期状態は閉じており、開くと購入グループが見える) ----------
function renderRaceCard(race) {
  const raceKey = `${race.race_date}__${race.track}__${race.race_number}`;
  const isExpanded = expandedRaces.has(raceKey);

  const settledTickets = race.tickets.filter((t) => t.payout !== null && t.payout !== undefined);
  const totalAmount = race.tickets.reduce((s, t) => s + t.amount, 0);
  const totalPayout = settledTickets.reduce((s, t) => s + t.payout, 0);
  const profit = totalPayout - totalAmount;

  const card = document.createElement("div");
  card.className = "race-card";

  const head = document.createElement("div");
  head.className = "race-card-head";
  head.innerHTML = `
    <span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>
    <span class="r-num">${race.race_number}R</span>
    <span class="track">${escapeHtml(race.track)}</span>
    ${race.race_name ? `<span class="race-name">${escapeHtml(race.race_name)}</span>` : ""}
    <span class="race-date">${formatDate(race.race_date)}</span>
    <span class="race-total">
      購入¥${totalAmount.toLocaleString()}
      ${settledTickets.length > 0 ? ` / 払戻¥${totalPayout.toLocaleString()} / ` : ""}
      ${settledTickets.length > 0 ? `<span class="${profit >= 0 ? "profit-plus" : "profit-minus"}">${profit >= 0 ? "+" : ""}¥${profit.toLocaleString()}</span>` : ""}
    </span>
  `;
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "race-card-body";
  body.hidden = !isExpanded;

  const purchaseGroups = groupByGroupId(race.tickets);
  for (const group of purchaseGroups) {
    body.appendChild(renderGroupRow(group));
  }
  card.appendChild(body);

  head.addEventListener("click", () => {
    const nowHidden = !body.hidden;
    body.hidden = nowHidden;
    if (nowHidden) expandedRaces.delete(raceKey);
    else expandedRaces.add(raceKey);
    head.querySelector(".expand-arrow").textContent = body.hidden ? "▸" : "▾";
  });

  return card;
}

function renderGroupRow(group) {
  const first = group[0];
  const settledTickets = group.filter((t) => t.payout !== null && t.payout !== undefined);
  const allSettled = settledTickets.length === group.length;
  const totalAmount = group.reduce((s, t) => s + t.amount, 0);
  const totalPayout = settledTickets.reduce((s, t) => s + t.payout, 0);

  const wrap = document.createElement("div");
  wrap.className = "group-card";

  const groupKey = first.group_id;
  const isExpanded = expandedGroups.has(groupKey);

  const head = document.createElement("div");
  head.className = "group-card-head";
  head.innerHTML = `
    <span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>
    <span class="bet-badge">${betTypeLabel(first.bet_type)}</span>
    <span class="method-badge">${methodLabel(first.method)}</span>
    <span class="point-count">${group.length}点</span>
    <span class="group-money">
      購入¥${totalAmount.toLocaleString()}
      ${settledTickets.length > 0 ? ` / 払戻¥${totalPayout.toLocaleString()}` : ""}
    </span>
    <span class="status-badge ${allSettled ? "settled" : ""}">${allSettled ? "確定済み" : settledTickets.length > 0 ? "一部確定" : "未確定"}</span>
  `;
  wrap.appendChild(head);

  const detail = document.createElement("div");
  detail.className = "group-detail";
  detail.hidden = !isExpanded;
  detail.innerHTML = `
    <div class="group-detail-rows">
      ${group
        .map((t) => {
          // 不正/未知の bet_type (壊れたインポートデータ等)でも描画がクラッシュしないよう
          // フォールバック値を用意する。
          const def = BET_TYPES[t.bet_type] || { ordered: false };
          const selHtml = t.selections
            .map((s) => `<span class="sel-item"><span class="sel-num">${s.horse_number}</span>${escapeHtml(s.horse_name || "")}</span>`)
            .join(def.ordered ? '<span class="sel-arrow">→</span>' : '<span class="sel-dash">-</span>');
          return `
            <div class="group-detail-row" data-id="${t.id}" data-imported="${t.imported ? "1" : ""}">
              <div class="sel-line">${selHtml}</div>
              ${t.imported
                ? `<span class="import-source-badge">CSV取込</span><label class="payout-label">購入額 <input type="number" class="amount-edit-input import-edit-input" min="0" step="100" value="${t.amount}" /></label><label class="payout-label">払戻 <input type="number" class="payout-edit-input import-edit-input" min="0" step="1" value="${t.payout ?? ""}" placeholder="未確定" /></label>`
                : `<label class="payout-label">購入額
                    <input type="number" class="amount-edit-input" min="100" step="100" value="${t.amount}" />
                  </label>`
              }
              <span class="detail-payout">${t.payout !== null && t.payout !== undefined ? `払戻¥${t.payout.toLocaleString()}` : "未確定"}</span>
              ${t.imported && !t.legacy_import ? `<button type="button" class="icon-btn delete detail-delete-btn" title="削除">×</button>` : (t.imported ? "" : `<button type="button" class="icon-btn delete detail-delete-btn" title="削除">×</button>`)}
            </div>
          `;
        })
        .join("")}
    </div>
    ${first.imported || !(window.currentUser && window.currentUser.isAdmin) ? "" : `<div class="group-detail-actions">
      <a href="races.html?edit=${encodeURIComponent(first.race_id)}" class="ghost-btn">払戻を編集(レース管理へ)</a>
    </div>`}
  `;
  wrap.appendChild(detail);

  head.addEventListener("click", () => {
    const nowHidden = !detail.hidden;
    detail.hidden = nowHidden;
    if (nowHidden) expandedGroups.delete(groupKey);
    else expandedGroups.add(groupKey);
    head.querySelector(".expand-arrow").textContent = detail.hidden ? "▸" : "▾";
  });

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

setupAuth(loadTickets);
