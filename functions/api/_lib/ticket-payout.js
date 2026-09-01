// 払戻確定時の全ユーザーticket反映(recomputeTicketPayoutsForRace(s))。
// 2026-09-01: functions/api/_shared.js から分割(リファクタリング。詳細は_lib/auth.js冒頭の注記参照)。
//
// races.finish_order / races.payouts が確定した際、そのレースを購入した
// 全ユーザーの tickets.payout を再計算して反映する。races は共有データ、
// tickets はユーザーごとに分離されたデータであるため、user_idで絞り込まず
// race_id単位で全ユーザーのticketsを対象にする必要がある。
// (ロジックは public/payout.js の computeWinningCombos 等をサーバー側へ移植したもの。
//  クライアント側と実装がずれないよう、変更する際は両方を確認すること)
//
// 呼び出し元(2026-08-30時点):
//   - functions/api/races/[id].js (レース管理画面の払戻編集モーダルからの保存。単一レース版)
//   - functions/api/races/results-import.js (JRAレース結果PDF一括登録。複数レース一括版を使う)
//   - functions/api/races/entries-import.js (出走馬一覧PDFインポート。保険として呼び出す。
//     木・金の出走馬インポート時点では通常finish_order/payoutsが存在しないため実質
//     何もしないが、木金を省略して結果PDFが先に取り込まれるイレギュラーな運用への備え。
//     単一レース版を使う)
//   - functions/api/tickets/bulk.js (通常購入。過去に購入した馬券の履歴を残す目的の
//     購入操作であっても、対象レースが既に着順・払戻確定済みの場合、保存時点で
//     payoutが未確定のまま残ってしまう不具合があったため、チケットINSERT直後に呼び出す。
//     単一レース版を使う)
// 新しく finish_order / payouts を更新する処理を追加する場合は、必ずここも
// 呼び出すこと(呼び忘れると、購入済みの馬券のpayoutが更新されないまま
// 「未確定」表示が残ってしまう不具合になる)。

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
//   そのためこの関数は中止馬についてはfalseを返し、呼び出し元では通常の的中判定へ進む
//   (中止馬向けの分岐を別途設ける必要はない)
//
// 詳細はdocs/DESIGN.md「返還(refund)処理」参照。
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

// レースの着順・払戻レートが確定/更新された際、そのレースに紐づく
// 「全ユーザーの」tickets.payout を再計算して反映する(user_idで絞り込まない)。
// finishOrder / payoutsObj が無い(未確定に戻った)場合は payout を null に戻す。
//
// 返還判定は的中判定より先に行う。返還対象の買い目は、たとえ結果的に的中コンボと
// 一致していたとしても返還として扱う(取消・除外により対象そのものが競走から除かれた
// ことを意味するため、的中/不的中の判定自体が成立しない)。返還判定は payoutsObj.refunds
// の有無だけで行える(finish_order/該当bet_typeのレート登録の有無に関係なく判定できる)
// ため、既存の `finishOrder && payoutsObj && payoutsObj[t.bet_type]` という前提条件より
// 外側でチェックする。
export async function recomputeTicketPayoutsForRace(db, raceId, finishOrder, payoutsObj, entries) {
  if (!db || !raceId) return { updated: 0 };
  const { results } = await db
    .prepare(`SELECT id, bet_type, selections, amount, payout, refunded FROM tickets WHERE race_id = ?`)
    .bind(raceId)
    .all();
  if (!results || !results.length) return { updated: 0 };

  const refunds = (payoutsObj && Array.isArray(payoutsObj.refunds)) ? payoutsObj.refunds : [];

  const statements = [];
  for (const t of results) {
    let selections;
    try {
      selections = JSON.parse(t.selections || "[]");
    } catch {
      selections = [];
    }

    let newPayout = null;
    let newRefunded = 0;

    if (refunds.length && isTicketRefunded(t.bet_type, selections, refunds)) {
      newPayout = Number(t.amount);
      newRefunded = 1;
    } else if (finishOrder && payoutsObj && payoutsObj[t.bet_type]) {
      const combos = computeWinningCombos(t.bet_type, finishOrder, entries);
      // 枠番(waku_number)が未確定の出走馬が絡む枠連など、的中組み合わせ自体を
      // 算出できない(combo === null)ケースでは、「不的中(0円)」と断定せず
      // 判定不能(null=未確定のまま)として扱う(0円へフォールバックすると、
      // 実際には的中している可能性がある馬券まで不的中扱いになってしまうため)。
      if (combos.some((c) => c.combo === null)) {
        newPayout = null;
      } else {
        let matchedRate = null;
        for (const c of combos) {
          const rate = findStoredRateServer(payoutsObj, t.bet_type, c.combo);
          if (rate !== null && ticketMatchesComboServer(t.bet_type, selections, c.combo)) {
            matchedRate = rate;
            break;
          }
        }
        newPayout = matchedRate !== null ? Math.round((Number(t.amount) / 100) * matchedRate) : 0;
      }
    }
    const currentPayout = t.payout === undefined ? null : t.payout;
    const currentRefunded = Number(t.refunded || 0);
    if (newPayout !== currentPayout || newRefunded !== currentRefunded) {
      statements.push(db.prepare(`UPDATE tickets SET payout = ?, refunded = ? WHERE id = ?`).bind(newPayout, newRefunded, t.id));
    }
  }
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
  const { results } = await db
    .prepare(`SELECT id, race_id, bet_type, selections, amount, payout, refunded FROM tickets WHERE race_id IN (${placeholders})`)
    .bind(...raceIds)
    .all();
  if (!results || !results.length) return { updated: 0 };

  const ticketsByRace = new Map();
  for (const t of results) {
    if (!ticketsByRace.has(t.race_id)) ticketsByRace.set(t.race_id, []);
    ticketsByRace.get(t.race_id).push(t);
  }

  const statements = [];
  for (const u of targets) {
    const raceTickets = ticketsByRace.get(u.raceId);
    if (!raceTickets || !raceTickets.length) continue;
    const refunds = (u.payoutsObj && Array.isArray(u.payoutsObj.refunds)) ? u.payoutsObj.refunds : [];

    for (const t of raceTickets) {
      let selections;
      try {
        selections = JSON.parse(t.selections || "[]");
      } catch {
        selections = [];
      }

      let newPayout = null;
      let newRefunded = 0;

      if (refunds.length && isTicketRefunded(t.bet_type, selections, refunds)) {
        newPayout = Number(t.amount);
        newRefunded = 1;
      } else if (u.finishOrder && u.payoutsObj && u.payoutsObj[t.bet_type]) {
        const combos = computeWinningCombos(t.bet_type, u.finishOrder, u.entries);
        if (combos.some((c) => c.combo === null)) {
          newPayout = null;
        } else {
          let matchedRate = null;
          for (const c of combos) {
            const rate = findStoredRateServer(u.payoutsObj, t.bet_type, c.combo);
            if (rate !== null && ticketMatchesComboServer(t.bet_type, selections, c.combo)) {
              matchedRate = rate;
              break;
            }
          }
          newPayout = matchedRate !== null ? Math.round((Number(t.amount) / 100) * matchedRate) : 0;
        }
      }

      const currentPayout = t.payout === undefined ? null : t.payout;
      const currentRefunded = Number(t.refunded || 0);
      if (newPayout !== currentPayout || newRefunded !== currentRefunded) {
        statements.push(db.prepare(`UPDATE tickets SET payout = ?, refunded = ? WHERE id = ?`).bind(newPayout, newRefunded, t.id));
      }
    }
  }

  if (statements.length) await db.batch(statements);
  return { updated: statements.length };
}
