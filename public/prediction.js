let races = [];
let selectedRace = null;
let prediction = { marks: [] };
let horseNotes = {};
const emptyState = document.getElementById("prediction-empty");
const panel = document.getElementById("prediction-panel");
const raceHeader = document.getElementById("prediction-race-header");
const horsesEl = document.getElementById("prediction-horses");
const buyBtn = document.getElementById("buy-race-btn");
const messageEl = document.getElementById("prediction-message");
const MARKS = ["◎", "○", "▲", "△", "☆"];

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) {
    showEmpty("レース情報の取得に失敗しました。");
    return;
  }
  races = await res.json();
  const raceId = Number(new URLSearchParams(location.search).get("race"));
  if (!Number.isInteger(raceId) || raceId <= 0) {
    showEmpty("レースが指定されていません。レース一覧から対象レースを選択してください。");
    return;
  }
  selectedRace = races.find(r => Number(r.id) === raceId);
  if (!selectedRace) {
    showEmpty("指定されたレースが見つかりません。");
    return;
  }
  await selectRace();
}

function showEmpty(message) {
  emptyState.hidden = false;
  emptyState.textContent = message;
  panel.hidden = true;
}

async function selectRace() {
  emptyState.hidden = true;
  panel.hidden = false;
  renderRaceHeader();
  renderHorses();

  const [predRes, noteRes] = await Promise.all([
    authedFetch(`/api/predictions?race_id=${selectedRace.id}`),
    authedFetch(`/api/horse-notes?race_id=${selectedRace.id}`)
  ]);

  // 予想印はDBのprediction_marksを唯一の正とする。
  // APIが失敗した場合だけ、既存entries内のmarkを互換用に読み込む。
  if (predRes.ok) {
    prediction = await predRes.json();
  } else {
    prediction = {
      marks: (selectedRace.entries || [])
        .filter(e => MARKS.includes(e.mark))
        .map(e => ({ horse_number: Number(e.horse_number), mark: e.mark }))
    };
  }

  horseNotes = noteRes.ok ? await noteRes.json() : {};
  applyPrediction();
  applyHorseNotes();
  buyBtn.href = `buy.html?race=${encodeURIComponent(selectedRace.id)}`;
}

function renderRaceHeader() {
  raceHeader.innerHTML = `
    <div class="prediction-race-title">
      <span class="track">${escapeHtml(selectedRace.track)}</span>
      <span class="r-num">${selectedRace.race_number}R</span>
      ${selectedRace.race_name ? `<span class="race-name">${escapeHtml(selectedRace.race_name)}</span>` : ""}
    </div>
    <div class="prediction-race-meta">
      ${escapeHtml(formatDate(selectedRace.race_date))} ・ ${selectedRace.entries.length}頭
    </div>
  `;
}

function renderHorses() {
  const entries = [...selectedRace.entries].sort((a,b) => Number(a.horse_number) - Number(b.horse_number));
  if (!entries.length) {
    horsesEl.innerHTML = `<p class="prediction-no-entries">出走馬が登録されていません。</p>`;
    return;
  }

  horsesEl.innerHTML = entries.map(e => {
    const n = Number(e.horse_number);
    const note = horseNotes[e.horse_name] || {};
    return `
      <article class="prediction-horse horse-note-card"
        data-horse-number="${n}"
        data-horse-name="${escapeAttr(e.horse_name || "")}">
        <div class="horse-note-toggle" role="button" tabindex="0">
          <span class="mini-waku waku-${e.waku_number || 0}">${e.waku_number || "-"}</span>
          <span class="prediction-horse-number">${n}</span>
          <span class="prediction-horse-name">
            <strong>${escapeHtml(e.horse_name || "馬名未登録")}</strong>
            ${e.jockey ? `<small>${escapeHtml(e.jockey)}</small>` : ""}
            ${note.memo ? `<small class="horse-note-preview" title="${escapeAttr(note.memo)}">メモ: ${escapeHtml(note.memo.length > 36 ? note.memo.slice(0,36) + "…" : note.memo)}</small>` : ""}
          </span>
          <span class="prediction-mark-inline" aria-label="予想印">
            ${MARKS.map(m => `<button type="button" class="prediction-mark-btn" data-mark="${m}" aria-label="${m}">${m}</button>`).join("")}
            <button type="button" class="prediction-mark-btn clear-mark" data-mark="" aria-label="印なし">−</button>
          </span>
          <span class="note-chevron">＋</span>
        </div>
        <div class="horse-note-editor" hidden>
          <label class="horse-memo-label">
            この馬についてのメモ
            <textarea class="horse-memo" rows="3" maxlength="5000"
              placeholder="次回以降も参照したい、この馬固有のメモを入力">${escapeHtml(note.memo || "")}</textarea>
          </label>
          <span class="horse-note-status" hidden></span>
        </div>
      </article>
    `;
  }).join("");

  // 馬名行のクリックでメモだけ展開。印ボタンのクリックでは展開を切り替えない。
  horsesEl.querySelectorAll(".horse-note-toggle").forEach(btn => {
    btn.addEventListener("click", (event) => {
      if (event.target.closest(".prediction-mark-inline")) return;
      const card = btn.closest(".horse-note-card");
      const editor = card.querySelector(".horse-note-editor");
      editor.hidden = !editor.hidden;
      btn.querySelector(".note-chevron").textContent = editor.hidden ? "＋" : "−";
    });
  });

  horsesEl.querySelectorAll(".prediction-mark-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const card = btn.closest(".horse-note-card");
      const n = Number(card.dataset.horseNumber);
      const mark = btn.dataset.mark || "";
      const existing = (prediction.marks || []).some(x => Number(x.horse_number) === n && x.mark === mark);
      if (mark) {
        if (existing) {
          prediction.marks = (prediction.marks || []).filter(x => !(Number(x.horse_number) === n && x.mark === mark));
        } else {
          prediction.marks = [...(prediction.marks || []), { horse_number: n, mark }];
        }
      } else {
        prediction.marks = (prediction.marks || []).filter(x => Number(x.horse_number) !== n);
      }
      await savePredictionMarks();
    });
  });

  // メモは入力変更後に自動保存。短時間の連続入力はデバウンスする。
  horsesEl.querySelectorAll(".horse-memo").forEach(textarea => {
    let timer;
    textarea.addEventListener("input", () => {
      clearTimeout(timer);
      const card = textarea.closest(".horse-note-card");
      timer = setTimeout(() => saveHorseNote(card), 500);
    });
  });
}

async function saveHorseNote(card) {
  const name = normalizeHorseName(card.dataset.horseName);
  if (!name) return;
  const memo = card.querySelector(".horse-memo").value.trim();
  const status = card.querySelector(".horse-note-status");
  const res = await authedFetch("/api/horse-notes", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ horse_name: name, memo })
  });
  status.hidden = false;
  status.textContent = res.ok ? "自動保存済み" : "保存に失敗しました";
  status.className = `horse-note-status ${res.ok ? "success" : "error"}`;
  if (res.ok) {
    horseNotes[name] = { memo };
  }
}

async function savePredictionMarks() {
  if (!selectedRace) return;
  const res = await authedFetch("/api/predictions", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ race_id: selectedRace.id, marks: prediction.marks || [], memo: "" })
  });
  messageEl.hidden = false;
  messageEl.className = `submit-message ${res.ok ? "success" : "error"}`;
  messageEl.textContent = res.ok ? "印を自動保存しました" : "印の保存に失敗しました";
  if (res.ok) {
    setTimeout(() => { messageEl.hidden = true; }, 1200);
  }
}

function applyPrediction() {
  const map = new Map();
  for (const x of (prediction.marks || [])) {
    const n = Number(x.horse_number);
    if (!map.has(n)) map.set(n, new Set());
    map.get(n).add(x.mark);
  }
  horsesEl.querySelectorAll(".horse-note-card").forEach(card => {
    const marks = map.get(Number(card.dataset.horseNumber)) || new Set();
    card.querySelectorAll(".prediction-mark-btn").forEach(btn => {
      const mark = btn.dataset.mark || "";
      btn.classList.toggle("selected", mark ? marks.has(mark) : marks.size === 0);
    });
  });
}

function applyHorseNotes() {
  horsesEl.querySelectorAll(".horse-note-card").forEach(card => {
    const name = normalizeHorseName(card.dataset.horseName);
    const note = horseNotes[normalizeHorseName(name)]?.memo || "";
    const textarea = card.querySelector(".horse-memo");
    if (textarea) textarea.value = note;
  });
}

function normalizeHorseName(str) { return String(str ?? "").replace(/[\u3000\s]+/g, " ").trim(); }

function escapeHtml(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g,"&#39;"); }
function formatDate(s) {
  return new Date(`${s}T00:00:00`).toLocaleDateString("ja-JP", {
    year:"numeric", month:"numeric", day:"numeric", weekday:"short"
  });
}

setupAuth(loadRaces);
