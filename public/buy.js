// 馬券購入画面のコア(state・カレンダー・レース選択グリッド描画)。
//
// 2026-09-01リファクタリング: トークン消費削減のため、元々1ファイルだった buy.js を
// 「グリッド表示」と「購入モーダル」の2ファイルに分割した(docs/ROADMAP.md「クラスタI」参照。
// races.jsの3分割と同じ方針)。
//   - buy.js(本ファイル): state・カレンダー・競馬場タブ・レース選択グリッド描画
//   - buy-purchase-modal.js: 購入モーダル一式(券種選択・購入方式・馬選択・組み合わせ生成・送信)
// いずれもESモジュールを使わないクラシックスクリプトのため、2ファイルは同一の
// グローバルスコープを共有する(races.js分割時と同じ前提)。index.html での読み込み順は
// buy.js → buy-purchase-modal.js。分割によって画面の挙動・DOM構造・APIは変更していない。

// 予想登録画面などから ?race= 付きで直接来たときは、購入モーダルが開くまでの一瞬
// レース選択UI(.buy-step)がちらっと見えるのを防ぐため隠しておく。
// #purchase-modal は .buy-step の外にあるので隠れない。モーダルが開けばその上に
// 覆われ、モーダルを(予想画面へ戻らずに)閉じた時点で closePurchaseModal() が
// 隠しクラスを外す。
if (new URLSearchParams(location.search).get("race")) {
  document.body.classList.add("deep-link-purchase");
}

let races = [];
// 自分(ログインユーザー)が既に購入済みのレースID(races.id)の集合。
// 通常購入(tickets)・CSVインポート分(ticket-imports)の両方を対象とする。
// GET /api/tickets・GET /api/ticket-imports はいずれもログインユーザー自身のデータのみを
// 返すため、他ユーザーの購入は含まれない(docs/design/screens.md「画面仕様」参照)。
let purchasedRaceIds = new Set();

// 自分(ログインユーザー)が空でないメモを登録済みの馬名の集合(2026-08-16追加)。
// レース選択画面で「出走馬に1頭でもメモ登録済みの馬がいれば▼マークを表示する」判定に使う。
// GET /api/horse-notes (race_id省略) はログインユーザー自身のメモのみを返すため、
// 他ユーザーのメモは対象に含まれない。
let myMemoHorseNames = new Set();

// 自分(ログインユーザー)が「勝負レース」に設定済みのレースID(races.id)の集合
// (2026-09-12追加)。予想登録画面の勝負レーストグルはユーザーごとの個人設定
// (prediction_notes.is_key_race)なので、他ユーザーの設定は含まれない。
// GET /api/predictions (race_id省略) はログインユーザー自身の設定のみを返す。
let myKeyRaceIds = new Set();

// レース一覧の目印「複」「ワ」(2026-11-01。docs/design/screens.md「レース一覧の目印(複・ワ)」)。全ユーザー共通の計算結果。
// 日付を選んだら保存済みの分(GET /api/data-search/race-signals)を出し、計算し直しが要るレース(pending)を
// 表示中の競馬場の上から2件ずつ GET /api/data-search/race-signal で計算して、その行の目印だけ書き換える
const raceSignals = new Map(); // レースID -> "複" | "ワ" | "複ワ"
const signalLoadedDates = new Set();
let signalPending = []; // 計算待ちのレースID
let signalWorkers = 0;
const SIGNAL_WORKERS_MAX = 2;
const SIGNAL_TITLES = {
  複: "複: ◎の合計が125以上で、2位と10点以上の差(複勝◎・ワイド◎-〇向き)",
  ワ: "ワ: ◎〇の合計がどちらも120以上で、ほかの馬は全部10点以上下(〇の単複・◎-〇の馬連・馬単向き)",
};

function normalizeHorseNameForMemoCheck(v) {
  return String(v ?? "").replace(/[\u3000\s]+/g, " ").trim();
}

const dateInput = document.getElementById("date-input");
const raceGrid = document.getElementById("race-grid");
const raceTrackTabs = document.getElementById("race-track-tabs");
const calendarGrid = document.getElementById("calendar-grid");
const calendarMonthLabel = document.getElementById("calendar-month-label");
const prevMonthBtn = document.getElementById("prev-month-btn");
const nextMonthBtn = document.getElementById("next-month-btn");
const todayBtn = document.getElementById("today-btn");
const noRaceHint = document.getElementById("no-race-hint");

// ---------- 競馬場タブ・カラムの並び順(2026-08-16追加) ----------
// 「中央(主要4場)を東から → 中央ローカル6場を東から → 南関東4場を東から →
//  その他地方10場を東から」という要望に基づく並び順。競馬場名は自由入力のTEXT列
// (races.track)であり、地方競馬場はDBスキーマ上は元々入力可能だったが、この
// 並び順定義を追加するまでは特別扱いされていなかった。一覧に無い競馬場名が来た
// 場合は末尾に五十音順で追加表示する(将来の競馬場追加への保険)。
const RACE_TRACK_ORDER = [
  // 中央4場(主要場・東から)
  "東京", "中山", "京都", "阪神",
  // 中央ローカル6場(東から)
  "札幌", "函館", "福島", "新潟", "中京", "小倉",
  // 南関東4場(東から)
  "船橋", "大井", "川崎", "浦和",
  // その他地方10場(東から)
  "門別", "盛岡", "水沢", "名古屋", "笠松", "金沢", "園田", "姫路", "高知", "佐賀",
];

function trackSortIndex(track) {
  const idx = RACE_TRACK_ORDER.indexOf(track);
  return idx >= 0 ? idx : RACE_TRACK_ORDER.length;
}

function sortTracksForDisplay(tracks) {
  return [...tracks].sort((a, b) => {
    const ka = trackSortIndex(a), kb = trackSortIndex(b);
    if (ka !== kb) return ka - kb;
    return a.localeCompare(b, "ja"); // 一覧に無い競馬場同士は五十音順
  });
}

// モバイル用: 現在タブ選択中の競馬場。日付を切り替えた際はnullへリセットし、
// renderGrid() 側でその日の先頭(並び順の一番東)へフォールバックする。
let selectedTrackTab = null;

const today = new Date();
// 2026-08-24修正: 以前は today.toISOString().slice(0,10) (UTC基準)を使っていたため、
// 日本(JST=UTC+9)で日付が変わってから午前9時頃までの間、馬券履歴画面(todayDateKey()を
// 使用)と「今日」の判定がずれる不具合があった。共有関数 todayDateKey()(public/utils.js。
// ローカルタイムゾーン基準)に統一する(docs/design/screens.md「『今日』ボタンの日付判定」参照)。
let selectedDate = new URLSearchParams(location.search).get("date")
  || todayDateKey(today);
let calendarMonth = new Date(`${selectedDate}T00:00:00`);
calendarMonth.setDate(1);
dateInput.value = selectedDate;

// 自分が既に購入済みのレースID集合を作る(通常購入・CSVインポート分の両方)。
// レース一覧取得と並行して呼び出す(loadRaces参照)。取得に失敗した場合は
// バッジ表示を諦めるだけで、レース一覧・購入自体には影響させない。
// 2026-10-18: 選んだ日の分だけ、レースの番号だけを取る(?since=その日&until=その日&fields=race_ids)。以前は1か月分の
// 購入を全項目で読んでいた(1回約4,600行)。日付ごとに覚えておき、同じ日に戻ったときは取り直さない(購入はこの画面では起きない)
const purchasedLoadedDates = new Set();
async function loadPurchasedRaceIds(date) {
  if (purchasedLoadedDates.has(date)) return;
  try {
    const q = `since=${date}&until=${date}&fields=race_ids`;
    const [ticketsRes, importedRes] = await Promise.all([
      authedFetch(`/api/tickets?${q}`),
      authedFetch(`/api/ticket-imports?${q}`),
    ]);
    if (!ticketsRes.ok || !importedRes.ok) return;
    const tickets = await ticketsRes.json().catch(() => ({}));
    const imported = await importedRes.json().catch(() => ({}));
    [...(tickets.race_ids || []), ...(imported.race_ids || [])].forEach((id) => purchasedRaceIds.add(Number(id)));
    purchasedLoadedDates.add(date);
  } catch (_) {
    // 取得に失敗してもレース一覧表示自体は継続する(色分けが出ないだけ)。
  }
}

// 自分が空でないメモを登録済みの馬名一覧を取得する(2026-08-16追加)。
// レースごとに個別APIを呼ぶN+1を避けるため、ページ読み込み時に1回だけ取得する。
async function loadMyMemoHorseNames() {
  const names = new Set();
  try {
    const res = await authedFetch("/api/horse-notes");
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      (data.names || []).forEach((n) => names.add(normalizeHorseNameForMemoCheck(n)));
    }
  } catch (_) {
    // 取得に失敗してもマーク表示が出ないだけで、一覧表示自体は継続する。
  }
  myMemoHorseNames = names;
}

// そのレースの出走馬に、自分がメモを登録済みの馬が1頭でも含まれるか。
function raceHasMemoHorse(race) {
  return (race.entries || []).some((e) => myMemoHorseNames.has(normalizeHorseNameForMemoCheck(e.horse_name)));
}

// 自分が「勝負レース」に設定済みのレースID一覧を取得する(2026-09-12追加)。
// レースごとに個別APIを呼ぶN+1を避けるため、ページ読み込み時に1回だけ取得する
// (loadMyMemoHorseNames() と同じ考え方)。
async function loadMyKeyRaceIds() {
  const ids = new Set();
  try {
    const res = await authedFetch("/api/predictions");
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      (data.race_ids || []).forEach((id) => ids.add(Number(id)));
    }
  } catch (_) {
    // 取得に失敗しても★が出ないだけで、一覧表示自体は継続する。
  }
  myKeyRaceIds = ids;
}

// 2026-09-13: GET /api/races は ?since= (直近1ヶ月+未来レース全部) に絞って呼ぶ
// (docs/design/data-model.md「GET /api/races の範囲限定」参照)。買い目画面は
// この範囲だけで足りる想定のため、初期表示の高速化を優先する。
// 2026-10-18: 表に出すレース(出走馬込み)は選んだ日の分だけ取る(?since=その日&until=その日。1日約36レース)。
// カレンダーの「レースのある日」の印は一覧用の軽いキャッシュ(?index=1。読み取り約35行・変わらなければ 304)から作る。
// 以前は開くたびに1か月分(約450レース・1回約900行)を出走馬込みで読んでいた
// レースのある日(カレンダーの印)。日付 → その日の競馬場の Set(中央・地方の絞り込み〈2026-10-28〉で使う)
const raceDateTracks = new Map();
function addRaceDateTrack(date, track) {
  if (!raceDateTracks.has(date)) raceDateTracks.set(date, new Set());
  raceDateTracks.get(date).add(track || "");
}
// 中央・地方のチェック(utils.js の setupRegionFilter。購入履歴と共通)。カレンダーの印と、選んだ日の重賞・競馬場・レースを絞る
let regionFilter = setupRegionFilter(document.getElementById("region-filter"), (f) => {
  regionFilter = f;
  selectedTrackTab = null;
  renderCalendar();
  renderGrid();
  runRaceSignalQueue(); // 絞り込みで新しく出した競馬場の計算待ち
});
const loadedRaceDates = new Set();
async function loadRacesOfDate(date) {
  if (loadedRaceDates.has(date)) return true;
  const res = await authedFetch(`/api/races?since=${date}&until=${date}`);
  if (!res.ok) return false;
  const list = await res.json().catch(() => null);
  if (!Array.isArray(list)) return false;
  races = [...races.filter((r) => r.race_date !== date), ...list];
  list.forEach((r) => addRaceDateTrack(r.race_date, r.track));
  loadedRaceDates.add(date);
  return true;
}

async function loadRaceDates() {
  try {
    const res = await authedFetch("/api/races?index=1");
    if (!res.ok) return;
    const data = await res.json();
    const di = (data.fields || []).indexOf("race_date");
    const ti = (data.fields || []).indexOf("track");
    if (di < 0) return;
    (data.rows || []).forEach((row) => addRaceDateTrack(row[di], ti >= 0 ? row[ti] : ""));
  } catch (_) {
    // 取れなくても、読み込んだ日の印だけで表示を続ける
  }
}

// 日付を選んだとき: その日のレースと購入済みの印を取ってから描く(取ってある日は取り直さない)
async function showDate(date) {
  await Promise.all([loadRacesOfDate(date), loadPurchasedRaceIds(date)]);
  if (dateInput.value !== date) return; // 取っている間に別の日を選んだ
  renderCalendar();
  renderGrid();
  showRaceSignals(date);
}

// その日の保存済みの目印を取り、行へ出してから、計算し直しが要るレースを計算する。失敗しても一覧はそのまま(目印が出ないだけ)
async function showRaceSignals(date) {
  if (!signalLoadedDates.has(date)) {
    try {
      const res = await authedFetch(`/api/data-search/race-signals?date=${encodeURIComponent(date)}`);
      if (!res.ok) return;
      const data = await res.json();
      signalLoadedDates.add(date);
      Object.entries(data.signals || {}).forEach(([id, s]) => raceSignals.set(Number(id), s));
      signalPending.push(...(data.pending || []).map(Number));
    } catch (_) {
      return;
    }
  }
  if (dateInput.value !== date) return;
  raceSignals.forEach((_, id) => updateRaceSignalBadge(id));
  runRaceSignalQueue();
}

// 計算待ちから、表示中の日・中央地方の絞り込みに入る競馬場のレースを、競馬場の並び順・レース番号の順に1件取り出す
function takeNextSignalRace() {
  const date = dateInput.value;
  const cands = signalPending
    .map((id) => races.find((r) => Number(r.id) === id))
    .filter((r) => r && r.race_date === date && trackPassesRegionFilter(r.track, regionFilter))
    .sort((a, b) => trackSortIndex(a.track) - trackSortIndex(b.track) || Number(a.race_number) - Number(b.race_number));
  if (!cands.length) return null;
  const id = Number(cands[0].id);
  signalPending = signalPending.filter((x) => x !== id);
  return id;
}

function runRaceSignalQueue() {
  while (signalWorkers < SIGNAL_WORKERS_MAX) {
    const id = takeNextSignalRace();
    if (id === null) return;
    signalWorkers++;
    computeRaceSignal(id).finally(() => {
      signalWorkers--;
      runRaceSignalQueue();
    });
  }
}

async function computeRaceSignal(id) {
  try {
    const res = await authedFetch(`/api/data-search/race-signal?race_id=${id}`);
    if (res.status === 503) { signalPending = []; return; } // D1 の使用量が多い日の一時停止。残りは計算しない
    if (!res.ok) return;
    const data = await res.json();
    if (data.signals) raceSignals.set(id, data.signals);
    else raceSignals.delete(id);
    updateRaceSignalBadge(id);
  } catch (_) {
    // 目印が出ないだけ
  }
}

function raceSignalHtml(id) {
  return [...(raceSignals.get(Number(id)) || "")]
    .map((c) => `<span class="race-signal-badge race-signal-${c === "複" ? "fuku" : "wide"}" title="${escapeAttr(SIGNAL_TITLES[c] || "")}">${escapeHtml(c)}</span>`)
    .join("");
}

function updateRaceSignalBadge(id) {
  const el = raceGrid.querySelector(`[data-signal-race="${Number(id)}"]`);
  if (el) el.innerHTML = raceSignalHtml(id);
}

async function loadRaces() {
  const date = dateInput.value;
  const [ok] = await Promise.all([
    loadRacesOfDate(date),
    loadPurchasedRaceIds(date),
    loadRaceDates(),
    loadMyMemoHorseNames(),
    loadMyKeyRaceIds(),
  ]);
  if (!ok) return;
  renderCalendar();
  renderGrid();
  showRaceSignals(date);

  const id = Number(new URLSearchParams(location.search).get("race"));
  if (id) {
    let race = races.find(x => Number(x.id) === id);
    // ?since= の範囲外(古い)レースへの深リンクは、その1件だけ個別取得する。
    if (!race) {
      const res = await authedFetch(`/api/races/${id}`);
      if (res.ok) race = await res.json();
    }
    if (race) await openPurchase(race);
    else document.body.classList.remove("deep-link-purchase"); // レース不明なら通常表示に戻す
  }
}

// 選んだ日に開催される重賞の一覧(カレンダーと競馬場ごとの一覧の間。2026-10-08)。
// 重賞の判定はサーバー側(GET /api/races の graded。重賞一覧と照合)。押すとデータ検索「重賞検索」で
// その重賞(今年の出走馬・過去10年の成績)を別タブで開く。
function renderGradedDayList(day) {
  const el = document.getElementById("graded-day-list");
  if (!el) return;
  const graded = day
    .filter(r => r.graded)
    .sort((a, b) => trackSortIndex(a.track) - trackSortIndex(b.track) || Number(a.race_number) - Number(b.race_number));
  el.hidden = graded.length === 0;
  if (!graded.length) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <span class="graded-day-title">開催予定の重賞</span>
    ${graded.map(r => {
      const g = r.graded;
      const grade = `${g.is_jump ? "J" : ""}${g.grade || ""}`;
      return `<a class="graded-day-item" href="${appUrl("search", `data-search.html?graded=${encodeURIComponent(g.id)}`)}" target="_blank" rel="noopener" title="データ検索「重賞検索」で過去10年の成績を別タブで開きます">
        <span class="graded-day-grade">${escapeHtml(grade)}</span>
        <span class="graded-day-name">${escapeHtml(g.name)}</span>
        <span class="graded-day-where">${escapeHtml(r.track)}${r.race_number}R</span>
      </a>`;
    }).join("")}`;
}

function renderGrid() {
  const date = dateInput.value;
  // まだ取っていない日(2026-10-18〜。日付を選んでから取る)は、取り終わるまで「読み込み中」を出す
  if (!loadedRaceDates.has(date)) {
    renderGradedDayList([]);
    noRaceHint.hidden = true;
    raceGrid.innerHTML = `<p class="buy-hint">読み込み中…</p>`;
    if (raceTrackTabs) raceTrackTabs.innerHTML = "";
    return;
  }
  // 中央・地方のチェックで外した方の競馬場は、重賞の一覧・競馬場のタブ・レースの一覧のどれにも出さない(2026-10-28)
  const day = races.filter(r => r.race_date === date && trackPassesRegionFilter(r.track, regionFilter));
  renderGradedDayList(day);
  const tracks = sortTracksForDisplay([...new Set(day.map(r => r.track))]);
  noRaceHint.hidden = tracks.length > 0;
  noRaceHint.textContent = races.some(r => r.race_date === date)
    ? `この日は${regionFilter.central ? "地方" : "中央"}のレースだけです(上の「${regionFilter.central ? "地方" : "中央"}」にチェックを入れると表示します)。`
    : "この日に登録済みのレースがありません。";

  if (!tracks.length) {
    raceGrid.innerHTML = "";
    if (raceTrackTabs) raceTrackTabs.innerHTML = "";
    return;
  }

  // 選択中タブがその日に存在しない(=日付切り替え、または開催が無くなった)場合は
  // 並び順の先頭(一番東の競馬場)へフォールバックする。
  if (!selectedTrackTab || !tracks.includes(selectedTrackTab)) {
    selectedTrackTab = tracks[0];
  }

  const by = {};
  day.forEach(r => by[`${r.track}_${r.race_number}`] = r);

  // モバイル用の競馬場タブ(PCではCSSで非表示。#race-track-tabs参照)。
  if (raceTrackTabs) {
    raceTrackTabs.innerHTML = tracks.map(track => `
      <button type="button" class="race-track-tab ${track === selectedTrackTab ? "active" : ""}" data-track="${escapeAttr(track)}">${escapeHtml(track)}</button>
    `).join("");
    raceTrackTabs.querySelectorAll("button[data-track]").forEach(btn => {
      btn.onclick = () => {
        selectedTrackTab = btn.dataset.track;
        renderGrid();
      };
    });
  }

  raceGrid.innerHTML = `
    <div class="race-columns">
      ${tracks.map(track => `
        <section class="race-track-column ${track === selectedTrackTab ? "tab-active" : ""}" data-track="${escapeAttr(track)}">
          <h3>${escapeHtml(track)}</h3>
          ${Array.from({length:12}, (_, i) => {
            const r = by[`${track}_${i+1}`];
            if (!r) return `<div class="race-column-row no-race"><b>${i+1}R</b></div>`;
            // 「購入済み」はテキストバッジではなく、行の背景色(薄い緑の
            // アクセント)で示す方式。(docs/DESIGN.md参照)。
            const purchased = purchasedRaceIds.has(Number(r.id));
            const courseText = formatCourseText(r.course_type, r.distance);
            const hasMemo = raceHasMemoHorse(r);
            const infoParts = [];
            if (r.post_time) infoParts.push(escapeHtml(r.post_time));
            if (courseText) infoParts.push(escapeHtml(courseText));
            // 出走取消の印(2026-10-15)の馬は頭数から引く
            const scratchedN = r.entries.filter((e) => e && e.scratched).length;
            infoParts.push(r.entries.length ? `${r.entries.length - scratchedN}頭${scratchedN ? `(取消${scratchedN})` : ""}` : "出走馬未登録");
            // 勝負レースの★/☆トグルは行ボタン(予想画面へ遷移)の中に入れられない
            // (ボタンの入れ子は不正)ため、ラッパー内で行ボタンの右端に重ねて置く。
            const isKey = myKeyRaceIds.has(Number(r.id));
            return `
              <div class="race-row-wrap">
                <button class="race-column-row ${r.entries.length ? "has-entries" : "empty-race"} ${purchased ? "purchased" : ""}"
                  data-id="${r.id}" type="button">
                  <b>${i+1}R</b>
                  <span>${escapeHtml(r.race_name || "")}</span>
                  <small>${infoParts.join(" ・ ")}${hasMemo ? `<span class="memo-mark" title="メモ登録済みの馬が出走しています">▼</span>` : ""}<span class="race-signal" data-signal-race="${r.id}">${raceSignalHtml(r.id)}</span></small>
                </button>
                <button type="button" class="key-race-mini ${isKey ? "active" : ""}" data-key-race-id="${r.id}"
                  aria-pressed="${isKey}" title="勝負レース(${isKey ? "ON" : "OFF"})">${isKey ? "★" : "☆"}</button>
              </div>`;
          }).join("")}
        </section>
      `).join("")}
    </div>
  `;

  raceGrid.querySelectorAll("button[data-id]").forEach(btn => {
    btn.onclick = () => {
      // レース選択の責務は「予想へ進む」こと。
      // 馬券購入は予想ページからのみ開始する。
      location.href = `prediction.html?race=${encodeURIComponent(btn.dataset.id)}`;
    };
  });

  raceGrid.querySelectorAll("button[data-key-race-id]").forEach(btn => {
    btn.onclick = () => toggleKeyRaceFromGrid(btn);
  });
}

// レース一覧の★/☆ボタンで勝負レースをON/OFFする(2026-09-25。予想登録画面のトグルと
// 同じ PUT /api/predictions/key-race)。一覧全体を描き直さず、押したボタンだけ更新する
// (カラムの横スクロール位置などを保つため)。
async function toggleKeyRaceFromGrid(btn) {
  const raceId = Number(btn.dataset.keyRaceId);
  const next = !myKeyRaceIds.has(raceId);
  btn.disabled = true;
  try {
    const res = await authedFetch("/api/predictions/key-race", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ race_id: raceId, is_key_race: next }),
    });
    if (!res.ok) {
      alert("勝負レースの切り替えに失敗しました。");
      return;
    }
    if (next) myKeyRaceIds.add(raceId); else myKeyRaceIds.delete(raceId);
    btn.classList.toggle("active", next);
    btn.setAttribute("aria-pressed", String(next));
    btn.title = `勝負レース(${next ? "ON" : "OFF"})`;
    btn.textContent = next ? "★" : "☆";
  } finally {
    btn.disabled = false;
  }
}

function renderCalendar() {
  if (!calendarGrid || !calendarMonthLabel) return;
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  calendarMonthLabel.textContent = `${year}年${month + 1}月`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const selected = dateInput.value;

  const headers = ["日","月","火","水","木","金","土"];
  let html = headers.map(h => `<span class="calendar-weekday">${h}</span>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<span class="calendar-day empty"></span>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const hasRace = [...(raceDateTracks.get(key) || [])].some((t) => trackPassesRegionFilter(t, regionFilter));
    html += `<button type="button" class="calendar-day ${key === selected ? "selected" : ""} ${hasRace ? "has-race" : ""}" data-date="${key}">
      <span>${d}</span>${hasRace ? '<i></i>' : ''}
    </button>`;
  }
  calendarGrid.innerHTML = html;
  calendarGrid.querySelectorAll("button[data-date]").forEach(btn => {
    btn.onclick = () => {
      selectedDate = btn.dataset.date;
      dateInput.value = selectedDate;
      selectedTrackTab = null; // 日付が変わるため、タブ選択を先頭競馬場へリセットする
      renderCalendar();
      renderGrid();
      showDate(selectedDate); // その日をまだ取っていなければ取ってから描き直す(2026-10-18)
      const url = new URL(location.href);
      url.searchParams.set("date", selectedDate);
      url.searchParams.delete("race");
      history.replaceState(null, "", url);
    };
  });
}

prevMonthBtn?.addEventListener("click", () => {
  calendarMonth.setMonth(calendarMonth.getMonth() - 1);
  renderCalendar();
});
nextMonthBtn?.addEventListener("click", () => {
  calendarMonth.setMonth(calendarMonth.getMonth() + 1);
  renderCalendar();
});
todayBtn?.addEventListener("click", () => {
  const now = new Date();
  calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  // 2026-08-24修正: UTC基準のtoISOString()から、共有関数todayDateKey()
  // (public/utils.js。ローカルタイムゾーン基準)へ統一した。上記の初期表示時の
  // 修正と同じ理由(docs/design/screens.md「『今日』ボタンの日付判定」参照)。
  selectedDate = todayDateKey(now);
  dateInput.value = selectedDate;
  selectedTrackTab = null; // 日付が変わるため、タブ選択を先頭競馬場へリセットする
  renderCalendar();
  renderGrid();
  showDate(selectedDate);
});

setupAuth(loadRaces);
