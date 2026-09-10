// データ検索画面。現状は「レース成績」タブのみ。
// GET /api/data-search/race-stats を叩いて、競馬場・コース種別・距離ごとの
// 単勝/馬連の傾向・騎手率・馬番別成績を表示する。仕様は docs/design/data-search.md。

// 競馬場セレクトの並び順(buy.js の RACE_TRACK_ORDER と同じ並び。グローバル const を
// 共有できないため中央10場ぶんを複製)。一覧に無い競馬場は末尾へ。
const DS_TRACK_ORDER = [
  "東京", "中山", "京都", "阪神",
  "札幌", "函館", "福島", "新潟", "中京", "小倉",
];
function dsTrackSortIndex(track) {
  const i = DS_TRACK_ORDER.indexOf(track);
  return i >= 0 ? i : DS_TRACK_ORDER.length;
}

const dsEls = {};
let dsLoading = false;

function dsPct(v) {
  return v == null ? "-" : `${(v * 100).toFixed(1)}%`;
}
function dsYen(v) {
  return v == null ? "-" : `¥${Math.round(v).toLocaleString()}`;
}

function dsSetSelectOptions(select, values, { keepValue = true, formatLabel } = {}) {
  const prev = select.value;
  const first = select.querySelector("option"); // 「すべて」
  select.innerHTML = "";
  select.appendChild(first);
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = formatLabel ? formatLabel(v) : String(v);
    select.appendChild(opt);
  }
  if (keepValue && values.map(String).includes(prev)) select.value = prev;
}

function dsRenderPayout(data) {
  const win = data.win || {};
  const uma = data.umaren || {};
  dsEls.payoutNote.textContent =
    `単勝: ${win.raceCount || 0} レース / 馬連: ${uma.raceCount || 0} レース が対象` +
    `(払戻が登録済みのレースのみ。騎手・馬番の集計とは母数が異なります)`;

  const cards = [
    ["平均単勝金額", dsYen(win.avg)],
    ["単勝 300円以下率", dsPct(win.under300Rate)],
    ["単勝 500円以下率", dsPct(win.under500Rate)],
    ["単勝 1000円以下率", dsPct(win.under1000Rate)],
    ["平均馬連金額", dsYen(uma.avg)],
  ];
  dsEls.payoutGrid.innerHTML = cards
    .map(
      ([label, value]) => `
      <div class="overall-card">
        <span class="overall-label">${escapeHtml(label)}</span>
        <span class="overall-value">${escapeHtml(value)}</span>
      </div>`
    )
    .join("");
}

function dsRenderJockeyTable(table, rows, rateHeader, countHeader) {
  if (!rows || rows.length === 0) {
    table.innerHTML = `<tr><td class="table-empty">該当データなし</td></tr>`;
    return;
  }
  const head = `<tr><th>順位</th><th>騎手</th><th>${escapeHtml(rateHeader)}</th><th>${escapeHtml(countHeader)}</th><th>騎乗</th></tr>`;
  const body = rows
    .map(
      (r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="table-name">${escapeHtml(r.name)}</td>
        <td>${dsPct(r.rate)}</td>
        <td>${r.count}</td>
        <td>${r.rides}</td>
      </tr>`
    )
    .join("");
  table.innerHTML = head + body;
}

function dsRenderHorseNumberTable(rows) {
  const table = dsEls.horseNumberTable;
  if (!rows || rows.length === 0) {
    table.innerHTML = `<tr><td class="table-empty">該当データなし</td></tr>`;
    return;
  }
  const head =
    `<tr><th>馬番</th><th>出走</th><th>1着</th><th>2着</th><th>3着</th>` +
    `<th>勝率</th><th>連対率</th><th>複勝率</th></tr>`;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="table-name">${r.horseNumber}</td>
        <td>${r.starts}</td>
        <td>${r.win}</td>
        <td>${r.second}</td>
        <td>${r.third}</td>
        <td>${dsPct(r.winRate)}</td>
        <td>${dsPct(r.quinellaRate)}</td>
        <td>${dsPct(r.showRate)}</td>
      </tr>`
    )
    .join("");
  table.innerHTML = head + body;
}

function dsRender(data) {
  // セレクトの選択肢を更新(現在の選択は保持)
  const tracks = [...(data.trackOptions || [])].sort(
    (a, b) => dsTrackSortIndex(a) - dsTrackSortIndex(b) || a.localeCompare(b, "ja")
  );
  dsSetSelectOptions(dsEls.track, tracks);
  dsSetSelectOptions(dsEls.distance, data.distanceOptions || [], {
    formatLabel: (v) => `${v}m`,
  });

  dsRenderPayout(data);

  const j = data.jockeys || {};
  dsEls.jockeyNote.textContent =
    `対象 ${j.resultRaceCount || 0} レース / 最低騎乗 ${j.minRides || 0} 回以上の騎手が対象。` +
    `勝率・複勝率は「1着 or 3着以内」÷「騎乗回数(取消・除外を除く)」。`;
  dsRenderJockeyTable(dsEls.jockeyWinTable, j.topWin, "勝率", "勝利");
  dsRenderJockeyTable(dsEls.jockeyShowTable, j.topShow, "複勝率", "複勝");

  dsRenderHorseNumberTable(data.byHorseNumber);
}

async function dsLoad() {
  if (dsLoading) return;
  dsLoading = true;
  dsEls.status.hidden = false;
  dsEls.status.textContent = "集計中…";

  const params = new URLSearchParams();
  if (dsEls.track.value) params.set("track", dsEls.track.value);
  if (dsEls.surface.value) params.set("course_type", dsEls.surface.value);
  if (dsEls.distance.value) params.set("distance", dsEls.distance.value);

  try {
    const res = await authedFetch(`/api/data-search/race-stats?${params.toString()}`);
    if (!res.ok) {
      dsEls.status.textContent = "集計の取得に失敗しました";
      dsEls.results.hidden = true;
      return;
    }
    const data = await res.json();
    dsRender(data);
    dsEls.status.hidden = true;
    dsEls.results.hidden = false;
  } catch {
    dsEls.status.textContent = "集計の取得に失敗しました";
    dsEls.results.hidden = true;
  } finally {
    dsLoading = false;
  }
}

function dsInit() {
  dsEls.track = document.getElementById("ds-track");
  dsEls.surface = document.getElementById("ds-surface");
  dsEls.distance = document.getElementById("ds-distance");
  dsEls.status = document.getElementById("ds-status");
  dsEls.results = document.getElementById("ds-results");
  dsEls.payoutNote = document.getElementById("ds-payout-note");
  dsEls.payoutGrid = document.getElementById("ds-payout-grid");
  dsEls.jockeyNote = document.getElementById("ds-jockey-note");
  dsEls.jockeyWinTable = document.getElementById("ds-jockey-win-table");
  dsEls.jockeyShowTable = document.getElementById("ds-jockey-show-table");
  dsEls.horseNumberTable = document.getElementById("ds-horse-number-table");

  // 競馬場・コース種別を変えたら距離セレクトの選択肢が変わるため、距離の選択はリセットする。
  dsEls.track.addEventListener("change", () => {
    dsEls.distance.value = "";
    dsLoad();
  });
  dsEls.surface.addEventListener("change", () => {
    dsEls.distance.value = "";
    dsLoad();
  });
  dsEls.distance.addEventListener("change", dsLoad);

  dsLoad();
}

setupAuth(dsInit);
