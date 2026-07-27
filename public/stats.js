// ---------- タブ切り替え ----------
document.querySelectorAll(".stats-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".stats-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    document.querySelectorAll(".stats-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== target;
    });
  });
});

// ---------- 集計ロジック ----------

// グループ(レース/競馬場/騎手)ごとの購入・払戻・収支を計算する共通関数。
// 未確定の馬券も購入額はすでに支払い済みとして収支に反映する(結果が出るまでは暫定的にマイナス計上)。
function computeGroupStats(tickets) {
  const totalAmount = tickets.reduce((s, t) => s + t.amount, 0);
  const settled = tickets.filter((t) => t.payout !== null && t.payout !== undefined);
  const settledPayout = settled.reduce((s, t) => s + t.payout, 0);
  const profit = settledPayout - totalAmount;
  const rate = totalAmount > 0 ? Math.round((settledPayout / totalAmount) * 1000) / 10 : null;
  const hit = computeHitRate(tickets);
  return {
    count: tickets.length,
    totalAmount,
    settledCount: settled.length,
    unsettledCount: tickets.length - settled.length,
    settledPayout,
    profit,
    rate,
    hitRate: hit.rate,
    judgedRaces: hit.judgedRaces,
    hitRaces: hit.hitRaces,
  };
}

// 的中率(クラブJRA-netと同じ考え方): レース単位で、購入したいずれかの馬券が的中(払戻>0)していれば「的中」とみなす。
// 払戻を1件も入力していないレースは、まだ判定できないため分母に含めない。
function computeHitRate(tickets) {
  const byRace = groupBy(tickets, (t) => t.race_id);
  let judgedRaces = 0;
  let hitRaces = 0;
  for (const raceTickets of byRace.values()) {
    const judged = raceTickets.some((t) => t.payout !== null && t.payout !== undefined);
    if (!judged) continue;
    judgedRaces++;
    if (raceTickets.some((t) => t.payout !== null && t.payout !== undefined && t.payout > 0)) hitRaces++;
  }
  const rate = judgedRaces > 0 ? Math.round((hitRaces / judgedRaces) * 1000) / 10 : null;
  return { judgedRaces, hitRaces, rate };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function renderOverall(items) {
  const s = computeGroupStats(items);
  const el = document.getElementById("overall-summary");
  el.innerHTML = `
    <div class="overall-card">
      <span class="overall-label">総購入金額</span>
      <span class="overall-value">¥${s.totalAmount.toLocaleString()}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">総払戻金額(確定分)</span>
      <span class="overall-value">¥${s.settledPayout.toLocaleString()}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">収支</span>
      <span class="overall-value ${s.profit >= 0 ? "profit-plus" : "profit-minus"}">${s.profit >= 0 ? "+" : ""}¥${s.profit.toLocaleString()}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">回収率</span>
      <span class="overall-value">${s.rate !== null ? s.rate + "%" : "-"}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">的中率(レース単位)</span>
      <span class="overall-value">${s.hitRate !== null ? s.hitRate + "%" : "-"}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">購入枚数(未確定)</span>
      <span class="overall-value">${s.count}枚(${s.unsettledCount}枚)</span>
    </div>
  `;
}

function renderTable(elId, rows, labelHeader) {
  const table = document.getElementById(elId);
  if (rows.length === 0) {
    table.innerHTML = `<tr><td class="table-empty">データがありません</td></tr>`;
    return;
  }
  const head = `
    <tr>
      <th>${labelHeader}</th>
      <th>購入</th>
      <th>払戻(確定)</th>
      <th>収支</th>
      <th>回収率</th>
      <th>的中率</th>
      <th>未確定</th>
    </tr>
  `;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="table-name">${escapeHtml(r.name)}</td>
        <td>¥${r.stats.totalAmount.toLocaleString()}</td>
        <td>¥${r.stats.settledPayout.toLocaleString()}</td>
        <td class="${r.stats.profit >= 0 ? "profit-plus" : "profit-minus"}">${r.stats.profit >= 0 ? "+" : ""}¥${r.stats.profit.toLocaleString()}</td>
        <td>${r.stats.rate !== null ? r.stats.rate + "%" : "-"}</td>
        <td>${r.stats.hitRate !== null ? r.stats.hitRate + "%" : "-"}</td>
        <td>${r.stats.unsettledCount > 0 ? r.stats.unsettledCount + "枚" : "-"}</td>
      </tr>
    `
    )
    .join("");
  table.innerHTML = head + body;
}

function renderRaceTable(items) {
  const groups = groupBy(items, (t) => `${t.race_date}__${t.track}__${t.race_number}`);
  const rows = Array.from(groups.entries())
    .map(([key, tickets]) => {
      const t0 = tickets[0];
      return {
        name: `${formatDate(t0.race_date)} ${t0.track} ${t0.race_number}R${t0.race_name ? " " + t0.race_name : ""}`,
        sortKey: t0.race_date,
        stats: computeGroupStats(tickets),
      };
    })
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1));
  renderTable("race-table", rows, "レース");
}

function renderTrackTable(items) {
  const groups = groupBy(items, (t) => t.track);
  const rows = Array.from(groups.entries())
    .map(([track, tickets]) => ({ name: track, stats: computeGroupStats(tickets) }))
    .sort((a, b) => b.stats.totalAmount - a.stats.totalAmount);
  renderTable("track-table", rows, "競馬場");
}

function renderJockeyTable(items) {
  // 1枚の馬券に複数騎手が絡む場合、関係する騎手それぞれに全額を計上する(按分しない)
  const jockeyMap = new Map();
  for (const ticket of items) {
    const jockeys = new Set(
      (ticket.selections || [])
        .map((s) => s.jockey)
        .filter((j) => j && j.trim() !== "")
    );
    for (const jockey of jockeys) {
      if (!jockeyMap.has(jockey)) jockeyMap.set(jockey, []);
      jockeyMap.get(jockey).push(ticket);
    }
  }
  const rows = Array.from(jockeyMap.entries())
    .map(([jockey, tickets]) => ({ name: jockey, stats: computeGroupStats(tickets) }))
    .sort((a, b) => b.stats.totalAmount - a.stats.totalAmount);
  renderTable("jockey-table", rows, "騎手");
}

async function loadAndRender() {
  const res = await authedFetch("/api/tickets");
  if (!res.ok) return;
  const items = await res.json();
  renderOverall(items);
  renderRaceTable(items);
  renderTrackTable(items);
  renderJockeyTable(items);
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
  return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

setupAuth(loadAndRender);
