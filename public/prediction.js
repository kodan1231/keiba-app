let races = [];
let selectedRace = null;
let prediction = { marks: [] };
let horseNotes = {};
// 出走各馬の過去成績(race_results 由来)。キーは空白正規化した馬名。
// selectRace() で GET /api/races/:id/horse-history からまとめて取得し、
// renderHorses() より後の applyHorseHistory() で各行の展開パネルへ流し込む。
let horseHistory = {};
// 馬柱表示の「同条件の持ちタイム・上がり」(GET /api/races/:id/horse-best。2026-10-03追加)。
// 馬柱タブを開いたときだけ取得する(出馬表しか見ない場合は通信しない)。
// { raceId, status: "loading"|"done"|"error", data } の形で、どのレースの結果かを持つ。
let horseBest = null;
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

// 2026-10-07: レース一覧は軽い一覧(GET /api/races?index=1。日付・競馬場・R等だけ)を取り、
// 出走馬・着順・払戻は開いたレース1件ぶんだけ GET /api/races/:id で取る。以前は GET /api/races で
// 全レース・全出走馬を丸ごと取得しており、開くたびに数MBの通信と、サーバー側でCPU時間上限超過の
// 恐れがあった(docs/design/data-model.md「レース一覧用の軽いキャッシュ」)。
// races の要素は一覧の項目だけ(entries 等は無い)。selectedRace は1件ぶんの完全なレース情報。
let raceLoadToken = 0; // 別のレースへ切り替えたら、取得中の古いレースの結果を捨てるための世代番号

async function fetchRaceDetail(raceId) {
  const res = await authedFetch(`/api/races/${encodeURIComponent(raceId)}`);
  if (!res.ok) return null;
  return res.json();
}

async function loadRaces() {
  const list = await fetchRaceIndex();
  if (!list) {
    showEmpty("レース情報の取得に失敗しました。");
    return;
  }
  races = list;
  const raceId = Number(new URLSearchParams(location.search).get("race"));
  if (!Number.isInteger(raceId) || raceId <= 0) {
    showEmpty("レースが指定されていません。レース一覧から対象レースを選択してください。");
    return;
  }
  const token = ++raceLoadToken;
  const detail = races.some(r => Number(r.id) === raceId) ? await fetchRaceDetail(raceId) : null;
  if (token !== raceLoadToken) return;
  if (!detail) {
    showEmpty("指定されたレースが見つかりません。");
    return;
  }
  selectedRace = detail;
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
  // 表示中の1レース分だけで足りるため、サーバー側で ?race_id= 絞り込みをかけて呼ぶ
  // (2026-09-29追加。全履歴を毎回読んでいたことがCloudflare WorkersのCPU時間上限
  // 超過の一因になっていたため。docs/design/data-model.md
  // 「GET /api/tickets・GET /api/ticket-imports の範囲限定」参照)。
  const raceId = encodeURIComponent(selectedRace.id);
  const [ticketsRes, importedRes] = await Promise.all([
    authedFetch(`/api/tickets?race_id=${raceId}`),
    authedFetch(`/api/ticket-imports?race_id=${raceId}`),
  ]);
  const tickets = ticketsRes.ok ? await ticketsRes.json() : [];
  const importedPayload = importedRes.ok ? await importedRes.json() : { items: [] };
  const imported = Array.isArray(importedPayload) ? importedPayload : (importedPayload.items || []);
  return [...(Array.isArray(tickets) ? tickets : []), ...(Array.isArray(imported) ? imported : [])];
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
  // 2026-09-18修正: renderRaceHeader()はraceHeader.innerHTMLを丸ごと再構築し
  // #buy-race-btn要素を作り直すため、この再描画より前に取得したDOM参照へ
  // 後からhref/textContentを設定しても、画面上の(作り直された)要素には反映されず
  // 購入ボタンが常に初期状態(href="#"・初期文言)のまま操作不能になる不具合があった。
  // (2026-10-03以降はボタンの状態設定を renderRaceHeader() 内で毎回行うため、
  //  ここでDOM参照を取り直す必要は無くなった。applyBuyButtonState() 参照)
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
  // 重賞メモの有無(ヘッダーの「重賞メモ」ボタンの強調用)も独立して読み込む(2026-10-12)。
  loadGradedNotes();
  // 購入画面への導線ボタンの状態設定は renderRaceHeader() の中(applyBuyButtonState())で
  // 毎回行う(2026-10-03。下記参照)。

  // 購入馬券セクションは独立して読み込む。ここで失敗しても、予想印の保存や
  // 購入ページへの遷移など他の機能に影響させない。
  loadRaceTickets()
    .then(renderPurchasedTickets)
    .catch(() => { ticketsEl.innerHTML = ""; ticketsEl.hidden = true; });
}

// 「投票」ボタン(#buy-race-btn)のリンク先・文言・見た目を設定する。
// 2026-10-03: renderRaceHeader() はヘッダーを丸ごと作り直すため、ボタンも初期状態
// (href="#"・文言「投票」)で作り直される。以前はこの設定を selectRace() の中で1回だけ
// 行っていたため、勝負レースの切り替え(toggleKeyRace → renderRaceHeader)でヘッダーを
// 描き直すとリンク先が消えて「投票」ボタンが効かなくなり、確定済・購入不可の表示も
// 「投票」に戻ってしまう不具合があった(2026-09-18にも selectRace() 内の再描画で同種の
// 不具合を修正済み)。renderRaceHeader() の末尾から毎回呼ぶことで、どの経路で
// 描き直しても状態が揃うようにした。
function applyBuyButtonState() {
  const buyBtn = document.getElementById("buy-race-btn");
  if (!buyBtn || !selectedRace) return;
  // レースの着順 or 払戻が確定済みの場合でも、購入履歴の登録し忘れに対応できるよう
  // 購入自体は引き続きできるようにする。ボタンのラベルだけ「確定済」に変え、
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
  // 未確定の間は購入できない(購入モーダル側〈buy-purchase-modal.js〉でも、URL直打ち等に
  // 備えて案内を出して購入UIをブロックしている)。
  const hasUnconfirmedNumbers = (selectedRace.entries || []).some((e) => e.horse_number === null || e.horse_number === undefined);
  // 2026-09-30: 購入不可はグレー(is-unavailable)にし、購入画面へ遷移させない
  // (以前は確定済と同じ色で、遷移先の購入モーダルで案内を出して購入をブロックしていた)。
  // <a>のためhrefを外し、aria-disabledとクリック抑止で押せないことを明示する。
  if (hasUnconfirmedNumbers) {
    buyBtn.textContent = "購入不可";
    buyBtn.classList.remove("is-settled");
    buyBtn.classList.add("is-unavailable");
    buyBtn.removeAttribute("href");
    buyBtn.setAttribute("aria-disabled", "true");
    buyBtn.onclick = (e) => e.preventDefault();
    buyBtn.title = "枠番・馬番が確定するまで購入できません";
  } else if (settled) {
    buyBtn.textContent = "確定済";
    buyBtn.classList.add("is-settled");
    buyBtn.title = "このレースは結果確定済みですが、購入履歴の登録は引き続き行えます";
  } else {
    buyBtn.textContent = "投票";
    buyBtn.classList.remove("is-settled");
    buyBtn.removeAttribute("title");
  }
}

// 予想登録画面から購入画面のカレンダーへ戻る手段がなかったため、開催日・競馬場・
// レース番号のセレクトからページ遷移なしで別レースへ切り替えられるようにする。
function racesOnSameDate() {
  return races.filter(r => r.race_date === selectedRace.race_date);
}

async function switchToRace(raceId) {
  if (!races.some(r => Number(r.id) === Number(raceId))) return;
  const token = ++raceLoadToken;
  const detail = await fetchRaceDetail(raceId); // 出走馬等は切り替え先の1件ぶんだけ取る(2026-10-07)
  if (token !== raceLoadToken || !detail) return;
  selectedRace = detail;
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
  //         + 「投票」ボタン(右寄せ。旧「このレースの馬券を購入」)
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
      <a id="buy-race-btn" class="stamp-btn" href="#">投票</a>
    </div>
    <div class="prediction-race-meta">
      ${selectedRace.race_name ? `<span class="race-name">${escapeHtml(selectedRace.race_name)}</span>` : ""}
      <button type="button" id="key-race-toggle-btn" class="race-cond-badge key-race-toggle ${isKeyRace ? "active" : ""}" aria-pressed="${isKeyRace}" title="勝負レース(ONにすると馬券購入画面のレース一覧にも★が表示されます)">${isKeyRace ? "★ 勝負レース" : "☆ 勝負レース"}</button>
      ${formatCourseText(selectedRace.course_type, selectedRace.distance) ? `<span class="race-course">${escapeHtml(formatCourseText(selectedRace.course_type, selectedRace.distance))}</span>` : ""}
      <span class="prediction-entry-count">${selectedRace.entries.length}頭</span>
      ${isFillyOnly ? `<span class="race-cond-badge race-cond-filly" title="牝馬限定">牝</span>` : ""}
      ${isHandicap ? `<span class="race-cond-badge race-cond-handi" title="ハンデ戦">H</span>` : ""}
      ${selectedRace.graded ? `<a class="race-cond-badge graded-past-link" href="data-search.html?graded=${encodeURIComponent(selectedRace.graded.id)}" target="_blank" rel="noopener" title="データ検索「重賞検索」でこの重賞の過去10年の成績を別タブで開きます">過去のデータ</a>` : ""}
      ${selectedRace.graded ? `<button type="button" id="graded-memo-btn" class="race-cond-badge graded-memo-btn ${gradedNotesHaveMemo() ? "has-memo" : ""}" title="この重賞の年ごとのメモ(予想の根拠・結果の振り返り。自分だけに表示)">重賞メモ</button>` : ""}
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
  document.getElementById("graded-memo-btn")?.addEventListener("click", openGradedMemo);
  // ボタンは作り直されたばかりで初期状態なので、毎回ここで状態を設定し直す。
  applyBuyButtonState();
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
            <button type="button" class="horse-memo-btn ${note.memo ? "has-memo" : ""}" ${e.horse_name ? `title="${note.memo ? "この馬のメモがあります" : "この馬のメモを入力"}"` : 'disabled title="馬名が未登録のためメモは使えません"'}>メモ</button>
            <select class="prediction-mark-select" aria-label="予想印を選択" ${hasNumber ? "" : 'disabled title="枠番・馬番確定後に選択できます"'}>
              <option value="">−</option>
              ${MARKS.map(m => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </span>
        </div>
        <div class="horse-note-editor" hidden>
          <div class="horse-history"></div>
        </div>
      </article>
    `;
  }).join("");

  // 馬名行のクリックで展開パネル(過去成績のみ。馬メモは「メモ」ボタンのダイアログ)を
  // 開閉する。印セレクト・メモボタンのクリックでは展開を切り替えない
  // (どちらも .prediction-mark-inline 内)。開閉トグルの「＋/−」記号は表示しない
  // (2026-09-10。行ホバーの背景変化で開閉可能なことを示す)。
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
    select.addEventListener("change", () => {
      const card = select.closest(".horse-note-card");
      if (!card.dataset.horseNumber) return; // 念のための二重ガード
      setHorseMark(Number(card.dataset.horseNumber), select.value || "");
    });
  });

  // 「メモ」ボタン: 馬メモのダイアログを開く。
  horsesEl.querySelectorAll(".horse-memo-btn").forEach(btn => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openHorseMemo(btn.closest(".horse-note-card"));
    });
  });

  // 馬柱タブも同じ出走馬で作り直す(過去走は horseHistory 取得後に applyHorseHistory() から再描画)。
  renderUmabashira();
}

// 予想印の変更(出馬表・馬柱の両方から呼ぶ)。1頭につき1つまで。両方の表示へ即時反映してから保存する。
async function setHorseMark(n, mark) {
  prediction.marks = (prediction.marks || []).filter(x => Number(x.horse_number) !== n);
  if (mark) {
    prediction.marks.push({ horse_number: n, mark });
  }
  applyPrediction(); // 変更直後に見た目へ反映する(保存を待たず即時反映)
  await savePredictionMarks();
}

// ---------- 馬柱表示(近5走。2026-10-03追加) ----------
// netkeiba の「馬柱」に相当する表。左端の列(馬番・馬名・騎手・予想印)を固定し、
// 前走〜5走前を横に並べる(スマホでは横スクロール)。データは出馬表の過去成績と同じ
// horseHistory(GET /api/races/:id/horse-history。追加の通信なし)。予想印は出馬表と共有する。
// 仕様は docs/design/screens.md「予想登録画面」の「馬柱表示」。
const umabashiraEl = document.getElementById("prediction-umabashira");
const UB_RUNS = 5;
let predictionView = "card"; // "card"(出馬表)/"umabashira"(馬柱)/"pace"(展開・時計)。レースを切り替えても保つ
const paceEl = document.getElementById("prediction-pace");

function setupPredictionViewTabs() {
  document.querySelectorAll(".prediction-view-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      predictionView = tab.dataset.view;
      document.querySelectorAll(".prediction-view-tab").forEach(t => {
        const active = t.dataset.view === predictionView;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
      });
      horsesEl.hidden = predictionView !== "card";
      if (umabashiraEl) umabashiraEl.hidden = predictionView !== "umabashira";
      if (paceEl) paceEl.hidden = predictionView !== "pace";
      ensureHorseBest();
      ensureJockeyCourse();
    });
  });
}

// 馬柱・展開・時計タブを表示している時だけ、今のレースの持ちタイムを1回取得する(両タブで共用)。
// 取得後に馬柱を描き直す(renderUmabashira() の中で展開・時計タブも描き直す)。
function ensureHorseBest() {
  if (!selectedRace || (predictionView !== "umabashira" && predictionView !== "pace")) return;
  const rid = selectedRace.id;
  if (horseBest && horseBest.raceId === rid) return; // 取得済み・取得中・失敗済み
  horseBest = { raceId: rid, status: "loading", data: null };
  authedFetch(`/api/races/${rid}/horse-best`)
    .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(data => {
      if (!horseBest || horseBest.raceId !== rid) return; // 取得中に別レースへ切り替わった
      horseBest = { raceId: rid, status: "done", data };
      if (selectedRace && selectedRace.id === rid) renderUmabashira();
    })
    .catch(() => {
      if (!horseBest || horseBest.raceId !== rid) return;
      horseBest = { raceId: rid, status: "error", data: null };
      if (selectedRace && selectedRace.id === rid) renderUmabashira();
    });
}

// 「持ちタイム」列のセル。同芝ダ・同距離で「同じ競馬場(同場)」と「全競馬場(全場)」の2段に、
// それぞれ最速タイムと最速上がりを出す(2026-10-03。当初は全場のみ)。各段の下にタイムを出した走の
// 「日付・(全場のみ競馬場)・馬場・着順」、上がりが別の走ならその走も「上:」付きで添える。
function ubBestBlockHtml(label, slot, showTrack) {
  const has = slot && (slot.time || slot.last3f);
  const sub = (x, prefix) => {
    if (!x) return "";
    const parts = [formatDateMd(x.race_date), showTrack ? x.track : null, x.track_condition,
      x.finish_position != null ? `${x.finish_position}着` : null]
      .filter(Boolean).map(s => escapeHtml(String(s)));
    return `<div class="ub-line ub-best-sub" title="${escapeAttr(x.race_name || "")}">${prefix}${parts.join(" ")}</div>`;
  };
  if (!has) {
    return `<div class="ub-best-block"><div class="ub-best-label">${escapeHtml(label)}</div><div class="ub-best-none">走なし</div></div>`;
  }
  const sameRun = slot.time && slot.last3f && slot.time.race_date === slot.last3f.race_date && slot.time.race_name === slot.last3f.race_name;
  return `
    <div class="ub-best-block">
      <div class="ub-best-label">${escapeHtml(label)}</div>
      <div class="ub-best-value">${slot.time ? escapeHtml(slot.time.time_text) : "—"}<span class="ub-best-l3f">上${slot.last3f ? Number(slot.last3f.last3f).toFixed(1) : "—"}</span></div>
      ${sub(slot.time || slot.last3f, "")}
      ${slot.time && slot.last3f && !sameRun ? sub(slot.last3f, "上: ") : ""}
    </div>`;
}

// 馬の列の父・母(2026-10-03追加)。horse-best API が返す horses(馬情報マスタ)保存済みの分で、
// 未登録は「不明」。取得中・取得失敗の間は何も出さない(「不明」と誤って見せないため)。
function ubPedigreeHtml(name) {
  const st = horseBest && selectedRace && horseBest.raceId === selectedRace.id ? horseBest : null;
  if (!st || st.status !== "done" || !st.data) return "";
  const p = (st.data.pedigree || {})[name] || {};
  return `<small class="ub-horse-ped"><span>父 ${escapeHtml(p.sire || "不明")}</span><span>母 ${escapeHtml(p.dam || "不明")}</span></small>`;
}

function ubBestCellHtml(name) {
  const st = horseBest && selectedRace && horseBest.raceId === selectedRace.id ? horseBest : null;
  if (!st || st.status === "loading") return `<td class="ub-best ub-best-muted">読み込み中…</td>`;
  if (st.status === "error") return `<td class="ub-best ub-best-muted">取得失敗</td>`;
  if (!st.data || !st.data.condition) return `<td class="ub-best ub-best-muted">—</td>`;
  const b = (st.data.horses || {})[name];
  if (!b) return `<td class="ub-best ub-best-muted">同条件の<br>走なし</td>`;
  const trackLabel = st.data.condition.track ? `同場(${st.data.condition.track})` : "同場";
  return `
    <td class="ub-best">
      ${ubBestBlockHtml(trackLabel, b.track, false)}
      ${ubBestBlockHtml("全場", b.all, true)}
    </td>`;
}

function ubRunCellHtml(r) {
  if (!r) return `<td class="ub-run ub-run-empty"></td>`;
  const statusLabel = { scratched: "取消", excluded: "除外", stopped: "中止" }[r.status];
  const place = statusLabel || (r.finish_position != null ? `${r.finish_position}着` : "—");
  const placeClass = !statusLabel && r.finish_position >= 1 && r.finish_position <= 3 ? `ub-place-${r.finish_position}` : "";
  const num = (v, suffix) => (v !== null && v !== undefined && v !== "" ? `${v}${suffix}` : null);
  const kinryo = (r.weight_carried !== null && r.weight_carried !== undefined && !Number.isNaN(Number(r.weight_carried)))
    ? Number(r.weight_carried).toFixed(1) : null;
  const agari = (r.final_furlong_time !== null && r.final_furlong_time !== undefined && !Number.isNaN(Number(r.final_furlong_time)))
    ? Number(r.final_furlong_time).toFixed(1) : null;
  const bw = r.body_weight !== null && r.body_weight !== undefined
    ? `${r.body_weight}${r.body_weight_change ? `(${r.body_weight_change})` : ""}` : null;
  // 値がある項目だけを空白でつなぐ(取込経路によって欠ける項目があるため)。
  const line = (...parts) => {
    const s = parts.filter(Boolean).map(p => escapeHtml(String(p))).join(" ");
    return s ? `<div class="ub-line">${s}</div>` : "";
  };
  const rival = r.rival && r.rival.horse_name
    ? `<div class="ub-line ub-rival">${escapeHtml(r.rival.horse_name)}${r.rival.margin ? `(${escapeHtml(r.rival.margin)})` : ""}</div>`
    : "";
  return `
    <td class="ub-run ${placeClass}" title="${escapeAttr(r.race_name || "")}">
      <div class="ub-line ub-run-head">${escapeHtml(formatDateMdW(r.race_date))} ${escapeHtml(`${r.track || ""}${r.race_number ? `${r.race_number}R` : ""}`)}</div>
      <div class="ub-line ub-race-name">${escapeHtml(r.race_name || "—")}</div>
      ${line(formatCourseText(r.course_type, r.distance), r.track_condition, r.weather)}
      <div class="ub-place">${escapeHtml(place)}</div>
      ${line(num(r.field_size, "頭"), num(r.horse_number, "番"), num(r.win_popularity, "人"))}
      ${line(r.jockey, kinryo)}
      ${line(r.time_text, agari ? `上${agari}` : null)}
      ${line(r.corner_positions, bw)}
      ${rival}
    </td>`;
}

function renderUmabashira() {
  // 展開・時計タブも同じきっかけ(出走馬・過去走・持ちタイムの更新)で描き直す。
  renderPace();
  if (!umabashiraEl || !selectedRace) return;
  const hasUnconfirmedNumbers = selectedRace.entries.some((e) => e.horse_number === null || e.horse_number === undefined);
  const entries = hasUnconfirmedNumbers
    ? [...selectedRace.entries].sort((a, b) => String(a.horse_name || "").localeCompare(String(b.horse_name || ""), "ja"))
    : [...selectedRace.entries].sort((a, b) => Number(a.horse_number) - Number(b.horse_number));
  if (!entries.length) {
    umabashiraEl.innerHTML = `<p class="prediction-no-entries">出走馬が登録されていません。</p>`;
    return;
  }
  const head = ["前走", "2走前", "3走前", "4走前", "5走前"].slice(0, UB_RUNS);
  const rows = entries.map(e => {
    const hasNumber = e.horse_number !== null && e.horse_number !== undefined;
    const n = hasNumber ? Number(e.horse_number) : null;
    const runs = horseHistory[normalizeHorseName(e.horse_name)] || [];
    const w = e.weight_carried;
    const meta = [
      e.sex_age ? String(e.sex_age) : null,
      (w !== null && w !== undefined && w !== "" && !Number.isNaN(Number(w))) ? `${Number(w).toFixed(1)}kg` : null,
      e.jockey || null,
    ].filter(Boolean).map(s => escapeHtml(s)).join(" ");
    return `
      <tr>
        <th class="ub-horse" scope="row">
          <div class="ub-horse-top">
            <span class="prediction-horse-number waku-tint waku-${e.waku_number || 0}">${n !== null ? n : "-"}</span>
            <select class="prediction-mark-select ub-mark-select" data-horse-number="${n !== null ? n : ""}" aria-label="予想印を選択" ${hasNumber ? "" : 'disabled title="枠番・馬番確定後に選択できます"'}>
              <option value="">−</option>
              ${MARKS.map(m => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </div>
          <strong class="ub-horse-name">${escapeHtml(e.horse_name || "馬名未登録")}</strong>
          ${meta ? `<small class="ub-horse-meta">${meta}</small>` : ""}
          ${ubPedigreeHtml(normalizeHorseName(e.horse_name))}
        </th>
        ${ubBestCellHtml(normalizeHorseName(e.horse_name))}
        ${Array.from({ length: UB_RUNS }, (_, i) => ubRunCellHtml(runs[i])).join("")}
      </tr>`;
  }).join("");
  umabashiraEl.innerHTML = `
    <div class="ub-scroll">
      <table class="ub-table">
        <thead><tr><th class="ub-horse">馬名</th><th class="ub-best-head">持ちタイム<br><small>${escapeHtml(formatCourseText(selectedRace.course_type, selectedRace.distance) || "同条件")}</small></th>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  umabashiraEl.querySelectorAll(".ub-mark-select").forEach(select => {
    select.addEventListener("change", () => {
      if (!select.dataset.horseNumber) return; // 枠番・馬番未確定(disabled)の二重ガード
      setHorseMark(Number(select.dataset.horseNumber), select.value || "");
    });
  });
  applyPrediction();
  // 馬柱を表示中なら持ちタイムを取得する(取得済み・別タブ表示中なら何もしない)。
  ensureHorseBest();
}

// ---------- 展開・時計タブ(2026-10-12追加。docs/design/screens.md「予想登録画面」の「展開・時計」) ----------
// ① 前走の脚質: horseHistory(追加の通信なし)の前走の最初のコーナー通過順位 ÷ 頭数で判定し、
//    脚質ごとに前にいた順で並べる。判定の基準は重賞検索タブ(_lib/graded-race-search.js の runningStyleOf)と同じ。
// ② 持ちタイム順位: 同場・同距離の順位表は2026-10-12に廃止(補正タイム順位〈⑤。全場の走を今回の競馬場に換算〉に含まれるため)。
//    同場の値(horseBest の track)は推奨馬の「展開が有利な馬」で引き続き使う。
const PACE_STYLES = ["逃げ", "先行", "差し", "追込"];

// 前走 = このレースより前で、取消・除外を除いた一番新しい走(取消・除外は走っていないため)。
// horseHistory は新しい順。過去のレースを開いたときは、そのレースより後の走も入っているので日付で除く。
function paceLastRun(runs) {
  const date = String(selectedRace.race_date || "");
  return (runs || []).find(r => r && String(r.race_date || "") < date && r.status !== "scratched" && r.status !== "excluded") || null;
}

// { style, pos, fieldSize, ratio } | null(通過順位・頭数が無い走、前走が無い馬)
function paceStyleOf(run) {
  if (!run) return null;
  const m = String(run.corner_positions ?? "").normalize("NFKC").match(/\d+/);
  const pos = m ? Number(m[0]) : 0;
  const fieldSize = Number(run.field_size) || 0;
  if (!pos || !fieldSize) return null;
  const ratio = pos / fieldSize;
  const style = pos === 1 ? "逃げ" : ratio <= 1 / 3 ? "先行" : ratio <= 2 / 3 ? "差し" : "追込";
  return { style, pos, fieldSize, ratio };
}

function paceEntries() {
  return (selectedRace.entries || []).filter(e => e && e.horse_name);
}

function paceHorseLabelHtml(e) {
  const hasNumber = e.horse_number !== null && e.horse_number !== undefined;
  return `<span class="prediction-horse-number waku-tint waku-${e.waku_number || 0}">${hasNumber ? Number(e.horse_number) : "-"}</span><span class="pace-horse-name">${escapeHtml(e.horse_name)}</span>`;
}

const paceNumberOf = (e) => (e.horse_number === null || e.horse_number === undefined ? 999 : Number(e.horse_number));

function paceStyleSectionHtml(entries) {
  const groups = new Map([...PACE_STYLES, "不明"].map(s => [s, []]));
  for (const e of entries) {
    const run = paceLastRun(horseHistory[normalizeHorseName(e.horse_name)]);
    const st = paceStyleOf(run);
    groups.get(st ? st.style : "不明").push({ e, run, st });
  }
  for (const [style, list] of groups) {
    list.sort((a, b) => (style === "不明" ? 0 : a.st.ratio - b.st.ratio || a.st.pos - b.st.pos) || paceNumberOf(a.e) - paceNumberOf(b.e));
  }
  const rows = [...groups].filter(([style, list]) => list.length || style !== "不明").map(([style, list]) => `
    <div class="pace-style-row">
      <span class="pace-style-label pace-style-${PACE_STYLES.indexOf(style)}">${escapeHtml(style)}<small>${list.length}頭</small></span>
      <div class="pace-style-horses">
        ${list.length ? list.map(({ e, run, st }) => `
          <span class="pace-chip" title="${escapeAttr(run ? `${formatDateMd(run.race_date)} ${run.track || ""} ${run.race_name || ""} 通過 ${run.corner_positions || "—"}` : "前走なし")}">
            ${paceHorseLabelHtml(e)}${st ? `<small class="pace-chip-sub">${st.pos}/${st.fieldSize}</small>` : `<small class="pace-chip-sub">${run ? "通過なし" : "前走なし"}</small>`}
          </span>`).join("") : `<span class="pace-none">—</span>`}
      </div>
    </div>`).join("");
  return `
    <h3 class="pace-heading">前走の脚質<small>前走の最初のコーナーの位置(位置/頭数)で判定。脚質ごとに前にいた順</small></h3>
    <div class="pace-style-list">${rows}</div>`;
}

// ③ 騎手の同コース成績(2026-10-12追加): GET /api/data-search/jockey-course。展開・時計タブを開いたときに
//    レースごとに1回だけ取得する。最初は馬番順、見出しの「騎乗」「単勝率」「複勝率」で並べ替え(レースを切り替えても保つ)。
let jockeyCourse = null; // { raceId, status: "loading"|"done"|"error"|"paused", data }
let paceJockeySort = "number"; // "number" | "rides" | "win" | "show"

function ensureJockeyCourse() {
  if (!selectedRace || predictionView !== "pace") return;
  const rid = selectedRace.id;
  if (jockeyCourse && jockeyCourse.raceId === rid) return; // 取得済み・取得中・失敗済み
  jockeyCourse = { raceId: rid, status: "loading", data: null };
  authedFetch(`/api/data-search/jockey-course?race_id=${encodeURIComponent(rid)}`)
    .then(res => {
      if (res.status === 503) return { paused: true };
      return res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`));
    })
    .then(data => {
      if (!jockeyCourse || jockeyCourse.raceId !== rid) return; // 取得中に別レースへ切り替わった
      jockeyCourse = data.paused ? { raceId: rid, status: "paused", data: null } : { raceId: rid, status: "done", data };
      if (selectedRace && selectedRace.id === rid) renderPace();
    })
    .catch(() => {
      if (!jockeyCourse || jockeyCourse.raceId !== rid) return;
      jockeyCourse = { raceId: rid, status: "error", data: null };
      if (selectedRace && selectedRace.id === rid) renderPace();
    });
}

const pacePct = (v) => `${(v * 100).toFixed(1)}%`;

function paceJockeySectionHtml() {
  const cond = [selectedRace.track, formatCourseText(selectedRace.course_type, selectedRace.distance)].filter(Boolean).join(" ");
  const heading = `<h3 class="pace-heading">騎手の${escapeHtml(cond || "同条件")} 成績<small>同じ競馬場・芝ダート・距離での騎乗(このレースより前の取り込み済み全期間)。騎乗が少ないと率は当てにならない</small></h3>`;
  const st = jockeyCourse && jockeyCourse.raceId === selectedRace.id ? jockeyCourse : null;
  if (!st || st.status === "loading") return `${heading}<p class="pace-none">読み込み中…</p>`;
  if (st.status === "paused") return `${heading}<p class="pace-none">D1の使用量が多いため、データ検索の集計は一時停止中です</p>`;
  if (st.status === "error" || !st.data) return `${heading}<p class="pace-none">取得に失敗しました</p>`;
  if (!st.data.condition) return `${heading}<p class="pace-none">このレースのコース・距離が未登録のため出せません</p>`;

  const list = [...(st.data.jockeys || [])];
  const num = (x) => (x.horse_number === null || x.horse_number === undefined ? 999 : Number(x.horse_number));
  const val = { rides: (s) => s.rides, win: (s) => s.winRate, show: (s) => s.showRate }[paceJockeySort];
  list.sort((a, b) => {
    if (val) {
      // 騎手が空欄の馬は最後。同じ値なら騎乗の多い順→馬番順
      if (!a.stats || !b.stats) return (a.stats ? 0 : 1) - (b.stats ? 0 : 1) || num(a) - num(b);
      return val(b.stats) - val(a.stats) || b.stats.rides - a.stats.rides || num(a) - num(b);
    }
    return num(a) - num(b);
  });
  const sortTh = (key, label) =>
    `<th><button type="button" class="pace-sort-btn ${paceJockeySort === key ? "active" : ""}" data-sort="${key}">${label}${paceJockeySort === key ? " ▼" : ""}</button></th>`;
  const rows = list.map(x => {
    const s = x.stats;
    const horse = paceHorseLabelHtml({ horse_number: x.horse_number, waku_number: x.waku_number, horse_name: x.horse_name });
    if (!s) return `<tr><td class="pace-time-horse">${horse}</td><td>—</td><td colspan="4" class="pace-none">騎手未定</td></tr>`;
    return `
      <tr>
        <td class="pace-time-horse">${horse}</td>
        <td>${escapeHtml(x.jockey || "")}</td>
        <td>${s.rides}</td>
        <td>${s.first}-${s.second}-${s.third}-${s.other}</td>
        <td>${s.rides ? pacePct(s.winRate) : "—"}</td>
        <td>${s.rides ? pacePct(s.showRate) : "—"}</td>
      </tr>`;
  }).join("");
  return `${heading}
    <div class="table-wrap">
      <table class="horse-history-table pace-time-table pace-jockey-table">
        <thead><tr>${sortTh("number", "馬")}<th>騎手</th>${sortTh("rides", "騎乗")}<th>着度数</th>${sortTh("win", "単勝率")}${sortTh("show", "複勝率")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ④ 推奨馬(2026-10-12追加。タブの先頭)。上の①〜③と同じデータから作る(追加の通信なし)。基準はユーザー確認済み:
//   - ペース予想: 前走の脚質で、逃げ2頭以上 または 逃げ+先行が頭数の半分以上 → ハイ、
//     逃げ0〜1頭 かつ 逃げ+先行が頭数の1/4以下 → スロー、それ以外 → ミドル(脚質「不明」の馬は数えない。頭数は全出走馬)
//   - 展開が有利な馬: ハイは同場・同距離の持ちタイム順、スローは同場・同距離の最速上がり3F順、
//     ミドルは「持ちタイムの順位+上がり3Fの順位」の小さい順(両方ある馬だけ)
//   - 有利な馬番: 同コースの馬番別の複勝率順(同じなら単勝率→騎乗の多い順)。今回いる馬番だけ
//   - 騎手: 同コースの複勝率順(同じなら単勝率→騎乗の多い順)。騎乗5回未満は除く
const PACE_TOP_N = 5;
const PACE_MIN_JOCKEY_RIDES = 5;

function pacePredictionOf(entries) {
  let nige = 0, senko = 0, unknown = 0;
  for (const e of entries) {
    const st = paceStyleOf(paceLastRun(horseHistory[normalizeHorseName(e.horse_name)]));
    if (!st) unknown++;
    else if (st.style === "逃げ") nige++;
    else if (st.style === "先行") senko++;
  }
  const n = entries.length;
  const front = nige + senko;
  const pace = nige >= 2 || front >= n / 2 ? "high" : nige <= 1 && front <= n / 4 ? "slow" : "middle";
  return { pace, nige, senko, unknown, n };
}

// 値の小さい順に並べ、同じ値は同じ順位にする(1, 2, 2, 4 …)。
function paceRanked(list, valueOf) {
  const sorted = [...list].sort((a, b) => valueOf(a) - valueOf(b));
  let rank = 0;
  return sorted.map((x, i) => {
    if (i === 0 || valueOf(x) !== valueOf(sorted[i - 1])) rank = i + 1;
    return { ...x, rank };
  });
}

function paceTopListHtml(items, emptyText) {
  if (!items.length) return `<p class="pace-none">${escapeHtml(emptyText)}</p>`;
  return `<ol class="pace-top-list">${items.map(x => `
    <li><span class="pace-top-rank">${x.rank}</span>${x.labelHtml}<span class="pace-top-value">${x.valueHtml}</span></li>`).join("")}</ol>`;
}

function paceRecommendPaceHtml(entries) {
  const p = pacePredictionOf(entries);
  const label = { high: "ハイペース", slow: "スローペース", middle: "ミドルペース" }[p.pace];
  const basis = { high: "持ちタイム順", slow: "上がり3F順", middle: "持ちタイムと上がり3Fの順位の合計順" }[p.pace];
  const reason = `逃げ${p.nige}頭・先行${p.senko}頭(${p.n}頭中${p.unknown ? `、脚質不明${p.unknown}頭` : ""})`;
  const head = `<div class="pace-reco-block"><h4>展開が有利な馬<span class="pace-reco-pace pace-reco-${p.pace}">${label}予想</span></h4>
    <p class="pace-reco-note">${escapeHtml(reason)} → ${escapeHtml(basis)}(同場・同距離の最速)</p>`;
  const st = horseBest && horseBest.raceId === selectedRace.id ? horseBest : null;
  if (!st || st.status === "loading") return `${head}<p class="pace-none">読み込み中…</p></div>`;
  if (st.status === "error" || !st.data || !st.data.condition) return `${head}<p class="pace-none">持ちタイムを取得できませんでした</p></div>`;

  const rows = entries.map(e => {
    const slot = (st.data.horses || {})[normalizeHorseName(e.horse_name)]?.track || {};
    return { e, time: slot.time || null, l3: slot.last3f || null };
  });
  let ranked;
  if (p.pace === "high") {
    ranked = paceRanked(rows.filter(x => x.time), x => x.time.seconds);
  } else if (p.pace === "slow") {
    ranked = paceRanked(rows.filter(x => x.l3), x => x.l3.last3f);
  } else {
    const both = rows.filter(x => x.time && x.l3);
    const tRank = new Map(paceRanked(both, x => x.time.seconds).map(x => [x.e, x.rank]));
    const lRank = new Map(paceRanked(both, x => x.l3.last3f).map(x => [x.e, x.rank]));
    ranked = paceRanked(both.map(x => ({ ...x, sum: tRank.get(x.e) + lRank.get(x.e) })), x => x.sum);
  }
  const items = ranked.slice(0, PACE_TOP_N).map(x => ({
    rank: x.rank,
    labelHtml: paceHorseLabelHtml(x.e),
    valueHtml: [
      p.pace !== "slow" ? escapeHtml(x.time.time_text) : null,
      p.pace !== "high" ? `上${Number(x.l3.last3f).toFixed(1)}` : null,
    ].filter(Boolean).join(" "),
  }));
  return `${head}${paceTopListHtml(items, "同場・同距離を走ったことのある馬がいません")}</div>`;
}

// 馬番別・騎手の推奨は騎手成績のAPI(jockeyCourse)を使う。取得中・停止中・失敗は同じ案内を出す。
function paceJockeyCourseState() {
  const st = jockeyCourse && jockeyCourse.raceId === selectedRace.id ? jockeyCourse : null;
  if (!st || st.status === "loading") return { message: "読み込み中…" };
  if (st.status === "paused") return { message: "D1の使用量が多いため一時停止中です" };
  if (st.status === "error" || !st.data) return { message: "取得に失敗しました" };
  if (!st.data.condition) return { message: "このレースのコース・距離が未登録のため出せません" };
  return { data: st.data };
}

const paceByShowRate = (a, b) => b.stats.showRate - a.stats.showRate || b.stats.winRate - a.stats.winRate || b.stats.rides - a.stats.rides;
// 複勝率・単勝率がともに同じなら同順位
function paceRateRanked(list) {
  const sorted = [...list].sort(paceByShowRate);
  let rank = 0;
  return sorted.map((x, i) => {
    const prev = sorted[i - 1];
    if (i === 0 || x.stats.showRate !== prev.stats.showRate || x.stats.winRate !== prev.stats.winRate) rank = i + 1;
    return { ...x, rank };
  });
}
const paceRatesHtml = (s) => `複${pacePct(s.showRate)} 単${pacePct(s.winRate)}<small>(${s.rides}騎乗)</small>`;

function paceRecommendNumberHtml(entries) {
  const head = `<div class="pace-reco-block"><h4>有利な馬番</h4><p class="pace-reco-note">同コースの馬番別の複勝率順(取り込み済み全期間)</p>`;
  const { data, message } = paceJockeyCourseState();
  if (!data) return `${head}<p class="pace-none">${escapeHtml(message)}</p></div>`;
  const byNumber = new Map((data.horse_numbers || []).map(x => [Number(x.horse_number), x.stats]));
  const list = entries
    .filter(e => e.horse_number !== null && e.horse_number !== undefined)
    .map(e => ({ e, stats: byNumber.get(Number(e.horse_number)) }))
    .filter(x => x.stats && x.stats.rides > 0);
  const items = paceRateRanked(list).slice(0, PACE_TOP_N).map(x => ({
    rank: x.rank, labelHtml: paceHorseLabelHtml(x.e), valueHtml: paceRatesHtml(x.stats),
  }));
  const empty = entries.some(e => e.horse_number === null || e.horse_number === undefined)
    ? "馬番が確定していないため出せません"
    : "同コースの馬番別の記録がありません";
  return `${head}${paceTopListHtml(items, empty)}</div>`;
}

function paceRecommendJockeyHtml() {
  const head = `<div class="pace-reco-block"><h4>騎手</h4><p class="pace-reco-note">同コースの複勝率順(騎乗${PACE_MIN_JOCKEY_RIDES}回以上)</p>`;
  const { data, message } = paceJockeyCourseState();
  if (!data) return `${head}<p class="pace-none">${escapeHtml(message)}</p></div>`;
  const list = (data.jockeys || []).filter(x => x.stats && x.stats.rides >= PACE_MIN_JOCKEY_RIDES);
  const items = paceRateRanked(list).slice(0, PACE_TOP_N).map(x => ({
    rank: x.rank,
    labelHtml: `${paceHorseLabelHtml({ horse_number: x.horse_number, waku_number: x.waku_number, horse_name: x.horse_name })}<span class="pace-top-jockey">${escapeHtml(x.jockey || "")}</span>`,
    valueHtml: paceRatesHtml(x.stats),
  }));
  return `${head}${paceTopListHtml(items, `同コースで騎乗${PACE_MIN_JOCKEY_RIDES}回以上の騎手がいません`)}</div>`;
}

function paceRecommendSectionHtml(entries) {
  return `
    <h3 class="pace-heading">推奨馬<small>下の脚質・持ちタイム・騎手成績から機械的に出した参考です</small></h3>
    <div class="pace-reco">
      ${paceRecommendPaceHtml(entries)}
      ${paceRecommendNumberHtml(entries)}
      ${paceRecommendJockeyHtml()}
    </div>`;
}

// ⑤ 補正タイム順位(2026-10-12追加。docs/design/data-search.md「競馬場傾向タブ」): 全場・同距離の走を、競馬場と馬場の
//    補正値で「今回の競馬場・良馬場」に換算したタイム(horse-best の corrected)の速い順。補正値の元はデータ検索「競馬場傾向」。
function paceCorrectedSectionHtml(entries) {
  const course = formatCourseText(selectedRace.course_type, selectedRace.distance);
  const heading = `<h3 class="pace-heading">補正タイム順位(全場・${escapeHtml(course || "同距離")})<small>競馬場と馬場による時計の差を補正し、${escapeHtml(selectedRace.track || "今回の競馬場")}・良馬場で走った場合に換算した最速タイム。補正値はデータ検索「競馬場傾向」の勝ちタイムの平均から。※は補正値が出せない部分を0として計算</small></h3>`;
  const st = horseBest && horseBest.raceId === selectedRace.id ? horseBest : null;
  if (!st || st.status === "loading") return `${heading}<p class="pace-none">読み込み中…</p>`;
  if (st.status === "error" || !st.data) return `${heading}<p class="pace-none">取得に失敗しました</p>`;
  if (!st.data.condition || !selectedRace.track) return `${heading}<p class="pace-none">このレースの競馬場・コース・距離が未登録のため出せません</p>`;

  const ranked = [];
  const none = [];
  for (const e of entries) {
    const c = (st.data.horses || {})[normalizeHorseName(e.horse_name)]?.corrected;
    if (c) ranked.push({ e, c });
    else none.push(e);
  }
  const sorted = paceRanked(ranked, x => x.c.corrected_seconds);
  const top = sorted.length ? sorted[0].c.corrected_seconds : 0;
  const secText = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m ? `${m}:${s.toFixed(1).padStart(4, "0")}` : s.toFixed(1);
  };
  const adjText = (a) => (Math.abs(a) < 0.005 ? "±0.0" : `${a > 0 ? "+" : "−"}${Math.abs(a).toFixed(1)}`);
  const rows = sorted.map((x, i) => `
      <tr>
        <td>${x.rank}</td>
        <td class="pace-time-horse">${paceHorseLabelHtml(x.e)}</td>
        <td><strong>${secText(x.c.corrected_seconds)}</strong>${x.c.partial ? "※" : ""}</td>
        <td>${i === 0 ? "—" : `+${(x.c.corrected_seconds - top).toFixed(1)}`}</td>
        <td>${escapeHtml(x.c.time_text)}</td>
        <td>${escapeHtml(x.c.track || "—")}</td>
        <td>${escapeHtml(x.c.track_condition || "—")}</td>
        <td>${adjText(x.c.adj)}</td>
        <td>${x.c.run_last3f != null ? Number(x.c.run_last3f).toFixed(1) : "—"}</td>
        <td>${x.c.weight_carried != null ? Number(x.c.weight_carried).toFixed(1) : "—"}</td>
        <td>${escapeHtml(x.c.jockey || "—")}</td>
        <td title="${escapeAttr(x.c.race_name || "")}">${escapeHtml([formatDateMd(x.c.race_date), x.c.finish_position != null ? `${x.c.finish_position}着` : null].filter(Boolean).join(" "))}</td>
      </tr>`).join("");
  none.sort((a, b) => paceNumberOf(a) - paceNumberOf(b));
  return `${heading}
    ${sorted.length ? `
      <div class="table-wrap">
        <table class="horse-history-table pace-time-table">
          <thead><tr><th>順位</th><th>馬</th><th>補正タイム</th><th>差</th><th>元のタイム</th><th>競馬場</th><th>馬場</th><th>補正</th><th>上がり3F</th><th>斤量</th><th>騎手</th><th>その走</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<p class="pace-none">この距離を走ったことのある馬はいません</p>`}
    ${none.length ? `<p class="pace-time-none"><span>走なし</span>${none.map(e => `<span class="pace-chip">${paceHorseLabelHtml(e)}</span>`).join("")}</p>` : ""}`;
}

function renderPace() {
  if (!paceEl || !selectedRace) return;
  const entries = paceEntries();
  if (!entries.length) {
    paceEl.innerHTML = `<p class="prediction-no-entries">出走馬が登録されていません。</p>`;
    return;
  }
  paceEl.innerHTML = paceRecommendSectionHtml(entries) + paceStyleSectionHtml(entries) + paceCorrectedSectionHtml(entries) + paceJockeySectionHtml();
  paceEl.querySelectorAll(".pace-sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      paceJockeySort = btn.dataset.sort;
      renderPace();
    });
  });
  // 展開・時計タブを表示中なら騎手成績を取得する(取得済み・別タブ表示中なら何もしない)。
  ensureJockeyCourse();
}

// ---------- 馬メモダイアログ(2026-09-25。以前は馬名の展開パネル内のtextarea) ----------
// 入力変更後に自動保存する(短時間の連続入力はデバウンス)。閉じる時は保留中の保存を
// 即時に実行する。メモは馬名キー(全レース共通)なので、ダイアログは開いた馬の名前だけを持つ。
const horseMemoModal = document.getElementById("horse-memo-modal");
const horseMemoTitle = document.getElementById("horse-memo-title");
const horseMemoText = document.getElementById("horse-memo-text");
const horseMemoStatus = document.getElementById("horse-memo-status");
let memoEditingName = null;
let memoSaveTimer = null;

function openHorseMemo(card) {
  const name = normalizeHorseName(card.dataset.horseName);
  if (!name) return;
  memoEditingName = name;
  horseMemoTitle.textContent = `${name} のメモ`;
  horseMemoText.value = horseNotes[name]?.memo || "";
  horseMemoStatus.hidden = true;
  // 自動フォーカスはしない(スマホで開いた瞬間にキーボードが出て画面が動く・拡大されるのを
  // 避ける。入力したい時に入力欄をタップする)。
  horseMemoModal.hidden = false;
}

function closeHorseMemo() {
  if (memoSaveTimer) {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = null;
    saveHorseNote(memoEditingName, horseMemoText.value);
  }
  horseMemoModal.hidden = true;
}

horseMemoText.addEventListener("input", () => {
  clearTimeout(memoSaveTimer);
  const name = memoEditingName;
  const text = horseMemoText.value;
  memoSaveTimer = setTimeout(() => {
    memoSaveTimer = null;
    saveHorseNote(name, text);
  }, 500);
});
document.getElementById("horse-memo-close-btn").addEventListener("click", closeHorseMemo);
horseMemoModal.addEventListener("click", (e) => { if (e.target === horseMemoModal) closeHorseMemo(); });
registerEscToClose(horseMemoModal, closeHorseMemo);

async function saveHorseNote(name, memoRaw) {
  if (!name) return;
  const memo = String(memoRaw ?? "").trim();
  const res = await authedFetch("/api/horse-notes", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ horse_name: name, memo })
  });
  if (res.ok) {
    horseNotes[name] = { memo };
    updateMemoButtons(name);
  }
  if (memoEditingName === name && !horseMemoModal.hidden) {
    horseMemoStatus.hidden = false;
    horseMemoStatus.textContent = res.ok ? "自動保存済み" : "保存に失敗しました";
    horseMemoStatus.className = `horse-note-status ${res.ok ? "success" : "error"}`;
  }
}

// ---- 重賞メモ(2026-10-12追加。docs/design/graded-race-search.md「重賞メモ」) ----
// 重賞のレースのとき、ヘッダーの「重賞メモ」ボタンからダイアログを開く。重賞1つ×年ごとのメモで、
// このレースの年のメモを編集し、ほかの年のメモを下に表示する(入力欄は graded-race-notes.js)。
// gradedNotes は表示中の重賞のメモ一覧。別の重賞へ切り替えた直後に前の重賞の有無で
// ボタンを強調しないよう、重賞の id と組で持つ。
let gradedNotes = { gradedRaceId: null, notes: [] };
let gradedNotesView = null;
const gradedMemoModal = document.getElementById("graded-memo-modal");

function gradedNotesHaveMemo() {
  const g = selectedRace?.graded;
  return Boolean(g && gradedNotes.gradedRaceId === g.id && gradedNotes.notes.length);
}

function updateGradedMemoButton() {
  const btn = document.getElementById("graded-memo-btn");
  if (btn) btn.classList.toggle("has-memo", gradedNotesHaveMemo());
}

async function loadGradedNotes() {
  const g = selectedRace?.graded;
  if (!g) return;
  try {
    const notes = await fetchGradedRaceNotes(g.id);
    if (selectedRace?.graded?.id !== g.id) return;
    gradedNotes = { gradedRaceId: g.id, notes };
    updateGradedMemoButton();
  } catch {
    // 取得に失敗してもボタンは使える(ダイアログを開いたときに取り直す)。
  }
}

function openGradedMemo() {
  const g = selectedRace?.graded;
  if (!g) return;
  document.getElementById("graded-memo-title").textContent = `${g.name} のメモ`;
  gradedNotesView = mountGradedRaceNotes(document.getElementById("graded-memo-body"), {
    gradedRaceId: g.id,
    year: Number(String(selectedRace.race_date || "").slice(0, 4)) || new Date().getFullYear(),
    notes: gradedNotes.gradedRaceId === g.id ? gradedNotes.notes : undefined,
    onChange(notes) {
      gradedNotes = { gradedRaceId: g.id, notes };
      updateGradedMemoButton();
    },
  });
  gradedMemoModal.hidden = false;
}

function closeGradedMemo() {
  if (gradedNotesView) {
    gradedNotesView.dispose();
    gradedNotesView = null;
  }
  gradedMemoModal.hidden = true;
}

document.getElementById("graded-memo-close-btn").addEventListener("click", closeGradedMemo);
gradedMemoModal.addEventListener("click", (e) => { if (e.target === gradedMemoModal) closeGradedMemo(); });
registerEscToClose(gradedMemoModal, closeGradedMemo);

// 「メモ」ボタンの見た目(メモ登録済みの強調)を、その馬名のメモの有無に合わせる。
// nameを省略すると全馬を更新する。
function updateMemoButtons(name) {
  horsesEl.querySelectorAll(".horse-note-card").forEach(card => {
    const cardName = normalizeHorseName(card.dataset.horseName);
    if (name && cardName !== name) return;
    const btn = card.querySelector(".horse-memo-btn");
    if (!btn || btn.disabled) return;
    const has = Boolean(horseNotes[cardName]?.memo);
    btn.classList.toggle("has-memo", has);
    btn.title = has ? "この馬のメモがあります" : "この馬のメモを入力";
  });
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
  // 馬柱タブの印セレクト(2026-10-03追加)も同じ印で揃える。
  if (umabashiraEl) {
    umabashiraEl.querySelectorAll(".ub-mark-select").forEach(select => {
      if (!select.dataset.horseNumber) return;
      select.value = map.get(Number(select.dataset.horseNumber)) || "";
    });
  }
}

// 馬メモ(horseNotes)の取得はrenderHorses()より後に完了するため、renderHorses()内で
// 組み立てる「メモ」ボタンは常に「メモ未取得」の状態で描画される
// (2026-08-24。以前の「▼」マークで起きていた同じ問題)。取得完了後のこのタイミングで
// ボタンの「メモあり」の強調を反映する。
function applyHorseNotes() {
  updateMemoButtons();
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

// 過去成績（出走履歴）を各馬の展開パネルへ流し込む。horseHistory の
// 取得は renderHorses() より後に完了するため、applyHorseNotes() と同じくこのタイミングで
// 描画する。0走の馬はセクションごと非表示のまま（従来どおりメモのみ）。
function applyHorseHistory() {
  horsesEl.querySelectorAll(".horse-note-card").forEach(card => {
    const box = card.querySelector(".horse-history");
    if (!box) return;
    const name = normalizeHorseName(card.dataset.horseName);
    const rows = horseHistory[name] || [];
    // 展開パネルは過去成績だけなので、0走の馬も空のパネルにならないよう案内を出す。
    box.innerHTML = rows.length ? renderHorseHistory(rows) : `<p class="horse-history-empty">過去成績はありません</p>`;
  });
  // 馬柱タブ(2026-10-03追加)も過去走が揃ったので描き直す。
  renderUmabashira();
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
    const agari = (r.final_furlong_time !== null && r.final_furlong_time !== undefined && !Number.isNaN(Number(r.final_furlong_time)))
      ? Number(r.final_furlong_time).toFixed(1)
      : "—";
    return `
      <tr title="${escapeAttr(r.race_name || "")}">
        <td>${escapeHtml(formatDateMdW(r.race_date))}</td>
        <td>${escapeHtml(`${r.track || ""}${r.race_number ? `${r.race_number}R` : ""}`)}</td>
        <td>${escapeHtml(r.race_name || "—")}</td>
        <td>${escapeHtml(course)}</td>
        <td class="hh-place">${escapeHtml(historyPlaceText(r))}</td>
        <td>${escapeHtml(pop)}</td>
        <td>${escapeHtml(r.jockey || "—")}</td>
        <td>${escapeHtml(kinryo)}</td>
        <td>${escapeHtml(bw)}</td>
        <td>${escapeHtml(r.time_text || "—")}</td>
        <td>${escapeHtml(r.corner_positions || "—")}</td>
        <td>${escapeHtml(agari)}</td>
        <td>${escapeHtml(r.margin || "—")}</td>
      </tr>`;
  }).join("");
  return `
    <div class="horse-history-scroll">
      <table class="horse-history-table">
        <thead>
          <tr><th>日付</th><th>場</th><th>レース名</th><th>コース</th><th>着順</th><th>人気</th><th>騎手</th><th>斤量</th><th>馬体重</th><th>タイム</th><th>通過</th><th>上がり</th><th>着差</th></tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function normalizeHorseName(str) { return String(str ?? "").replace(/[\u3000\s]+/g, " ").trim(); }

// escapeHtml / escapeAttr / formatDate は utils.js のものを使用する
// (2026-09-07: ローカルの formatDate 定義を撤去。utils.js に統合し全画面で
//  「2026/08/24(日)」表記に統一した)

setupPredictionViewTabs();
setupAuth(loadRaces);
