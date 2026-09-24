// レース管理画面: 払戻 登録・編集モーダル(着順・払戻レート入力・race_results詳細表示)。
//
// 2026-09-01: races.js から分割(トークン消費削減。docs/ROADMAP.md「クラスタI」参照)。
// ESモジュールを使わないクラシックスクリプトのため races.js とグローバルスコープを
// 共有する。races.html では races.js の後に読み込む必要がある(本ファイル冒頭の
// HORSE_COUNT_OPTIONS 参照のため)。分割によって挙動・DOM構造・APIは変更していない。

let currentPayoutHorseCount = 8; // 払戻モーダル内の頭数(着順選択肢の範囲用)
let currentTickets = [];

// 払戻モーダル
const payoutModal = document.getElementById("race-payout-modal");
const payoutForm = document.getElementById("race-payout-form");
const payoutModalTitle = document.getElementById("race-payout-modal-title");
const payoutRaceInfo = document.getElementById("payout-race-info");
const payoutHorseCountSelect = document.getElementById("rp-horse-count");
const ticketsSection = document.getElementById("race-tickets-section");
const finish1Select = document.getElementById("r-finish-1");
const finish2Select = document.getElementById("r-finish-2");
const finish3Select = document.getElementById("r-finish-3");
const raceResultsDetailSection = document.getElementById("race-results-detail-section");
const raceResultsDetailTable = document.getElementById("race-results-detail-table");
const scratchedOpenBtn = document.getElementById("race-scratched-open-btn");
const scratchedModal = document.getElementById("race-scratched-modal");
const scratchedPicker = document.getElementById("race-scratched-picker");
const payoutImportOpenBtn = document.getElementById("race-payout-import-open-btn");
const payoutImportModal = document.getElementById("race-payout-import-modal");
const payoutImportText = document.getElementById("race-payout-import-text");
const payoutImportMessage = document.getElementById("race-payout-import-message");
const payoutImportStatus = document.getElementById("payout-import-status");

// 払戻モーダルで編集中のレースの出走馬情報(combo表示・枠連判定に使う。払戻モーダルでは編集不可)
let currentPayoutEntries = [];

// 出走取消馬の馬番(払戻確定時の返還判定に使う。races.payouts.refunds として保存する。
// 除外は出走馬表確定前に取り除く運用のため対象外。docs/design/payout-refund.md
// 「払戻モーダルでの手動入力(出走取消馬)」参照)
let currentScratchedHorseNumbers = new Set();

// ---------- 初期化: セレクトの選択肢を用意 ----------
payoutHorseCountSelect.innerHTML = HORSE_COUNT_OPTIONS;

// ---------- 着順(1〜3着)セレクト(払戻モーダル) ----------
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

payoutHorseCountSelect.addEventListener("change", () => {
  const newCount = Number(payoutHorseCountSelect.value);
  const finishOrder = readFinishTop3();
  currentPayoutHorseCount = newCount;
  // 頭数変更時、既存の着順選択が新しい頭数の範囲を超えていれば維持できないため、
  // 範囲内に収まるものだけ保持する。
  renderFinishSelects(newCount, (finishOrder || []).filter((n) => n <= newCount));
  for (const n of [...currentScratchedHorseNumbers]) {
    if (n > newCount) currentScratchedHorseNumbers.delete(n);
  }
  updateScratchedButtonLabel();
  renderPayoutBlocks();
});

// ---------- 出走取消馬(返還対象)の選択 ----------
// 除外は出走馬表確定前に出走馬表側で取り除く運用のためここでは扱わない
// (docs/design/payout-refund.md「払戻モーダルでの手動入力(出走取消馬)」参照)。
// 着順の横の「出走取消馬選択」ボタンから専用ダイアログ(race-scratched-modal)を開いて
// 複数選択する(2026-09-24。以前は払戻モーダル内に常時表示のチェックボックス欄
// だったが、払戻モーダルが縦に長くなるためダイアログへ切り出した)。

// ボタンの表示を選択件数に応じて更新する(ダイアログを開かなくても選択状況が分かるように)。
function updateScratchedButtonLabel() {
  const n = currentScratchedHorseNumbers.size;
  scratchedOpenBtn.textContent = n > 0 ? `出走取消馬選択(${n}頭)` : "出走取消馬選択";
}

// ダイアログを開くたびに、その時点の出走頭数・出走馬表で選択肢を作り直す。
function renderScratchedPicker() {
  const entries = currentPayoutEntries;
  const nameOf = (n) => {
    const e = entries.find((x) => x.horse_number === n);
    return e && e.horse_name ? e.horse_name : "";
  };
  scratchedPicker.innerHTML = Array.from({ length: currentPayoutHorseCount }, (_, i) => i + 1)
    .map((n) => {
      const name = nameOf(n);
      const selected = currentScratchedHorseNumbers.has(n);
      return `<button type="button" class="horse-chip${selected ? " selected" : ""}" data-horse-number="${n}"><span class="chip-num">${n}番</span>${name ? escapeHtml(name) : ""}</button>`;
    })
    .join("");
  scratchedPicker.querySelectorAll(".horse-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.horseNumber);
      if (currentScratchedHorseNumbers.has(n)) currentScratchedHorseNumbers.delete(n);
      else currentScratchedHorseNumbers.add(n);
      btn.classList.toggle("selected");
      updateScratchedButtonLabel();
    });
  });
}

scratchedOpenBtn.addEventListener("click", () => {
  renderScratchedPicker();
  scratchedModal.hidden = false;
});
document.getElementById("race-scratched-modal-close-btn").addEventListener("click", () => {
  scratchedModal.hidden = true;
});
// 背景クリックで閉じる。ESCキーは専用に登録しない
// (registerEscToClose()は「非hiddenなら閉じる」方式のため、このダイアログにも
// 登録すると払戻モーダル側のハンドラと同時に発火し両方閉じてしまう。
// 代わりに closePayoutModal() 側でこのダイアログが開いていれば先にそちらだけを
// 閉じるようにしているため、ESCでも実質「まずダイアログだけ閉じる」動作になる)。
scratchedModal.addEventListener("click", (e) => {
  if (e.target === scratchedModal) scratchedModal.hidden = true;
});

// ---------- 払戻一括取込(楽天競馬・netkeibaの払戻表の貼り付け) ----------
// 解析は payout-paste-parser.js の parsePayoutPaste()。貼り付けた式別ごとの払戻を
// currentRacePayouts へ上書きし、着順(1〜3着)も貼り付け内容から推定してセットする
// (組み合わせ行は着順から算出した的中組み合わせにしか表示されないため)。
// 貼り付けに含まれない式別は現在の入力をそのまま残す。保存は「保存する」を押した時。
payoutImportOpenBtn.addEventListener("click", () => {
  payoutImportText.value = "";
  payoutImportMessage.hidden = true;
  payoutImportModal.hidden = false;
  payoutImportText.focus();
});
document.getElementById("race-payout-import-cancel-btn").addEventListener("click", () => {
  payoutImportModal.hidden = true;
});
payoutImportModal.addEventListener("click", (e) => {
  if (e.target === payoutImportModal) payoutImportModal.hidden = true;
});
document.getElementById("race-payout-import-run-btn").addEventListener("click", () => {
  const r = parsePayoutPaste(payoutImportText.value);
  const types = BET_TYPE_ORDER.filter((t) => r.payouts[t]);
  const showError = (msg) => {
    payoutImportMessage.textContent = msg;
    payoutImportMessage.hidden = false;
  };
  if (!types.length) {
    showError(r.errors.join(" ") || "取り込める払戻が見つかりませんでした。");
    return;
  }

  // 馬番が現在の出走頭数を超える場合は頭数を広げる(選択肢は5〜18頭)。
  const maxHorse = Math.max(
    ...types.filter((t) => t !== "wakuren").flatMap((t) => r.payouts[t].flatMap((p) => p.combo))
  );
  if (maxHorse > 18) {
    showError(`馬番${maxHorse}が18を超えています。貼り付け内容を確認してください。`);
    return;
  }
  const finishOrder = r.finishOrder || readFinishTop3();
  if (maxHorse > currentPayoutHorseCount) {
    currentPayoutHorseCount = maxHorse;
    payoutHorseCountSelect.value = maxHorse;
  }
  renderFinishSelects(currentPayoutHorseCount, finishOrder);

  captureEnteredRatesIntoState(); // 貼り付けに含まれない式別の入力中の値を退避
  currentRacePayouts = { ...currentRacePayouts, ...r.payouts };
  ticketsSection.innerHTML = ""; // 再描画時に古いDOMの値で上書きされないよう空にする
  renderPayoutBlocks();

  // 枠連は出走馬表の枠番から的中組み合わせを算出するため、枠番が未登録だと行が無効化され
  // 取り込んだ値を表示・保存できない。
  const problems = [...r.errors, ...r.warnings];
  const wakurenSkipped = types.includes("wakuren")
    && ticketsSection.querySelector('.payout-rate-row[data-bet-type="wakuren"][data-combo="null"]');
  if (wakurenSkipped) problems.push("枠連: 出走馬表に枠番が登録されていないため設定できませんでした。");

  const okTypes = types.filter((t) => !(t === "wakuren" && wakurenSkipped));
  const notes = [`${okTypes.map(betTypeLabel).join("・")}を設定しました。`];
  if (r.finishOrder) notes.push(`着順: ${r.finishOrder.map((n) => n + "番").join(" → ")}`);
  if (r.ignored.length) notes.push(`取込対象外: ${r.ignored.join("・")}`);
  payoutImportStatus.className = `submit-message ${problems.length ? "error" : "success"}`;
  payoutImportStatus.textContent = [...notes, ...problems, "「保存する」を押すと確定します。"].join(" ");
  payoutImportStatus.hidden = false;
  payoutImportModal.hidden = true;
});

// 取消馬番から「返還同枠」(枠連の返還判定に使う)を自動算出する。ある枠に属する
// 出走馬が全頭取消なら、その枠番を返す。出走馬表が未登録(枠番情報が無い)場合は
// 算出できないため空配列を返す(枠連の返還のみ非対応。PDFインポート経由と同じ制約)。
function computeRefundWakuNumbers(scratchedSet, entries) {
  if (!scratchedSet.size || !entries.length) return [];
  const byWaku = new Map();
  for (const e of entries) {
    if (e.waku_number === null || e.waku_number === undefined) continue;
    if (!byWaku.has(e.waku_number)) byWaku.set(e.waku_number, []);
    byWaku.get(e.waku_number).push(e.horse_number);
  }
  const wakuNumbers = [];
  for (const [waku, horseNumbers] of byWaku) {
    if (horseNumbers.every((n) => scratchedSet.has(n))) wakuNumbers.push(waku);
  }
  return wakuNumbers.sort((a, b) => a - b);
}

finish1Select.addEventListener("change", renderPayoutBlocks);
finish2Select.addEventListener("change", renderPayoutBlocks);
finish3Select.addEventListener("change", renderPayoutBlocks);

// ---------- 払戻金額入力(馬券式別・払戻モーダル) ----------
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
//
// 注: ここで入力・保存されるのは「レースの払戻レート」(races.payouts)のみ。
// 各ユーザーの購入履歴(tickets.payout)への反映は、保存後にサーバー側
// (functions/api/races/[id].js の recomputeTicketPayoutsForRace)が
// 全ユーザー分まとめて再計算する。currentTickets はこの画面での「◯点購入」表示にのみ使う。
function renderPayoutBlocks() {
  captureEnteredRatesIntoState();

  const finishOrder = readFinishTop3();
  const entries = currentPayoutEntries;

  ticketsSection.innerHTML = `
    <div class="payout-flat-rows">
      ${BET_TYPE_ORDER.map((betType) => {
        const betTickets = currentTickets.filter((t) => t.bet_type === betType);
        const required = REQUIRED_TOP[betType];
        const enoughInfo = finishOrder && finishOrder.length >= required;
        const combos = enoughInfo ? computeWinningCombos(betType, finishOrder, entries) : [];

        // 各行が単独で意味が通るよう、全行に式別バッジを付ける(複数段組みで流し込むため)。
        // 購入点数は式別単位の値で行ごとに表示すると誤解を招くため、バッジのツールチップに置く。
        const badgeCell = `<span class="bet-badge"${betTickets.length > 0 ? ` title="この式別の購入: ${betTickets.length}点"` : ""}>${betTypeLabel(betType)}</span>`;

        if (!enoughInfo) {
          return `
            <label class="payout-rate-row" data-bet-type="${betType}">
              ${badgeCell}
              <span class="buy-hint" style="grid-column:span 2;margin:0">${required}着まで入力すると表示されます</span>
            </label>
          `;
        }
        return combos
          .map((c) => {
            const rate = findStoredRate(currentRacePayouts, betType, c.combo);
            return `
              <label class="payout-rate-row" data-bet-type="${betType}" data-combo='${escapeAttr(JSON.stringify(c.combo))}'>
                ${badgeCell}
                <span class="payout-rate-label">${c.label}</span>
                <input type="number" class="payout-rate-input" min="0" step="10" value="${rate !== null ? rate : ""}" ${c.combo ? "" : "disabled"} placeholder="未確定" />
              </label>
            `;
          })
          .join("");
      }).join("")}
    </div>
  `;
}

// 再描画で消えてしまう前に、今表示されている入力値をstateへ退避する。
// まだ着順不足で表示されていない式別(hint表示のみ)は、以前の値をそのまま保持する。
function captureEnteredRatesIntoState() {
  const rowsByType = new Map();
  ticketsSection.querySelectorAll(".payout-rate-row[data-combo]").forEach((row) => {
    const betType = row.dataset.betType;
    if (!rowsByType.has(betType)) rowsByType.set(betType, []);
    rowsByType.get(betType).push(row);
  });
  rowsByType.forEach((rows, betType) => {
    const combos = rows
      .map((row) => ({
        combo: row.dataset.combo === "null" ? null : JSON.parse(row.dataset.combo),
        rate: row.querySelector(".payout-rate-input").value === "" ? null : Number(row.querySelector(".payout-rate-input").value),
      }))
      .filter((c) => c.combo && c.rate !== null);
    currentRacePayouts = { ...currentRacePayouts, [betType]: combos };
  });
}

// フォーム送信時: racesに保存する払戻率データを組み立てる。
// 各購入履歴(tickets.payout)への反映はサーバー側で全ユーザー分まとめて行われるため、
// ここではticket個別の更新は組み立てない。
function buildPayoutSubmission() {
  captureEnteredRatesIntoState();
  const payoutsPayload = {};

  for (const betType of BET_TYPE_ORDER) {
    const combos = currentRacePayouts[betType] || [];
    if (combos.length > 0) payoutsPayload[betType] = combos;
  }

  if (currentScratchedHorseNumbers.size > 0) {
    payoutsPayload.refunds = [{
      horse_numbers: Array.from(currentScratchedHorseNumbers).sort((a, b) => a - b),
      waku_numbers: computeRefundWakuNumbers(currentScratchedHorseNumbers, currentPayoutEntries),
    }];
  }

  return { payoutsPayload };
}

// ---------- レース結果詳細(race_results)の表示・出来事メモ編集(2026-08-11追加) ----------
// 全着順・タイム・着差・馬体重等はPDFインポート経由でのみ登録される(このUIからは
// 編集不可)。競走中の出来事メモ(incident_note)のみ、管理者がその場で編集・保存できる。
async function loadRaceResultsDetail(raceId) {
  if (!raceId) {
    raceResultsDetailSection.hidden = true;
    raceResultsDetailTable.innerHTML = "";
    return;
  }
  const res = await authedFetch(`/api/races/${raceId}/results`);
  if (!res.ok) {
    raceResultsDetailSection.hidden = true;
    return;
  }
  const data = await res.json().catch(() => ({ items: [] }));
  const items = data.items || [];
  if (!items.length) {
    raceResultsDetailSection.hidden = true;
    return;
  }
  raceResultsDetailSection.hidden = false;
  const isAdmin = Boolean(window.currentUser && window.currentUser.isAdmin);

  const statusLabel = (s) => (s === "scratched" ? "取消" : s === "excluded" ? "除外" : s === "stopped" ? "中止" : "");

  raceResultsDetailTable.innerHTML = `
    <div class="table-wrap"><table class="stats-table">
      <thead><tr>
        <th>着順</th><th>馬番</th><th>馬名</th><th>タイム</th><th>着差</th>
        <th>馬体重</th><th>人気</th><th>出来事メモ</th>
      </tr></thead>
      <tbody>
        ${items.map((it) => `
          <tr data-horse-number="${it.horse_number}">
            <td>${it.finish_position ?? statusLabel(it.status) ?? "-"}</td>
            <td>${it.horse_number ?? "-"}</td>
            <td class="table-name">${escapeHtml(it.horse_name || "")}</td>
            <td>${escapeHtml(it.time_text || "")}</td>
            <td>${escapeHtml(it.margin || "")}</td>
            <td>${it.body_weight ? `${it.body_weight}${it.body_weight_change ? `(${escapeHtml(it.body_weight_change)})` : ""}` : ""}</td>
            <td>${it.win_popularity ?? ""}</td>
            <td>
              ${isAdmin
                ? `<textarea class="incident-note-input" rows="1" style="width:100%;min-width:160px" placeholder="競走中の出来事等">${escapeHtml(it.incident_note || "")}</textarea>`
                : escapeHtml(it.incident_note || "")}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table></div>
    ${isAdmin ? `<button type="button" id="save-incident-notes-btn" class="ghost-btn" style="margin-top:8px">出来事メモを保存</button>
    <span id="incident-notes-save-status" class="submit-message" hidden></span>` : ""}
  `;

  const saveBtn = document.getElementById("save-incident-notes-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const statusEl = document.getElementById("incident-notes-save-status");
      const rows = Array.from(raceResultsDetailTable.querySelectorAll("tr[data-horse-number]"));
      saveBtn.disabled = true;
      let failed = 0;
      for (const row of rows) {
        const horseNumber = Number(row.dataset.horseNumber);
        const textarea = row.querySelector(".incident-note-input");
        if (!textarea) continue;
        const res2 = await authedFetch(`/api/races/${raceId}/results`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ horse_number: horseNumber, incident_note: textarea.value }),
        });
        if (!res2.ok) failed++;
      }
      saveBtn.disabled = false;
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.className = `submit-message ${failed ? "error" : "success"}`;
        statusEl.textContent = failed ? `${failed}件の保存に失敗しました` : "保存しました";
      }
    });
  }
}

// ---------- 払戻モーダル(登録・編集) ----------
document.getElementById("payout-cancel-btn").addEventListener("click", closePayoutModal);
payoutModal.addEventListener("click", (e) => { if (e.target === payoutModal) closePayoutModal(); });

function openPayoutModal(race) {
  if (!race) return;
  payoutForm.reset();
  // モーダルを開くたびに残留DOM(払戻入力欄)を即座に空にしておく。これをしないと、
  // 前回モーダルの残留DOMをcaptureEnteredRatesIntoState()が読み取ってしまい、
  // 直後にセットしたcurrentRacePayoutsが空データで上書きされてしまう不具合が起きる。
  ticketsSection.innerHTML = "";
  raceResultsDetailSection.hidden = true;
  raceResultsDetailTable.innerHTML = "";
  document.getElementById("payout-race-id").value = race.id;
  payoutModalTitle.textContent = race.finish_order ? "払戻を編集" : "払戻を登録";

  const courseText = formatCourseText(race.course_type, race.distance);
  payoutRaceInfo.textContent = `${formatDate(race.race_date)} ${race.track} ${race.race_number}R${race.race_name ? "・" + race.race_name : ""}${courseText ? "・" + courseText : ""}`;

  currentPayoutEntries = race.entries || [];
  const count = Math.max(race.entries.length, 8);
  currentPayoutHorseCount = count;
  payoutHorseCountSelect.value = count;
  renderFinishSelects(count, race.finish_order);
  currentRacePayouts = race.payouts || {};
  currentScratchedHorseNumbers = new Set(
    ((race.payouts && race.payouts.refunds) || []).flatMap((r) => r.horse_numbers || [])
  );
  updateScratchedButtonLabel();
  payoutImportStatus.hidden = true;
  loadTicketsForRace(race.id);
  loadRaceResultsDetail(race.id);

  payoutModal.hidden = false;
  // 前回別レースを開いていたときのスクロール位置が残らないよう、先頭にリセットする。
  const modalBox = payoutModal.querySelector(".modal");
  if (modalBox) modalBox.scrollTop = 0;
}

function closePayoutModal() {
  // 出走取消馬選択ダイアログが開いたまま払戻モーダルを閉じると、ダイアログだけが
  // 残留してしまう。ESC/キャンセル/背景クリックのいずれの経路でも、開いていれば
  // まずダイアログ側だけを閉じる(払戻モーダル自体は開いたまま)。
  for (const sub of [payoutImportModal, scratchedModal]) {
    if (!sub.hidden) {
      sub.hidden = true;
      return;
    }
  }
  payoutModal.hidden = true;
}
// ESCキーでキャンセル相当(保存せず閉じる)にする(docs/BACKLOG.md クラスタK対応)。
registerEscToClose(payoutModal, closePayoutModal);

payoutForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const id = document.getElementById("payout-race-id").value;
  const finish_order = readFinishTop3();
  const { payoutsPayload } = buildPayoutSubmission();

  const payload = {
    finish_order,
    payouts: payoutsPayload,
  };

  const res = await authedFetch(`/api/races/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "保存に失敗しました");
    return;
  }

  // 各購入履歴(tickets.payout)への反映は、上のPUTを受けたサーバー側
  // (functions/api/races/[id].js)が全ユーザー分まとめて再計算・保存する。

  closePayoutModal();
  loadRaces();
});
