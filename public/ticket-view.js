// 購入馬券グループ表示の共通部品。
//
// 2026-09-08新設: 購入履歴画面(app.js の renderGroupRow)と予想登録画面
// (prediction.js の renderPurchasedTickets)は、どちらも「tickets を group_id 単位で
// まとめ、`.group-card > .group-card-head` + `.group-detail` で開閉表示する」同型の
// UIを持つ。ただし編集可否・削除ボタン・ステータスバッジ・買い目の馬名表示有無等の
// 機能セットが異なるため、レンダラ本体とDOMイベント配線は各ファイルに残し、差分の
// 無い純粋関数だけをここへ集約する。
//
// ESモジュール不使用のグローバルスクリプト構成のため、各HTMLで app.js /
// prediction.js より前、かつ utils.js(formatYen/escapeHtml)・bettypes.js(BET_TYPES)
// より後に読み込む。読み込むのは history.html と prediction.html のみ。

// tickets を group_id 単位でまとめる。返り値は「同一グループの ticket 配列」の配列で、
// 各グループが最初に出現した順を保持する。
function groupTicketsByGroupId(tickets) {
  const map = new Map();
  for (const t of tickets) {
    if (!map.has(t.group_id)) map.set(t.group_id, []);
    map.get(t.group_id).push(t);
  }
  return Array.from(map.values());
}

// 購入額の合計。amount が数値でない場合は 0 扱い。
function sumTicketAmount(tickets) {
  return tickets.reduce((s, t) => s + Number(t.amount || 0), 0);
}

// 払戻が確定している(payout が null/undefined でない)ticket の払戻合計。
function sumSettledPayout(tickets) {
  return tickets
    .filter((t) => t.payout !== null && t.payout !== undefined)
    .reduce((s, t) => s + Number(t.payout || 0), 0);
}

// `<span class="group-money">` の中身になる「購入¥… / 払戻¥…」表示文字列。
// 払戻が1件も確定していなければ購入額のみを返す。
function ticketMoneyText(tickets) {
  const amount = sumTicketAmount(tickets);
  const hasSettled = tickets.some((t) => t.payout !== null && t.payout !== undefined);
  return `購入${formatYen(amount)}${hasSettled ? ` / 払戻${formatYen(sumSettledPayout(tickets))}` : ""}`;
}

// グループの確定状況ラベル。全点確定=「確定済み」、一部のみ=「一部確定」、0点=「未確定」。
function ticketGroupStatus(group) {
  const settled = group.filter((t) => t.payout !== null && t.payout !== undefined).length;
  if (settled === group.length) return "確定済み";
  if (settled > 0) return "一部確定";
  return "未確定";
}

// 買い目セル(`.sel-line` の中身)。馬番+馬名を `.sel-item` で並べ、券種が着順あり
// (馬単・三連単)なら「→」、着順なしなら「-」で連結する。未知/不正な bet_type
// (壊れたインポートデータ等)でも描画がクラッシュしないよう ordered=false にフォールバックする。
function selectionCellHtml(betType, selections) {
  const def = BET_TYPES[betType] || { ordered: false };
  return (selections || [])
    .map((s) => `<span class="sel-item"><span class="sel-num">${s.horse_number}</span>${escapeHtml(s.horse_name || "")}</span>`)
    .join(def.ordered ? '<span class="sel-arrow">→</span>' : '<span class="sel-dash">-</span>');
}
