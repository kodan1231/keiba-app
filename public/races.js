let races = [];
let currentHorseCount = 8;
let currentTickets = [];
let selectedRaceDate = null;
let racesCalendarMonth = new Date();
racesCalendarMonth.setDate(1);

const racesMain = document.getElementById("races-main");
const racesCalendarGrid = document.getElementById("races-calendar-grid");
const racesCalendarMonthLabel = document.getElementById("races-calendar-month-label");
const racesClearFilterBtn = document.getElementById("races-clear-filter-btn");
const raceModal = document.getElementById("race-modal");
const raceForm = document.getElementById("race-form");
const raceModalTitle = document.getElementById("race-modal-title");
const entryRows = document.getElementById("entry-rows");
const horseCountSelect = document.getElementById("r-horse-count");
const raceNumberSelect = document.getElementById("r-race-number");
const ticketsSection = document.getElementById("race-tickets-section");
const finish1Select = document.getElementById("r-finish-1");
const finish2Select = document.getElementById("r-finish-2");
const finish3Select = document.getElementById("r-finish-3");

// ---------- 初期化: セレクトの選択肢を用意 ----------
raceNumberSelect.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}R</option>`).join("");
// 出走頭数は最低5頭・最大18頭(JRAの実運用上の範囲)。
horseCountSelect.innerHTML = Array.from({ length: 14 }, (_, i) => i + 5).map((n) => `<option value="${n}">${n}頭</option>`).join("");

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) return;
  races = await res.json();
  renderRaceCalendar();
  renderRaceList();

  const editId = new URLSearchParams(window.location.search).get("edit");
  if (editId) {
    const target = races.find((r) => r.id === Number(editId));
    if (target && window.currentUser && window.currentUser.isAdmin) openModal(target);
    history.replaceState(null, "", "races.html");
    return;
  }

  // admin.html の「未登録レース一覧」から「登録する」で遷移してきた場合、
  // 日付・競馬場・レース番号を事前入力した状態で新規登録モーダルを開く。
  const params = new URLSearchParams(window.location.search);
  const newDate = params.get("new_date");
  if (newDate && window.currentUser && window.currentUser.isAdmin) {
    openModal(null, {
      race_date: newDate,
      track: params.get("new_track") || "",
      race_number: params.get("new_race_number") || "1",
    });
    history.replaceState(null, "", "races.html");
  }
}

// ---------- カレンダーから日付を選ぶ ----------
// レースが登録されている日をカレンダー上でマークし、クリックするとその日だけに絞り込む。
// (以前は登録済みの全日付を上から下へスクロールして探す必要があった)
function renderRaceCalendar() {
  if (!racesCalendarGrid || !racesCalendarMonthLabel) return;
  const year = racesCalendarMonth.getFullYear();
  const month = racesCalendarMonth.getMonth();
  racesCalendarMonthLabel.textContent = `${year}年${month + 1}月`;

  const byDate = new Map();
  races.forEach((r) => {
    if (!byDate.has(r.race_date)) byDate.set(r.race_date, []);
    byDate.get(r.race_date).push(r);
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const headers = ["日", "月", "火", "水", "木", "金", "土"];
  let html = headers.map((h) => `<span class="calendar-weekday">${h}</span>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<span class="calendar-day empty"></span>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dateRaces = byDate.get(key);
    const settledCount = dateRaces ? dateRaces.filter((r) => r.finish_order).length : 0;
    html += `<button type="button" class="calendar-day ${key === selectedRaceDate ? "selected" : ""} ${dateRaces ? "has-race" : ""}" data-date="${key}">
      <span>${d}</span>
      ${dateRaces ? `<span class="calendar-day-count">${settledCount}/${dateRaces.length}</span>` : ""}
    </button>`;
  }
  racesCalendarGrid.innerHTML = html;
  racesCalendarGrid.querySelectorAll("button[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRaceDate = selectedRaceDate === btn.dataset.date ? null : btn.dataset.date;
      expandedDates.add(selectedRaceDate);
      renderRaceCalendar();
      renderRaceList();
    });
  });
}

document.getElementById("races-prev-month-btn")?.addEventListener("click", () => {
  racesCalendarMonth.setMonth(racesCalendarMonth.getMonth() - 1);
  renderRaceCalendar();
});
document.getElementById("races-next-month-btn")?.addEventListener("click", () => {
  racesCalendarMonth.setMonth(racesCalendarMonth.getMonth() + 1);
  renderRaceCalendar();
});
document.getElementById("races-today-btn")?.addEventListener("click", () => {
  const now = new Date();
  racesCalendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  renderRaceCalendar();
});
racesClearFilterBtn?.addEventListener("click", () => {
  selectedRaceDate = null;
  renderRaceCalendar();
  renderRaceList();
});

let expandedDates = new Set();

function renderRaceList() {
  if (races.length === 0) {
    racesMain.innerHTML = `<p class="empty-state">まだレースが登録されていません。「＋ レースを登録」または「開催日程を一括登録」から始めましょう。</p>`;
    return;
  }

  racesClearFilterBtn.hidden = !selectedRaceDate;

  racesMain.innerHTML = "";

  const byDate = new Map();
  races.forEach((r) => {
    if (!byDate.has(r.race_date)) byDate.set(r.race_date, []);
    byDate.get(r.race_date).push(r);
  });
  let dates = [...byDate.keys()].sort().reverse();

  // カレンダーで日付が選択されている場合は、その日だけに絞り込む。
  if (selectedRaceDate) {
    dates = dates.filter((d) => d === selectedRaceDate);
    if (dates.length === 0) {
      racesMain.innerHTML = `<p class="empty-state">この日に登録されているレースはありません。「＋ レースを登録」から追加できます。</p>`;
      return;
    }
  }

  for (const date of dates) {
    const dateRaces = byDate.get(date);
    const settledCount = dateRaces.filter((r) => r.finish_order).length;
    const dateExpanded = expandedDates.has(date);

    const dateWrap = document.createElement("div");
    dateWrap.className = "date-group";

    const dateHead = document.createElement("div");
    dateHead.className = "date-group-head";
    dateHead.innerHTML = `
      <span class="expand-arrow">${dateExpanded ? "▾" : "▸"}</span>
      <span class="date-label">${formatDate(date)}</span>
      <span class="date-meta">${dateRaces.length}レース ・ 結果確定 ${settledCount}/${dateRaces.length}</span>
    `;

    const dateBody = document.createElement("div");
    dateBody.className = "date-group-body";
    dateBody.hidden = !dateExpanded;

    // 競馬場は横に並べ、その下にR1〜12を縦に並べる(予想ページの「馬券購入」カレンダー選択後と同じレイアウト)。
    const byTrack = new Map();
    dateRaces.forEach((r) => {
      if (!byTrack.has(r.track)) byTrack.set(r.track, []);
      byTrack.get(r.track).push(r);
    });

    const columnsWrap = document.createElement("div");
    columnsWrap.className = "race-columns";

    for (const [track, trackRaces] of byTrack) {
      const trackSettled = trackRaces.filter((r) => r.finish_order).length;
      const byNumber = new Map(trackRaces.map((r) => [r.race_number, r]));

      const col = document.createElement("section");
      col.className = "race-track-column";
      col.innerHTML = `<h3>${escapeHtml(track)} <span class="track-meta">結果確定 ${trackSettled}/${trackRaces.length}</span></h3>`;

      for (let n = 1; n <= 12; n++) {
        const r = byNumber.get(n);
        if (!r) {
          const empty = document.createElement("div");
          empty.className = "race-column-row no-race";
          empty.innerHTML = `<b>${n}R</b><span>未登録</span>`;
          col.appendChild(empty);
          continue;
        }
        col.appendChild(renderRaceRow(r));
      }
      columnsWrap.appendChild(col);
    }

    dateBody.appendChild(columnsWrap);

    dateHead.addEventListener("click", () => {
      const nowHidden = !dateBody.hidden;
      dateBody.hidden = nowHidden;
      if (nowHidden) expandedDates.delete(date); else expandedDates.add(date);
      dateHead.querySelector(".expand-arrow").textContent = dateBody.hidden ? "▸" : "▾";
    });

    dateWrap.appendChild(dateHead);
    dateWrap.appendChild(dateBody);
    racesMain.appendChild(dateWrap);
  }
}

function renderRaceRow(r) {
  const settled = !!r.finish_order;
  const hasEntries = r.entries.length > 0;
  const isAdmin = Boolean(window.currentUser && window.currentUser.isAdmin);

  const row = document.createElement("div");
  row.className = "race-list-card";
  row.innerHTML = `
    <span class="r-num">${r.race_number}R</span>
    ${r.race_name ? `<span class="meta">${escapeHtml(r.race_name)}</span>` : ""}
    <span class="entries-badge ${hasEntries ? "done" : ""}">${hasEntries ? `出走馬登録済み(${r.entries.length}頭)` : "出走馬未登録"}</span>
    <span class="settled-badge ${settled ? "done" : ""}">${settled ? "結果確定" : "結果未確定"}</span>
    <span class="card-actions">
      ${isAdmin ? `<button class="icon-btn edit-race-btn" data-id="${r.id}" title="編集">✎</button>` : ""}
      ${isAdmin ? `<button class="icon-btn delete delete-race-btn" data-id="${r.id}" title="削除">×</button>` : ""}
    </span>
  `;
  if (isAdmin) {
    row.querySelector(".edit-race-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(races.find((x) => x.id === r.id));
    });
    row.querySelector(".delete-race-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRace(r.id);
    });
  }
  return row;
}

async function deleteRace(id) {
  if (!confirm("このレースを削除しますか？関連する購入履歴も削除されます。")) return;
  
  try {
    const res = await authedFetch(`/api/races/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    
    if (!res.ok) {
      // 409: 確認が必要なケース
      if (res.status === 409 && data.requires_confirmation) {
        const message = `${data.error}\n\n削除を強制実行しますか？`;
        if (confirm(message)) {
          const forceRes = await authedFetch(`/api/races/${id}?force=1`, { method: "DELETE" });
          const forceData = await forceRes.json().catch(() => ({}));
          if (forceRes.ok) {
            alert("レースを削除しました。");
            loadRaces();
          } else {
            alert(forceData.error || "削除に失敗しました。");
          }
        }
        return;
      }
      alert(data.error || "削除に失敗しました。");
      return;
    }
    
    alert("レースを削除しました。");
    loadRaces();
  } catch (e) {
    alert("削除に失敗しました: " + (e.message || e));
  }
}

// 出走頭数から、枠番の初期値を計算する。JRAの正式な枠番決定ルール(抽選)とは異なるが、
// 「頭数が決まればおおよその枠番の目安はつく」というリクエストに対する簡易な初期値であり、
// 実際の枠番と異なる場合は手動で選び直せる(あくまで入力の手間を減らすための初期値)。
// 8頭以下は1頭1枠、9頭以上は8枠に均等に近い形で振り分ける(余りは若い枠番から+1頭ずつ)。
function defaultWakuNumber(horseNumber, horseCount) {
  const base = Math.floor(horseCount / 8);
  const remainder = horseCount % 8;
  let n = horseNumber;
  for (let waku = 1; waku <= 8; waku++) {
    const size = waku <= remainder ? base + 1 : base;
    if (n <= size) return waku;
    n -= size;
  }
  return 8;
}

// ---------- 着順(1〜3着)セレクト ----------
// 出走馬表(馬名)が未登録でも、馬番だけで払戻計算に必要な上位3着を入力できるようにする。
function renderFinishSelects(horseCount, finishOrder) {
  const options = (selected) =>
    `<option value="">-</option>` +
    Array.from({ length: horseCount }, (_, i) => i + 1)
      .map((n) => `<option value="${n}" ${selected == n ? "selected" : ""}>${n}番</option>`)
      .join("");
  const f = finishOrder || [];
  finish1Select.innerHTML = options(f[0] ?? "");
  finish2Select.innerHTML = options(f[1] ?? "");
  finish3Select.innerHTML = options(f[2] ?? "");
}

// 1〜3着セレクトの現在値から finish_order (先頭が空なら以降も無視。歯抜けは詰めない) を組み立てる。
function readFinishTop3() {
  const vals = [finish1Select.value, finish2Select.value, finish3Select.value].map((v) => (v ? Number(v) : null));
  const order = [];
  for (const v of vals) {
    if (v === null) break; // 1着が未入力なら2着以降は無視、2着が未入力なら3着は無視
    order.push(v);
  }
  return order.length > 0 ? order : null;
}

// ---------- 出走馬の行 ----------
function renderEntryRows(entries, horseCount) {
  currentHorseCount = horseCount;
  const rows = [];
  for (let i = 0; i < horseCount; i++) {
    // 既存データ(entries[i])に枠番があればそれを尊重し、無い新規行だけ初期値を自動設定する。
    const existing = entries[i];
    const waku_number = (existing?.waku_number ?? null) !== null
      ? existing.waku_number
      : defaultWakuNumber(i + 1, horseCount);
    rows.push(existing ? { ...existing, waku_number } : { waku_number, horse_number: i + 1, horse_name: "", jockey: "" });
  }
  entryRows.innerHTML = rows
    .map((e, i) => {
      return `
        <div class="entry-form-row" data-row="${i}">
          <select class="e-waku">
            <option value="">枠-</option>
            ${[1,2,3,4,5,6,7,8].map((n) => `<option value="${n}" ${e.waku_number == n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <select class="e-horse-number">
            ${Array.from({ length: horseCount }, (_, n) => n + 1).map((n) => `<option value="${n}" ${e.horse_number == n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <input type="text" class="e-horse-name" placeholder="馬名" value="${escapeAttr(e.horse_name ?? "")}" />
          <input type="text" class="e-jockey" placeholder="騎手" value="${escapeAttr(e.jockey ?? "")}" />
        </div>
      `;
    })
    .join("");
}

horseCountSelect.addEventListener("change", () => {
  const newCount = Number(horseCountSelect.value);
  const current = readEntryRows();
  const finishOrder = readFinishTop3();
  renderEntryRows(current, newCount);
  // 頭数変更時、既存の着順選択が新しい頭数の範囲を超えていれば維持できないため、
  // 範囲内に収まるものだけ保持する。
  renderFinishSelects(newCount, (finishOrder || []).filter((n) => n <= newCount));
  renderPayoutBlocks();
});

finish1Select.addEventListener("change", renderPayoutBlocks);
finish2Select.addEventListener("change", renderPayoutBlocks);
finish3Select.addEventListener("change", renderPayoutBlocks);

function readEntryRows() {
  return Array.from(entryRows.querySelectorAll(".entry-form-row")).map((row) => ({
    waku_number: row.querySelector(".e-waku").value ? Number(row.querySelector(".e-waku").value) : null,
    horse_number: Number(row.querySelector(".e-horse-number").value),
    horse_name: row.querySelector(".e-horse-name").value,
    jockey: row.querySelector(".e-jockey").value || null,
  }));
}

// ---------- テキスト貼り付けで出走馬を一括入力 ----------
document.getElementById("toggle-paste-btn").addEventListener("click", () => {
  const area = document.getElementById("paste-area");
  area.hidden = !area.hidden;
});

document.getElementById("apply-paste-btn").addEventListener("click", () => {
  const text = document.getElementById("entries-paste").value;
  const parsed = parseEntries(text);
  if (parsed.length === 0) {
    alert("読み取れる行が見つかりませんでした。書式をご確認のうえ、直接入力欄で修正してください。");
    return;
  }
  const count = Math.max(parsed.length, currentHorseCount, 5);
  horseCountSelect.value = count;
  // 馬番が読み取れていればその番号順に、読み取れなければ出現順に並べる
  const withNumbers = parsed.filter((p) => p.horse_number);
  const ordered = withNumbers.length === parsed.length
    ? [...parsed].sort((a, b) => a.horse_number - b.horse_number)
    : parsed.map((p, i) => ({ ...p, horse_number: p.horse_number || i + 1 }));
  renderEntryRows(ordered, count);
  renderFinishSelects(count, readFinishTop3());
  renderPayoutBlocks();
  document.getElementById("paste-area").hidden = true;
});

// ---------- 払戻金額入力(馬券式別) ----------
// 表示中の払戻レート入力値(未保存分もこの中に保持する)。着順セレクトの変更等で再描画しても消えないようにする。
let currentRacePayouts = {};

const REQUIRED_TOP = { tan: 1, fuku: 3, wakuren: 2, umaren: 2, umatan: 2, wide: 3, sanrenpuku: 3, sanrentan: 3 };

async function loadTicketsForRace(raceId) {
  if (!raceId) {
    currentTickets = [];
    renderPayoutBlocks();
    return;
  }
  const res = await authedFetch("/api/tickets");
  if (!res.ok) { currentTickets = []; renderPayoutBlocks(); return; }
  const allTickets = await res.json();
  currentTickets = allTickets.filter((t) => t.race_id === raceId);
  renderPayoutBlocks();
}

// 出走馬表(馬名)や着順が未登録でも、常に払戻金額を入力できるようにする。
// 1〜3着セレクトで着順が入力されている式別だけ、的中組み合わせを表示して入力欄を出す
// (何着まで必要かは式別により異なる。例: 単勝は1着のみ、三連単は3着まで)。
// 未入力の式別は「◯着まで入力すると表示されます」という案内のみ表示し、画面全体は常に表示したままにする。
function renderPayoutBlocks() {
  captureEnteredRatesIntoState();

  const finishOrder = readFinishTop3();
  const entries = readEntryRows();

  ticketsSection.innerHTML = `
    <p class="picker-hint" style="margin-top:16px">払戻金額(100円あたり)。購入金額に応じて自動計算されます。上の1〜3着を入力すると、的中する組み合わせが表示されます。</p>
    <div class="payout-by-type">
      ${BET_TYPE_ORDER.map((betType) => {
        const betTickets = currentTickets.filter((t) => t.bet_type === betType);
        const required = REQUIRED_TOP[betType];
        const enoughInfo = finishOrder && finishOrder.length >= required;
        const combos = enoughInfo ? computeWinningCombos(betType, finishOrder, entries) : [];
        return `
          <div class="payout-type-block" data-bet-type="${betType}">
            <div class="result-head-line"><span class="bet-badge">${betTypeLabel(betType)}</span>${betTickets.length > 0 ? `<span class="point-count">${betTickets.length}点購入</span>` : ""}</div>
            ${!enoughInfo
              ? `<p class="buy-hint">${required}着まで入力すると表示されます。</p>`
              : combos
                  .map((c) => {
                    const rate = findStoredRate(currentRacePayouts, betType, c.combo);
                    return `
                      <label class="payout-rate-row" data-combo='${escapeAttr(JSON.stringify(c.combo))}'>
                        ${c.label}の払戻(100円あたり)
                        <input type="number" class="payout-rate-input" min="0" step="10" value="${rate !== null ? rate : ""}" ${c.combo ? "" : "disabled"} placeholder="未確定" />
                      </label>
                    `;
                  })
                  .join("")}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// 再描画で消えてしまう前に、今表示されている入力値をstateへ退避する。
// まだ着順不足で表示されていない式別(hint表示のみ)は、以前の値をそのまま保持する。
function captureEnteredRatesIntoState() {
  ticketsSection.querySelectorAll(".payout-type-block").forEach((block) => {
    const betType = block.dataset.betType;
    const rows = Array.from(block.querySelectorAll(".payout-rate-row"));
    if (rows.length === 0) return;
    const combos = rows
      .map((row) => ({
        combo: row.dataset.combo === "null" ? null : JSON.parse(row.dataset.combo),
        rate: row.querySelector(".payout-rate-input").value === "" ? null : Number(row.querySelector(".payout-rate-input").value),
      }))
      .filter((c) => c.combo && c.rate !== null);
    currentRacePayouts = { ...currentRacePayouts, [betType]: combos };
  });
}

// フォーム送信時: (1) racesに保存する払戻率データ (2) 各チケットに反映する払戻金額 の両方を組み立てる
function buildPayoutSubmission() {
  captureEnteredRatesIntoState();
  const payoutsPayload = {};
  const ticketUpdates = [];

  for (const betType of BET_TYPE_ORDER) {
    const combos = currentRacePayouts[betType] || [];
    if (combos.length > 0) payoutsPayload[betType] = combos;

    const betTickets = currentTickets.filter((t) => t.bet_type === betType);
    betTickets.forEach((t) => {
      const match = combos.find((c) => ticketMatchesCombo(t, c.combo));
      if (match) {
        ticketUpdates.push({ id: t.id, payout: Math.round((t.amount / 100) * match.rate) });
      } else {
        ticketUpdates.push({ id: t.id, payout: combos.length > 0 ? 0 : null });
      }
    });
  }

  return { payoutsPayload, ticketUpdates };
}

// ---------- モーダル(登録・編集) ----------
document.getElementById("new-race-btn").addEventListener("click", () => openModal());
document.getElementById("race-cancel-btn").addEventListener("click", closeModal);
raceModal.addEventListener("click", (e) => { if (e.target === raceModal) closeModal(); });

function openModal(race, prefill) {
  raceForm.reset();
  document.getElementById("paste-area").hidden = true;
  document.getElementById("entries-paste").value = "";
  document.getElementById("race-id").value = race ? race.id : "";
  raceModalTitle.textContent = race ? "レースを編集" : "レースを登録";

  if (race) {
    document.getElementById("r-race-date").value = race.race_date;
    document.getElementById("r-track").value = race.track;
    raceNumberSelect.value = race.race_number;
    document.getElementById("r-race-name").value = race.race_name || "";

    const count = Math.max(race.entries.length, 5);
    horseCountSelect.value = count;

    renderEntryRows(race.entries, count);
    renderFinishSelects(count, race.finish_order);
    currentRacePayouts = race.payouts || {};
    loadTicketsForRace(race.id);
  } else {
    // admin.html の「未登録レース一覧」から遷移してきた場合、日付・競馬場・レース番号を
    // 事前入力しておく(?new_date=&new_track=&new_race_number= のクエリパラメータ経由)。
    document.getElementById("r-race-date").value = (prefill && prefill.race_date) || new Date().toISOString().slice(0, 10);
    document.getElementById("r-track").value = (prefill && prefill.track) || "";
    raceNumberSelect.value = (prefill && prefill.race_number) || "1";
    horseCountSelect.value = "8";
    renderEntryRows([], 8);
    renderFinishSelects(8, null);
    currentRacePayouts = {};
    loadTicketsForRace(null);
  }

  raceModal.hidden = false;
}

function closeModal() {
  raceModal.hidden = true;
}

raceForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const id = document.getElementById("race-id").value;
  const entries = readEntryRows();
  const finish_order = readFinishTop3();

  const { payoutsPayload, ticketUpdates } = buildPayoutSubmission();

  const payload = {
    race_date: document.getElementById("r-race-date").value,
    track: document.getElementById("r-track").value,
    race_number: Number(raceNumberSelect.value),
    race_name: document.getElementById("r-race-name").value || null,
    entries,
    finish_order,
    payouts: payoutsPayload,
  };

  const res = id
    ? await authedFetch(`/api/races/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    : await authedFetch("/api/races", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "保存に失敗しました");
    return;
  }

  // 払戻金額もあわせて保存(馬券式別に入力された払戻率から自動計算)
  await Promise.all(
    ticketUpdates.map((u) =>
      authedFetch(`/api/tickets/${u.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payout: u.payout }),
      })
    )
  );

  closeModal();
  loadRaces();
});

// ---------- 開催日程 一括登録 ----------
const scheduleModal = document.getElementById("schedule-modal");
const scheduleYearSelect = document.getElementById("schedule-year");
const schedulePreview = document.getElementById("schedule-preview");
const scheduleSubmitBtn = document.getElementById("schedule-submit-btn");
const scheduleMessage = document.getElementById("schedule-message");
let parsedSchedule = [];

const thisYear = new Date().getFullYear();
scheduleYearSelect.innerHTML = [thisYear - 1, thisYear, thisYear + 1]
  .map((y) => `<option value="${y}" ${y === thisYear ? "selected" : ""}>${y}年</option>`)
  .join("");

document.getElementById("schedule-btn").addEventListener("click", () => {
  document.getElementById("schedule-paste").value = "";
  schedulePreview.innerHTML = "";
  scheduleMessage.hidden = true;
  scheduleSubmitBtn.disabled = true;
  parsedSchedule = [];
  scheduleModal.hidden = false;
});
document.getElementById("schedule-cancel-btn").addEventListener("click", () => { scheduleModal.hidden = true; });
scheduleModal.addEventListener("click", (e) => { if (e.target === scheduleModal) scheduleModal.hidden = true; });

document.getElementById("schedule-parse-btn").addEventListener("click", () => {
  const text = document.getElementById("schedule-paste").value;
  const year = Number(scheduleYearSelect.value);
  parsedSchedule = parseSchedule(text, year);

  if (parsedSchedule.length === 0) {
    schedulePreview.innerHTML = `<p class="picker-hint">読み取れる行が見つかりませんでした。書式をご確認ください。</p>`;
    scheduleSubmitBtn.disabled = true;
    return;
  }

  schedulePreview.innerHTML = `
    <p class="picker-hint">${parsedSchedule.length}件の開催日を検出しました(各12レース分作成されます)。</p>
    <ul class="schedule-preview-list">
      ${parsedSchedule.map((s) => `<li>${formatDate(s.race_date)} ${escapeHtml(s.track)}</li>`).join("")}
    </ul>
  `;
  scheduleSubmitBtn.disabled = false;
});

scheduleSubmitBtn.addEventListener("click", async () => {
  const raceRows = [];
  for (const s of parsedSchedule) {
    for (let r = 1; r <= 12; r++) {
      raceRows.push({ race_date: s.race_date, track: s.track, race_number: r, entries: [] });
    }
  }

  scheduleSubmitBtn.disabled = true;
  const res = await authedFetch("/api/races/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ races: raceRows }),
  });

  scheduleMessage.hidden = false;
  if (res.ok) {
    scheduleMessage.className = "submit-message success";
    scheduleMessage.textContent = `${parsedSchedule.length}開催日分のレース枠を作成しました。`;
    loadRaces();
  } else {
    scheduleMessage.className = "submit-message error";
    scheduleMessage.textContent = "登録に失敗しました。";
    scheduleSubmitBtn.disabled = false;
  }
});

// ---------- ユーティリティ ----------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, "&#39;"); }

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
}

setupAuth(loadRaces);
