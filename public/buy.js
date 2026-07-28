let races = [];
let selectedRace = null;
let comboAmounts = new Map();
let predictionMarks = new Map();

const state = {
  betType: "tan",
  method: "normal",
  normalOrder: [],
  boxSet: new Set(),
  singleSet: new Set(),
  axisSet: new Set(),
  axisPair: [null, null],
  axisPlacement: "12",
  nagashiFixedSlot: 0,
  partnerSet: new Set(),
  axisCount: 1,
  multi: false,
  formationSlots: []
};

const dateInput = document.getElementById("date-input");
const raceGrid = document.getElementById("race-grid");
const calendarGrid = document.getElementById("calendar-grid");
const calendarMonthLabel = document.getElementById("calendar-month-label");
const prevMonthBtn = document.getElementById("prev-month-btn");
const nextMonthBtn = document.getElementById("next-month-btn");
const todayBtn = document.getElementById("today-btn");
const noRaceHint = document.getElementById("no-race-hint");
const modal = document.getElementById("purchase-modal");
const titleEl = document.getElementById("purchase-dialog-title");
const summaryEl = document.getElementById("purchase-race-summary");
const betButtons = document.getElementById("bet-type-buttons");
const methodSection = document.getElementById("method-section");
const methodButtons = document.getElementById("method-buttons");
const methodOptions = document.getElementById("method-options");
const pickerSection = document.getElementById("picker-section");
const pickerArea = document.getElementById("picker-area");
const pickerTitle = document.getElementById("picker-dialog-title");
const previewSection = document.getElementById("preview-section");
const previewArea = document.getElementById("preview-area");
const amountInput = document.getElementById("amount-input");
const submitBtn = document.getElementById("submit-btn");
const submitMessage = document.getElementById("submit-message");

const BET_LABELS = {
  tan:"単勝", fuku:"複勝", wakuren:"枠連", umaren:"馬連",
  wide:"ワイド", umatan:"馬単", sanrenpuku:"三連複", sanrentan:"三連単"
};

const today = new Date();
let selectedDate = new URLSearchParams(location.search).get("date")
  || today.toISOString().slice(0,10);
let calendarMonth = new Date(`${selectedDate}T00:00:00`);
calendarMonth.setDate(1);
dateInput.value = selectedDate;

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) return;
  races = await res.json();
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
  const tracks = [...new Set(day.map(r => r.track))];
  noRaceHint.hidden = tracks.length > 0;

  if (!tracks.length) {
    raceGrid.innerHTML = "";
    return;
  }

  const by = {};
  day.forEach(r => by[`${r.track}_${r.race_number}`] = r);

  raceGrid.innerHTML = `
    <div class="race-columns">
      ${tracks.map(track => `
        <section class="race-track-column">
          <h3>${escapeHtml(track)}</h3>
          ${Array.from({length:12}, (_, i) => {
            const r = by[`${track}_${i+1}`];
            if (!r) return `<div class="race-column-row no-race"><b>${i+1}R</b></div>`;
            return `
              <button class="race-column-row ${r.entries.length ? "has-entries" : "empty-race"}"
                data-id="${r.id}" type="button">
                <b>${i+1}R</b>
                <span>${escapeHtml(r.race_name || "")}</span>
                <small>${r.entries.length ? `${r.entries.length}頭` : "出走馬未登録"}</small>
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
  selectedDate = now.toISOString().slice(0,10);
  dateInput.value = selectedDate;
  renderCalendar();
  renderGrid();
});


function resetState() {
  state.betType = "tan";
  state.method = "normal";
  state.normalOrder = [null];
  state.boxSet = new Set();
  state.singleSet = new Set();
  state.axisSet = new Set();
  state.axisPair = [null, null];
  state.axisPlacement = "12";
  state.nagashiFixedSlot = 0;
  state.partnerSet = new Set();
  state.axisCount = 1;
  state.multi = false;
  state.formationSlots = [];
  comboAmounts = new Map();
}

async function openPurchase(race) {
  selectedRace = race;
  resetState();

  // 予想印を購入UIへ引き継ぐ。
  predictionMarks = new Map();
  try {
    const res = await authedFetch(`/api/predictions?race_id=${race.id}`);
    if (res.ok) {
      const data = await res.json();
      predictionMarks = new Map();
      for (const x of (data.marks || [])) { const n=Number(x.horse_number); if (!predictionMarks.has(n)) predictionMarks.set(n, []); predictionMarks.get(n).push(x.mark); }
    }
  } catch (_) {}

  titleEl.textContent = `${race.track} ${race.race_number}R${race.race_name ? ` ${race.race_name}` : ""}`;
  summaryEl.innerHTML = `
    <strong>${escapeHtml(race.track)}</strong>
    <span>${race.race_number}R</span>
    ${race.race_name ? `<span>${escapeHtml(race.race_name)}</span>` : ""}
  `;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  renderBetTypes();
  hideDownstream();
}

function hideDownstream() {
  methodSection.hidden = true;
  pickerSection.hidden = true;
  previewSection.hidden = true;
  submitMessage.hidden = true;
}

document.getElementById("close-purchase-modal").onclick = () => {
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  history.replaceState(null, "", "buy.html");
};

function renderBetTypes() {
  betButtons.innerHTML = Object.entries(BET_LABELS)
    .map(([k,v]) => `<button class="choice-button ${state.betType===k ? "selected" : ""}" data-value="${k}" type="button">${v}</button>`)
    .join("");

  betButtons.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      state.betType = btn.dataset.value;
      resetBetSelections();
      renderBetTypes();
      if (BET_TYPES[state.betType].n === 1) {
        // 単勝・複勝は「通常」を選ばせず、券種選択後すぐ馬選択へ。
        methodSection.hidden = true;
        renderPicker();
      } else {
        renderMethods();
      }
    };
  });
}

function resetBetSelections() {
  const n = BET_TYPES[state.betType].n;
  state.method = "normal";
  state.normalOrder = Array(n).fill(null);
  state.boxSet = new Set();
  state.singleSet = new Set();
  state.axisSet = new Set();
  state.axisPair = [null, null];
  state.axisPlacement = "12";
  state.nagashiFixedSlot = 0;
  state.partnerSet = new Set();
  state.axisCount = 1;
  state.multi = false;
  state.formationSlots = Array.from({length:n}, () => new Set());
  comboAmounts = new Map();
}

function methodsFor() {
  const n = BET_TYPES[state.betType].n;
  if (n === 1) return ["normal"];
  if (state.betType === "sanrentan") return ["normal","box","nagashi","formation"];
  return ["normal","box","nagashi","formation"];
}

function renderMethods() {
  const methods = methodsFor();
  methodSection.hidden = false;
  methodButtons.innerHTML = methods.map(m =>
    `<button class="choice-button ${state.method===m ? "selected" : ""}" data-value="${m}" type="button">${methodLabel(m)}</button>`
  ).join("");

  methodButtons.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      state.method = btn.dataset.value;
      resetMethodSelections();
      renderMethods();
      renderPicker();
    };
  });

  renderMethodOptions();
  renderPicker();
}

function resetMethodSelections() {
  const n = BET_TYPES[state.betType].n;
  state.normalOrder = Array(n).fill(null);
  state.boxSet = new Set();
  state.singleSet = new Set();
  state.axisSet = new Set();
  state.axisPair = [null, null];
  state.axisPlacement = "12";
  state.nagashiFixedSlot = 0;
  state.partnerSet = new Set();
  state.formationSlots = Array.from({length:n}, () => new Set());
  comboAmounts = new Map();
}

function renderMethodOptions() {
  methodOptions.innerHTML = "";
  if (state.method !== "nagashi") return;

  const n = BET_TYPES[state.betType].n;
  const isSanrenpuku = state.betType === "sanrenpuku";
  const isSanrentan = state.betType === "sanrentan";
  // 馬連・馬単・ワイド・枠連は流し＝軸1頭で固定。軸数選択は表示しない。
  const supportsTwoAxis = isSanrenpuku || isSanrentan;

  let html = "";
  if (supportsTwoAxis) {
    html += `
      <div class="inline-options axis-mode-options">
        <label><input type="radio" name="axis-count" value="1" ${state.axisCount===1?"checked":""}> 1頭軸</label>
        <label><input type="radio" name="axis-count" value="2" ${state.axisCount===2?"checked":""}> 2頭軸</label>
      </div>
    `;
  }

  if (state.betType === "umatan" && state.method === "nagashi") {
    html += `
      <div class="inline-options axis-placement-options">
        <label><input type="radio" name="umatan-fixed-slot" value="0" ${state.nagashiFixedSlot===0?"checked":""}> 1着固定</label>
        <label><input type="radio" name="umatan-fixed-slot" value="1" ${state.nagashiFixedSlot===1?"checked":""}> 2着固定</label>
      </div>
    `;
  }

  if (isSanrentan && state.axisCount === 2) {
    html += `
      <div class="inline-options axis-placement-options">
        <label><input type="radio" name="axis-placement" value="12" ${state.axisPlacement==="12"?"checked":""}> 1・2着</label>
        <label><input type="radio" name="axis-placement" value="13" ${state.axisPlacement==="13"?"checked":""}> 1・3着</label>
        <label><input type="radio" name="axis-placement" value="23" ${state.axisPlacement==="23"?"checked":""}> 2・3着</label>
      </div>
    `;
  }

  if (isSanrentan) {
    html += `
      <label class="toggle-option">
        <input type="checkbox" id="multi-toggle" ${state.multi ? "checked" : ""}>
        マルチ
      </label>
    `;
  }

  methodOptions.innerHTML = html;

  methodOptions.querySelectorAll('input[name="axis-count"]').forEach(x => {
    x.onchange = () => {
      state.axisCount = Number(x.value);
      resetMethodSelections();
      state.axisCount = Number(x.value);
      renderMethodOptions();
      renderPicker();
    };
  });

  methodOptions.querySelectorAll('input[name="axis-placement"]').forEach(x => {
    x.onchange = () => {
      state.axisPlacement = x.value;
      renderPreview();
    };
  });
  methodOptions.querySelectorAll('input[name="umatan-fixed-slot"]').forEach(x => {
    x.onchange = () => {
      state.nagashiFixedSlot = Number(x.value);
      renderPreview();
    };
  });

  const mt = document.getElementById("multi-toggle");
  if (mt) mt.onchange = () => {
    state.multi = mt.checked;
    renderPreview();
  };
}

function horseRow(e, controlHtml) {
  const mark = (predictionMarks.get(Number(e.horse_number)) || []).join(" ");
  return `
    <div class="bet-horse-row ${mark ? "has-prediction-mark" : ""}">
      <span class="mini-waku waku-${e.waku_number||0}">${e.waku_number||"-"}</span>
      <span class="bet-horse-num">${e.horse_number}</span>
      <span class="bet-horse-name">${escapeHtml(e.horse_name||"馬名未登録")}</span>
      <span class="bet-horse-jockey">${escapeHtml(e.jockey||"")}</span>
      <span class="bet-horse-mark">${mark || ""}</span>
      <span class="bet-horse-control">${controlHtml}</span>
    </div>
  `;
}

function renderPicker() {
  if (!selectedRace) return;
  pickerSection.hidden = false;
  pickerTitle.textContent = `${BET_LABELS[state.betType]} / ${methodLabel(state.method)}`;

  if (!selectedRace.entries.length) {
    pickerArea.innerHTML = `<p class="buy-hint">出走馬が未登録です。レース管理で出走馬を登録してから購入してください。</p>`;
    previewSection.hidden = true;
    return;
  }

  const entries = [...selectedRace.entries].sort((a,b) => Number(a.horse_number)-Number(b.horse_number));
  let html = "";

  if (state.method === "normal") {
    if (BET_TYPES[state.betType].n === 1) {
      html = entries.map(e => horseRow(e,
        `<label class="check-inline"><input type="checkbox" class="single-check" value="${e.horse_number}" ${state.singleSet.has(e.horse_number)?"checked":""} aria-label="${escapeHtml(e.horse_name||"馬")}を選択"></label>`
      )).join("");
    } else {
      html = entries.map(e => horseRow(e,
        Array.from({length:BET_TYPES[state.betType].n}, (_,i) =>
          `<label class="radio-inline"><input type="radio" name="normal-${i}" data-slot="${i}" value="${e.horse_number}" ${state.normalOrder[i]===e.horse_number?"checked":""}></label>`
        ).join("")
      )).join("");
    }
  } else if (state.method === "box") {
    html = entries.map(e => horseRow(e,
      `<label class="check-inline"><input type="checkbox" class="horse-check" value="${e.horse_number}" ${state.boxSet.has(e.horse_number)?"checked":""} aria-label="${escapeHtml(e.horse_name||"馬")}を選択"></label>`
    )).join("");
  } else if (state.method === "nagashi") {
    if (state.axisCount === 2 && (state.betType === "sanrenpuku" || state.betType === "sanrentan")) {
      const axis1 = entries.map(e => horseRow(e,
        `<label class="check-inline"><input type="radio" name="axis-pair-1" class="axis-pair-1" value="${e.horse_number}" ${state.axisPair[0]===Number(e.horse_number)?"checked":""}></label>`
      )).join("");
      const axis2 = entries.map(e => horseRow(e,
        `<label class="check-inline"><input type="radio" name="axis-pair-2" class="axis-pair-2" value="${e.horse_number}" ${state.axisPair[1]===Number(e.horse_number)?"checked":""}></label>`
      )).join("");
      const partners = entries.map(e => horseRow(e,
        `<label class="check-inline"><input type="checkbox" class="partner-check" value="${e.horse_number}" ${state.partnerSet.has(e.horse_number)?"checked":""}></label>`
      )).join("");
      html = `
        <div class="axis-jra-panel">
          <div class="axis-jra-head">
            <div><strong>軸馬①</strong><span>1頭選択</span></div>
            <div><strong>軸馬②</strong><span>1頭選択</span></div>
          </div>
          <div class="axis-two-columns">
            <div class="axis-jra-column"><div class="bet-horse-list">${axis1}</div></div>
            <div class="axis-jra-column"><div class="bet-horse-list">${axis2}</div></div>
          </div>
        </div>
        <div class="nagashi-partners axis-jra-partners">
          <div class="axis-jra-head single"><div><strong>相手</strong><span>複数選択可</span></div></div>
          <div class="bet-horse-list">${partners}</div>
        </div>
      `;
    } else {
      html = entries.map(e => {
        const axisControl = `<input type="radio" name="axis-one" class="axis-radio" value="${e.horse_number}" ${state.axisSet.has(e.horse_number)?"checked":""}>`;
        const partner = `<input type="checkbox" class="partner-check" value="${e.horse_number}" ${state.partnerSet.has(e.horse_number)?"checked":""}>`;
        return horseRow(e,
          `<label class="control-label">${axisControl}</label><label class="control-label">${partner}</label>`
        );
      }).join("");
    }
  } else {
    html = entries.map(e => horseRow(e,
      Array.from({length:BET_TYPES[state.betType].n}, (_,i) =>
        `<label class="check-inline"><input type="checkbox" class="formation-check" data-slot="${i}" value="${e.horse_number}" ${state.formationSlots[i].has(e.horse_number)?"checked":""} aria-label="${selectionLabel(state.betType,i)}"></label>`
      ).join("")
    )).join("");
  }

  if (state.method === "nagashi" && state.axisCount === 2 && (state.betType === "sanrenpuku" || state.betType === "sanrentan")) {
    // 2頭軸専用レイアウトは見出しを外側に置くため、共通ヘッダーは表示しない。
    pickerArea.innerHTML = html;
  } else {
    pickerArea.innerHTML = `
      <div class="bet-horse-table-head">
        <span>枠</span><span>馬番</span><span>馬名</span><span>騎手</span><span>印</span><span></span>
      </div>
      <div class="bet-horse-list">${html}</div>
    `;
  }

  bindPicker();
  renderPreview();
}

function bindPicker() {
  pickerArea.querySelectorAll('input[name^="normal-"]').forEach(x =>
    x.onchange = () => {
      state.normalOrder[Number(x.dataset.slot)] = Number(x.value);
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".single-check").forEach(x =>
    x.onchange = () => {
      x.checked ? state.singleSet.add(Number(x.value)) : state.singleSet.delete(Number(x.value));
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".horse-check").forEach(x =>
    x.onchange = () => {
      x.checked ? state.boxSet.add(Number(x.value)) : state.boxSet.delete(Number(x.value));
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".axis-radio").forEach(x =>
    x.onchange = () => {
      state.axisSet = new Set([Number(x.value)]);
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".axis-pair-1").forEach(x =>
    x.onchange = () => {
      const n = Number(x.value);
      if (state.axisPair[1] === n) {
        x.checked = false;
        return;
      }
      state.axisPair[0] = n;
      state.axisSet = new Set(state.axisPair.filter(Boolean));
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".axis-pair-2").forEach(x =>
    x.onchange = () => {
      const n = Number(x.value);
      if (state.axisPair[0] === n) {
        x.checked = false;
        return;
      }
      state.axisPair[1] = n;
      state.axisSet = new Set(state.axisPair.filter(Boolean));
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".partner-check").forEach(x =>
    x.onchange = () => {
      const n = Number(x.value);
      x.checked ? state.partnerSet.add(n) : state.partnerSet.delete(n);
      renderPreview();
    }
  );

  pickerArea.querySelectorAll(".formation-check").forEach(x =>
    x.onchange = () => {
      const i = Number(x.dataset.slot), n = Number(x.value);
      x.checked ? state.formationSlots[i].add(n) : state.formationSlots[i].delete(n);
      renderPreview();
    }
  );
}

function currentCombos() {
  const def = BET_TYPES[state.betType];

  if (state.method === "normal") {
    if (def.n === 1) {
      return [...state.singleSet].map(x => [x]);
    }
    if (state.normalOrder.some(x => x == null)) return [];
    return generateCombinations(state.normalOrder.map(x => [x]), def.ordered);
  }

  if (state.method === "box") {
    return generateCombinations(
      Array.from({length:def.n}, () => [...state.boxSet]), def.ordered
    );
  }

  if (state.method === "formation") {
    return generateCombinations(
      state.formationSlots.map(s => [...s]), def.ordered
    );
  }

  if (state.method === "nagashi") {
    const axis = [...state.axisSet];
    const partners = [...state.partnerSet].filter(x => !state.axisSet.has(x));

    if (state.axisCount === 1) {
      if (axis.length !== 1) return [];

      if (def.ordered) {
        if (state.multi) return generateAxis1Multi(axis[0], partners);
        // 馬単流しは1着固定/2着固定を選択。三連単1頭軸は従来どおり1着固定。
        const fixedSlot = state.betType === "umatan" ? state.nagashiFixedSlot : 0;
        return generateCombinations(slotsForNagashiOrdered(def.n, axis[0], fixedSlot, partners), true);
      }

      return generateCombinations(
        slotsForNagashiUnordered(def.n, axis, partners), false
      );
    }

    if (axis.length !== 2 || partners.length < 1) return [];

    if (state.betType === "sanrenpuku") {
      return generateCombinations([[axis[0]],[axis[1]],partners], false);
    }

    // 三連単2頭軸。マルチONなら2頭＋相手の全着順。
    if (state.multi) return generateAxis2Multi(axis, partners);

    const placement = state.axisPlacement || "12";
    const slots = placement === "13"
      ? [[axis[0]], partners, [axis[1]]]
      : placement === "23"
        ? [partners, [axis[0]], [axis[1]]]
        : [[axis[0]], [axis[1]], partners];
    return generateCombinations(slots, true);
  }

  return [];
}

function renderPreview() {
  if (!selectedRace) return;
  const combos = currentCombos();
  previewSection.hidden = combos.length === 0;

  if (!combos.length) {
    previewArea.innerHTML = "";
    submitBtn.disabled = true;
    return;
  }

  const map = Object.fromEntries(selectedRace.entries.map(e => [e.horse_number, e]));
  const def = BET_TYPES[state.betType];

  combos.forEach(c => {
    const key = JSON.stringify(c);
    if (!comboAmounts.has(key)) comboAmounts.set(key, Number(amountInput.value) || 100);
  });

  const total = combos.reduce((sum,c) => sum + (comboAmounts.get(JSON.stringify(c)) || 0), 0);

  previewArea.innerHTML = `
    <div class="preview-summary">
      <b>${combos.length}点</b>
      <b>合計 ¥${total.toLocaleString()}</b>
    </div>
    <div class="preview-combo-list">
      ${combos.map(c => {
        const key = JSON.stringify(c);
        return `
          <div class="preview-combo-row">
            <span>${c.map(h => `${h} ${escapeHtml(map[h]?.horse_name || "")}`).join(def.ordered ? " → " : " - ")}</span>
            <input class="preview-combo-amount" data-key='${escapeAttr(key)}'
              type="number" min="100" step="100" value="${comboAmounts.get(key)}">
          </div>
        `;
      }).join("")}
    </div>
  `;

  previewArea.querySelectorAll(".preview-combo-amount").forEach(input => {
    input.onchange = () => {
      comboAmounts.set(input.dataset.key, Number(input.value) || 0);
      renderPreview();
    };
  });

  submitBtn.disabled = false;
}

document.getElementById("apply-amount-btn").onclick = () => {
  const value = Number(amountInput.value) || 100;
  currentCombos().forEach(c => comboAmounts.set(JSON.stringify(c), value));
  renderPreview();
};

submitBtn.onclick = async () => {
  const combos = currentCombos();
  if (!combos.length) return;

  const map = Object.fromEntries(selectedRace.entries.map(e => [e.horse_number, e]));
  const payload = combos.map(c => ({
    selections: c.map(h => {
      const e = map[h] || {};
      return {
        horse_number:h,
        waku_number:e.waku_number ?? null,
        horse_name:e.horse_name || "",
        jockey:e.jockey || ""
      };
    }),
    amount:comboAmounts.get(JSON.stringify(c)) || 0
  }));

  if (payload.some(x => !x.amount)) {
    alert("金額を確認してください");
    return;
  }

  submitBtn.disabled = true;
  const res = await authedFetch("/api/tickets/bulk", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      race_id:selectedRace.id,
      race_date:selectedRace.race_date,
      track:selectedRace.track,
      race_number:selectedRace.race_number,
      race_name:selectedRace.race_name,
      bet_type:state.betType,
      method:state.method,
      combos:payload
    })
  });

  submitMessage.hidden = false;
  submitMessage.className = `submit-message ${res.ok ? "success" : "error"}`;
  submitMessage.textContent = res.ok
    ? `${combos.length}点を購入記録に保存しました。`
    : "保存に失敗しました。";
  submitBtn.disabled = !res.ok;
};

setupAuth(loadRaces);
