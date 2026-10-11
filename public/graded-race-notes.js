// 重賞メモ(2026-10-12追加)の入力欄。予想登録画面(prediction.js のダイアログ)と
// データ検索「重賞検索」タブ(graded-race-search.js)で共用する。
// 重賞1つ×年ごとに1件。選んだ年のメモを編集し(入力は自動保存)、その下にほかの年のメモを
// 新しい年から順に表示する。仕様は docs/design/graded-race-search.md「重賞メモ」。
//
// mountGradedRaceNotes(container, { gradedRaceId, year, notes?, onChange? })
//   year: 最初に選んでおく年(そのレースの年・今年)
//   notes: 取得済みの GET /api/graded-race-notes の notes(省略時はここで取得する)
//   onChange(notes): 保存後に呼ぶ(メモの有無の表示を親が更新する用)
// 戻り値の flush() は保存待ちの入力をすぐ保存する(ダイアログを閉じる・画面を切り替える前に呼ぶ)。

const GRN_PAST_YEARS = 10;

async function fetchGradedRaceNotes(gradedRaceId) {
  const res = await authedFetch(`/api/graded-race-notes?graded_race_id=${encodeURIComponent(gradedRaceId)}`);
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  return Array.isArray(data.notes) ? data.notes : [];
}

function mountGradedRaceNotes(container, { gradedRaceId, year, notes, onChange }) {
  const byYear = new Map();
  let selectedYear = Number(year);
  let saveTimer = null;
  let pendingText = null;
  let disposed = false;

  container.innerHTML = `
    <div class="grn">
      <div class="grn-head">
        <select class="prediction-select grn-year-select" aria-label="メモの年"></select>
        <span class="horse-note-status grn-status" hidden></span>
      </div>
      <textarea class="grn-text" rows="6" maxlength="5000" placeholder="予想の根拠、結果の振り返りなど(自分だけに表示されます)" aria-label="この年の重賞メモ" disabled></textarea>
      <div class="grn-others"></div>
    </div>`;
  const selectEl = container.querySelector(".grn-year-select");
  const textEl = container.querySelector(".grn-text");
  const statusEl = container.querySelector(".grn-status");
  const othersEl = container.querySelector(".grn-others");

  function setStatus(text, ok) {
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = `horse-note-status grn-status ${ok ? "success" : "error"}`;
  }

  function renderYearOptions() {
    const thisYear = new Date().getFullYear();
    const top = Math.max(thisYear, selectedYear, ...byYear.keys());
    const bottom = Math.min(selectedYear - GRN_PAST_YEARS, thisYear - GRN_PAST_YEARS, ...byYear.keys());
    const options = [];
    for (let y = top; y >= bottom; y--) {
      options.push(`<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}年${byYear.has(y) ? " ●" : ""}</option>`);
    }
    selectEl.innerHTML = options.join("");
  }

  function renderOthers() {
    const others = [...byYear.entries()].filter(([y]) => y !== selectedYear).sort((a, b) => b[0] - a[0]);
    othersEl.innerHTML = others.length
      ? `<p class="grn-others-title">ほかの年のメモ</p>` +
        others
          .map(([y, n]) => `
          <div class="grn-other">
            <div class="grn-other-head">
              <span class="grn-other-year">${y}年</span>
              <button type="button" class="ghost-btn grn-edit-btn" data-year="${y}">この年を編集</button>
            </div>
            <div class="grn-other-text">${escapeHtml(n.memo)}</div>
          </div>`)
          .join("")
      : "";
  }

  function render() {
    renderYearOptions();
    textEl.value = byYear.get(selectedYear)?.memo || "";
    renderOthers();
  }

  async function save(targetYear, text) {
    const memo = String(text ?? "").trim();
    let res;
    try {
      res = await authedFetch("/api/graded-race-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graded_race_id: gradedRaceId, year: targetYear, memo }),
      });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      if (!disposed) setStatus("保存に失敗しました", false);
      return;
    }
    const saved = await res.json();
    if (memo) byYear.set(targetYear, { memo, updated_at: saved.updated_at });
    else byYear.delete(targetYear);
    if (onChange) onChange([...byYear.entries()].map(([y, n]) => ({ year: y, ...n })));
    if (disposed) return;
    setStatus("自動保存済み", true);
    renderYearOptions();
    // 編集中の年の一覧は出さないので、保存した年が今選んでいる年なら一覧はそのまま。
    if (targetYear !== selectedYear) renderOthers();
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    save(selectedYear, pendingText);
  }

  textEl.addEventListener("input", () => {
    clearTimeout(saveTimer);
    pendingText = textEl.value;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save(selectedYear, pendingText);
    }, 500);
  });

  function selectYear(y) {
    flush();
    selectedYear = y;
    statusEl.hidden = true;
    render();
  }

  selectEl.addEventListener("change", () => selectYear(Number(selectEl.value)));
  othersEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".grn-edit-btn");
    if (!btn) return;
    selectYear(Number(btn.dataset.year));
    textEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  function load(list) {
    byYear.clear();
    for (const n of list || []) {
      if (n && n.memo) byYear.set(Number(n.year), { memo: n.memo, updated_at: n.updated_at });
    }
    textEl.disabled = false;
    render();
  }

  render();
  if (notes) {
    load(notes);
  } else {
    fetchGradedRaceNotes(gradedRaceId)
      .then((list) => { if (!disposed) load(list); })
      .catch(() => { if (!disposed) setStatus("メモの読み込みに失敗しました", false); });
  }

  return {
    flush,
    // 画面から外すとき。保存待ちの入力は保存してから切り離す。
    dispose() {
      flush();
      disposed = true;
    },
  };
}
