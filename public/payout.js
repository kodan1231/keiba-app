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

function ticketMatchesCombo(ticket, combo) {
  if (!combo) return false;
  const def = BET_TYPES[ticket.bet_type];
  if (ticket.bet_type === "wakuren") {
    const w = ticket.selections.map((s) => s.waku_number).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    return JSON.stringify(w) === JSON.stringify(combo);
  }
  const nums = ticket.selections.map((s) => s.horse_number);
  const target = def.ordered ? nums : [...nums].sort((a, b) => a - b);
  return JSON.stringify(target) === JSON.stringify(combo);
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
  if (!race || !race.finish_order || !race.payouts || !race.payouts[ticket.bet_type]) return null;
  const combos = computeWinningCombos(ticket.bet_type, race.finish_order, race.entries);
  for (const c of combos) {
    const rate = findStoredRate(race.payouts, ticket.bet_type, c.combo);
    if (rate !== null && ticketMatchesCombo(ticket, c.combo)) {
      return Math.round((ticket.amount / 100) * rate);
    }
  }
  // どの的中組み合わせにも一致しなかったが、その式別に何らかのレートが入力済み = 不的中確定
  return 0;
}
