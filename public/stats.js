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
  // 未確定(払戻未入力)の馬券も、購入した時点で金額を支払い済みとして収支に反映する。
  // 実際の財布・口座残高のイメージ: 結果が出るまでは実質マイナス表示になり、
  // 払戻が確定するごとにプラス方向へ補正されていく(README「収支・回収率の考え方」参照)。
  const settled = tickets.filter((t) => t.payout !== null && t.payout !== undefined);
  const settledAmount = settled.reduce((s, t) => s + Number(t.amount || 0), 0);
  const totalAmount = tickets.reduce((s, t) => s + Number(t.amount || 0), 0);
  const settledPayout = settled.reduce((s, t) => s + Number(t.payout || 0), 0);
  const profit = settledPayout - totalAmount;
  const rate = totalAmount > 0 ? Math.round((settledPayout / totalAmount) * 1000) / 10 : null;
  const hit = computeHitRate(tickets);
  return {
    count: tickets.length,
    totalAmount,
    settledAmount,
    settledCount: settled.length,
    settledPayout,
    profit,
    rate,
    hitRate: hit.rate,
    judgedRaces: hit.judgedRaces,
    hitRaces: hit.hitRaces,
  };
}

// 的中率(クラブJRA-netと同じ考え方): レース単位で、購入したいずれかの馬券が的中(払戻>0)していれば「的中」とみなす。
// 判定対象(分母)に含めるのは、購入履歴に払戻が入力されている場合に加えて、
// 着順(finish_order)またはレース払戻(payouts)のいずれかが確定しているレース。
// 着順だけ確定していて払戻レート未入力の場合、勝ち馬券の判定はできないが
// 「結果は出ている」ため分母には含める(payoutが入っていない=このレースでは不的中として扱う)。
function computeHitRate(tickets) {
  const byRace = groupBy(tickets, (t) => t.race_id);
  let judgedRaces = 0;
  let hitRaces = 0;
  for (const raceTickets of byRace.values()) {
    const t0 = raceTickets[0];
    const hasTicketPayout = raceTickets.some((t) => t.payout !== null && t.payout !== undefined);
    const raceResultKnown = hasRaceResult(t0?.race_finish_order) || hasRaceResult(t0?.race_payouts);
    const judged = hasTicketPayout || raceResultKnown;
    if (!judged) continue;
    judgedRaces++;
    if (raceTickets.some((t) => t.payout !== null && t.payout !== undefined && t.payout > 0)) hitRaces++;
  }
  const rate = judgedRaces > 0 ? Math.round((hitRaces / judgedRaces) * 1000) / 10 : null;
  return { judgedRaces, hitRaces, rate };
}

// JSON文字列(TEXT列)として保存されたfinish_order/payoutsが実質的な値を持つか判定する。
function hasRaceResult(value) {
  if (value === null || value === undefined || value === "") return false;
  if (value === "[]" || value === "{}") return false;
  return true;
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

// ---------- 表の列ソート ----------
// 各テーブルの現在のソート状態(キー・方向)を保持する。列ヘッダーをクリックするたびに更新する。
// key: "date"(レース別のみ)/"name"(競馬場別・騎手別)/"amount"/"payout"/"profit"/"rate"/"hitRate"
const sortState = {
  race: { key: "date", dir: "desc" },
  track: { key: "totalAmount", dir: "desc" },
  jockey: { key: "totalAmount", dir: "desc" },
};

// ソート対象の行データ(再計算せず並べ替えだけで再描画できるようキャッシュしておく)
let raceRows = [];
let trackRows = [];
let jockeyRows = [];

const STAT_COLUMNS = [
  { key: "totalAmount", label: "購入" },
  { key: "settledPayout", label: "払戻(確定)" },
  { key: "profit", label: "収支" },
  { key: "rate", label: "回収率" },
  { key: "hitRate", label: "的中率" },
];

// nullは常に末尾(方向によらず)、それ以外は指定方向で比較する。
function compareValues(av, bv, dir) {
  const factor = dir === "asc" ? 1 : -1;
  const an = av === null || av === undefined;
  const bn = bv === null || bv === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (av < bv) return -1 * factor;
  if (av > bv) return 1 * factor;
  return 0;
}

function sortRows(rows, key, dir) {
  return [...rows].sort((a, b) => {
    if (key === "date") return compareValues(a.dateKey, b.dateKey, dir);
    if (key === "name") return compareValues(a.name, b.name, dir);
    return compareValues(a.stats[key], b.stats[key], dir);
  });
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
  `;
}

function sortIndicator(tableKey, key) {
  const state = sortState[tableKey];
  if (state.key !== key) return "";
  return state.dir === "asc" ? " ▲" : " ▼";
}

function renderTable(elId, tableKey, labelHeader, labelKey) {
  const table = document.getElementById(elId);
  const rowsCache = { race: raceRows, track: trackRows, jockey: jockeyRows }[tableKey];
  const state = sortState[tableKey];
  const rows = sortRows(rowsCache, state.key, state.dir);

  if (rows.length === 0) {
    table.innerHTML = `<tr><td class="table-empty">データがありません</td></tr>`;
    return;
  }

  const head = `
    <tr>
      <th class="sortable-th" data-sort-key="${labelKey}">${labelHeader}${sortIndicator(tableKey, labelKey)}</th>
      ${STAT_COLUMNS.map((c) => `<th class="sortable-th" data-sort-key="${c.key}">${c.label}${sortIndicator(tableKey, c.key)}</th>`).join("")}
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
      </tr>
    `
    )
    .join("");
  table.innerHTML = head + body;

  table.querySelectorAll(".sortable-th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (state.key === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.key = key;
        // 金額・率などの数値列は「大きい順」から見たい場合が多いため降順を初期方向にする。
        // 日付・名前(文字列)列は昇順を初期方向にする。
        state.dir = key === "date" || key === "name" ? "asc" : "desc";
      }
      renderTable(elId, tableKey, labelHeader, labelKey);
    });
  });
}

function renderRaceTable(items) {
  const groups = groupBy(items, (t) => `${t.race_date}__${t.track}__${t.race_number}`);
  raceRows = Array.from(groups.entries()).map(([key, tickets]) => {
    const t0 = tickets[0];
    return {
      name: `${formatDate(t0.race_date)} ${t0.track} ${t0.race_number}R${t0.race_name ? " " + t0.race_name : ""}`,
      // 初期表示は「日付・競馬場・レース番号」の順でソートするため、この3つを連結したキーで比較する。
      dateKey: `${t0.race_date}_${t0.track}_${String(t0.race_number).padStart(2, "0")}`,
      stats: computeGroupStats(tickets),
    };
  });
  renderTable("race-table", "race", "レース", "date");
}

function renderTrackTable(items) {
  const groups = groupBy(items, (t) => t.track);
  trackRows = Array.from(groups.entries()).map(([track, tickets]) => ({ name: track, stats: computeGroupStats(tickets) }));
  renderTable("track-table", "track", "競馬場", "name");
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
  jockeyRows = Array.from(jockeyMap.entries()).map(([jockey, tickets]) => ({ name: jockey, stats: computeGroupStats(tickets) }));
  renderTable("jockey-table", "jockey", "騎手", "name");
}


async function fetchImportedTicketHistory() {
  try {
    const res = await authedFetch("/api/ticket-imports");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  } catch {
    return [];
  }
}

async function loadAndRender() {
  const [ticketRes, importedRes] = await Promise.all([authedFetch("/api/tickets"), authedFetch("/api/ticket-imports")]);
  if (!ticketRes.ok) return;
  const items = await ticketRes.json();
  const importedPayload = importedRes.ok ? await importedRes.json() : {items: []};
  const imported = Array.isArray(importedPayload.items) ? importedPayload.items : [];
  const all = [...(Array.isArray(items) ? items : []), ...imported];
  renderOverall(all);
  renderRaceTable(all);
  renderTrackTable(all);
  renderJockeyTable(all);
}

// escapeHtml は utils.js のものを使用する

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

setupAuth(loadAndRender);
