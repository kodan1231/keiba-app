let races = [];
let selectedRace = null;
let prediction = { marks: [] };
let horseNotes = {};
// 出走各馬の過去成績(race_results 由来)。キーは空白正規化した馬名。
// selectRace() で GET /api/races/:id/horse-history からまとめて取得し、
// renderHorses() より後の applyHorseHistory() で各行の展開パネルへ流し込む。
let horseHistory = {};
// 「このレースの購入馬券」欄の開閉状態(group_idごと)。app.jsの.group-card開閉パターンと
// 同じ考え方で、開閉した状態を再描画(selectRace()のたびに呼ばれるrenderPurchasedTickets)
// をまたいで保持する。
let expandedTicketGroups = new Set();
// IPAT風コンパクト表示の下にある「内訳(1点ごとの明細)」の開閉状態(group_idごと)。
// 2026-09-12追加。デフォルトは閉じた状態(app.jsのexpandedBreakdownsと同じ考え方)。
let expandedTicketBreakdowns = new Set();
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
  // group_id 単位のグルーピング・金額表示は public/ticket-view.js の共通実装
  // (groupTicketsByGroupId / ticketMoneyText)を使う。
  const groups = groupTicketsByGroupId(items);

  ticketsEl.innerHTML = `
    <div class="prediction-tickets-head">
      <h2 class="prediction-tickets-title">このレースの購入馬券</h2>
      <span class="group-money">${ticketMoneyText(items)}</span>
    </div>
    ${groups
      .map((group) => {
        const first = group[0];
        const groupId = first.group_id;
        // 開閉状態はgroup_idをキーに保持する(通常購入=UUID、CSV取込=import-<id>等、
        // いずれも文字列のため型の不一致は起きない)。デフォルトは閉じた状態。
        const isExpanded = expandedTicketGroups.has(groupId);
        const compactSummary = groupCompactSummaryHtml(first.bet_type, group);
        const isBreakdownExpanded = expandedTicketBreakdowns.has(groupId);
        return `
          <div class="group-card">
            <div class="group-card-head" data-group-id="${escapeAttr(String(groupId))}">
              <span class="expand-arrow">${isExpanded ? "▾" : "▸"}</span>
              <span class="bet-badge">${betTypeLabel(first.bet_type)}</span>
              <span class="method-badge">${methodLabel(first.method)}</span>
              <span class="point-count">${group.length}点</span>
              ${first.imported ? `<span class="import-source-badge">CSV取込</span>` : ""}
              <span class="group-money">${ticketMoneyText(group)}</span>
            </div>
            <div class="group-detail" ${isExpanded ? "" : "hidden"}>
              ${compactSummary}
              ${compactSummary ? `<button type="button" class="breakdown-toggle-btn" data-group-id="${escapeAttr(String(groupId))}">${isBreakdownExpanded ? "内訳を隠す ▾" : "内訳を見る ▸"}</button>` : ""}
              <div class="group-detail-rows" ${compactSummary && !isBreakdownExpanded ? "hidden" : ""}>
                ${group
                  .map(
                   (t) => `
                  <div class="group-detail-row" data-id="${escapeAttr(String(t.id))}" data-imported="${t.imported ? "1" : "0"}">
                    <div class="sel-line">${formatSelections(t.bet_type, t.selections)}</div>
                    ${t.imported
                      ? `<span class="import-source-badge">CSV取込</span><span class="detail-payout">購入${formatYen(t.amount)}${
                          t.payout !== null && t.payout !== undefined
                            ? ` / 払戻${formatYen(t.payout)}`
                            : " / 未確定"
                        }</span>`
                      : `<label class="payout-label">購入額
                          <input type="number" class="amount-edit-input" min="100" step="100" value="${Number(t.amount || 0)}" aria-label="購入金額" />
                        </label>
                        <span class="detail-payout">${
                          t.payout !== null && t.payout !== undefined
                            ? `${t.refunded ? "返還" : "払戻"}${formatYen(t.payout)}`
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

  ticketsEl.querySelectorAll(".breakdown-toggle-btn[data-group-id]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const groupId = btn.dataset.groupId;
      const rows = btn.closest(".group-detail").querySelector(".group-detail-rows");
      const nowHidden = !rows.hidden;
      rows.hidden = nowHidden;
      if (nowHidden) expandedTicketBreakdowns.delete(groupId);
      else expandedTicketBreakdowns.add(groupId);
      btn.textContent = rows.hidden ? "内訳を見る ▸" : "内訳を隠す ▾";
    });
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
      race_id: selectedRace.id,
      is_key_race: false,
      marks: (selectedRace.entries || [])
        .filter(e => MARKS.includes(e.mark))
        .map(e => ({ horse_number: Number(e.horse_number), mark: e.mark }))
    };
  }
  // 勝負レースフラグは selectRace() 冒頭の renderRaceHeader() 初回描画時点では
  // まだ取得できていないため、取得完了後にヘッダーを再描画して反映する。
  renderRaceHeader();

  horseNotes = noteRes.ok ? await noteRes.json() : {};
  applyPrediction();
  applyHorseNotes();

  // 過去成績は完全に独立して読み込む。取得・パースで何が起きても、予想印・馬メモ・
  // 購入導線には影響させない(下の loadRaceTickets と同じ考え方。2026-09-10:
  // 当初は上の Promise.all に含めていたが、エンドポイント応答が非JSONだと
  // await res.json() が throw して applyHorseNotes まで巻き添えで止まる不具合があった)。
  horseHistory = {};
  applyHorseHistory();
  loadHorseHistory().catch(() => {});
  // レースの着順 or 払戻が確定済みの場合でも、購入履歴の登録し忘れに対応できるよう
  // 購入自体は引き続きできるようにする。ボタンのラベルだけ「結果確定済」に変え、
  // 確定済みであることがひと目でわかるようにする。
  // 2026-08-16: ファイルリネーム(buy.html→index.html)に伴い、購入画面へのリンク先を
  // index.html に更新する(docs/design/screens.md「トップページ(/)の表示について」参照)。
  // from=prediction を付けておくと、購入モーダルを×/ESCで閉じたときに購入画面へ
  // 留まらず、この予想登録画面へ戻る(buy-purchase-modal.js closePurchaseModal 参照)。
  buyBtn.href = `index.html?race=${encodeURIComponent(selectedRace.id)}&from=prediction`;
  // 2026-08-23修正: selectedRace.payoutsに「返還」情報(payouts.refunds。取消・除外・
  // 中止馬の馬番/枠番の記録であり、実際の払戻レートではない)のみが入っている場合に、
  // 誤って「結果確定済」と判定されてしまう不具合があった。実際の払戻レート(式別ごとの
  // データ)が1件以上あるかどうかで判定する共通関数 hasSettledPayoutRates() を使う
  // よう修正した(public/utils.js参照)。
  const settled = !!selectedRace.finish_order || hasSettledPayoutRates(selectedRace.payouts);
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

// 予想登録画面から購入画面のカレンダーへ戻る手段がなかったため、開催日・競馬場・
// レース番号のセレクトからページ遷移なしで別レースへ切り替えられるようにする。
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

// 指定の開催日・競馬場・レース番号にできるだけ近いレースへ切り替える。
// 優先順: 「日付+競馬場+R」一致 → 「日付+競馬場」一致の先頭R → その日付の先頭レース。
function switchToRaceKeeping(date, track, raceNumber) {
  const onDate = races
    .filter(r => r.race_date === date)
    .sort((a, b) => Number(a.race_number) - Number(b.race_number));
  if (!onDate.length) return;
  const onTrack = onDate.filter(r => r.track === track);
  const pool = onTrack.length ? onTrack : onDate;
  const exact = pool.find(r => Number(r.race_number) === Number(raceNumber));
  switchToRace((exact || pool[0]).id);
}

function renderRaceHeader() {
  const sameDate = racesOnSameDate();
  const dates = [...new Set(races.map(r => r.race_date))].sort();
  const tracks = [...new Set(sameDate.map(r => r.track))];
  const racesForTrack = sameDate
    .filter(r => r.track === selectedRace.track)
    .sort((a, b) => Number(a.race_number) - Number(b.race_number));

  // ヘッダーは2行構成。
  //  1行目: 日付・競馬場名・レース番号(いずれもセレクト。ページ遷移なしで別レースへ
  //         切り替え。日付・競馬場変更時は現在のR番号をできるだけ維持=switchToRaceKeeping)
  //         + 「このレースの馬券を購入」ボタン(右寄せ)
  //  2行目: レース名・勝負レーストグル・コース情報(芝/ダート+距離)・頭数・
  //         条件バッジ(牝馬限定なら「牝」・ハンデ戦なら「H」)
  // 牝馬限定は class_flags の生テキストに「牝」を含むか、ハンデ戦は weight_type
  // (または class_flags)に「ハンデ」を含むかで判定する(docs/design/data-model.md
  // 「レース条件の詳細カラム」参照。構造化されていない生テキストのため部分一致で見る)。
  const classFlags = String(selectedRace.class_flags || "");
  const isFillyOnly = classFlags.includes("牝");
  const isHandicap = String(selectedRace.weight_type || "").includes("ハンデ") || classFlags.includes("ハンデ");
  // 勝負レースフラグ(prediction.is_key_race)は selectRace() が /api/predictions を
  // 取得し終えるまでは前のレースの値が残っているため、初回描画時は常にOFF扱いにする
  // (取得完了後に renderRaceHeader() を再度呼び直して正しい状態に更新する)。
  const isKeyRace = Boolean(prediction.race_id === selectedRace.id && prediction.is_key_race);
  raceHeader.innerHTML = `
    <div class="prediction-race-title">
      <select id="prediction-date-select" class="prediction-select" aria-label="開催日を選択">
        ${dates.map(d => `<option value="${escapeAttr(d)}" ${d === selectedRace.race_date ? "selected" : ""}>${escapeHtml(formatDateMdW(d))}</option>`).join("")}
      </select>
      <select id="prediction-track-select" class="prediction-select" aria-label="競馬場を選択">
        ${tracks.map(t => `<option value="${escapeAttr(t)}" ${t === selectedRace.track ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
      </select>
      <select id="prediction-racenum-select" class="prediction-select" aria-label="レース番号を選択">
        ${racesForTrack.map(r => `<option value="${r.id}" ${Number(r.id) === Number(selectedRace.id) ? "selected" : ""}>${r.race_number}R</option>`).join("")}
      </select>
      <a id="buy-race-btn" class="stamp-btn" href="#">このレースの馬券を購入</a>
    </div>
    <div class="prediction-race-meta">
      ${selectedRace.race_name ? `<span class="race-name">${escapeHtml(selectedRace.race_name)}</span>` : ""}
      <button type="button" id="key-race-toggle-btn" class="race-cond-badge key-race-toggle ${isKeyRace ? "active" : ""}" aria-pressed="${isKeyRace}" title="勝負レース(ONにすると馬券購入画面のレース一覧にも★が表示されます)">${isKeyRace ? "★ 勝負レース" : "☆ 勝負レース"}</button>
      ${formatCourseText(selectedRace.course_type, selectedRace.distance) ? `<span class="race-course">${escapeHtml(formatCourseText(selectedRace.course_type, selectedRace.distance))}</span>` : ""}
      <span class="prediction-entry-count">${selectedRace.entries.length}頭</span>
      ${isFillyOnly ? `<span class="race-cond-badge race-cond-filly" title="牝馬限定">牝</span>` : ""}
      ${isHandicap ? `<span class="race-cond-badge race-cond-handi" title="ハンデ戦">H</span>` : ""}
    </div>
    <span id="prediction-message" class="submit-message" hidden></span>
  `;

  document.getElementById("prediction-date-select").addEventListener("change", (e) => {
    switchToRaceKeeping(e.target.value, selectedRace.track, selectedRace.race_number);
  });
  document.getElementById("prediction-track-select").addEventListener("change", (e) => {
    switchToRaceKeeping(selectedRace.race_date, e.target.value, selectedRace.race_number);
  });
  document.getElementById("prediction-racenum-select").addEventListener("change", (e) => {
    switchToRace(Number(e.target.value));
  });
  document.getElementById("key-race-toggle-btn").addEventListener("click", toggleKeyRace);
}

// 勝負レースフラグのON/OFF切り替え(2026-09-12追加)。予想印・予想メモの保存とは
// 独立した専用エンドポイント(PUT /api/predictions/key-race)を使う。
async function toggleKeyRace() {
  const race = selectedRace;
  const nextValue = !(prediction.race_id === race.id && prediction.is_key_race);
  const res = await authedFetch("/api/predictions/key-race", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ race_id: race.id, is_key_race: nextValue }),
  });
  if (!res.ok) {
    alert("勝負レースの切り替えに失敗しました。");
    return;
  }
  prediction.race_id = race.id;
  prediction.is_key_race = nextValue;
  if (selectedRace === race) renderRaceHeader();
}

function renderHorses() {
  // 出走馬一覧PDFインポート(枠番なし)対応により、枠番・馬番が未確定(null)の馬が
  // 混在しうる。馬番でのソートができないため、未確定の馬がいる場合は馬名(五十音)順に
  // フォールバックする(詳細はdocs/design/entries-import.md「出走馬一覧PDFインポート」参照)。
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
    // 2026-08-20修正: horseNotesのキーは登録時に空白正規化された馬名のため、
    // 出走馬表側の馬名(e.horse_name)も正規化してから参照する。以前はここで
    // 正規化しておらず、空白の入り方の違いで一致せず「メモありなのに何も
    // 表示されない」不具合があった(docs/DESIGN.md参照)。
    const note = horseNotes[normalizeHorseName(e.horse_name)] || {};
    return `
      <article class="prediction-horse horse-note-card"
        data-horse-number="${n !== null ? n : ""}"
        data-horse-name="${escapeAttr(e.horse_name || "")}">
        <div class="horse-note-toggle" role="button" tabindex="0">
          <span class="prediction-horse-number waku-tint waku-${e.waku_number || 0}">${n !== null ? n : "-"}</span>
          <span class="prediction-horse-name">
            <strong>${escapeHtml(e.horse_name || "馬名未登録")}</strong>
            ${(() => {
              // 性齢(sex_age)・負担重量(weight_carried)は出走馬一覧/結果PDFインポートでのみ
              // 入る(手動登録レースには無い)。値がある項目だけを「・」で連結し、馬名の下段に表示する。
              const w = e.weight_carried;
              const meta = [
                e.sex_age ? escapeHtml(String(e.sex_age)) : null,
                (w !== null && w !== undefined && w !== "" && !Number.isNaN(Number(w))) ? `${Number(w).toFixed(1)}kg` : null,
                e.jockey ? escapeHtml(e.jockey) : null,
              ].filter(Boolean).join(" ・ ");
              return meta ? `<small>${meta}</small>` : "";
            })()}
          </span>
          <span class="prediction-mark-inline" aria-label="予想印">
            <select class="prediction-mark-select" aria-label="予想印を選択" ${hasNumber ? "" : 'disabled title="枠番・馬番確定後に選択できます"'}>
              <option value="">−</option>
              ${MARKS.map(m => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </span>
          <span class="note-toggle-tail">
            ${note.memo ? `<span class="memo-mark" title="この馬のメモがあります">▼</span>` : ""}
          </span>
        </div>
        <div class="horse-note-editor" hidden>
          <label class="horse-memo-label">
            <textarea class="horse-memo" rows="3" maxlength="5000" aria-label="この馬についてのメモ"
              >${escapeHtml(note.memo || "")}</textarea>
          </label>
          <span class="horse-note-status" hidden></span>
          <div class="horse-history" hidden></div>
        </div>
      </article>
    `;
  }).join("");

  // 馬名行のクリックで展開パネル(馬メモ + 過去成績)を開閉する。
  // 印セレクトのクリックでは展開を切り替えない。開閉トグルの「＋/−」記号は
  // 表示しない(2026-09-10。行ホバーの背景変化とメモ「▼」マークで開閉可能なことを示す)。
  horsesEl.querySelectorAll(".horse-note-toggle").forEach(btn => {
    btn.addEventListener("click", (event) => {
      if (event.target.closest(".prediction-mark-inline")) return;
      const card = btn.closest(".horse-note-card");
      const editor = card.querySelector(".horse-note-editor");
      editor.hidden = !editor.hidden;
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

    // 2026-08-24修正: 馬メモ(horseNotes)の取得はrenderHorses()より後に完了するため、
    // renderHorses()内で組み立てる「▼」マークは常に「メモ未取得」の状態で描画されて
    // しまい、実際にメモがある馬でも一覧上は▼マークが表示されない不具合があった。
    // (メモ本文自体はこの関数でtextareaへ反映されていたため、行を開けば中身は見える
    // が、一覧を見ただけではどの馬にメモがあるか分からない状態になっていた)
    // メモ取得完了後のこのタイミングで、▼マークの追加/削除も行うようにする。
    const tail = card.querySelector(".note-toggle-tail");
    if (!tail) return;
    let mark = tail.querySelector(".memo-mark");
    if (note) {
      if (!mark) {
        mark = document.createElement("span");
        mark.className = "memo-mark";
        mark.title = "この馬のメモがあります";
        mark.textContent = "▼";
        tail.insertBefore(mark, tail.firstChild);
      }
    } else if (mark) {
      mark.remove();
    }
  });
}

// 過去成績(race_results 由来)を取得する。予想印・馬メモの読み込みからは切り離し、
// 失敗しても握りつぶす(呼び出し側で .catch)。応答が非JSON/エラーでも throw させない。
async function loadHorseHistory() {
  const rid = selectedRace && selectedRace.id;
  if (!rid) return;
  const res = await authedFetch(`/api/races/${rid}/horse-history`);
  // 切り分け用: 応答状況をコンソールに残す(過去成績が出ないときの原因追跡)。
  if (!res.ok) { console.warn("[horse-history] HTTP", res.status, res.statusText); return; }
  const data = await res.json().catch((e) => { console.warn("[horse-history] JSON parse失敗", e); return null; });
  if (!data || typeof data !== "object") return;
  const horseCount = Object.keys(data).length;
  console.info("[horse-history] 取得OK 対象馬数", horseCount);
  // 取得中に別レースへ切り替わっていたら破棄する。
  if (selectedRace && selectedRace.id === rid) {
    horseHistory = data;
    applyHorseHistory();
  }
}

// 過去成績（出走履歴）を各馬の展開パネル（馬メモの下）へ流し込む。horseHistory の
// 取得は renderHorses() より後に完了するため、applyHorseNotes() と同じくこのタイミングで
// 描画する。0走の馬はセクションごと非表示のまま（従来どおりメモのみ）。
function applyHorseHistory() {
  horsesEl.querySelectorAll(".horse-note-card").forEach(card => {
    const box = card.querySelector(".horse-history");
    if (!box) return;
    const name = normalizeHorseName(card.dataset.horseName);
    const rows = horseHistory[name] || [];
    if (!rows.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = renderHorseHistory(rows);
  });
}

// 着順セル。取消・除外・中止は着順が付かないため状態ラベルを出す。
function historyPlaceText(row) {
  const label = { scratched: "取消", excluded: "除外", stopped: "中止" }[row.status];
  if (label) return label;
  if (row.finish_position === null || row.finish_position === undefined) return "—";
  return row.field_size ? `${row.finish_position}着 / ${row.field_size}頭` : `${row.finish_position}着`;
}

function renderHorseHistory(rows) {
  const tbody = rows.map(r => {
    const course = formatCourseText(r.course_type, r.distance) || "—";
    const bw = (r.body_weight !== null && r.body_weight !== undefined)
      ? `${r.body_weight}${r.body_weight_change ? `（${r.body_weight_change}）` : ""}`
      : "—";
    const kinryo = (r.weight_carried !== null && r.weight_carried !== undefined && !Number.isNaN(Number(r.weight_carried)))
      ? Number(r.weight_carried).toFixed(1)
      : "—";
    const pop = (r.win_popularity !== null && r.win_popularity !== undefined) ? `${r.win_popularity}人` : "—";
    return `
      <tr title="${escapeAttr(r.race_name || "")}">
        <td>${escapeHtml(formatDateMdW(r.race_date))}</td>
        <td>${escapeHtml(`${r.track || ""}${r.race_number ? `${r.race_number}R` : ""}`)}</td>
        <td>${escapeHtml(course)}</td>
        <td class="hh-place">${escapeHtml(historyPlaceText(r))}</td>
        <td>${escapeHtml(pop)}</td>
        <td>${escapeHtml(r.jockey || "—")}</td>
        <td>${escapeHtml(kinryo)}</td>
        <td>${escapeHtml(bw)}</td>
        <td>${escapeHtml(r.time_text || "—")}</td>
        <td>${escapeHtml(r.margin || "—")}</td>
      </tr>`;
  }).join("");
  return `
    <div class="horse-history-head">過去成績（${rows.length}走）</div>
    <div class="horse-history-scroll">
      <table class="horse-history-table">
        <thead>
          <tr><th>日付</th><th>場</th><th>コース</th><th>着順</th><th>人気</th><th>騎手</th><th>斤量</th><th>馬体重</th><th>タイム</th><th>着差</th></tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function normalizeHorseName(str) { return String(str ?? "").replace(/[\u3000\s]+/g, " ").trim(); }

// escapeHtml / escapeAttr / formatDate は utils.js のものを使用する
// (2026-09-07: ローカルの formatDate 定義を撤去。utils.js に統合し全画面で
//  「2026/08/24(日)」表記に統一した)

setupAuth(loadRaces);
