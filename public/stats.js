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
    // レースの取りやめ(2026-10-23。全部返還)は的中率の判定対象にしない(不的中のレースとして分母に入れない)
    if (parsePayoutsJson(t0?.race_payouts)?.race_cancelled === true) continue;
    const hasTicketPayout = raceTickets.some((t) => t.payout !== null && t.payout !== undefined);
    // race_payoutsはJOIN元(races.payouts)のJSON文字列そのままなので、判定前にパースする。
    // 2026-08-23修正: payouts.refunds(取消・除外・中止馬の馬番/枠番の記録であり、
    // 実際の払戻レートではない)のみが入っている場合に、着順未確定でも「結果確定済」と
    // 誤って的中率の判定対象(分母)に含めてしまう不具合があった。実際の払戻レートが
    // 1件以上あるかどうかで判定する共通関数 hasSettledPayoutRates()(public/utils.js)を
    // 使うよう修正した。
    const raceResultKnown = hasRaceResult(t0?.race_finish_order) || hasSettledPayoutRates(parsePayoutsJson(t0?.race_payouts));
    const judged = hasTicketPayout || raceResultKnown;
    if (!judged) continue;
    judgedRaces++;
    // 2026-08-20修正: 返還(refunded=1)された馬券は、payout(=購入金額と同額)が0より
    // 大きくても「的中」ではないため、的中率のカウント対象から除外する
    // (docs/design/payout-refund.md「返還(refund)処理」参照)。
    if (raceTickets.some((t) => t.payout !== null && t.payout !== undefined && t.payout > 0 && !t.refunded)) hitRaces++;
  }
  const rate = judgedRaces > 0 ? Math.round((hitRaces / judgedRaces) * 1000) / 10 : null;
  return { judgedRaces, hitRaces, rate };
}

// JSON文字列(TEXT列)として保存されたfinish_orderが実質的な値を持つか判定する
// (race_payoutsの判定は上記の通りhasSettledPayoutRates()に統一したため、
// この関数はfinish_order専用として使う)。
function hasRaceResult(value) {
  if (value === null || value === undefined || value === "") return false;
  if (value === "[]" || value === "{}") return false;
  return true;
}

// race_payouts(races.payoutsのJSON文字列)を安全にパースする。
// 不正な値・空値の場合はnullを返し、呼び出し側のhasSettledPayoutRates()がfalseを返す。
function parsePayoutsJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
//
// 騎手別収支の初期ソートは「回収率(rate)の高い順」とする(以前は購入金額の多い順だったが、
// 収支効率を優先して確認したいという要望に合わせて変更した)。回収率が未確定(null)の行は
// compareValues() の仕様により、ソート方向によらず常に末尾に表示される。
const sortState = {
  race: { key: "date", dir: "desc" },
  track: { key: "totalAmount", dir: "desc" },
  course: { key: "totalAmount", dir: "desc" },
  jockey: { key: "rate", dir: "desc" },
};

// ソート対象の行データ(再計算せず並べ替えだけで再描画できるようキャッシュしておく)
let raceRows = [];
let trackRows = [];
let courseRows = [];
let jockeyRows = [];

const STAT_COLUMNS = [
  { key: "totalAmount", label: "購入" },
  { key: "settledPayout", label: "払戻(確定)" },
  { key: "profit", label: "収支" },
  { key: "rate", label: "回収率" },
  { key: "hitRate", label: "的中率" },
];

// レース別収支は1レースあたりの的中率が0%か100%にしかならず表示する意味が薄いため、
// 的中率列を除外する。競馬場別・騎手別は複数レースにまたがる集計のため引き続き表示する。
const STAT_COLUMNS_BY_TABLE = {
  race: STAT_COLUMNS.filter((c) => c.key !== "hitRate"),
  track: STAT_COLUMNS,
  course: STAT_COLUMNS,
  jockey: STAT_COLUMNS,
};

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
    // 名前列は、表示名とは別に sortKey があればそれで比較する
    // (コース別: 「競馬場→芝/ダ/障→距離昇順」で並ぶよう padding 済みキーを使う)。
    if (key === "name") return compareValues(a.sortKey ?? a.name, b.sortKey ?? b.name, dir);
    return compareValues(a.stats[key], b.stats[key], dir);
  });
}

function renderOverall(items) {
  const s = computeGroupStats(items);
  const el = document.getElementById("overall-summary");
  el.innerHTML = `
    <div class="overall-card">
      <span class="overall-label">総購入金額</span>
      <span class="overall-value">${formatYen(s.totalAmount)}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">総払戻金額(確定分)</span>
      <span class="overall-value">${formatYen(s.settledPayout)}</span>
    </div>
    <div class="overall-card">
      <span class="overall-label">収支</span>
      <span class="overall-value ${s.profit >= 0 ? "profit-plus" : "profit-minus"}">${formatSignedYen(s.profit)}</span>
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

// ---------- 総合成績: 購入比率バー ----------
// 3種類の棒グラフ(馬券種別別 / 競馬場別 / 騎手別)で購入金額の比率を表示する。
// 分母はいずれも「全購入の合計金額(未確定を含む)」。バーの幅は比率(%)そのもの。
//   - 馬券種別別: bet_type ごとに amount を合算。BET_TYPES の定義順で並べ、定義外の
//     bet_type(不明等)は末尾に回す。
//   - 競馬場別: track ごとに amount を合算。金額の多い順。track 空欄は「競馬場不明」。
//   - 騎手別: 1枚に複数騎手が絡む場合は各騎手へ全額を計上する(按分しない。既存の
//     「騎手別収支」表と同じ方針)。そのためバーの合計は 100% を超えることがある。
//     金額の多い順に上位10名を表示し、残りは「その他(N名)」1本に集約する。
//     騎手情報を持たない購入(CSV取込分など)は計上されない。
const JOCKEY_RATIO_TOP_N = 10;

function ratioRowsFromMap(amountByName, total) {
  return Array.from(amountByName.entries())
    .map(([name, amount]) => ({ name, amount, pct: total > 0 ? (amount / total) * 100 : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

function renderRatioBars(elId, rows, total) {
  const el = document.getElementById(elId);
  if (rows.length === 0 || total <= 0) {
    el.innerHTML = `<p class="ratio-empty">データがありません</p>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (r) => `
      <div class="ratio-row">
        <span class="ratio-label" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        <span class="ratio-bar"><span class="ratio-bar-fill" style="width:${Math.min(r.pct, 100).toFixed(1)}%"></span></span>
        <span class="ratio-value"><span class="ratio-pct">${r.pct.toFixed(1)}%</span><span class="ratio-yen">${formatYen(r.amount)}</span></span>
      </div>
    `
    )
    .join("");
}

function renderRatioBreakdowns(items) {
  const total = items.reduce((s, t) => s + Number(t.amount || 0), 0);

  // 馬券種別別
  const byBetType = new Map();
  for (const t of items) {
    const key = t.bet_type || "不明";
    byBetType.set(key, (byBetType.get(key) || 0) + Number(t.amount || 0));
  }
  const betTypeRows = [];
  for (const key of BET_TYPE_ORDER) {
    if (!byBetType.has(key)) continue;
    const amount = byBetType.get(key);
    betTypeRows.push({ name: betTypeLabel(key), amount, pct: total > 0 ? (amount / total) * 100 : 0 });
  }
  for (const [key, amount] of byBetType) {
    if (BET_TYPE_ORDER.includes(key)) continue;
    betTypeRows.push({ name: betTypeLabel(key), amount, pct: total > 0 ? (amount / total) * 100 : 0 });
  }
  renderRatioBars("ratio-bettype", betTypeRows, total);

  // 競馬場別(金額の多い順)
  const byTrack = new Map();
  for (const t of items) {
    const key = String(t.track || "").trim() || "競馬場不明";
    byTrack.set(key, (byTrack.get(key) || 0) + Number(t.amount || 0));
  }
  renderRatioBars("ratio-course", ratioRowsFromMap(byTrack, total), total);

  // 騎手別(全額を各騎手に計上・金額の多い順・上位N + その他)
  const byJockey = new Map();
  for (const t of items) {
    const jockeys = new Set(
      (t.selections || [])
        .map((s) => s.jockey)
        .filter((j) => j && j.trim() !== "")
    );
    for (const jockey of jockeys) {
      byJockey.set(jockey, (byJockey.get(jockey) || 0) + Number(t.amount || 0));
    }
  }
  const jockeyRowsAll = ratioRowsFromMap(byJockey, total);
  const jockeyRows = jockeyRowsAll.slice(0, JOCKEY_RATIO_TOP_N);
  const rest = jockeyRowsAll.slice(JOCKEY_RATIO_TOP_N);
  if (rest.length > 0) {
    const restAmount = rest.reduce((s, r) => s + r.amount, 0);
    jockeyRows.push({
      name: `その他(${rest.length}名)`,
      amount: restAmount,
      pct: total > 0 ? (restAmount / total) * 100 : 0,
    });
  }
  renderRatioBars("ratio-jockey", jockeyRows, total);
}

function sortIndicator(tableKey, key) {
  const state = sortState[tableKey];
  if (state.key !== key) return "";
  return state.dir === "asc" ? " ▲" : " ▼";
}

function renderTable(elId, tableKey, labelHeader, labelKey) {
  const table = document.getElementById(elId);
  const rowsCache = { race: raceRows, track: trackRows, course: courseRows, jockey: jockeyRows }[tableKey];
  const state = sortState[tableKey];
  const rows = sortRows(rowsCache, state.key, state.dir);

  if (rows.length === 0) {
    table.innerHTML = `<tr><td class="table-empty">データがありません</td></tr>`;
    return;
  }

  const columns = STAT_COLUMNS_BY_TABLE[tableKey] || STAT_COLUMNS;
  const CELL_RENDERERS = {
    totalAmount: (s) => `<td>${formatYen(s.totalAmount)}</td>`,
    settledPayout: (s) => `<td>${formatYen(s.settledPayout)}</td>`,
    profit: (s) => `<td class="${s.profit >= 0 ? "profit-plus" : "profit-minus"}">${formatSignedYen(s.profit)}</td>`,
    rate: (s) => `<td>${s.rate !== null ? s.rate + "%" : "-"}</td>`,
    hitRate: (s) => `<td>${s.hitRate !== null ? s.hitRate + "%" : "-"}</td>`,
  };

  const head = `
    <tr>
      <th class="sortable-th" data-sort-key="${labelKey}">${labelHeader}${sortIndicator(tableKey, labelKey)}</th>
      ${columns.map((c) => `<th class="sortable-th" data-sort-key="${c.key}">${c.label}${sortIndicator(tableKey, c.key)}</th>`).join("")}
    </tr>
  `;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="table-name">${escapeHtml(r.name)}</td>
        ${columns.map((c) => CELL_RENDERERS[c.key](r.stats)).join("")}
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

// レース名の表示は race_base_name(races.race_base_name。回次「第N回」を除いたベース名。
// 常に最新のraces側の値)を優先し、無ければ race_name(購入時点のスナップショット)に
// フォールバックする。race_name をそのまま使うと、購入後にレース名を修正しても
// 表示に反映されない・結果PDF解析のズレでグレードバッジが混入したままになる、
// という問題があったため(2026-09-24。docs/design/data-model.md「races.race_base_name」参照)。
function renderRaceTable(items) {
  const groups = groupBy(items, (t) => `${t.race_date}__${t.track}__${t.race_number}`);
  raceRows = Array.from(groups.entries()).map(([key, tickets]) => {
    const t0 = tickets[0];
    const displayName = t0.race_base_name || t0.race_name;
    return {
      name: `${formatDateMd(t0.race_date)} ${t0.track} ${t0.race_number}R${displayName ? " " + displayName : ""}`,
      // 初期表示は「日付・競馬場・レース番号」の順でソートするため、この3つを連結したキーで比較する。
      dateKey: `${t0.race_date}_${t0.track}_${String(t0.race_number).padStart(2, "0")}`,
      stats: computeGroupStats(tickets),
    };
  });
  renderTable("race-table", "race", "レース", "date");
}

// 競馬場別収支: trackのみでまとめる(コース種別・距離では分けない。コース別収支より
// 粗い粒度)。総合成績タブの「競馬場別 購入比率」棒グラフ(byTrack)と同じ集計単位。
function renderTrackTable(items) {
  const groups = groupBy(items, (t) => String(t.track || "").trim() || "競馬場不明");
  trackRows = Array.from(groups.entries()).map(([track, tickets]) => ({
    name: track,
    stats: computeGroupStats(tickets),
  }));
  renderTable("track-table", "track", "競馬場", "name");
}

// コース別収支: 「競馬場 × コース種別(芝/ダート/障害) × 距離」でまとめる。
// レースにコース情報が無い(course_type未入力)購入は「(競馬場)コース未登録」に集約する
// フォールバック。course_typeはあるが距離だけ無い場合は「(競馬場) 芝」のように距離を省く
// (formatCourseTextの挙動)。距離は正確な値ごとに1行(例: 東京 芝1600m)。
// コース種別(芝/ダート/障害)が分からない購入は、距離が入っていても「コース未登録」に
// 集約する(芝1600かダ1600かを区別できないため)。
function courseGroupLabel(t) {
  const track = String(t.track || "").trim() || "競馬場不明";
  if (!t.race_course_type) return `${track} コース未登録`;
  return `${track} ${formatCourseText(t.race_course_type, t.race_distance)}`; // "東京 芝1600m" / "東京 芝"
}
function courseSortKey(t) {
  const track = String(t.track || "").trim() || "￿";
  const surfaceOrder = { "芝": "1", "ダート": "2", "障害": "3" }[t.race_course_type] || "9";
  const dist = t.race_course_type ? String(Number(t.race_distance) || 0).padStart(5, "0") : "00000";
  return `${track}|${surfaceOrder}|${dist}`;
}
function renderCourseTable(items) {
  const groups = groupBy(items, (t) => {
    const track = String(t.track || "").trim();
    const ct = t.race_course_type || "";
    const dist = ct ? (t.race_distance || "") : "";
    return `${track}|${ct}|${dist}`;
  });
  courseRows = Array.from(groups.values()).map((tickets) => {
    const t0 = tickets[0];
    return { name: courseGroupLabel(t0), sortKey: courseSortKey(t0), stats: computeGroupStats(tickets) };
  });
  renderTable("course-table", "course", "コース", "name");
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

// ---------- 馬別収支(2026-10-15追加。docs/design/stats-rules.md「馬別収支」) ----------
// 1枚の馬券に複数の馬が絡む場合、関係する馬それぞれに全額を計上する(騎手別と同じ。按分しない)。
// 同じ馬は馬名を NFKC にして空白を除いた値で突き合わせる(サーバーの horseAliasKeyOf と同じ考え方。購入時点の馬名は
// 出走馬表〈馬名エイリアスを通して保存〉から入るため、エイリアスは画面では通さない)。表示名はその馬の一番新しい購入の馬名。
// 枠連(selections の馬番は枠番)と、馬名の無い選択は対象外。購入回数 = その馬を含む馬券を買ったレースの数(BOX等の組数で増えないように)。
const HORSE_TOP_N = 10;
// 回収率の順位に入れる最低の購入回数。2026-10-15: 当初3回以上にしたが、1回だけの大当たりの馬も見たいとのユーザー要望で1にした
const HORSE_RATE_MIN_RACES = 1;
const HORSE_SEARCH_MAX = 50;
let horseGroups = []; // [{ key, name, stats, races }]

function horseStatsKeyOf(name) {
  return String(name || "").normalize("NFKC").replace(/\s/g, "");
}

function raceKeyOfTicket(t) {
  return t.race_id != null ? `id:${t.race_id}` : `${t.race_date || ""}|${t.track || ""}|${t.race_number || ""}`;
}

function renderHorseTables(items) {
  const byKey = new Map(); // key -> { name, date, tickets, races }
  for (const t of items) {
    if (t.bet_type === "wakuren") continue;
    const keys = new Map();
    for (const s of t.selections || []) {
      const k = horseStatsKeyOf(s?.horse_name);
      if (k) keys.set(k, String(s.horse_name).trim());
    }
    for (const [k, name] of keys) {
      let g = byKey.get(k);
      if (!g) byKey.set(k, (g = { name, date: "", tickets: [], races: new Set() }));
      const d = String(t.race_date || "");
      if (d >= g.date) { g.date = d; g.name = name; }
      g.tickets.push(t);
      g.races.add(raceKeyOfTicket(t));
    }
  }
  horseGroups = [...byKey.entries()].map(([key, g]) => ({ key, name: g.name, stats: computeGroupStats(g.tickets), races: g.races.size }));

  const byAmount = [...horseGroups].sort((a, b) => b.stats.totalAmount - a.stats.totalAmount || b.races - a.races);
  const byRate = horseGroups.filter((g) => g.races >= HORSE_RATE_MIN_RACES && g.stats.rate !== null)
    .sort((a, b) => b.stats.rate - a.stats.rate || b.stats.totalAmount - a.stats.totalAmount);
  const byCount = [...horseGroups].sort((a, b) => b.races - a.races || b.stats.totalAmount - a.stats.totalAmount);
  renderHorseTable("horse-amount-table", byAmount.slice(0, HORSE_TOP_N), true);
  renderHorseTable("horse-rate-table", byRate.slice(0, HORSE_TOP_N), true);
  renderHorseTable("horse-count-table", byCount.slice(0, HORSE_TOP_N), true);
  const note = document.getElementById("horse-rate-note");
  if (note) note.textContent = "購入1回だけの馬も含みます(購入回数の列で確かめてください)。回収率が同じなら購入額の多い順。";
  renderHorseSearch();
}

// withRank: 先頭に順位の列を付ける
function renderHorseTable(elId, rows, withRank) {
  const table = document.getElementById(elId);
  if (!table) return;
  if (!rows.length) {
    table.innerHTML = `<tr><td class="table-empty">データがありません</td></tr>`;
    return;
  }
  const head = `<tr>${withRank ? "<th>順位</th>" : ""}<th>馬名</th><th>購入回数</th><th>購入</th><th>払戻(確定)</th><th>収支</th><th>回収率</th><th>的中率</th></tr>`;
  const body = rows.map((g, i) => {
    const s = g.stats;
    return `<tr>${withRank ? `<td>${i + 1}</td>` : ""}
      <td class="table-name">${escapeHtml(g.name)}</td>
      <td>${g.races}</td>
      <td>${formatYen(s.totalAmount)}</td>
      <td>${formatYen(s.settledPayout)}</td>
      <td class="${s.profit >= 0 ? "profit-plus" : "profit-minus"}">${formatSignedYen(s.profit)}</td>
      <td>${s.rate !== null ? s.rate + "%" : "-"}</td>
      <td>${s.hitRate !== null ? s.hitRate + "%" : "-"}</td></tr>`;
  }).join("");
  table.innerHTML = head + body;
}

// 馬名検索: 入力を含む馬(全角半角・空白をそろえて比べる)を購入額の多い順に最大 HORSE_SEARCH_MAX 頭
function renderHorseSearch() {
  const input = document.getElementById("horse-stats-search");
  const wrap = document.getElementById("horse-stats-search-result");
  if (!input || !wrap) return;
  const q = horseStatsKeyOf(input.value);
  if (!q) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const hits = horseGroups.filter((g) => g.key.includes(q)).sort((a, b) => b.stats.totalAmount - a.stats.totalAmount);
  const note = document.getElementById("horse-stats-search-note");
  if (note) note.textContent = hits.length > HORSE_SEARCH_MAX ? `${hits.length}頭が当てはまります(購入額の多い順に${HORSE_SEARCH_MAX}頭まで表示)` : `${hits.length}頭`;
  renderHorseTable("horse-search-table", hits.slice(0, HORSE_SEARCH_MAX), false);
}
document.getElementById("horse-stats-search")?.addEventListener("input", renderHorseSearch);

// ---------- レース区分フィルタ(総合成績・レース別。2026-09-19追加) ----------
// 各購入(t.race_category: "graded"/"condition"/"other")を「すべて/重賞のみ/条件戦のみ」で
// 絞り込む。タブごとに独立した選択状態を持つ(docs/design/graded-races.md参照)。
// レース情報が無い(race_idが無いレガシー取込等)購入はrace_category:"other"となり、
// 「重賞のみ」「条件戦のみ」には出てこず「すべて」にのみ含まれる。
const categoryFilterState = { overall: "all", race: "all" };

// 中央競馬(JRA)10場。これ以外の競馬場は地方競馬として扱う(競馬場名が空の購入は
// どちらにも含めず「すべて」にのみ出る)。buy.js の RACE_TRACK_ORDER と同じ場の一覧。
const JRA_TRACKS = new Set(["東京", "中山", "京都", "阪神", "札幌", "函館", "福島", "新潟", "中京", "小倉"]);

function filterByCategory(items, mode) {
  if (mode === "all") return items;
  if (mode === "jra") return items.filter((t) => JRA_TRACKS.has(String(t.track || "").trim()));
  if (mode === "local") {
    return items.filter((t) => {
      const track = String(t.track || "").trim();
      return track && !JRA_TRACKS.has(track);
    });
  }
  return items.filter((t) => t.race_category === mode);
}

function setupCategoryFilter(elId, tabKey, onChange) {
  const wrap = document.getElementById(elId);
  if (!wrap) return;
  wrap.querySelectorAll(".horse-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.value === categoryFilterState[tabKey]) return;
      wrap.querySelectorAll(".horse-row-btn").forEach((b) => b.classList.toggle("active", b === btn));
      categoryFilterState[tabKey] = btn.dataset.value;
      onChange();
    });
  });
}

let allTickets = [];

async function loadAndRender() {
  const [ticketRes, importedRes] = await Promise.all([authedFetch("/api/tickets"), authedFetch("/api/ticket-imports")]);
  if (!ticketRes.ok) return;
  const items = await ticketRes.json();
  const importedPayload = importedRes.ok ? await importedRes.json() : {items: []};
  const imported = Array.isArray(importedPayload.items) ? importedPayload.items : [];
  allTickets = [...(Array.isArray(items) ? items : []), ...imported];

  renderOverall(filterByCategory(allTickets, categoryFilterState.overall));
  renderRatioBreakdowns(filterByCategory(allTickets, categoryFilterState.overall));
  renderRaceTable(filterByCategory(allTickets, categoryFilterState.race));
  renderTrackTable(allTickets);
  renderCourseTable(allTickets);
  renderJockeyTable(allTickets);
  renderHorseTables(allTickets);
}

setupCategoryFilter("overall-category-filter", "overall", () => {
  renderOverall(filterByCategory(allTickets, categoryFilterState.overall));
  renderRatioBreakdowns(filterByCategory(allTickets, categoryFilterState.overall));
});
setupCategoryFilter("race-category-filter", "race", () => {
  renderRaceTable(filterByCategory(allTickets, categoryFilterState.race));
});

// escapeHtml / formatDateMd は utils.js のものを使用する
// (2026-09-07: ローカルの formatDate("8/24"形式)を撤去し utils.js の
//  formatDateMd に統合。呼び出し側も formatDateMd へ変更済み)

setupAuth(loadAndRender);
