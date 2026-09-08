// 払戻確定時の全ユーザーの購入馬券への反映(recomputeTicketPayoutsForRace(s))。
// 2026-09-01: functions/api/_shared.js から分割(リファクタリング。詳細は_lib/auth.js冒頭の注記参照)。
//
// races.finish_order / races.payouts が確定した際、そのレースに紐づく
// 「全ユーザーの」購入馬券を再計算して反映する。races は共有データ、購入馬券は
// ユーザーごとに分離されたデータであるため、user_idで絞り込まず race_id単位で対象にする。
//
// 対象テーブル:
//   - tickets              … 通常購入(payout・refunded を更新)
//   - imported_ticket_items … CSV取込分(payout・is_hit を更新。2026-09-08追加)。
//     ただし CSV は「既に決着済み」の購入履歴のため、レース結果から的中が確認できない
//     場合に既存の正の payout を 0 へ落とすことはしない(0→確定 と 増額方向のみ更新)。
//
// (ロジックは public/payout.js の computeWinningCombos 等をサーバー側へ移植したもの。
//  クライアント側と実装がずれないよう、変更する際は両方を確認すること)
//
// 呼び出し元(2026-09-08時点):
//   - functions/api/races/[id].js (レース管理画面の払戻編集モーダルからの保存。単一レース版)
//   - functions/api/races/results-import.js (JRAレース結果PDF一括登録。複数レース一括版を使う)
//   - functions/api/races/entries-import.js (出走馬一覧PDFインポート。保険として呼び出す。
//     木・金の出走馬インポート時点では通常finish_order/payoutsが存在しないため実質
//     何もしないが、木金を省略して結果PDFが先に取り込まれるイレギュラーな運用への備え。
//     単一レース版を使う)
//   - functions/api/tickets/bulk.js (通常購入。対象レースが既に着順・払戻確定済みの場合、
//     保存時点で payout が未確定のまま残る不具合の対策。チケットINSERT直後に呼び出す。
//     単一レース版を使う)
// 新しく finish_order / payouts を更新する処理を追加する場合は、必ずここも呼ぶこと。

const ORDERED_BET_TYPES = new Set(["umatan", "sanrentan"]);

function computeWinningCombos(betType, finishOrder, entries) {
  if (!finishOrder || finishOrder.length === 0) return [];
  const wakuOf = (h) => {
    const e = (entries || []).find((x) => x.horse_number === h);
    return e ? e.waku_number : null;
  };
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const top = (n) => finishOrder.slice(0, n);

  if (betType === "tan") return [{ combo: [top(1)[0]] }];
  if (betType === "fuku") return top(3).map((h) => ({ combo: [h] }));
  if (betType === "umaren") { const t = top(2); return [{ combo: sorted(t) }]; }
  if (betType === "wide") {
    const t3 = top(3);
    return [[t3[0], t3[1]], [t3[0], t3[2]], [t3[1], t3[2]]].map((p) => ({ combo: sorted(p) }));
  }
  if (betType === "umatan") { const t = top(2); return [{ combo: t }]; }
  if (betType === "sanrenpuku") { const t = top(3); return [{ combo: sorted(t) }]; }
  if (betType === "sanrentan") { const t = top(3); return [{ combo: t }]; }
  if (betType === "wakuren") {
    const t = top(2);
    const w = [wakuOf(t[0]), wakuOf(t[1])];
    if (w.some((x) => x === null || x === undefined)) return [{ combo: null }];
    return [{ combo: sorted(w) }];
  }
  return [];
}

function ticketMatchesComboServer(betType, selections, combo) {
  if (!combo) return false;
  if (betType === "wakuren") {
    const w = selections
      .map((s) => s.waku_number)
      .filter((x) => x !== null && x !== undefined)
      .sort((a, b) => a - b);
    return JSON.stringify(w) === JSON.stringify(combo);
  }
  const nums = selections.map((s) => s.horse_number);
  const target = ORDERED_BET_TYPES.has(betType) ? nums : [...nums].sort((a, b) => a - b);
  return JSON.stringify(target) === JSON.stringify(combo);
}

function findStoredRateServer(payouts, betType, combo) {
  if (!payouts || !payouts[betType] || !combo) return null;
  const found = payouts[betType].find((p) => JSON.stringify(p.combo) === JSON.stringify(combo));
  return found ? found.rate : null;
}

// ---- 返還(refund)判定 ----
// races.payouts.refunds (jraResultParseRefund()が抽出した「返還馬番」「返還同枠」の情報。
// [{horse_numbers:[...], waku_numbers:[...]}, ...]) と、1枚の購入(selections)を突き合わせ、
// この買い目が返還対象かどうかを判定する。
//
// - 馬番ベースの式別(単勝・複勝・馬連・馬単・ワイド・三連複・三連単): 買い目の馬番の
//   いずれか1つでも返還馬番に含まれていれば返還(1点の買い目に複数頭が含まれる式別では、
//   そのうち1頭でも返還対象なら買い目全体が返還になる、というJRAの実際の運用に合わせる)
// - 枠番ベースの式別(枠連): 買い目の枠番のいずれか1つでも返還同枠に含まれていれば返還
//   (個別の返還馬番だけでは枠連の返還は判定しない。枠内に出走馬が1頭でも残っていれば、
//   その枠連自体は返還にならないため)
// - 「中止」(競走中止)は取消・除外と異なり発走しているため refunds には一切含まれない。
//   そのためこの関数は中止馬についてはfalseを返し、呼び出し元では通常の的中判定へ進む。
//
// 詳細はdocs/design/payout-refund.md「返還(refund)処理」参照。
function isTicketRefunded(betType, selections, refunds) {
  if (!Array.isArray(refunds) || !refunds.length || !Array.isArray(selections) || !selections.length) return false;
  if (betType === "wakuren") {
    const refundWakus = new Set();
    for (const r of refunds) for (const w of (r?.waku_numbers || [])) refundWakus.add(w);
    if (!refundWakus.size) return false;
    return selections.some((s) => refundWakus.has(s.waku_number));
  }
  const refundHorses = new Set();
  for (const r of refunds) for (const h of (r?.horse_numbers || [])) refundHorses.add(h);
  if (!refundHorses.size) return false;
  return selections.some((s) => refundHorses.has(s.horse_number));
}

// ---- 1枚の買い目についての払戻計算(tickets / imported_ticket_items 共通) ----
// 返還判定は的中判定より先に行う。返還対象の買い目は、結果的に的中コンボと一致していても
// 返還として扱う(対象そのものが競走から除かれたため的中/不的中の判定が成立しない)。
// 戻り値:
//   payout === null … 判定不能(finish_order/payouts 未確定、または枠番未確定で
//                      的中組み合わせを算出できない)
//   payout === 0    … 不的中(確定)
//   payout  >  0    … 的中(確定)/ 返還(= amount と同額)
function computeSettledPayout(betType, selections, amount, finishOrder, payoutsObj, entries) {
  const refunds = (payoutsObj && Array.isArray(payoutsObj.refunds)) ? payoutsObj.refunds : [];
  if (refunds.length && isTicketRefunded(betType, selections, refunds)) {
    return { payout: Number(amount), refunded: 1 };
  }
  if (finishOrder && payoutsObj && payoutsObj[betType]) {
    const combos = computeWinningCombos(betType, finishOrder, entries);
    // 枠番未確定などで的中組み合わせ自体を算出できない場合は、「不的中」と断定せず
    // 判定不能(null)として扱う(0円へフォールバックすると的中している可能性がある
    // 馬券まで不的中扱いになってしまうため)。
    if (combos.some((c) => c.combo === null)) return { payout: null, refunded: 0 };
    let matchedRate = null;
    for (const c of combos) {
      const rate = findStoredRateServer(payoutsObj, betType, c.combo);
      if (rate !== null && ticketMatchesComboServer(betType, selections, c.combo)) {
        matchedRate = rate;
        break;
      }
    }
    return {
      payout: matchedRate !== null ? Math.round((Number(amount) / 100) * matchedRate) : 0,
      refunded: 0,
    };
  }
  return { payout: null, refunded: 0 };
}

function parseSelections(json) {
  try { return JSON.parse(json || "[]"); } catch { return []; }
}

// 1レース分の tickets / imported_ticket_items を再計算し、更新用 statement を statements へ push する。
function buildRecomputeStatements(db, rows, importedRows, finishOrder, payoutsObj, entries, statements) {
  for (const t of (rows || [])) {
    const { payout: newPayout, refunded: newRefunded } =
      computeSettledPayout(t.bet_type, parseSelections(t.selections), t.amount, finishOrder, payoutsObj, entries);
    const currentPayout = t.payout === undefined ? null : t.payout;
    if (newPayout !== currentPayout || newRefunded !== Number(t.refunded || 0)) {
      statements.push(db.prepare(`UPDATE tickets SET payout = ?, refunded = ? WHERE id = ?`).bind(newPayout, newRefunded, t.id));
    }
  }
  for (const it of (importedRows || [])) {
    const { payout: newPayout, refunded } =
      computeSettledPayout(it.bet_type, parseSelections(it.selections), it.amount, finishOrder, payoutsObj, entries);
    if (newPayout === null) continue; // 判定不能なら CSV 由来の値を維持
    const currentPayout = it.payout === undefined ? null : it.payout;
    // CSV は決着済みデータのため、レース結果から的中が確認できない場合でも既存の正の
    // payout を 0 に落とさない(CSV の方が実際の払戻を持っている可能性がある)。
    if (newPayout === 0 && Number(currentPayout || 0) > 0) continue;
    // 返還は「払戻あり」だが「的中」ではないため is_hit は立てない
    // (imported_ticket_items に refunded 列は無いので payout=amount のみで表現する)。
    const newIsHit = (!refunded && newPayout > 0) ? 1 : 0;
    if (newPayout !== currentPayout || newIsHit !== Number(it.is_hit || 0)) {
      statements.push(db.prepare(`UPDATE imported_ticket_items SET payout = ?, is_hit = ? WHERE id = ?`).bind(newPayout, newIsHit, it.id));
    }
  }
}

// レースの着順・払戻レートが確定/更新された際、そのレースに紐づく購入馬券の payout を
// 再計算して反映する(user_idで絞り込まない)。finishOrder / payoutsObj が無い場合は
// tickets.payout を null に戻す(imported_ticket_items は上記の理由で維持)。
export async function recomputeTicketPayoutsForRace(db, raceId, finishOrder, payoutsObj, entries) {
  if (!db || !raceId) return { updated: 0 };

  const [{ results: tks }, { results: items }] = await Promise.all([
    db.prepare(`SELECT id, bet_type, selections, amount, payout, refunded FROM tickets WHERE race_id = ?`).bind(raceId).all(),
    db.prepare(`SELECT id, bet_type, selections, amount, payout, is_hit FROM imported_ticket_items WHERE race_id = ?`).bind(raceId).all(),
  ]);
  if ((!tks || !tks.length) && (!items || !items.length)) return { updated: 0 };

  const statements = [];
  buildRecomputeStatements(db, tks, items, finishOrder, payoutsObj, entries, statements);
  if (statements.length) await db.batch(statements);
  return { updated: statements.length };
}

// ---- 複数レースをまとめて処理するバルク版 ----
// results-import.js(JRAレース結果PDF一括登録)が、12レース分などをまとめて処理する際に
// レースごとの逐次呼び出しによるサブリクエスト数超過を避けるために使う。
// updates: [{ raceId, finishOrder, payoutsObj, entries }, ...]
export async function recomputeTicketPayoutsForRaces(db, updates) {
  const targets = (updates || []).filter((u) => u && u.raceId);
  if (!db || !targets.length) return { updated: 0 };

  const raceIds = targets.map((u) => u.raceId);
  const placeholders = raceIds.map(() => "?").join(",");
  const [{ results: tks }, { results: items }] = await Promise.all([
    db.prepare(`SELECT id, race_id, bet_type, selections, amount, payout, refunded FROM tickets WHERE race_id IN (${placeholders})`).bind(...raceIds).all(),
    db.prepare(`SELECT id, race_id, bet_type, selections, amount, payout, is_hit FROM imported_ticket_items WHERE race_id IN (${placeholders})`).bind(...raceIds).all(),
  ]);
  if ((!tks || !tks.length) && (!items || !items.length)) return { updated: 0 };

  const ticketsByRace = new Map();
  for (const t of (tks || [])) {
    if (!ticketsByRace.has(t.race_id)) ticketsByRace.set(t.race_id, []);
    ticketsByRace.get(t.race_id).push(t);
  }
  const importedByRace = new Map();
  for (const it of (items || [])) {
    if (!importedByRace.has(it.race_id)) importedByRace.set(it.race_id, []);
    importedByRace.get(it.race_id).push(it);
  }

  const statements = [];
  for (const u of targets) {
    buildRecomputeStatements(
      db,
      ticketsByRace.get(u.raceId),
      importedByRace.get(u.raceId),
      u.finishOrder,
      u.payoutsObj,
      u.entries,
      statements
    );
  }

  if (statements.length) await db.batch(statements);
  return { updated: statements.length };
}
