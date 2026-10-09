// データ検索画面。「レース成績」「馬情報検索」「重賞検索」「騎手検索」の4タブ構成。仕様は docs/design/data-search.md。
// レース成績タブ: GET /api/data-search/race-stats を叩いて、競馬場・コース種別・距離ごとの
// 単勝/馬連の傾向・騎手率・馬番別成績を表示する。
// 馬情報検索タブ: GET /api/data-search/horse-search(部分一致検索)・
// GET/PUT /api/data-search/horse-info(過去全出走履歴・血統/調教師/馬主/生産牧場)を叩く。
// 重賞検索タブ(2026-10-02追加): graded-race-search.js(grInit)。仕様は
// docs/design/graded-race-search.md。

// ---------- タブ切り替え(stats.js と同じパターン) ----------
let hiInitialized = false;
let grInitialized = false;
let jsInitialized = false;
// ?graded=<graded_races.id>(2026-10-08): 予想登録画面の「過去のデータ」・馬券購入画面の「開催予定の重賞」から、
// 重賞検索タブでその重賞を開いた状態で表示する。このときレース成績タブの集計は、タブを開くまで読み込まない。
const dsGradedLinkId = new URLSearchParams(window.location.search).get("graded");
let dsRaceStatsDeferred = false;
document.querySelectorAll(".stats-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".stats-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    document.querySelectorAll(".stats-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== target;
    });
    if (target === "race-stats" && dsRaceStatsDeferred) {
      dsRaceStatsDeferred = false;
      dsLoad();
    }
    if (target === "horse-info" && !hiInitialized) {
      hiInitialized = true;
      hiInit();
    }
    if (target === "graded-race" && !grInitialized) {
      grInitialized = true;
      grInit();
    }
    // 騎手検索タブ(2026-10-03追加): jockey-search.js(jsInit)。
    if (target === "jockey" && !jsInitialized) {
      jsInitialized = true;
      jsInit();
    }
  });
});

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
    // 2026-10-03: 平均から中央値に変更(以前は「平均単勝金額」「平均馬連金額」)。
    ["単勝金額 中央値", dsYen(win.median)],
    ["単勝 300円以下率", dsPct(win.under300Rate)],
    ["単勝 500円以下率", dsPct(win.under500Rate)],
    ["単勝 1000円以下率", dsPct(win.under1000Rate)],
    ["馬連金額 中央値", dsYen(uma.median)],
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

  if (/^\d+$/.test(dsGradedLinkId || "")) {
    dsRaceStatsDeferred = true;
    document.querySelector('.stats-tab[data-tab="graded-race"]')?.click(); // 重賞検索タブを開く(grInit)
    grLoadDetail(dsGradedLinkId);
    return;
  }
  dsLoad();
}

// ---------- 馬情報検索タブ ----------

const HI_SEARCH_MIN_LENGTH = 2; // サーバー負荷対策(1文字だと該当馬が多すぎるため)。GET /api/data-search/horse-search 側でも検証する
const hiEls = {};
let hiSearchTimer = null;
let hiCurrentName = null;
let hiCurrentMaster = null;

// 血統等が未登録の馬の案内文(2026-10-08)。netkeiba への自動取得は廃止し、レース管理画面で馬柱(5走)を取り込むと
// 登録される(docs/design/netkeiba-bookmarklet.md)。重賞検索タブ(graded-race-search.js)からも使う。
// 以前の取得失敗の記録(horses.fetch_error)が残っている馬も、同じく未登録として扱う。
function hiMissingMasterText() {
  const isAdmin = Boolean(window.currentUser && window.currentUser.isAdmin);
  return `血統等は未登録です。${isAdmin ? "レース管理画面でこの馬が出走するレースの馬柱(5走)を取り込むと登録されます。「編集する」から手入力もできます。" : ""}`;
}

// 馬情報の出どころのお知らせ文。編集は管理者専用のため、操作への誘導は管理者にだけ出す。
function hiFetchNoteText(master) {
  const isAdmin = Boolean(window.currentUser && window.currentUser.isAdmin);
  const hasPedigree = master && (master.sire || master.dam || master.damSire);
  if (!master || (!hasPedigree && master.dataSource !== "manual")) return hiMissingMasterText();
  if (master.dataSource === "manual") return "手動で編集済みの情報です。";
  // 2026-10-06〜: レース管理画面で netkeiba の馬柱を取り込んだ情報(貼り付け・ブックマークレット)
  if (master.dataSource === "paste") {
    return `netkeibaの馬柱から取り込んだ情報です。${isAdmin ? "誤りがあれば「編集する」から修正してください。" : ""}`;
  }
  if (master.dataSource === "netkeiba" || master.dataSource === "import") {
    const when = master.fetchedAt ? new Date(master.fetchedAt).toLocaleString("ja-JP") : "";
    return `netkeiba等から取得した情報です${when ? `(${when}取得)` : ""}。${isAdmin ? "誤りがあれば「編集する」から修正してください。" : ""}`;
  }
  return "";
}

function hiCardsHtml(cards) {
  return cards
    .map(
      ([label, value]) => `
      <div class="overall-card">
        <span class="overall-label">${escapeHtml(label)}</span>
        <span class="overall-value">${escapeHtml(value || "不明")}</span>
      </div>`
    )
    .join("");
}

// 血統(父/母/母父)と調教師・馬主・生産牧場を別々の段で表示する(2026-09-29。
// 段を分けたぶん1段あたりのカード数が減り、その分1枚ずつ横に広くなる)。
function hiRenderMasterGrids(master) {
  hiEls.masterGridPedigree.innerHTML = hiCardsHtml([
    ["父", master?.sire],
    ["母", master?.dam],
    ["母父", master?.damSire],
  ]);
  hiEls.masterGridConnections.innerHTML = hiCardsHtml([
    ["調教師", master?.trainer],
    ["馬主", master?.owner],
    ["生産牧場", master?.breeder],
  ]);
}

function hiFillEditForm(master) {
  hiEls.editSire.value = master?.sire || "";
  hiEls.editDam.value = master?.dam || "";
  hiEls.editDamSire.value = master?.damSire || "";
  hiEls.editTrainer.value = master?.trainer || "";
  hiEls.editOwner.value = master?.owner || "";
  hiEls.editBreeder.value = master?.breeder || "";
}

function hiStatusLabel(row) {
  if (row.status === "scratched") return "取消";
  if (row.status === "excluded") return "除外";
  if (row.status === "stopped") return "中止";
  return row.finish_position != null ? `${row.finish_position}着` : "-";
}

function hiRenderHistoryTable(rows) {
  const table = hiEls.historyTable;
  if (!rows || rows.length === 0) {
    table.innerHTML = `<tr><td class="table-empty">出走履歴がありません(JRAレース結果PDF/HTML未取込の可能性があります)</td></tr>`;
    return;
  }
  const head =
    `<tr><th>日付</th><th>開催</th><th>レース名</th><th>着順</th><th>頭数</th>` +
    `<th>騎手</th><th>斤量</th><th>馬体重</th><th>タイム</th><th>人気</th></tr>`;
  const body = rows
    .map((r) => {
      const bodyWeight =
        r.body_weight != null ? `${r.body_weight}${r.body_weight_change ? `(${r.body_weight_change})` : ""}` : "-";
      return `
      <tr>
        <td>${escapeHtml(r.race_date || "-")}</td>
        <td class="table-name">${escapeHtml(r.track || "-")}${r.race_number ? `${r.race_number}R` : ""}</td>
        <td class="table-name">${escapeHtml(r.race_name || "-")}</td>
        <td>${hiStatusLabel(r)}</td>
        <td>${r.field_size ?? "-"}</td>
        <td>${escapeHtml(r.jockey || "-")}</td>
        <td>${r.weight_carried ?? "-"}</td>
        <td>${escapeHtml(bodyWeight)}</td>
        <td>${escapeHtml(r.time_text || "-")}</td>
        <td>${r.win_popularity ?? "-"}</td>
      </tr>`;
    })
    .join("");
  table.innerHTML = head + body;
}

function hiRenderDetail(data) {
  hiCurrentName = data.name;
  hiEls.detailName.textContent = data.name;
  hiEls.detailSub.textContent =
    data.sex && data.age != null
      ? `${data.sex}${data.age}(${data.ageAsOfRaceDate || "直近出走"}時点の性齢)`
      : "性齢不明(出走履歴なし)";

  hiCurrentMaster = data.master;
  hiRenderMasterGrids(data.master);
  const note = hiFetchNoteText(data.master);
  hiEls.fetchNote.hidden = !note;
  hiEls.fetchNote.textContent = note;

  hiFillEditForm(data.master);
  hiEls.editForm.hidden = true; // 馬を切り替えたら編集フォームは閉じておく
  hiEls.editMessage.hidden = true;
  hiRenderHistoryTable(data.history);

  hiEls.detail.hidden = false;
}

async function hiLoadDetail(name) {
  hiEls.searchStatus.textContent = "読み込み中…";
  try {
    const res = await authedFetch(`/api/data-search/horse-info?name=${encodeURIComponent(name)}`);
    if (!res.ok) {
      hiEls.searchStatus.textContent = "詳細の取得に失敗しました。";
      return;
    }
    const data = await res.json();
    hiRenderDetail(data);
    hiEls.searchStatus.textContent = "";
  } catch {
    hiEls.searchStatus.textContent = "詳細の取得に失敗しました。";
  }
}

async function hiLoadSearch(q) {
  try {
    const res = await authedFetch(`/api/data-search/horse-search?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      hiEls.resultList.hidden = true;
      hiEls.searchStatus.textContent = "検索に失敗しました。";
      return;
    }
    const data = await res.json();
    const horses = data.horses || [];
    if (!horses.length) {
      hiEls.resultList.hidden = true;
      hiEls.searchStatus.textContent = `「${q}」に該当する馬名がありません。`;
      return;
    }
    hiEls.searchStatus.textContent = `${horses.length}件${data.truncated ? "以上(絞り込んでください)" : ""}`;
    hiEls.resultList.hidden = false;
    hiEls.resultList.innerHTML = horses
      .map(
        (h) => `
        <li><button type="button" class="hi-result-btn" data-name="${escapeAttr(h.name)}">
          <span class="hi-result-name">${escapeHtml(h.name)}</span>
          <span class="hi-result-count">${h.raceCount}走分</span>
        </button></li>`
      )
      .join("");
    hiEls.resultList.querySelectorAll(".hi-result-btn").forEach((btn) => {
      btn.addEventListener("click", () => hiLoadDetail(btn.dataset.name));
    });
  } catch {
    hiEls.searchStatus.textContent = "検索に失敗しました。";
  }
}

function hiApplyMasterUpdate(master) {
  hiCurrentMaster = master;
  hiRenderMasterGrids(master);
  const note = hiFetchNoteText(master);
  hiEls.fetchNote.hidden = !note;
  hiEls.fetchNote.textContent = note;
}

function setupHiEditForm() {
  // 「編集する」ボタンを押すまで編集フォームは表示しない(常時表示にしない。2026-09-29)。
  hiEls.editToggleBtn.addEventListener("click", () => {
    hiFillEditForm(hiCurrentMaster);
    hiEls.editMessage.hidden = true;
    hiEls.editForm.hidden = false;
  });
  hiEls.editCancelBtn.addEventListener("click", () => {
    hiEls.editForm.hidden = true;
  });

  hiEls.editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!hiCurrentName) return;
    const body = {
      name: hiCurrentName,
      sire: hiEls.editSire.value.trim(),
      dam: hiEls.editDam.value.trim(),
      dam_sire: hiEls.editDamSire.value.trim(),
      trainer: hiEls.editTrainer.value.trim(),
      owner: hiEls.editOwner.value.trim(),
      breeder: hiEls.editBreeder.value.trim(),
    };
    const submitBtn = hiEls.editForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    hiEls.editMessage.hidden = true;

    const res = await authedFetch("/api/data-search/horse-info", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      hiApplyMasterUpdate(data.master);
      hiEls.editForm.hidden = true; // 保存したら編集フォームは閉じる
      hiEls.editMessage.hidden = false;
      hiEls.editMessage.className = "submit-message success";
      hiEls.editMessage.textContent = "保存しました。";
    } else {
      hiEls.editMessage.hidden = false;
      hiEls.editMessage.className = "submit-message error";
      hiEls.editMessage.textContent = data.error || "保存に失敗しました。";
    }
    submitBtn.disabled = false;
  });

}

function hiInit() {
  hiEls.search = document.getElementById("hi-search");
  hiEls.searchStatus = document.getElementById("hi-search-status");
  hiEls.resultList = document.getElementById("hi-result-list");
  hiEls.detail = document.getElementById("hi-detail");
  hiEls.detailName = document.getElementById("hi-detail-name");
  hiEls.detailSub = document.getElementById("hi-detail-sub");
  hiEls.masterGridPedigree = document.getElementById("hi-master-grid-pedigree");
  hiEls.masterGridConnections = document.getElementById("hi-master-grid-connections");
  hiEls.fetchNote = document.getElementById("hi-fetch-note");
  hiEls.editToggleBtn = document.getElementById("hi-edit-toggle-btn");
  hiEls.editCancelBtn = document.getElementById("hi-edit-cancel-btn");
  hiEls.editForm = document.getElementById("hi-edit-form");
  hiEls.editSire = document.getElementById("hi-edit-sire");
  hiEls.editDam = document.getElementById("hi-edit-dam");
  hiEls.editDamSire = document.getElementById("hi-edit-dam_sire");
  hiEls.editTrainer = document.getElementById("hi-edit-trainer");
  hiEls.editOwner = document.getElementById("hi-edit-owner");
  hiEls.editBreeder = document.getElementById("hi-edit-breeder");
  hiEls.editMessage = document.getElementById("hi-edit-message");
  hiEls.historyTable = document.getElementById("hi-history-table");

  hiEls.search.addEventListener("input", () => {
    clearTimeout(hiSearchTimer);
    const q = hiEls.search.value.trim();
    hiEls.detail.hidden = true;
    if (!q) {
      hiEls.resultList.hidden = true;
      hiEls.searchStatus.textContent = "馬名の一部を2文字以上入力してください。";
      return;
    }
    if (q.length < HI_SEARCH_MIN_LENGTH) {
      hiEls.resultList.hidden = true;
      hiEls.searchStatus.textContent = `あと${HI_SEARCH_MIN_LENGTH - q.length}文字以上入力してください。`;
      return;
    }
    hiEls.searchStatus.textContent = "検索中…";
    hiSearchTimer = setTimeout(() => hiLoadSearch(q), 300);
  });

  setupHiEditForm();
}

setupAuth(dsInit);
