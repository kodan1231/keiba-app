// 着順から、その馬券式で実際に的中する組み合わせを算出する。
// 複勝・ワイドは的中する組み合わせが複数(3つ)あるため、それぞれ返す。
function computeWinningCombos(betType, finishOrder, entries) {
  if (!finishOrder || finishOrder.length === 0) return [];
  const wakuOf = (h) => { const e = (entries || []).find((x) => x.horse_number === h); return e ? e.waku_number : null; };
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const top = (n) => finishOrder.slice(0, n);

  if (betType === "tan") return [{ label: `${top(1)[0]}番`, combo: [top(1)[0]] }];
  if (betType === "fuku") return top(3).map((h, i) => ({ label: `${h}番(${i + 1}着)`, combo: [h] }));
  if (betType === "umaren") { const t = top(2); return [{ label: sorted(t).join("-"), combo: sorted(t) }]; }
  if (betType === "wide") {
    const t3 = top(3);
    return [[t3[0], t3[1]], [t3[0], t3[2]], [t3[1], t3[2]]].map((p) => ({ label: sorted(p).join("-"), combo: sorted(p) }));
  }
  if (betType === "umatan") { const t = top(2); return [{ label: `${t[0]}→${t[1]}`, combo: t }]; }
  if (betType === "sanrenpuku") { const t = top(3); return [{ label: sorted(t).join("-"), combo: sorted(t) }]; }
  if (betType === "sanrentan") { const t = top(3); return [{ label: t.join("→"), combo: t }]; }
  if (betType === "wakuren") {
    const t = top(2);
    const w = [wakuOf(t[0]), wakuOf(t[1])];
    if (w.some((x) => x === null || x === undefined)) return [{ label: "枠情報が未登録です", combo: null }];
    return [{ label: `${sorted(w).join("-")}枠`, combo: sorted(w) }];
  }
  return [];
}

// レースに保存された払戻率(payouts)から、指定の組み合わせに対応するレート(100円あたり)を探す
function findStoredRate(payouts, betType, combo) {
  if (!payouts || !payouts[betType] || !combo) return null;
  const found = payouts[betType].find((p) => JSON.stringify(p.combo) === JSON.stringify(combo));
  return found ? found.rate : null;
}

// レースの確定情報(finish_order・payouts)から、1枚の購入(チケット)の払戻金額を計算する。
// 該当する式別のレートが1つも入力されていなければ null(未確定)を返す。
function computeTicketPayout(ticket, race) {
  // 2026-08-20追加: 取消・除外馬が絡む買い目として既にサーバー側(recomputeTicketPayoutsForRace)
  // で返還確定済みの場合は、購入金額(amount)の変更に追随して常に同額を返す。返還判定自体
  // (races.payouts.refundsとの突き合わせ)はサーバー側でのみ行い、この関数では確定済みの
  // ticket.refunded フラグを信頼するのみに留める(判定ロジックをクライアント側にも複製すると、
  // サーバー・クライアントの実装がズレるリスクが増えるため。docs/design/payout-refund.md「返還(refund)処理」参照)。
  if (ticket.refunded) return Number(ticket.amount);
  // 2026-10-27: 買った組み合わせを、払戻の表から直接探す(サーバーの _lib/ticket-payout.js と同じ)。以前は着順から当たりの組み合わせを
  // 作ってから探していたため、同着で組み合わせが増えると取りこぼした(10/26 大井11R の2着同着で、3連単 9-2-4・9-4-2 などが0円になった)
  const list = race && race.payouts ? race.payouts[ticket.bet_type] : null;
  if (!Array.isArray(list) || !list.length) return null;
  const def = BET_TYPES[ticket.bet_type] || { ordered: false };
  const vals = (ticket.selections || []).map((s) => (ticket.bet_type === "wakuren" ? s.waku_number : s.horse_number));
  // 枠番(waku_number)が未確定の出走馬が絡む枠連など、買い目の組み合わせ自体を作れない場合は、
  // 「不的中(0円)」と断定せず判定不能(null=未確定のまま)として扱う
  if (!vals.length || vals.some((v) => v === null || v === undefined)) return null;
  const key = def.ordered ? vals.map(Number) : vals.map(Number).sort((a, b) => a - b);
  const rate = findStoredRate(race.payouts, ticket.bet_type, key);
  // 払戻の表に無い = 不的中確定
  return rate !== null ? Math.round((ticket.amount / 100) * rate) : 0;
}
