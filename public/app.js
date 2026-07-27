const raceList = document.getElementById("race-list");
const emptyState = document.getElementById("empty-state");
const summaryBar = document.getElementById("summary-bar");
let expandedGroups = new Set();
let expandedRaces = new Set();
let races = [];

async function loadTickets() {
  const [ticketsRes, racesRes] = await Promise.all([
    authedFetch("/api/tickets"),
    authedFetch("/api/races"),
  ]);
  if (!ticketsRes.ok) return;
  const items = await ticketsRes.json();
  races = racesRes.ok ? await racesRes.json() : [];
  render(items);
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
  return Array.from(map.values()).sort((a, b) => (a.race_date < b.race_date ? 1 : -1));
}

function groupByGroupId(tickets) {
  const map = new Map();
  for (const t of tickets) {
    if (!map.has(t.group_id)) map.set(t.group_id, []);
    map.get(t.group_id).push(t);
  }
  return Array.from(map.values());
}

function render(items) {
  raceList.innerHTML = "";
  emptyState.hidden = items.length !== 0;

  renderSummary(items);

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
          const def = BET_TYPES[t.bet_type];
          const selHtml = t.selections
            .map((s) => `<span class="sel-item"><span class="sel-num">${s.horse_number}</span>${escapeHtml(s.horse_name || "")}</span>`)
            .join(def.ordered ? '<span class="sel-arrow">→</span>' : '<span class="sel-dash">-</span>');
          return `
            <div class="group-detail-row" data-id="${t.id}">
              <div class="sel-line">${selHtml}</div>
              <label class="payout-label">購入額
                <input type="number" class="amount-edit-input" min="100" step="100" value="${t.amount}" />
              </label>
              <span class="detail-payout">${t.payout !== null && t.payout !== undefined ? `払戻¥${t.payout.toLocaleString()}` : "未確定"}</span>
              <button type="button" class="icon-btn delete detail-delete-btn" title="削除">×</button>
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="group-detail-actions">
      <a href="races.html?edit=${encodeURIComponent(first.race_id)}" class="ghost-btn">払戻を編集(レース管理へ)</a>
    </div>
  `;
  wrap.appendChild(detail);

  head.addEventListener("click", () => {
    const nowHidden = !detail.hidden;
    detail.hidden = nowHidden;
    if (nowHidden) expandedGroups.delete(groupKey);
    else expandedGroups.add(groupKey);
    head.querySelector(".expand-arrow").textContent = detail.hidden ? "▸" : "▾";
  });

  detail.querySelectorAll(".amount-edit-input").forEach((input) => {
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
      const id = btn.closest(".group-detail-row").dataset.id;
      await authedFetch(`/api/tickets/${id}`, { method: "DELETE" });
      loadTickets();
    });
  });

  return wrap;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
}

setupAuth(loadTickets);
