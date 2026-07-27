let races = [];
let selectedRace = null;
let comboAmounts = new Map(); // key: JSON化した組み合わせ配列 -> 金額

const state = {
  betType: "tan",
  method: "normal",
  normalOrder: [],       // 固定長配列(nullあり) 通常購入で使う
  boxSet: new Set(),
  axisSet: new Set(),
  partnerSet: new Set(),
  axisPosition: 0,
  formationSlots: [],
};

const dateInput = document.getElementById("date-input");
const raceGrid = document.getElementById("race-grid");
const noRaceHint = document.getElementById("no-race-hint");
const manualToggleBtn = document.getElementById("manual-toggle-btn");
const manualRaceArea = document.getElementById("manual-race-area");
const manualTrackInput = document.getElementById("manual-track");
const manualRaceNumberSelect = document.getElementById("manual-race-number");

const entriesStep = document.getElementById("entries-step");
const entriesList = document.getElementById("entries-list");
const betStep = document.getElementById("bet-step");
const pickerStep = document.getElementById("picker-step");
const amountStep = document.getElementById("amount-step");
const previewStep = document.getElementById("preview-step");
const betTypeSelect = document.getElementById("bet-type-select");
const methodSelect = document.getElementById("method-select");
const pickerArea = document.getElementById("picker-area");
const amountInput = document.getElementById("amount-input");
const previewArea = document.getElementById("preview-area");
const submitBtn = document.getElementById("submit-btn");
const submitMessage = document.getElementById("submit-message");

manualRaceNumberSelect.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}R</option>`).join("");
dateInput.value = new Date().toISOString().slice(0, 10);

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) return;
  races = await res.json();
  renderGrid();
}

dateInput.addEventListener("change", () => { renderGrid(); resetToStep1(); });

function resetToStep1() {
  selectedRace = null;
  entriesStep.hidden = true;
  betStep.hidden = true;
  pickerStep.hidden = true;
  amountStep.hidden = true;
  previewStep.hidden = true;
}

// ---------- ①レースを選ぶ: 日付×競馬場×Rの一覧表 ----------
function renderGrid() {
  const dateStr = dateInput.value;
  const dayRaces = races.filter((r) => r.race_date === dateStr);
  const tracks = [...new Set(dayRaces.map((r) => r.track))].sort();

  noRaceHint.hidden = tracks.length > 0;
  if (tracks.length === 0) {
    raceGrid.innerHTML = "";
    return;
  }

  const byKey = {};
  dayRaces.forEach((r) => { byKey[`${r.track}_${r.race_number}`] = r; });

  raceGrid.innerHTML = `
    <table class="race-grid-table">
      <thead><tr><th></th>${Array.from({ length: 12 }, (_, i) => `<th>${i + 1}R</th>`).join("")}</tr></thead>
      <tbody>
        ${tracks
          .map(
            (track) => `
          <tr>
            <th>${escapeHtml(track)}</th>
            ${Array.from({ length: 12 }, (_, i) => {
              const r = byKey[`${track}_${i + 1}`];
              const selected = selectedRace && r && selectedRace.id === r.id;
              const cls = !r ? "no-race" : r.entries.length > 0 ? "has-entries" : "empty-race";
              return `<td><button type="button" class="grid-cell ${cls} ${selected ? "selected" : ""}" data-track="${escapeAttr(track)}" data-rnum="${i + 1}">${r ? i + 1 : "+"}</button></td>`;
            }).join("")}
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
    <p class="grid-legend">
      <span class="legend-swatch has-entries"></span>出走馬登録済み
      <span class="legend-swatch empty-race"></span>枠のみ登録
      <span class="legend-swatch no-race"></span>未登録(クリックで作成)
    </p>
  `;

  raceGrid.querySelectorAll(".grid-cell").forEach((btn) => {
    btn.addEventListener("click", () => selectOrCreateRace(dateStr, btn.dataset.track, Number(btn.dataset.rnum)));
  });
}

manualToggleBtn.addEventListener("click", () => {
  manualRaceArea.hidden = !manualRaceArea.hidden;
});

document.getElementById("manual-confirm-btn").addEventListener("click", () => {
  const track = manualTrackInput.value.trim();
  if (!dateInput.value || !track) {
    alert("開催日と競馬場を入力してください");
    return;
  }
  selectOrCreateRace(dateInput.value, track, Number(manualRaceNumberSelect.value));
});

async function selectOrCreateRace(dateStr, track, rnum) {
  let race = races.find((r) => r.race_date === dateStr && r.track === track && r.race_number === rnum);
  if (!race) {
    const res = await authedFetch("/api/races", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ race_date: dateStr, track, race_number: rnum, entries: [] }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "レースの作成に失敗しました");
      return;
    }
    const data = await res.json();
    const refetch = await authedFetch("/api/races");
    races = await refetch.json();
    race = races.find((r) => r.id === data.id);
  }
  onRaceSelected(race);
}

function onRaceSelected(race) {
  selectedRace = race;
  renderGrid();

  entriesStep.hidden = false;
  betStep.hidden = false;
  pickerStep.hidden = false;
  amountStep.hidden = false;
  previewStep.hidden = false;

  renderEntriesList();
  resetState();
  renderMethodOptions();
  renderPicker();
}

function renderEntriesList() {
  if (selectedRace.entries.length === 0) {
    entriesList.innerHTML = `
      <p class="buy-hint">
        出走馬が未登録のため、馬番のみで購入します。あとで
        <a href="races.html?edit=${selectedRace.id}">レース管理</a>
        から馬名・騎手を追記できます。
      </p>
    `;
    return;
  }
  entriesList.innerHTML = `
    <div class="entries-vertical-list">
      ${selectedRace.entries.map((e, i) => horseListRowHtml(e, i)).join("")}
    </div>
  `;
  entriesList.querySelectorAll(".mark-select").forEach((select) => {
    select.addEventListener("change", async (ev) => {
      const idx = Number(ev.target.dataset.idx);
      selectedRace.entries[idx].mark = ev.target.value;
      await authedFetch(`/api/races/${selectedRace.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: selectedRace.entries }),
      });
    });
  });
}

const MARK_OPTIONS = ["ー", "◎", "〇", "▲", "△", "☆", "消"];

function horseListRowHtml(entry, idx) {
  const waku = entry.waku_number
    ? `<span class="mini-waku" style="background:var(--waku-${entry.waku_number});color:var(--waku-${entry.waku_number}-ink)">${entry.waku_number}</span>`
    : "";
  const mark = entry.mark || "ー";
  return `
    <div class="entries-row">
      ${waku}
      <span class="chip-num">${entry.horse_number}</span>
      <span class="entries-row-name">${escapeHtml(entry.horse_name || "")}</span>
      <span class="entries-row-jockey">${escapeHtml(entry.jockey || "")}</span>
      <select class="mark-select" data-idx="${idx}">
        ${MARK_OPTIONS.map((m) => `<option value="${m}" ${mark === m ? "selected" : ""}>${m}</option>`).join("")}
      </select>
    </div>
  `;
}

// ---------- ②馬券種類・購入方式 ----------
betTypeSelect.addEventListener("change", () => {
  state.betType = betTypeSelect.value;
  resetSelections();
  renderMethodOptions();
  renderPicker();
});

methodSelect.addEventListener("change", () => {
  state.method = methodSelect.value;
  resetSelections();
  renderPicker();
});

function resetState() {
  state.betType = "tan";
  state.method = "normal";
  betTypeSelect.value = "tan";
  methodSelect.value = "normal";
  resetSelections();
}

function resetSelections() {
  const def = BET_TYPES[state.betType];
  state.normalOrder = Array(def.n).fill(null);
  state.boxSet = new Set();
  state.axisSet = new Set();
  state.partnerSet = new Set();
  state.axisPosition = 0;
  state.formationSlots = Array.from({ length: def.n }, () => new Set());
  comboAmounts = new Map();
}

function renderMethodOptions() {
  const avail = availableMethods(state.betType);
  if (!avail.includes(state.method)) {
    state.method = "normal";
    methodSelect.value = "normal";
  }
  Array.from(methodSelect.options).forEach((opt) => { opt.hidden = !avail.includes(opt.value); });
}

// ---------- ③馬を選ぶ ----------
function parseNumberList(str) {
  return [...new Set((str.match(/\d+/g) || []).map(Number))].filter((n) => n >= 1 && n <= 18);
}

function horseChipHtml(entry, selected, extraClass, orderBadge) {
  const waku = entry.waku_number
    ? `<span class="mini-waku" style="background:var(--waku-${entry.waku_number});color:var(--waku-${entry.waku_number}-ink)">${entry.waku_number}</span>`
    : "";
  return `
    <button type="button" class="horse-chip ${selected ? "selected" : ""} ${extraClass || ""}" data-horse="${entry.horse_number}">
      ${orderBadge !== undefined && orderBadge !== null ? `<span class="chip-order">${orderBadge}</span>` : ""}
      ${waku}
      <span class="chip-num">${entry.horse_number}</span>
      <span class="chip-name">${escapeHtml(entry.horse_name || "")}</span>
      <span class="chip-jockey">${escapeHtml(entry.jockey || "")}</span>
    </button>
  `;
}

function renderPicker() {
  if (!selectedRace) return;
  if (selectedRace.entries.length > 0) {
    renderPickerChips();
  } else {
    renderPickerManual();
  }
  renderPreview();
}

function renderPickerChips() {
  const def = BET_TYPES[state.betType];
  const entries = selectedRace.entries;

  if (state.method === "normal") {
    pickerArea.innerHTML = `
      <p class="picker-hint">${def.n}頭を${def.ordered ? "着順どおりの順番でタップ" : "タップして選択"}してください。</p>
      <div class="horse-grid">${entries.map((e) => horseChipHtml(e, state.normalOrder.includes(e.horse_number), "", def.ordered ? state.normalOrder.indexOf(e.horse_number) + 1 || null : null)).join("")}</div>
    `;
    pickerArea.querySelectorAll(".horse-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const h = Number(chip.dataset.horse);
        const idx = state.normalOrder.indexOf(h);
        if (idx >= 0) {
          state.normalOrder[idx] = null;
        } else {
          const emptyIdx = state.normalOrder.indexOf(null);
          if (emptyIdx >= 0) state.normalOrder[emptyIdx] = h;
        }
        renderPickerChips();
        renderPreview();
      });
    });
  } else if (state.method === "box") {
    pickerArea.innerHTML = `
      <p class="picker-hint">対象となる馬を全てタップしてください(${def.n}頭以上)。全組み合わせを自動生成します。</p>
      <div class="horse-grid">${entries.map((e) => horseChipHtml(e, state.boxSet.has(e.horse_number))).join("")}</div>
    `;
    pickerArea.querySelectorAll(".horse-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const h = Number(chip.dataset.horse);
        state.boxSet.has(h) ? state.boxSet.delete(h) : state.boxSet.add(h);
        renderPickerChips();
        renderPreview();
      });
    });
  } else if (state.method === "nagashi") {
    const maxAxis = def.ordered ? 1 : def.n - 1;
    pickerArea.innerHTML = `
      ${nagashiPositionHtml(def)}
      <p class="picker-hint">軸(必ず入る馬・最大${maxAxis}頭)を選んでください。</p>
      <div class="horse-grid">${entries.map((e) => horseChipHtml(e, state.axisSet.has(e.horse_number), state.partnerSet.has(e.horse_number) ? "disabled-chip" : "")).join("")}</div>
      <p class="picker-hint">相手(組み合わせる馬)を選んでください。</p>
      <div class="horse-grid partner-grid">${entries.map((e) => horseChipHtml(e, state.partnerSet.has(e.horse_number), state.axisSet.has(e.horse_number) ? "disabled-chip" : "")).join("")}</div>
    `;
    const grids = pickerArea.querySelectorAll(".horse-grid");
    grids[0].querySelectorAll(".horse-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const h = Number(chip.dataset.horse);
        if (state.partnerSet.has(h)) return;
        if (state.axisSet.has(h)) state.axisSet.delete(h);
        else if (state.axisSet.size < maxAxis) state.axisSet.add(h);
        renderPickerChips();
        renderPreview();
      });
    });
    grids[1].querySelectorAll(".horse-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const h = Number(chip.dataset.horse);
        if (state.axisSet.has(h)) return;
        state.partnerSet.has(h) ? state.partnerSet.delete(h) : state.partnerSet.add(h);
        renderPickerChips();
        renderPreview();
      });
    });
    bindAxisPositionRadios();
  } else if (state.method === "formation") {
    pickerArea.innerHTML = Array.from({ length: def.n }, (_, i) => `
      <p class="picker-hint">${selectionLabel(state.betType, i)}の候補</p>
      <div class="horse-grid formation-grid" data-slot="${i}">
        ${entries.map((e) => horseChipHtml(e, state.formationSlots[i].has(e.horse_number))).join("")}
      </div>
    `).join("");
    pickerArea.querySelectorAll(".formation-grid").forEach((grid) => {
      const slotIdx = Number(grid.dataset.slot);
      grid.querySelectorAll(".horse-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const h = Number(chip.dataset.horse);
          const set = state.formationSlots[slotIdx];
          set.has(h) ? set.delete(h) : set.add(h);
          renderPickerChips();
          renderPreview();
        });
      });
    });
  }
}

// 出走馬未登録の場合: 馬番を直接入力するフォールバックUI
function renderPickerManual() {
  const def = BET_TYPES[state.betType];

  if (state.method === "normal") {
    pickerArea.innerHTML = Array.from({ length: def.n }, (_, i) => `
      <label class="manual-inline">${selectionLabel(state.betType, i)}
        <input type="number" class="manual-normal" data-idx="${i}" min="1" max="18" value="${state.normalOrder[i] ?? ""}" />
      </label>
    `).join("");
    pickerArea.querySelectorAll(".manual-normal").forEach((inp) => {
      inp.addEventListener("input", () => {
        state.normalOrder[Number(inp.dataset.idx)] = inp.value ? Number(inp.value) : null;
        renderPreview();
      });
    });
  } else if (state.method === "box") {
    pickerArea.innerHTML = `
      <label>対象馬番(カンマ区切り、例: 3,5,7,9)
        <input type="text" id="manual-box-input" value="${[...state.boxSet].join(",")}" />
      </label>
    `;
    document.getElementById("manual-box-input").addEventListener("input", (e) => {
      state.boxSet = new Set(parseNumberList(e.target.value));
      renderPreview();
    });
  } else if (state.method === "nagashi") {
    pickerArea.innerHTML = `
      ${nagashiPositionHtml(def)}
      <label>軸馬番(カンマ区切り)
        <input type="text" id="manual-axis-input" value="${[...state.axisSet].join(",")}" />
      </label>
      <label>相手馬番(カンマ区切り)
        <input type="text" id="manual-partner-input" value="${[...state.partnerSet].join(",")}" />
      </label>
    `;
    document.getElementById("manual-axis-input").addEventListener("input", (e) => {
      state.axisSet = new Set(parseNumberList(e.target.value));
      renderPreview();
    });
    document.getElementById("manual-partner-input").addEventListener("input", (e) => {
      state.partnerSet = new Set(parseNumberList(e.target.value));
      renderPreview();
    });
    bindAxisPositionRadios();
  } else if (state.method === "formation") {
    pickerArea.innerHTML = Array.from({ length: def.n }, (_, i) => `
      <label>${selectionLabel(state.betType, i)}候補(カンマ区切り)
        <input type="text" class="manual-formation" data-slot="${i}" value="${[...state.formationSlots[i]].join(",")}" />
      </label>
    `).join("");
    pickerArea.querySelectorAll(".manual-formation").forEach((inp) => {
      inp.addEventListener("input", () => {
        state.formationSlots[Number(inp.dataset.slot)] = new Set(parseNumberList(inp.value));
        renderPreview();
      });
    });
  }
}

function nagashiPositionHtml(def) {
  if (!def.ordered) return "";
  return `
    <div class="axis-position">
      <span class="picker-hint" style="margin:0">軸の着順:</span>
      ${Array.from({ length: def.n }, (_, i) => `
        <label class="radio-chip">
          <input type="radio" name="axis-position" value="${i}" ${state.axisPosition === i ? "checked" : ""} />
          ${selectionLabel(state.betType, i)}
        </label>
      `).join("")}
    </div>
  `;
}

function bindAxisPositionRadios() {
  pickerArea.querySelectorAll('input[name="axis-position"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.axisPosition = Number(radio.value);
      renderPreview();
    });
  });
}

// ---------- 組み合わせ生成 ----------
function buildSlots() {
  const def = BET_TYPES[state.betType];
  if (state.method === "normal") {
    if (state.normalOrder.some((v) => v === null)) return [];
    return slotsForNormal(state.normalOrder);
  }
  if (state.method === "box") return slotsForBox(def.n, [...state.boxSet]);
  if (state.method === "nagashi") {
    if (def.ordered) {
      const axis = [...state.axisSet][0];
      if (axis === undefined) return [];
      return slotsForNagashiOrdered(def.n, axis, state.axisPosition, [...state.partnerSet]);
    }
    return slotsForNagashiUnordered(def.n, [...state.axisSet], [...state.partnerSet]);
  }
  if (state.method === "formation") return slotsForFormation(state.formationSlots.map((s) => [...s]));
  return [];
}

function currentCombos() {
  const def = BET_TYPES[state.betType];
  const slots = buildSlots();
  if (slots.length !== def.n || slots.some((s) => s.length === 0)) return [];
  return generateCombinations(slots, def.ordered);
}

// ---------- ④⑤ 金額・プレビュー ----------
document.getElementById("apply-amount-btn").addEventListener("click", () => {
  const val = Number(amountInput.value) || 0;
  const combos = currentCombos();
  combos.forEach((combo) => comboAmounts.set(JSON.stringify(combo), val));
  renderPreview();
});

function renderPreview() {
  if (!selectedRace) return;
  const combos = currentCombos();
  const defaultAmount = Number(amountInput.value) || 0;

  if (combos.length === 0) {
    previewArea.innerHTML = `<p class="picker-hint">馬を選ぶと、ここに組み合わせが表示されます。</p>`;
    submitBtn.disabled = true;
    return;
  }

  const entriesByNumber = Object.fromEntries(selectedRace.entries.map((e) => [e.horse_number, e]));
  const def = BET_TYPES[state.betType];

  // 新しく出てきた組み合わせには一括金額の初期値を設定する
  combos.forEach((combo) => {
    const key = JSON.stringify(combo);
    if (!comboAmounts.has(key)) comboAmounts.set(key, defaultAmount);
  });

  const total = combos.reduce((s, combo) => s + (comboAmounts.get(JSON.stringify(combo)) || 0), 0);

  previewArea.innerHTML = `
    <div class="preview-summary">
      <span>${combos.length}点</span>
      <span>合計</span>
      <span class="preview-total">¥${total.toLocaleString()}</span>
    </div>
    <div class="preview-combo-list">
      ${combos
        .map((combo) => {
          const key = JSON.stringify(combo);
          const comboLabel = combo.map((h) => `${h}${entriesByNumber[h] ? " " + escapeHtml(entriesByNumber[h].horse_name) : ""}`).join(def.ordered ? " → " : " - ");
          return `
            <div class="preview-combo-row" data-key='${escapeAttr(key)}'>
              <span class="preview-combo-label">${comboLabel}</span>
              <input type="number" class="preview-combo-amount" min="0" step="100" value="${comboAmounts.get(key)}" />
            </div>
          `;
        })
        .join("")}
    </div>
  `;

  previewArea.querySelectorAll(".preview-combo-row").forEach((row) => {
    const key = row.dataset.key;
    row.querySelector(".preview-combo-amount").addEventListener("input", (e) => {
      comboAmounts.set(key, Number(e.target.value) || 0);
      const newTotal = combos.reduce((s, combo) => s + (comboAmounts.get(JSON.stringify(combo)) || 0), 0);
      previewArea.querySelector(".preview-total").textContent = `¥${newTotal.toLocaleString()}`;
    });
  });

  submitBtn.disabled = false;
}

// ---------- 登録 ----------
submitBtn.addEventListener("click", async () => {
  const combos = currentCombos();
  if (combos.length === 0 || !selectedRace) return;

  const entriesByNumber = Object.fromEntries(selectedRace.entries.map((e) => [e.horse_number, e]));
  const comboPayload = combos.map((combo) => {
    const key = JSON.stringify(combo);
    const selections = combo.map((h) => {
      const e = entriesByNumber[h] || {};
      return {
        horse_number: h,
        waku_number: e.waku_number ?? null,
        horse_name: e.horse_name ?? "",
        jockey: e.jockey ?? "",
      };
    });
    return { selections, amount: comboAmounts.get(key) || 0 };
  });

  if (comboPayload.some((c) => !c.amount)) {
    alert("金額が0円の組み合わせがあります。金額を確認してください。");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "登録中...";

  const res = await authedFetch("/api/tickets/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      race_id: selectedRace.id,
      race_date: selectedRace.race_date,
      track: selectedRace.track,
      race_number: selectedRace.race_number,
      race_name: selectedRace.race_name,
      bet_type: state.betType,
      method: state.method,
      combos: comboPayload,
    }),
  });

  submitBtn.textContent = "この内容で購入する";

  if (res.ok) {
    submitMessage.hidden = false;
    submitMessage.className = "submit-message success";
    submitMessage.textContent = `${combos.length}点を登録しました。購入履歴一覧から確認できます。`;
    resetSelections();
    renderPicker();
  } else {
    const data = await res.json().catch(() => ({}));
    submitMessage.hidden = false;
    submitMessage.className = "submit-message error";
    submitMessage.textContent = data.error || "登録に失敗しました";
    submitBtn.disabled = false;
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

setupAuth(loadRaces);
