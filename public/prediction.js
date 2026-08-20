let races = [];
let selectedRace = null;
let prediction = { marks: [] };
let horseNotes = {};
// 「このレースの購入馬券」欄の開閉状態(group_idごと)。app.jsの.group-card開閉パターンと
// 同じ考え方で、開閉した状態を再描画(selectRace()のたびに呼ばれるrenderPurchasedTickets)
// をまたいで保持する。
let expandedTicketGroups = new Set();
const emptyState = document.getElementById("prediction-empty");
const panel = document.getElementById("prediction-panel");
const raceHeader = document.getElementById("prediction-race-header");
const horsesEl = document.getElementById("prediction-horses");
const ticketsEl = document.getElementById("prediction-tickets");
const MARKS = ["◎", "○", "▲", "△", "☆", "消"];

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

// CSVインポートで作成されたレースには出走馬表(馬名)がないことがあるため、
// 予想印とは別に「このレースで購入した馬券」を馬番ベースで一覧表示する。
// 馬名が分からなくても、買い目・購入金額・払戻金額は把握できるようにするため。
async function loadRaceTickets() {
  const [ticketsRes, importedRes] = await Promise.all([
    authedFetch("/api/tickets"),
    authedFetch("/api/ticket-imports"),
  ]);
  const tickets = ticketsRes.ok ? await ticketsRes.json() : [];
  const importedPayload = importedRes.ok ? await importedRes.json() : { items: [] };
  const imported = Array.isArray(importedPayload) ? importedPayload : (importedPayload.items || []);
  const all = [...(Array.isArray(tickets) ? tickets : []), ...(Array.isArray(imported) ? imported : [])];
  return all.filter((t) => Number(t.race_id) === Number(selectedRace.id));
}

// グループカード(購入方式単位)の開閉をトグルする。app.jsの.group-card-head
// クリック時の挙動(expandedGroups Setの更新・矢印の向き変更)と同じパターン。
function toggleTicketGroup(head) {
  const detail = head.nextElementSibling;
  if (!detail) return;
  const groupId = head.dataset.groupId;
  const nowHidden = !detail.hidden;
  detail.hidden = nowHidden;
  if (nowHidden) expandedTicketGroups.delete(groupId);
  else expandedTicketGroups.add(groupId);
  const arrow = head.querySelector(".expand-arrow");
  if (arrow) arrow.textContent = detail.hidden ? "▸" : "▾";
}

function renderPurchasedTickets(items) {
  if (!items.length) {
    ticketsEl.innerHTML = "";
    ticketsEl.hidden = true;
    return;
  }
  ticketsEl.hidden = false;
  const groups = new Map();
  for (const t of items) {
    if (!groups.has(t.group_id)) groups.set(t.group_id, []);
    groups.get(t.group_id).push(t);
  }
  const totalAmount = items.reduce((s, t) => s + Number(t.amount || 0), 0);
  const hasSettled = items.some((t) => t.payout !== null && t.payout !== undefined);
  const settledPayout = items
    .filter((t) => t.payout !== null && t.payout !== undefined)
    .reduce((s, t) => s + Number(t.payout || 0), 0);

  ticketsEl.innerHTML = `
    <div class="prediction-tickets-head">
      <h2 class="prediction-tickets-title">このレースの購入馬券</h2>
      <span class="group-money">購入¥${totalAmount.toLocaleString()}${hasSettled ? ` / 払戻¥${settledPayout.toLocaleString()}` : ""}</span>
    </div>
    ${Array.from(groups.entries())
      .map(([groupId, group]) => {
        const first = group[0];
        // 開閉状態はgroup_idをキーに保持する(通常購入=UUID、CSV取込=import-<id>等、
        // いずれも文字列のため型の不一致は起きない)。デフォルトは閉じた状態。
        const isExpanded = expandedTicketGroups.has(groupId);
        return `
          <div class="group-card">
            <div class="group-card-head" data-group-id="${escapeAttr(String(groupId))}">
              <span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>
              <span class="bet-badge">${betTypeLabel(first.bet_type)}</span>
              <span class="method-badge">${methodLabel(first.method)}</span>
              <span class="point-count">${group.length}点</span>
              ${first.imported ? `<span class="import-source-badge">CSV取込</span>` : ""}
              <span class="group-money">購入¥${group.reduce((s, t) => s + Number(t.amount || 0), 0).toLocaleString()}${
                group.some((t) => t.payout !== null && t.payout !== undefined)
                  ? ` / 払戻¥${group.filter((t) => t.payout !== null && t.payout !== undefined).reduce((s, t) => s + Number(t.payout || 0), 0).toLocaleString()}`
                  : ""
              }</span>
            </div>
            <div class="group-detail" ${isExpanded ? "" : "hidden"}>
              <div class="group-detail-rows">
                ${group
                  .map(
                   (t) => `
                  <div class="group-detail-row" data-id="${escapeAttr(String(t.id))}" data-imported="${t.imported ? "1" : "0"}">
                    <div class="sel-line">${formatSelections(t.bet_type, t.selections)}</div>
                    ${t.imported
                      ? `<span class="import-source-badge">CSV取込</span><span class="detail-payout">購入¥${Number(t.amount || 0).toLocaleString()}${
                          t.payout !== null && t.payout !== undefined
                            ? ` / 払戻¥${Number(t.payout).toLocaleString()}`
                            : " / 未確定"
                        }</span>`
                      : `<label class="payout-label">購入額
                          <input type="number" class="amount-edit-input" min="100" step="100" value="${Number(t.amount || 0)}" aria-label="購入金額" />
                        </label>
                        <span class="detail-payout">${
                          t.payout !== null && t.payout !== undefined
                            ? `払戻¥${Number(t.payout).toLocaleString()}`
                            : "未確定"
                        }</span>`
                    }
                  </div>
                `
                  )
                  .join("")}
              </div>
            </div>
          </div>
        `;
      })
      .join("")}
  `;

  ticketsEl.querySelectorAll(".group-card-head[data-group-id]").forEach((head) => {
    head.addEventListener("click", () => toggleTicketGroup(head));
  });

  // 通常購入分の購入金額は、この画面からその場で変更できる。
  // CSV取込分は確定した過去履歴として別APIで管理するため、ここでは編集対象外。
  ticketsEl.querySelectorAll(".amount-edit-input").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("change", async () => {
      const row = input.closest(".group-detail-row");
      const id = row?.dataset.id;
      if (!id || row.dataset.imported === "1") return;

      const ticket = items.find((t) => String(t.id) === String(id));
      if (!ticket) return;

      const newAmount = Number(input.value);
      if (!Number.isInteger(newAmount) || newAmount < 100) {
        input.value = Number(ticket.amount || 0);
        alert("購入金額は100円以上の整数で入力してください。");
        return;
      }

      // 払戻率が既に登録されている場合は、購入金額変更後の払戻額も再計算する。
      // 払戻率が未登録の場合は、既存の未確定状態を維持する。
      let newPayout = ticket.payout ?? null;
      if (selectedRace && selectedRace.payouts && selectedRace.payouts[ticket.bet_type]) {
        newPayout = computeTicketPayout({ ...ticket, amount: newAmount }, selectedRace);
      }

      const res = await authedFetch(`/api/tickets/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: newAmount, payout: newPayout }),
      });

      if (!res.ok) {
        input.value = Number(ticket.amount || 0);
        alert("購入金額の更新に失敗しました。");
        return;
      }

      const updatedItems = await loadRaceTickets();
      renderPurchasedTickets(updatedItems);
    });
  });
}

async function selectRace() {
  emptyState.hidden = true;
  panel.hidden = false;
  renderRaceHeader();
  renderHorses();

  const buyBtn = document.getElementById("buy-race-btn");

  const [predRes, noteRes] = await Promise.all([
    authedFetch(`/api/predictions?race_id=${selectedRace.id}`),
    authedFetch(`/api/horse-notes?race_id=${selectedRace.id}`),
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
  // レースの着順 or 払戻が確定済みの場合でも、購入履歴の登録し忘れに対応できるよう
  // 購入自体は引き続きできるようにする。ボタンのラベルだけ「結果確定済」に変え、
  // 確定済みであることがひと目でわかるようにする。
  // 2026-08-16: ファイルリネーム(buy.html→index.html)に伴い、購入画面へのリンク先を
  // index.html に更新する(docs/DESIGN.md「トップページ(/)の表示について」参照)。
  buyBtn.href = `index.html?race=${encodeURIComponent(selectedRace.id)}`;
  const settled = !!selectedRace.finish_order || !!(selectedRace.payouts && Object.keys(selectedRace.payouts).length > 0);
  // 出走馬一覧PDFインポート(枠番なし)対応により、枠番・馬番が未確定のレースが存在しうる。
  // 未確定の間は buy.js 側で購入自体をブロックするため、ここでもボタンの見た目を変える
  // (クリック自体はできる。buy.js側の案内バナーで説明する)。
  const hasUnconfirmedNumbers = (selectedRace.entries || []).some((e) => e.horse_number === null || e.horse_number === undefined);
  if (hasUnconfirmedNumbers) {
    buyBtn.textContent = "枠番・馬番未確定(購入不可)";
    buyBtn.classList.add("is-settled");
    buyBtn.title = "枠番・馬番が確定するまで購入できません";
  } else if (settled) {
    buyBtn.textContent = "結果確定済(購入する)";
    buyBtn.classList.add("is-settled");
    buyBtn.title = "このレースは結果確定済みですが、購入履歴の登録は引き続き行えます";
  } else {
    buyBtn.textContent = "このレースの馬券を購入";
    buyBtn.classList.remove("is-settled");
    buyBtn.removeAttribute("title");
  }

  // 購入馬券セクションは独立して読み込む。ここで失敗しても、予想印の保存や
  // 購入ページへの遷移など他の機能に影響させない。
  loadRaceTickets()
    .then(renderPurchasedTickets)
    .catch(() => { ticketsEl.innerHTML = ""; ticketsEl.hidden = true; });
}

// 予想登録画面から購入画面のカレンダーへ戻る手段がなかったため、同じ開催日内であれば
// 競馬場・レース番号のセレクトからページ遷移なしで別レースへ切り替えられるようにする。
function racesOnSameDate() {
  return races.filter(r => r.race_date === selectedRace.race_date);
}

function switchToRace(raceId) {
  const target = races.find(r => Number(r.id) === Number(raceId));
  if (!target) return;
  selectedRace = target;
  history.replaceState(null, "", `prediction.html?race=${encodeURIComponent(raceId)}`);
  selectRace();
}

function renderRaceHeader() {
  const sameDate = racesOnSameDate();
  const tracks = [...new Set(sameDate.map(r => r.track))];
  const racesForTrack = sameDate
    .filter(r => r.track === selectedRace.track)
    .sort((a, b) => Number(a.race_number) - Number(b.race_number));

  // ヘッダーの表示順は「日付・競馬場名・レース番号・レース名・頭数」の順。
  // 「このレースの馬券を購入」ボタンはレース名の近く(ヘッダー上部)に配置し、
  // 出走頭数が多いレースでも下までスクロールせずに購入画面へ進めるようにする。
  raceHeader.innerHTML = `
    <div class="prediction-race-title">
      <span class="prediction-date">${escapeHtml(formatDate(selectedRace.race_date))}</span>
      <select id="prediction-track-select" class="prediction-select" aria-label="競馬場を選択">
        ${tracks.map(t => `<option value="${escapeAttr(t)}" ${t === selectedRace.track ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
      </select>
      <select id="prediction-racenum-select" class="prediction-select" aria-label="レース番号を選択">
        ${racesForTrack.map(r => `<option value="${r.id}" ${Number(r.id) === Number(selectedRace.id) ? "selected" : ""}>${r.race_number}R</option>`).join("")}
      </select>
      ${selectedRace.race_name ? `<span class="race-name">${escapeHtml(selectedRace.race_name)}</span>` : ""}
      <span class="prediction-entry-count">${selectedRace.entries.length}頭</span>
      <a id="buy-race-btn" class="stamp-btn" href="#">このレースの馬券を購入</a>
    </div>
    <span id="prediction-message" class="submit-message" hidden></span>
  `;

  document.getElementById("prediction-track-select").addEventListener("change", (e) => {
    const newTrack = e.target.value;
    const candidates = sameDate
      .filter(r => r.track === newTrack)
      .sort((a, b) => Number(a.race_number) - Number(b.race_number));
    if (candidates.length) switchToRace(candidates[0].id);
  });
  document.getElementById("prediction-racenum-select").addEventListener("change", (e) => {
    switchToRace(Number(e.target.value));
  });
}

function renderHorses() {
  // 出走馬一覧PDFインポート(枠番なし)対応により、枠番・馬番が未確定(null)の馬が
  // 混在しうる。馬番でのソートができないため、未確定の馬がいる場合は馬名(五十音)順に
  // フォールバックする(詳細はdocs/DESIGN.md「出走馬一覧PDFインポート」参照)。
  const hasUnconfirmedNumbers = selectedRace.entries.some((e) => e.horse_number === null || e.horse_number === undefined);
  const entries = hasUnconfirmedNumbers
    ? [...selectedRace.entries].sort((a, b) => String(a.horse_name || "").localeCompare(String(b.horse_name || ""), "ja"))
    : [...selectedRace.entries].sort((a,b) => Number(a.horse_number) - Number(b.horse_number));
  if (!entries.length) {
    horsesEl.innerHTML = `<p class="prediction-no-entries">出走馬が登録されていません。</p>`;
    return;
  }

  horsesEl.innerHTML = entries.map(e => {
    const hasNumber = e.horse_number !== null && e.horse_number !== undefined;
    const n = hasNumber ? Number(e.horse_number) : null;
    const note = horseNotes[e.horse_name] || {};
    return `
      <article class="prediction-horse horse-note-card${note.memo ? " has-horse-memo" : ""}"
        data-horse-number="${n !== null ? n : ""}"
        data-horse-name="${escapeAttr(e.horse_name || "")}">
        <div class="horse-note-toggle" role="button" tabindex="0">
          <span class="mini-waku waku-${e.waku_number || 0}">${e.waku_number || "-"}</span>
          <span class="prediction-horse-number">${n !== null ? n : "-"}</span>
          <span class="prediction-horse-name">
            <span class="prediction-horse-name-line">
              <strong>${escapeHtml(e.horse_name || "馬名未登録")}</strong>
              ${e.jockey ? `<small>${escapeHtml(e.jockey)}</small>` : ""}
              ${note.memo ? `<span class="horse-note-badge" title="この馬のメモがあります">メモ</span>` : ""}
            </span>
            ${note.memo ? `<small class="horse-note-preview" title="${escapeAttr(note.memo)}">${escapeHtml(note.memo.length > 36 ? note.memo.slice(0,36) + "…" : note.memo)}</small>` : ""}
          </span>
          <span class="prediction-mark-inline" aria-label="予想印">
            <select class="prediction-mark-select" aria-label="予想印を選択" ${hasNumber ? "" : 'disabled title="枠番・馬番確定後に選択できます"'}>
              <option value="">−</option>
              ${MARKS.map(m => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </span>
          <span class="note-chevron">＋</span>
        </div>
        <div class="horse-note-editor" hidden>
          <label class="horse-memo-label">
            <textarea class="horse-memo" rows="3" maxlength="5000" aria-label="この馬についてのメモ"
              >${escapeHtml(note.memo || "")}</textarea>
          </label>
          <span class="horse-note-status" hidden></span>
        </div>
      </article>
    `;
  }).join("");

  // 馬名行のクリックでメモだけ展開。印セレクトのクリックでは展開を切り替えない。
  horsesEl.querySelectorAll(".horse-note-toggle").forEach(btn => {
    btn.addEventListener("click", (event) => {
      if (event.target.closest(".prediction-mark-inline")) return;
      const card = btn.closest(".horse-note-card");
      const editor = card.querySelector(".horse-note-editor");
      editor.hidden = !editor.hidden;
      btn.querySelector(".note-chevron").textContent = editor.hidden ? "＋" : "−";
    });
  });

  // 予想印は1頭につき1つまで。ドロップダウンで選択するとその馬の印を置き換える。
  // 枠番・馬番未確定の馬(select disabled)はそもそもchangeイベントが発火しないため対象外。
  horsesEl.querySelectorAll(".prediction-mark-select").forEach(select => {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", async () => {
      const card = select.closest(".horse-note-card");
      if (!card.dataset.horseNumber) return; // 念のための二重ガード
      const n = Number(card.dataset.horseNumber);
      const mark = select.value || "";
      prediction.marks = (prediction.marks || []).filter(x => Number(x.horse_number) !== n);
      if (mark) {
        prediction.marks.push({ horse_number: n, mark });
      }
      applyPrediction(); // 変更直後に見た目へ反映する(保存を待たず即時反映)
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
  const messageEl = document.getElementById("prediction-message");
  const res = await authedFetch("/api/predictions", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ race_id: selectedRace.id, marks: prediction.marks || [], memo: "" })
  });
  if (!messageEl) return;
  if (res.ok) {
    // 予想印は選択直後に画面へ即時反映される(applyPrediction())ため、
    // 「印を自動保存しました」という成功メッセージは表示しない。
    messageEl.hidden = true;
    return;
  }
  // 保存失敗時のみ、原因が分かるようメッセージを表示する。
  messageEl.hidden = false;
  messageEl.className = "submit-message error";
  messageEl.textContent = "印の保存に失敗しました";
}

function applyPrediction() {
  const map = new Map();
  for (const x of (prediction.marks || [])) {
    map.set(Number(x.horse_number), x.mark);
  }
  horsesEl.querySelectorAll(".horse-note-card").forEach(card => {
    if (!card.dataset.horseNumber) return; // 枠番・馬番未確定(セレクトはdisabled)
    const mark = map.get(Number(card.dataset.horseNumber)) || "";
    const select = card.querySelector(".prediction-mark-select");
    if (select) select.value = mark;
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

// escapeHtml / escapeAttr は utils.js のものを使用する
function formatDate(s) {
  return new Date(`${s}T00:00:00`).toLocaleDateString("ja-JP", {
    year:"numeric", month:"numeric", day:"numeric", weekday:"short"
  });
}

setupAuth(loadRaces);
