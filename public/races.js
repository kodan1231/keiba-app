let races = [];
let currentHorseCount = 8;
let currentTickets = [];

const racesMain = document.getElementById("races-main");
const raceModal = document.getElementById("race-modal");
const raceForm = document.getElementById("race-form");
const raceModalTitle = document.getElementById("race-modal-title");
const entryRows = document.getElementById("entry-rows");
const horseCountSelect = document.getElementById("r-horse-count");
const raceNumberSelect = document.getElementById("r-race-number");
const ticketsSection = document.getElementById("race-tickets-section");

// ---------- 初期化: セレクトの選択肢を用意 ----------
raceNumberSelect.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}R</option>`).join("");
horseCountSelect.innerHTML = Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}">${i + 1}頭</option>`).join("");

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) return;
  races = await res.json();
  renderRaceList();

  const editId = new URLSearchParams(window.location.search).get("edit");
  if (editId) {
    const target = races.find((r) => r.id === Number(editId));
    if (target) openModal(target);
    history.replaceState(null, "", "races.html");
  }
}

let expandedDates = new Set();
let expandedTracks = new Set();

function renderRaceList() {
  if (races.length === 0) {
    racesMain.innerHTML = `<p class="empty-state">まだレースが登録されていません。「＋ レースを登録」または「開催日程を一括登録」から始めましょう。</p>`;
    return;
  }

  racesMain.innerHTML = "";

  const byDate = new Map();
  races.forEach((r) => {
    if (!byDate.has(r.race_date)) byDate.set(r.race_date, []);
    byDate.get(r.race_date).push(r);
  });
  const dates = [...byDate.keys()].sort().reverse();

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

    const byTrack = new Map();
    dateRaces.forEach((r) => {
      if (!byTrack.has(r.track)) byTrack.set(r.track, []);
      byTrack.get(r.track).push(r);
    });

    for (const [track, trackRaces] of byTrack) {
      const trackKey = `${date}__${track}`;
      const trackExpanded = expandedTracks.has(trackKey);
      const trackSettled = trackRaces.filter((r) => r.finish_order).length;

      const trackWrap = document.createElement("div");
      trackWrap.className = "track-group";

      const trackHead = document.createElement("div");
      trackHead.className = "track-group-head";
      trackHead.innerHTML = `
        <span class="expand-arrow">${trackExpanded ? "▾" : "▸"}</span>
        <span class="track-label">${escapeHtml(track)}</span>
        <span class="track-meta">${trackRaces.length}レース ・ 結果確定 ${trackSettled}/${trackRaces.length}</span>
      `;

      const trackBody = document.createElement("div");
      trackBody.className = "track-group-body";
      trackBody.hidden = !trackExpanded;

      trackRaces
        .sort((a, b) => a.race_number - b.race_number)
        .forEach((r) => trackBody.appendChild(renderRaceRow(r)));

      trackHead.addEventListener("click", () => {
        const nowHidden = !trackBody.hidden;
        trackBody.hidden = nowHidden;
        if (nowHidden) expandedTracks.delete(trackKey); else expandedTracks.add(trackKey);
        trackHead.querySelector(".expand-arrow").textContent = trackBody.hidden ? "▸" : "▾";
      });

      trackWrap.appendChild(trackHead);
      trackWrap.appendChild(trackBody);
      dateBody.appendChild(trackWrap);
    }

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

  const row = document.createElement("div");
  row.className = "race-list-card";
  row.innerHTML = `
    <span class="r-num">${r.race_number}R</span>
    ${r.race_name ? `<span class="meta">${escapeHtml(r.race_name)}</span>` : ""}
    <span class="entries-badge ${hasEntries ? "done" : ""}">${hasEntries ? `出走馬登録済み(${r.entries.length}頭)` : "出走馬未登録"}</span>
    <span class="settled-badge ${settled ? "done" : ""}">${settled ? "結果確定" : "結果未確定"}</span>
    <span class="card-actions">
      <a class="icon-btn prediction-race-btn" href="prediction.html?race=${r.id}" title="予想">◎</a>
      <button class="icon-btn edit-race-btn" data-id="${r.id}" title="編集">✎</button>
      <button class="icon-btn delete delete-race-btn" data-id="${r.id}" title="削除">×</button>
    </span>
  `;
  row.querySelector(".edit-race-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openModal(races.find((x) => x.id === r.id));
  });
  row.querySelector(".delete-race-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteRace(r.id);
  });
  return row;
}

async function deleteRace(id) {
  if (!confirm("このレースを削除しますか？関連する購入履歴も削除されます。")) return;
  await authedFetch(`/api/races/${id}`, { method: "DELETE" });
  loadRaces();
}

// ---------- 出走馬の行 ----------
function renderEntryRows(entries, horseCount, finishByNumber) {
  currentHorseCount = horseCount;
  const rows = [];
  for (let i = 0; i < horseCount; i++) {
    rows.push(entries[i] || { waku_number: null, horse_number: i + 1, horse_name: "", jockey: "" });
  }
  entryRows.innerHTML = rows
    .map((e, i) => {
      const finish = finishByNumber ? finishByNumber[e.horse_number] : (e.finish || null);
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
          <select class="e-finish">
            <option value="">着-</option>
            ${Array.from({ length: horseCount }, (_, n) => n + 1).map((n) => `<option value="${n}" ${finish == n ? "selected" : ""}>${n}着</option>`).join("")}
          </select>
        </div>
      `;
    })
    .join("");
}

horseCountSelect.addEventListener("change", () => {
  const newCount = Number(horseCountSelect.value);
  const current = readEntryRows();
  renderEntryRows(current, newCount);
});

function readEntryRows() {
  return Array.from(entryRows.querySelectorAll(".entry-form-row")).map((row) => ({
    waku_number: row.querySelector(".e-waku").value ? Number(row.querySelector(".e-waku").value) : null,
    horse_number: Number(row.querySelector(".e-horse-number").value),
    horse_name: row.querySelector(".e-horse-name").value,
    jockey: row.querySelector(".e-jockey").value || null,
    finish: row.querySelector(".e-finish").value ? Number(row.querySelector(".e-finish").value) : null,
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
  const count = Math.max(parsed.length, currentHorseCount);
  horseCountSelect.value = count;
  // 馬番が読み取れていればその番号順に、読み取れなければ出現順に並べる
  const withNumbers = parsed.filter((p) => p.horse_number);
  const ordered = withNumbers.length === parsed.length
    ? [...parsed].sort((a, b) => a.horse_number - b.horse_number)
    : parsed.map((p, i) => ({ ...p, horse_number: p.horse_number || i + 1 }));
  renderEntryRows(ordered, count);
  document.getElementById("paste-area").hidden = true;
});

// ---------- 払戻金額入力(馬券式別) ----------
async function renderTicketsSection(race) {
  if (!race) {
    ticketsSection.innerHTML = "";
    return;
  }
  const res = await authedFetch("/api/tickets");
  if (!res.ok) return;
  const allTickets = await res.json();
  const tickets = allTickets.filter((t) => t.race_id === race.id);
  currentTickets = tickets;

  if (!race.finish_order) {
    ticketsSection.innerHTML = `<p class="buy-hint" style="margin-top:16px">着順を入力すると、ここで馬券式ごとに払戻金額を入力できるようになります。</p>`;
    return;
  }

  const betTypesUsed = BET_TYPE_ORDER;

  ticketsSection.innerHTML = `
    <p class="picker-hint" style="margin-top:16px">払戻金額(100円あたり)。購入金額に応じて自動計算されます。</p>
    <div class="payout-by-type">
      ${betTypesUsed
        .map((betType) => {
          const combos = computeWinningCombos(betType, race.finish_order, race.entries);
          const betTickets = tickets.filter((t) => t.bet_type === betType);
          return `
            <div class="payout-type-block" data-bet-type="${betType}">
              <div class="result-head-line"><span class="bet-badge">${betTypeLabel(betType)}</span><span class="point-count">${betTickets.length}点購入</span></div>
              ${combos
                .map((c) => {
                  const rate = findStoredRate(race.payouts, betType, c.combo);
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
        })
        .join("")}
    </div>
  `;
}

// 入力フォームから (1) racesに保存する払戻率データ (2) 各チケットに反映する払戻金額 の両方を組み立てる
function readPayoutForm() {
  const payoutsPayload = {};
  const ticketUpdates = [];

  ticketsSection.querySelectorAll(".payout-type-block").forEach((block) => {
    const betType = block.dataset.betType;
    const betTickets = currentTickets.filter((t) => t.bet_type === betType);
    const rows = Array.from(block.querySelectorAll(".payout-rate-row"));

    const combos = rows.map((row) => ({
      combo: row.dataset.combo === "null" ? null : JSON.parse(row.dataset.combo),
      rate: row.querySelector(".payout-rate-input").value === "" ? null : Number(row.querySelector(".payout-rate-input").value),
    }));

    const enteredCombos = combos.filter((c) => c.combo && c.rate !== null);
    if (enteredCombos.length > 0) {
      payoutsPayload[betType] = enteredCombos.map((c) => ({ combo: c.combo, rate: c.rate }));
    }

    betTickets.forEach((t) => {
      const match = combos.find((c) => ticketMatchesCombo(t, c.combo) && c.rate !== null);
      if (match) {
        ticketUpdates.push({ id: t.id, payout: Math.round((t.amount / 100) * match.rate) });
      } else {
        const anyRateEntered = combos.some((c) => c.rate !== null);
        ticketUpdates.push({ id: t.id, payout: anyRateEntered ? 0 : null });
      }
    });
  });

  return { payoutsPayload, ticketUpdates };
}

// ---------- モーダル(登録・編集) ----------
document.getElementById("new-race-btn").addEventListener("click", () => openModal());
document.getElementById("race-cancel-btn").addEventListener("click", closeModal);
raceModal.addEventListener("click", (e) => { if (e.target === raceModal) closeModal(); });

function openModal(race) {
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

    const count = Math.max(race.entries.length, 1);
    horseCountSelect.value = count;

    const finishByNumber = {};
    if (race.finish_order) {
      race.finish_order.forEach((horseNumber, idx) => { finishByNumber[horseNumber] = idx + 1; });
    }
    renderEntryRows(race.entries, count, finishByNumber);
    renderTicketsSection(race);
  } else {
    document.getElementById("r-race-date").value = new Date().toISOString().slice(0, 10);
    raceNumberSelect.value = "1";
    horseCountSelect.value = "8";
    renderEntryRows([], 8);
    renderTicketsSection(null);
  }

  raceModal.hidden = false;
}

function closeModal() {
  raceModal.hidden = true;
}

raceForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const id = document.getElementById("race-id").value;
  const rows = readEntryRows();

  const entries = rows.map(({ finish, ...rest }) => rest);
  const finishRows = rows.filter((r) => r.finish).sort((a, b) => a.finish - b.finish);
  const finish_order = finishRows.length > 0 ? finishRows.map((r) => r.horse_number) : null;

  const { payoutsPayload, ticketUpdates } = readPayoutForm();

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
