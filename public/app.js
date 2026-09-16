const raceList = document.getElementById("race-list");
const emptyState = document.getElementById("empty-state");
const summaryBar = document.getElementById("summary-bar");
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
  const filterRow = document.getElementById("history-filter-row");
  if (filterRow) filterRow.hidden = false;
  historyFilterLabel.textContent = `${formatDate(selectedHistoryDate)}の履歴を表示中`;
  renderList(dayItems);
  if (selectionMode) syncBulkSelectionUi();
}

// 2026-09-13: GET /api/races は ?since= (直近1ヶ月+未来レース全部) に絞って呼ぶ
// (docs/design/data-model.md「GET /api/races の範囲限定」参照)。この画面での races は
// 金額編集時の払戻再計算(下記 races.find 部分)にしか使わないため、対象が範囲外
// (古い購入履歴)の場合は GET /api/races/:id でその場で個別取得する。
async function loadTickets() {
  const since = monthsAgoDateKey(1);
  const [ticketsRes, racesRes, importedRes] = await Promise.all([
    authedFetch("/api/tickets"),
    authedFetch(`/api/races?since=${since}`),
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

  if (selectionMode && items.length) {
    const hint = document.createElement("p");
    hint.className = "bulk-hint";
    hint.textContent = "削除したい購入をタップして選択(レース見出しをタップするとそのレースの通常購入をまとめて選択)。選べるのは通常購入のみです。";
    raceList.appendChild(hint);
  }

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
  // 選択モード中は全レースを開いた状態にして、グループ単位でも選べるようにする。
  const isExpanded = selectionMode ? true : expandedRaces.has(raceKey);

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
  head.className = "race-card-head" + (showRaceCheck ? " bulk-selectable" : "");
  head.innerHTML = `
    ${showRaceCheck ? `<span class="bulk-check-wrap"><input type="checkbox" class="bulk-check bulk-check-race" data-ids="${raceTicketIds.join(",")}" tabindex="-1" /></span>` : ""}
    ${selectionMode ? "" : `<span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>`}
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

  head.addEventListener("click", () => {
    if (selectionMode) {
      // レース見出しのタップ = そのレースの通常購入を「全選択 ⇔ 全解除」。
      if (raceTicketIds.length === 0) return;
      const allSelected = raceTicketIds.every((id) => selectedTicketIds.has(id));
      for (const id of raceTicketIds) {
        if (allSelected) selectedTicketIds.delete(id);
        else selectedTicketIds.add(id);
      }
      syncBulkSelectionUi();
      return;
    }
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
  const status = ticketGroupStatus(group);

  const wrap = document.createElement("div");
  wrap.className = "group-card";

  // 一括削除の対象は通常購入のみ。CSV取込・レガシー取込グループにはチェックボックスを出さない。
  const groupTicketIds = first.imported ? [] : group.map((t) => Number(t.id)).filter((n) => Number.isInteger(n));
  const showGroupCheck = selectionMode && groupTicketIds.length > 0;

  const head = document.createElement("div");
  head.className = "group-card-head" + (showGroupCheck ? " bulk-selectable" : "");
  head.innerHTML = `
    ${showGroupCheck ? `<span class="bulk-check-wrap"><input type="checkbox" class="bulk-check bulk-check-group" data-ids="${groupTicketIds.join(",")}" tabindex="-1" /></span>` : ""}
    ${selectionMode ? "" : `<span class="expand-arrow">▸</span>`}
    <span class="bet-badge">${betTypeLabel(first.bet_type)}</span>
    <span class="method-badge">${methodLabel(first.method)}</span>
    <span class="point-count">${group.length}点</span>
    <span class="group-money">${ticketMoneyText(group)}</span>
    <span class="status-badge ${status === "確定済み" ? "settled" : ""}">${status}</span>
  `;
  wrap.appendChild(head);

  head.addEventListener("click", () => {
    if (selectionMode) {
      // 選択モード中は購入方式グループの見出しタップ = そのグループを選択 ⇔ 解除。
      if (groupTicketIds.length === 0) return;
      const allSelected = groupTicketIds.every((id) => selectedTicketIds.has(id));
      for (const id of groupTicketIds) {
        if (allSelected) selectedTicketIds.delete(id);
        else selectedTicketIds.add(id);
      }
      syncBulkSelectionUi();
      return;
    }
    // 2026-09-16: インライン展開の代わりに馬券風デザインのダイアログを開く
    // (docs/design/screens.md「購入方式グループのダイアログ(馬券風デザイン)」参照)。
    openTicketDialog(group);
  });

  return wrap;
}

// ---------- 購入方式グループのダイアログ(馬券風デザイン。2026-09-16〜) ----------
//
// レース単位のアコーディオンを開いた後、式別の行(.group-card-head)をタップした時の
// 挙動を、従来の「インライン展開」から「本物の馬券(印字済みの購入済み馬券)を模した
// 専用デザインのダイアログ表示」に変更した。ダイアログ右上の「金額変更」ボタンは、
// 券面の下に従来と同じ明細行(買い目ごとの金額入力・CSV取込は払戻入力・削除ボタン)を
// 開閉表示する(旧「内訳を見る/隠す」ボタンの置き換え。挙動・APIは変更していない)。
// 詳細は docs/design/screens.md 参照。

// 券面の縦帯に載せるJRA公式の英語表記(複数行のものは配列の要素ごとに改行)。
const TICKET_EN_LABELS = {
  tan: ["WIN"],
  fuku: ["PLACE", "SHOW"],
  wakuren: ["BRACKET", "QUINELLA"],
  umaren: ["QUINELLA"],
  wide: ["QUINELLA", "PLACE"],
  umatan: ["EXACTA"],
  sanrenpuku: ["TRIO"],
  sanrentan: ["TRIFECTA"],
};

// 実際の馬券では三連複・三連単は「三」ではなく算用数字「3」で印字されるため、
// 縦書き部分だけこの表記を使う(式別バッジ等、他の表示は betTypeLabel() のまま)。
const TICKET_BET_TYPE_TEXT = {
  sanrenpuku: "3連複",
  sanrentan: "3連単",
};
function ticketBetTypeText(betType) {
  return TICKET_BET_TYPE_TEXT[betType] || betTypeLabel(betType);
}

// 購入方式(1点のみなら不要)を券面の方式ボックスに出す際の和文・英文ラベル。
const TICKET_METHOD_LABELS = {
  box: { ja: "ボックス", en: "BOX" },
  nagashi: { ja: "ながし", en: "WHEEL" },
  axis1: { ja: "軸1頭ながし", en: "WHEEL" },
  axis2: { ja: "軸2頭ながし", en: "WHEEL" },
  multi: { ja: "マルチ", en: "WHEEL" },
  axis2_multi: { ja: "軸2頭マルチ", en: "WHEEL" },
  formation: { ja: "フォーメーション", en: "" },
};
function ticketMethodBoxLabel(method) {
  return TICKET_METHOD_LABELS[method] || { ja: methodLabel(method), en: "" };
}

// 縦帯の式別名(「単勝」等)は CSS の writing-mode:vertical-rl だと環境によって
// 漢字グリフが正しく縦回転されない(潰れて表示される)ことがあるため使わず、
// 1文字ずつ<span>で区切って縦に積む(どの環境でも通常の横書きレンダリングの
// まま並ぶだけなので確実)。
function ticketVerticalTextHtml(text) {
  return [...String(text)].map((c) => `<span class="ticket-vchar">${escapeHtml(c)}</span>`).join("");
}

// 馬番を実物の馬券のような四角囲み数字で表示する(1点のみの買い目・ボックス等の
// 複数点買い目のいずれでも使う共通パーツ)。
function ticketNumBoxHtml(num) {
  return `<span class="ticket-num-box">${escapeHtml(String(num))}</span>`;
}

// 1点のみの買い目(通常の単発購入)の券面表示。単勝・複勝は馬番ボックス+馬名、
// それ以外(馬連・馬単・ワイド・枠連・三連複・三連単の通常1点買い)は馬番ボックスを
// 着順あり(ordered)なら▶、着順なしなら－でつなぐ(参考にした馬券画像ジェネレーターの
// 表示に合わせた。複数頭の場合は馬名を出さない)。
function ticketSingleSelectionHtml(betType, selections) {
  const list = selections || [];
  if (list.length === 0) return "";
  if (list.length === 1) {
    const s = list[0];
    return `<div class="ticket-selection-line">${ticketNumBoxHtml(s.horse_number)}<span class="ticket-horse-name">${escapeHtml(s.horse_name || "")}</span></div>`;
  }
  const def = BET_TYPES[betType] || { ordered: false };
  const sepHtml = def.ordered ? `<span class="ticket-sep-arrow">▶</span>` : `<span class="ticket-sep-dash">－</span>`;
  return `<div class="ticket-selection-line">${list.map((s) => ticketNumBoxHtml(s.horse_number)).join(sepHtml)}</div>`;
}

// 複数点(ボックス・ながし・フォーメーション等)の買い目の券面表示。
// ticket-view.js の describeGroupSelections() (軸馬/相手・着順ごとの集合・馬番一覧の
// いずれかを返す。既存のIPAT風コンパクト表示と同じ判定ロジックを再利用)の結果を、
// 数字ボックスの並びとして描画し直す。
function ticketMultiSelectionHtml(betType, group) {
  const lines = describeGroupSelections(betType, group);
  if (!lines) return "";

  // 軸馬/相手(1頭軸・2頭軸ながし等)。それぞれ見出しラベル付きの行として並べる。
  if (lines.length === 2 && lines[0].label === "軸馬") {
    return lines
      .map(
        (l) => `<div class="ticket-axis-group">
          <span class="ticket-axis-label">(${l.label === "軸馬" ? "軸" : "相手"})</span>
          <div class="ticket-num-row">${l.values.map(ticketNumBoxHtml).join("")}</div>
        </div>`
      )
      .join("");
  }

  // 着順ごとに集合が異なる(フォーメーション)。着順あり券種は▶、着順なしは－でつなぐ。
  if (lines.length > 1) {
    const def = BET_TYPES[betType] || { ordered: false };
    const sepHtml = def.ordered ? `<span class="ticket-sep-arrow">▶</span>` : `<span class="ticket-sep-dash">－</span>`;
    return `<div class="ticket-formation-row">${lines
      .map((l) => `<span class="ticket-formation-col">${l.values.map(ticketNumBoxHtml).join("")}</span>`)
      .join(sepHtml)}</div>`;
  }

  // ボックス・単純な馬番一覧。
  return `<div class="ticket-box-row">${lines[0].values.map(ticketNumBoxHtml).join("")}</div>`;
}

// 複数点のうち、この点数以下なら実物の馬券と同じ「1行=1組み合わせ」の列挙形式
// (下記 ticketMultiListRowHtml)にする。これを超える点数(ボックス等で数十点になる
// 場合)は列挙すると長大になりすぎるため、従来通り軸/相手・ボックス等の要約表示
// (ticketMultiSelectionHtml)にフォールバックする。
const TICKET_LIST_ROWS_MAX = 6;

// 複数点のうち点数が少ない場合の1行表示。実物の馬券は「馬番▶馬番▶馬番 金額」を
// 買い目の数だけ縦に並べる(軸/相手のような要約はしない)。馬名は出さない
// (ticketSingleSelectionHtmlを流用。複数頭のときは番号のみになる仕様と一致する)。
function ticketMultiListRowHtml(betType, ticket) {
  return `<div class="ticket-line-row">
    ${ticketSingleSelectionHtml(betType, ticket.selections)}
    <span class="ticket-line-amount">${ticketDetailAmountHtml(ticket.amount)}</span>
  </div>`;
}

// 実物の馬券の金額表記(「¥」ではなく末尾に「円」)。アプリ内の他画面は
// utils.js の formatYen(¥表記)で統一しているが、券面デザインの部分だけは
// 本物の見た目を優先してこちらを使う。
function ticketYenText(n) {
  return `${Number(n || 0).toLocaleString()}円`;
}

// 実物の馬券は金額欄の桁数が固定で、空いている上位の桁を星(☆/★)で埋めて
// 印字される(内訳行は☆、合計欄は★を使う)。手元の実物馬券の写真数枚から
// 「内訳行は最大6桁・合計欄は最大7桁」を逆算した推定値であり、正確な規則の
// 保証はない(2026-09-16)。
function ticketStarPad(amount, maxDigits, star) {
  const digits = String(Math.trunc(Math.abs(Number(amount) || 0))).length;
  return star.repeat(Math.max(0, maxDigits - digits));
}
function ticketDetailAmountHtml(amount) {
  return `<span class="ticket-star">${ticketStarPad(amount, 6, "☆")}</span>${ticketYenText(amount)}`;
}
function ticketTotalAmountHtml(amount) {
  return `<span class="ticket-star">${ticketStarPad(amount, 7, "★")}</span>${ticketYenText(amount)}`;
}

// 実物の馬券は「合計」欄に金額だけでなく購入枚数(10円単位。100円なら10枚)も
// 星埋め付きで表示される(個別の買い目行には枚数は出ない。合計欄だけの表記)。
function ticketSheetCountText(amount) {
  const count = Math.round(Number(amount || 0) / 10);
  return `<span class="ticket-star">${ticketStarPad(count, 6, "★")}</span>${count.toLocaleString()}枚`;
}

// レース名が「2歳未勝利」「3歳以上1勝クラス」のような馬齢条件クラス名、または
// 障害レース(先頭が「障害」)の場合は券面にレース名を表示しない(実物の馬券は
// 重賞・特別戦等の固有名があるときだけレース名欄に印字されるため。CLAUDE.mdの
// 既存PDF解析(jra-pdf-common.js)ではこの手の条件は race_name とは別に
// class_flags として抽出しているが、本アプリの race_name には条件戦のクラス名が
// そのまま入っているケースがあるため、ここでは文字列の先頭パターンで判定する)。
function ticketShouldShowRaceName(raceName) {
  const name = String(raceName || "").trim();
  if (!name) return false;
  return !/^(障害|\d+歳)/.test(name);
}

// 券面左上の「年(+開催回+開催日)」行。開催回・開催日(JRAの「3回2日」表記)は
// 現時点でDBに列が無いため常に年のみになるが、将来 races テーブルに
// kai(開催回)/nichi(開催日)相当の列が追加された際にそのまま拾えるよう、
// ticket が kai/nichi を持っていれば「年◯回◯日」を組み立てる形にしておく
// (2026-09-16。表示の準備のみで、データ追加は別タスク)。
function ticketRaceYearLine(t) {
  const d = new Date(`${String(t.race_date ?? "").slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const year = `${d.getFullYear()}年`;
  if (t.kai && t.nichi) return `${year}${t.kai}回${t.nichi}日`;
  return year;
}

const ticketDialogOverlay = document.createElement("div");
ticketDialogOverlay.id = "ticket-dialog-overlay";
ticketDialogOverlay.className = "modal-overlay ticket-dialog-overlay";
ticketDialogOverlay.hidden = true;
ticketDialogOverlay.innerHTML = `<div class="modal ticket-dialog" id="ticket-dialog"></div>`;
document.getElementById("app-screen")?.appendChild(ticketDialogOverlay);
const ticketDialogEl = ticketDialogOverlay.querySelector("#ticket-dialog");

function closeTicketDialog() {
  ticketDialogOverlay.hidden = true;
  document.body.classList.remove("modal-open");
}
ticketDialogOverlay.addEventListener("click", (e) => {
  if (e.target === ticketDialogOverlay) closeTicketDialog();
});
if (typeof registerEscToClose === "function") registerEscToClose(ticketDialogOverlay, closeTicketDialog);

function openTicketDialog(group, opts) {
  renderTicketDialogContent(group, !!(opts && opts.amountPanelOpen));
  ticketDialogOverlay.hidden = false;
  document.body.classList.add("modal-open");
}

// 編集・削除の保存後にダイアログの中身だけを最新データで再描画する。
// 対象グループがまだ残っていればダイアログを開いたまま最新化し、1件も残っていなければ閉じる。
function refreshTicketDialog(groupId, amountPanelOpen) {
  const items = allItems.filter((t) => t.group_id === groupId);
  if (items.length === 0) {
    closeTicketDialog();
    return;
  }
  openTicketDialog(items, { amountPanelOpen });
}

function renderTicketDialogContent(group, amountPanelOpen) {
  const first = group[0];
  const groupId = first.group_id;
  const totalAmount = sumTicketAmount(group);
  const totalPayout = sumSettledPayout(group);
  const hasSettled = group.some((t) => t.payout !== null && t.payout !== undefined);
  const allSettled = group.every((t) => t.payout !== null && t.payout !== undefined);

  const isMulti = group.length > 1;
  const useListRows = isMulti && group.length <= TICKET_LIST_ROWS_MAX;
  const enLabelHtml = (TICKET_EN_LABELS[first.bet_type] || []).join("<br>");
  const methodInfo = isMulti ? ticketMethodBoxLabel(first.method) : null;
  const uniformAmount = isMulti ? describeGroupUniformAmount(group) : null;
  const selectionAreaHtml = !isMulti
    ? ticketSingleSelectionHtml(first.bet_type, first.selections)
    : useListRows
      ? group.map((t) => ticketMultiListRowHtml(first.bet_type, t)).join("")
      : ticketMultiSelectionHtml(first.bet_type, group);

  ticketDialogEl.innerHTML = `
    <div class="ticket-dialog-toolbar">
      <button type="button" class="dialog-close" id="ticket-dialog-close-btn" aria-label="閉じる">×</button>
      <button type="button" class="ticket-amount-toggle-btn" id="ticket-amount-toggle-btn">金額変更</button>
    </div>
    <div class="ticket-face">
      <div class="ticket-face-topbar">
        <span>馬券帳</span>
      </div>
      <div class="ticket-face-main">
        <div class="ticket-info-col">
          <div class="ticket-info-top">
            <div class="ticket-year-line">${escapeHtml(ticketRaceYearLine(first))}</div>
            <div class="ticket-track-line">${escapeHtml(first.track || "")}</div>
            <div class="ticket-race-line">
              <span class="ticket-race-num-badge">${first.race_number}</span><span class="ticket-race-num-suffix">レース</span>
            </div>
          </div>
          <div class="ticket-info-bottom">
            ${ticketShouldShowRaceName(first.race_name) ? `<div class="ticket-face-race-name">${escapeHtml(first.race_name)}</div>` : ""}
            <div class="ticket-jra-line">JRA ${escapeHtml(first.track || "")}</div>
            <div class="ticket-face-date">${formatDateMd(first.race_date)}</div>
          </div>
        </div>
        <div class="ticket-strip">
          <div class="ticket-strip-label">${enLabelHtml}</div>
          <div class="ticket-strip-kanji">${ticketVerticalTextHtml(ticketBetTypeText(first.bet_type))}</div>
          <div class="ticket-strip-label">${enLabelHtml}</div>
        </div>
        <div class="ticket-buy-col">
          ${methodInfo ? `<div class="ticket-method-box"><span class="ticket-method-ja">${escapeHtml(methodInfo.ja)}</span>${methodInfo.en ? `<span class="ticket-method-en">${escapeHtml(methodInfo.en)}</span>` : ""}</div>` : ""}
          <div class="ticket-selection-area">${selectionAreaHtml}</div>
          ${isMulti && !useListRows
            ? `<div class="ticket-combo-table">
                <div class="ticket-combo-row"><span>組合せ数</span><span>${group.length}</span></div>
                ${uniformAmount !== null ? `<div class="ticket-combo-row"><span>各組</span><span>${ticketDetailAmountHtml(uniformAmount)}</span></div>` : ""}
              </div>`
            : ""
          }
          ${!isMulti ? `<div class="ticket-single-amount">${ticketDetailAmountHtml(totalAmount)}</div>` : ""}
        </div>
        <div class="ticket-face-footer">
          <div class="ticket-totals">
            <div class="ticket-total-row"><span>合計</span><span class="ticket-total-values">${ticketSheetCountText(totalAmount)}${ticketTotalAmountHtml(totalAmount)}</span></div>
            ${hasSettled ? `<div class="ticket-payout-row"><span>${allSettled ? "払戻" : "払戻(一部)"}</span><span class="ticket-total-values">${ticketSheetCountText(totalPayout)}${ticketTotalAmountHtml(totalPayout)}</span></div>` : ""}
          </div>
        </div>
      </div>
    </div>
    <div class="group-detail-rows ticket-edit-rows" ${amountPanelOpen ? "" : "hidden"}>
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

  ticketDialogEl.querySelector("#ticket-dialog-close-btn").addEventListener("click", closeTicketDialog);

  const amountToggleBtn = ticketDialogEl.querySelector("#ticket-amount-toggle-btn");
  const editRows = ticketDialogEl.querySelector(".ticket-edit-rows");
  amountToggleBtn.addEventListener("click", () => {
    editRows.hidden = !editRows.hidden;
  });

  ticketDialogEl.querySelectorAll(".import-edit-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const row = input.closest(".group-detail-row"); const id = row?.dataset.id; if (!id || String(id).startsWith("legacy-import-")) return;
      const amount = row.querySelector(".amount-edit-input")?.value; const payoutInput = row.querySelector(".payout-edit-input");
      const payout = payoutInput && payoutInput.value !== "" ? Number(payoutInput.value) : null;
      await authedFetch(`/api/ticket-imports/${encodeURIComponent(id)}`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount:Number(amount),payout})});
      await loadTickets();
      refreshTicketDialog(groupId, true);
    });
  });

  ticketDialogEl.querySelectorAll(".amount-edit-input:not(.import-edit-input)").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.closest(".group-detail-row").dataset.id;
      const ticket = group.find((t) => String(t.id) === String(id));
      const newAmount = Number(input.value);

      // 払戻率が既に入力されているレースなら、新しい購入額で払戻金額も再計算する。
      // 払戻率データがまだない場合は、既存の払戻金額をそのまま維持する。
      // races は ?since= で範囲を絞っているため、古い購入履歴では見つからないことが
      // あり、その場合は GET /api/races/:id でその1件だけ個別取得する。
      let race = races.find((r) => r.id === ticket.race_id);
      if (!race) {
        const raceRes = await authedFetch(`/api/races/${ticket.race_id}`);
        if (raceRes.ok) race = await raceRes.json();
      }
      let newPayout = ticket.payout ?? null;
      if (race && race.payouts && race.payouts[ticket.bet_type]) {
        newPayout = computeTicketPayout({ ...ticket, amount: newAmount }, race);
      }

      await authedFetch(`/api/tickets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: newAmount, payout: newPayout }),
      });
      await loadTickets();
      refreshTicketDialog(groupId, true);
    });
  });

  ticketDialogEl.querySelectorAll(".detail-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
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

        await loadTickets();
        refreshTicketDialog(groupId, true);
      } catch (e) {
        alert("削除に失敗しました: " + (e.message || e));
      }
    });
  });
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
  if (historySelectBtn) {
    historySelectBtn.textContent = on ? "やめる" : "選択削除";
    historySelectBtn.classList.toggle("active", on);
  }
  document.body.classList.toggle("history-selection-mode", on);
  applyHistoryFilter();
}

function syncBulkSelectionUi() {
  raceList.querySelectorAll(".bulk-check-group").forEach((cb) => {
    const ids = (cb.dataset.ids || "").split(",").filter(Boolean).map(Number);
    const on = ids.length > 0 && ids.every((id) => selectedTicketIds.has(id));
    cb.checked = on;
    cb.closest(".group-card-head")?.classList.toggle("bulk-selected", on);
  });
  raceList.querySelectorAll(".bulk-check-race").forEach((cb) => {
    const ids = (cb.dataset.ids || "").split(",").filter(Boolean).map(Number);
    const sel = ids.filter((id) => selectedTicketIds.has(id)).length;
    const all = sel > 0 && sel === ids.length;
    cb.checked = all;
    cb.indeterminate = sel > 0 && sel < ids.length;
    const head = cb.closest(".race-card-head");
    if (head) {
      head.classList.toggle("bulk-selected", all);
      head.classList.toggle("bulk-partial", sel > 0 && sel < ids.length);
    }
  });
  const n = selectedTicketIds.size;
  const countEl = document.getElementById("bulk-count");
  const delBtn = document.getElementById("bulk-delete-btn");
  if (countEl) countEl.textContent = n === 0 ? "タップして購入を選択" : `選択中 ${n} 点`;
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
    setSelectionMode(false);
    await loadTickets();
  } catch (e) {
    alert("削除に失敗しました: " + (e.message || e));
  } finally {
    btn.textContent = "削除する";
  }
});

setupAuth(loadTickets);
