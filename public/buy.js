// 馬券購入画面のコア(state・カレンダー・レース選択グリッド描画)。
//
// 2026-09-01リファクタリング: トークン消費削減のため、元々1ファイルだった buy.js を
// 「グリッド表示」と「購入モーダル」の2ファイルに分割した(docs/ROADMAP.md「クラスタI」参照。
// races.jsの3分割と同じ方針)。
//   - buy.js(本ファイル): state・カレンダー・競馬場タブ・レース選択グリッド描画
//   - buy-purchase-modal.js: 購入モーダル一式(券種選択・購入方式・馬選択・組み合わせ生成・送信)
// いずれもESモジュールを使わないクラシックスクリプトのため、2ファイルは同一の
// グローバルスコープを共有する(races.js分割時と同じ前提。既存のpublic/utils.jsの
// JRA_CENTRAL_TRACKS共有パターンで検証済み)。index.html での読み込み順は
// buy.js → buy-purchase-modal.js。分割によって画面の挙動・DOM構造・APIは変更していない。

let races = [];
// 自分(ログインユーザー)が既に購入済みのレースID(races.id)の集合。
// 通常購入(tickets)・CSVインポート分(ticket-imports)の両方を対象とする。
// GET /api/tickets・GET /api/ticket-imports はいずれもログインユーザー自身のデータのみを
// 返すため、他ユーザーの購入は含まれない(docs/DESIGN.md「画面仕様」参照)。
let purchasedRaceIds = new Set();

// 自分(ログインユーザー)が空でないメモを登録済みの馬名の集合(2026-08-16追加)。
// レース選択画面で「出走馬に1頭でもメモ登録済みの馬がいれば▼マークを表示する」判定に使う。
// GET /api/horse-notes (race_id省略) はログインユーザー自身のメモのみを返すため、
// 他ユーザーのメモは対象に含まれない。
let myMemoHorseNames = new Set();

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
// ローカルタイムゾーン基準)に統一する(docs/DESIGN.md「『今日』ボタンの日付判定」参照)。
let selectedDate = new URLSearchParams(location.search).get("date")
  || todayDateKey(today);
let calendarMonth = new Date(`${selectedDate}T00:00:00`);
calendarMonth.setDate(1);
dateInput.value = selectedDate;

// 自分が既に購入済みのレースID集合を作る(通常購入・CSVインポート分の両方)。
// レース一覧取得と並行して呼び出す(loadRaces参照)。取得に失敗した場合は
// バッジ表示を諦めるだけで、レース一覧・購入自体には影響させない。
async function loadPurchasedRaceIds() {
  const ids = new Set();
  try {
    const [ticketsRes, importedRes] = await Promise.all([
      authedFetch("/api/tickets"),
      authedFetch("/api/ticket-imports"),
    ]);
    if (ticketsRes.ok) {
      const tickets = await ticketsRes.json().catch(() => []);
      (Array.isArray(tickets) ? tickets : []).forEach((t) => {
        if (t.race_id !== null && t.race_id !== undefined) ids.add(Number(t.race_id));
      });
    }
    if (importedRes.ok) {
      const payload = await importedRes.json().catch(() => ({}));
      const items = Array.isArray(payload) ? payload : (Array.isArray(payload.items) ? payload.items : []);
      items.forEach((t) => {
        if (t.race_id !== null && t.race_id !== undefined) ids.add(Number(t.race_id));
      });
    }
  } catch (_) {
    // 取得に失敗してもレース一覧表示自体は継続する(色分けが出ないだけ)。
  }
  purchasedRaceIds = ids;
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

async function loadRaces() {
  const [racesRes] = await Promise.all([
    authedFetch("/api/races"),
    loadPurchasedRaceIds(),
    loadMyMemoHorseNames(),
  ]);
  if (!racesRes.ok) return;
  races = await racesRes.json();
  renderCalendar();
  renderGrid();

  const id = Number(new URLSearchParams(location.search).get("race"));
  if (id) {
    const race = races.find(x => Number(x.id) === id);
    if (race) await openPurchase(race);
  }
}

function renderGrid() {
  const date = dateInput.value;
  const day = races.filter(r => r.race_date === date);
  const tracks = sortTracksForDisplay([...new Set(day.map(r => r.track))]);
  noRaceHint.hidden = tracks.length > 0;

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
            if (courseText) infoParts.push(escapeHtml(courseText));
            infoParts.push(r.entries.length ? `${r.entries.length}頭` : "出走馬未登録");
            return `
              <button class="race-column-row ${r.entries.length ? "has-entries" : "empty-race"} ${purchased ? "purchased" : ""}"
                data-id="${r.id}" type="button">
                <b>${i+1}R</b>
                <span>${escapeHtml(r.race_name || "")}</span>
                <small>${infoParts.join(" ・ ")}${hasMemo ? `<span class="memo-mark" title="メモ登録済みの馬が出走しています">▼</span>` : ""}</small>
              </button>`;
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
}

function renderCalendar() {
  if (!calendarGrid || !calendarMonthLabel) return;
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  calendarMonthLabel.textContent = `${year}年${month + 1}月`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const raceDates = new Set(races.map(r => r.race_date));
  const selected = dateInput.value;

  const headers = ["日","月","火","水","木","金","土"];
  let html = headers.map(h => `<span class="calendar-weekday">${h}</span>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<span class="calendar-day empty"></span>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const hasRace = raceDates.has(key);
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
  // 修正と同じ理由(docs/DESIGN.md「『今日』ボタンの日付判定」参照)。
  selectedDate = todayDateKey(now);
  dateInput.value = selectedDate;
  selectedTrackTab = null; // 日付が変わるため、タブ選択を先頭競馬場へリセットする
  renderCalendar();
  renderGrid();
});

setupAuth(loadRaces);
