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

// 払戻モーダルで編集中のレースの出走馬情報(combo表示・枠連判定に使う。払戻モーダルでは編集不可)
let currentPayoutEntries = [];

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
  renderPayoutBlocks();
});

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
              : `<div class="payout-rate-rows">${combos
                  .map((c) => {
                    const rate = findStoredRate(currentRacePayouts, betType, c.combo);
                    return `
                      <label class="payout-rate-row" data-combo='${escapeAttr(JSON.stringify(c.combo))}'>
                        ${c.label}の払戻(100円あたり)
                        <input type="number" class="payout-rate-input" min="0" step="10" value="${rate !== null ? rate : ""}" ${c.combo ? "" : "disabled"} placeholder="未確定" />
                      </label>
                    `;
                  })
                  .join("")}</div>`}
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
  loadTicketsForRace(race.id);
  loadRaceResultsDetail(race.id);

  payoutModal.hidden = false;
  // 前回別レースを開いていたときのスクロール位置が残らないよう、先頭にリセットする。
  const modalBox = payoutModal.querySelector(".modal");
  if (modalBox) modalBox.scrollTop = 0;
}

function closePayoutModal() {
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
