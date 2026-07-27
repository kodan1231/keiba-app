let races = [];
let selectedRace = null;
let prediction = { marks: [], memo: "" };

const raceSelect = document.getElementById("race-select");
const emptyState = document.getElementById("prediction-empty");
const panel = document.getElementById("prediction-panel");
const raceHeader = document.getElementById("prediction-race-header");
const horsesEl = document.getElementById("prediction-horses");
const memoEl = document.getElementById("prediction-memo");
const saveBtn = document.getElementById("save-prediction-btn");
const messageEl = document.getElementById("prediction-message");

const MARKS = ["◎", "○", "▲", "△", "☆"];

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) return;

  races = await res.json();

  const sorted = [...races].sort((a, b) => {
    const dateCompare = String(b.race_date).localeCompare(String(a.race_date));
    if (dateCompare !== 0) return dateCompare;
    const trackCompare = String(a.track).localeCompare(String(b.track), "ja");
    if (trackCompare !== 0) return trackCompare;
    return Number(a.race_number) - Number(b.race_number);
  });

  raceSelect.innerHTML = `<option value="">レースを選択してください</option>` +
    sorted.map((race) => `
      <option value="${race.id}">
        ${escapeHtml(formatDate(race.race_date))} ${escapeHtml(race.track)} ${race.race_number}R${race.race_name ? ` ${escapeHtml(race.race_name)}` : ""}
      </option>
    `).join("");

  const queryRaceId = Number(new URLSearchParams(window.location.search).get("race"));
  const initial = Number.isInteger(queryRaceId) && queryRaceId > 0
    ? sorted.find((r) => r.id === queryRaceId)
    : null;

  if (initial) {
    raceSelect.value = String(initial.id);
    await selectRace(initial.id);
  }
}

raceSelect.addEventListener("change", async () => {
  const raceId = Number(raceSelect.value);
  if (!raceId) {
    selectedRace = null;
    panel.hidden = true;
    emptyState.hidden = false;
    return;
  }
  await selectRace(raceId);
});

async function selectRace(raceId) {
  selectedRace = races.find((race) => race.id === raceId);
  if (!selectedRace) return;

  emptyState.hidden = true;
  panel.hidden = false;
  messageEl.hidden = true;
  saveBtn.disabled = true;

  renderRaceHeader();
  renderHorses();
  memoEl.value = "";

  const res = await authedFetch(`/api/predictions?race_id=${encodeURIComponent(raceId)}`);
  if (res.ok) {
    prediction = await res.json();
    applyPrediction();
  } else {
    prediction = { marks: [], memo: "" };
    memoEl.value = "";
    showMessage("既存の予想を読み込めませんでした。", false);
  }

  saveBtn.disabled = false;
}

function renderRaceHeader() {
  raceHeader.innerHTML = `
    <div class="prediction-race-title">
      <span class="r-num">${selectedRace.race_number}R</span>
      <span class="track">${escapeHtml(selectedRace.track)}</span>
      ${selectedRace.race_name ? `<span class="race-name">${escapeHtml(selectedRace.race_name)}</span>` : ""}
    </div>
    <div class="prediction-race-meta">
      ${escapeHtml(formatDate(selectedRace.race_date))} ・ ${selectedRace.entries.length}頭
    </div>
  `;
}

function renderHorses() {
  const entries = [...selectedRace.entries].sort((a, b) =>
    Number(a.horse_number) - Number(b.horse_number)
  );

  if (entries.length === 0) {
    horsesEl.innerHTML = `<p class="prediction-no-entries">このレースにはまだ出走馬が登録されていません。先にレース管理から出走馬を登録してください。</p>`;
    saveBtn.disabled = true;
    return;
  }

  saveBtn.disabled = false;

  horsesEl.innerHTML = entries.map((entry) => {
    const horseNumber = Number(entry.horse_number);
    return `
      <article class="prediction-horse" data-horse-number="${horseNumber}">
        <div class="prediction-horse-info">
          <span class="mini-waku waku-${entry.waku_number || 0}">${entry.waku_number || "-"}</span>
          <span class="prediction-horse-number">${horseNumber}</span>
          <div class="prediction-horse-name">
            <strong>${escapeHtml(entry.horse_name || "馬名未登録")}</strong>
            ${entry.jockey ? `<small>${escapeHtml(entry.jockey)}</small>` : ""}
          </div>
        </div>
        <div class="prediction-mark-buttons" role="group" aria-label="${horseNumber}番の予想印">
          ${MARKS.map((mark) => `
            <button type="button" class="prediction-mark-btn" data-mark="${mark}" aria-label="${mark}">
              ${mark}
            </button>
          `).join("")}
          <button type="button" class="prediction-mark-btn clear-mark" data-mark="" aria-label="印なし">−</button>
        </div>
      </article>
    `;
  }).join("");

  horsesEl.querySelectorAll(".prediction-mark-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".prediction-horse");
      const horseNumber = Number(row.dataset.horseNumber);
      const mark = btn.dataset.mark;

      row.querySelectorAll(".prediction-mark-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");

      prediction.marks = prediction.marks.filter((item) => Number(item.horse_number) !== horseNumber);
      if (mark) {
        prediction.marks.push({ horse_number: horseNumber, mark });
      }
    });
  });
}

function applyPrediction() {
  memoEl.value = prediction.memo || "";

  const markMap = new Map(
    (prediction.marks || []).map((item) => [Number(item.horse_number), item.mark])
  );

  horsesEl.querySelectorAll(".prediction-horse").forEach((row) => {
    const horseNumber = Number(row.dataset.horseNumber);
    const mark = markMap.get(horseNumber) || "";
    const target = row.querySelector(`.prediction-mark-btn[data-mark="${CSS.escape(mark)}"]`)
      || row.querySelector(".clear-mark");

    row.querySelectorAll(".prediction-mark-btn").forEach((btn) => btn.classList.remove("selected"));
    if (target) target.classList.add("selected");
  });
}

saveBtn.addEventListener("click", async () => {
  if (!selectedRace) return;

  saveBtn.disabled = true;
  messageEl.hidden = true;

  const res = await authedFetch("/api/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      race_id: selectedRace.id,
      marks: prediction.marks,
      memo: memoEl.value,
    }),
  });

  if (res.ok) {
    prediction = await res.json();
    showMessage("予想を保存しました。", true);
  } else {
    const data = await res.json().catch(() => ({}));
    showMessage(data.error || "予想の保存に失敗しました。", false);
  }

  saveBtn.disabled = false;
});

function showMessage(message, success) {
  messageEl.hidden = false;
  messageEl.className = `submit-message ${success ? "success" : "error"}`;
  messageEl.textContent = message;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
}

setupAuth(loadRaces);
