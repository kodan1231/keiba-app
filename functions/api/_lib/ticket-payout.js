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
// (ロジックは public/payout.js の computeTicketPayout と同じ。クライアント側と実装がずれないよう、変更する際は両方を確認すること。
//  2026-10-27〜 どちらも、買った組み合わせを払戻の表から直接探す〈同着で組み合わせが増えても取りこぼさない〉)
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

import { runBatchInChunks } from "./http.js";

const ORDERED_BET_TYPES = new Set(["umatan", "sanrentan"]);

// 買い目の組み合わせ(払戻の表の combo と同じ形)。馬単・3連単は買った順、それ以外は小さい順。枠連は枠番。作れなければ null
function ticketComboKeyServer(betType, selections) {
  if (!Array.isArray(selections) || !selections.length) return null;
  const vals = selections.map((s) => (betType === "wakuren" ? s?.waku_number : s?.horse_number));
  if (vals.some((v) => v === null || v === undefined || !Number.isFinite(Number(v)))) return null;
  const nums = vals.map(Number);
  return ORDERED_BET_TYPES.has(betType) ? nums : [...nums].sort((a, b) => a - b);
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

// 結果の取り込みで、各馬の結果が取消・除外の馬を払戻の返還の記録(payouts.refunds)に足す(2026-10-23)。
// netkeiba の結果の取り込み(地方)は返還の記録を作らず、10/23 浦和5R で除外の馬を含む7点が「外れ(0円)」で確定していた。
// 購入の後の除外も JRA・地方とも返還(中止は返還しない。今の決まりどおり)。枠連は、その枠の馬が全部取消・除外のときだけ返還の枠。
// payouts: 取り込んだ払戻(券種の金額が無ければそのまま返す)、raceResults: [{ horse_number, waku_number, status }]
// 戻り値: 新しい payouts(足すものが無ければ渡されたもの)
const REFUND_STATUSES = new Set(["scratched", "excluded"]);
export function addResultRefunds(payouts, raceResults) {
  if (!payouts || typeof payouts !== "object" || !Array.isArray(raceResults) || !raceResults.length) return payouts;
  if (!Object.keys(payouts).some((k) => k !== "refunds" && Array.isArray(payouts[k]) && payouts[k].length)) return payouts;
  const refundRows = raceResults.filter((r) => REFUND_STATUSES.has(r?.status) && Number.isInteger(Number(r.horse_number)) && r.horse_number !== null);
  if (!refundRows.length) return payouts;
  const existing = Array.isArray(payouts.refunds) ? payouts.refunds : [];
  const known = new Set(existing.flatMap((r) => r?.horse_numbers || []).map(Number));
  const horseNumbers = [...new Set(refundRows.map((r) => Number(r.horse_number)))].filter((n) => !known.has(n)).sort((a, b) => a - b);
  if (!horseNumbers.length) return payouts;
  const refundSet = new Set([...known, ...horseNumbers]);
  const knownWakus = new Set(existing.flatMap((r) => r?.waku_numbers || []).map(Number));
  const byWaku = new Map(); // 枠 -> [馬番]
  for (const r of raceResults) {
    const w = Number(r?.waku_number);
    if (!Number.isInteger(w) || w < 1) continue;
    if (!byWaku.has(w)) byWaku.set(w, []);
    byWaku.get(w).push(Number(r.horse_number));
  }
  const wakuNumbers = [...byWaku.entries()]
    .filter(([w, nums]) => !knownWakus.has(w) && nums.every((n) => refundSet.has(n)))
    .map(([w]) => w).sort((a, b) => a - b);
  return { ...payouts, refunds: [...existing, { horse_numbers: horseNumbers, waku_numbers: wakuNumbers }] };
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
  // レースの取りやめ(2026-10-23。payouts.race_cancelled。docs/design/payout-refund.md「レースの取りやめ」): 券種によらず全部返還
  if (payoutsObj && payoutsObj.race_cancelled === true) return { payout: Number(amount), refunded: 1 };
  const refunds = (payoutsObj && Array.isArray(payoutsObj.refunds)) ? payoutsObj.refunds : [];
  if (refunds.length && isTicketRefunded(betType, selections, refunds)) {
    return { payout: Number(amount), refunded: 1 };
  }
  // 2026-10-27: 買った組み合わせを、払戻の表(その券種の当たりの組み合わせと金額。公式の払戻そのもの)から直接探す。
  // 以前は着順(finish_order)から当たりの組み合わせを作ってから探していたが、同着で組み合わせが増えると取りこぼした
  // (10/26 大井11R は2着同着〈2番・4番〉で、読み取りの着順が [9,4,5] になり、ワイド2-4・3連複2-4-9・3連単9-2-4/9-4-2 が0円になった)。
  // 払戻の表は手入力(払戻モーダル)でも着順から作った当たりの組み合わせだけを持つので、どちらでも同じに判定できる
  if (payoutsObj && Array.isArray(payoutsObj[betType]) && payoutsObj[betType].length) {
    const key = ticketComboKeyServer(betType, selections);
    // 枠番未確定などで買い目の組み合わせ自体を作れない場合は、「不的中」と断定せず判定不能(null)にする
    if (!key) return { payout: null, refunded: 0 };
    const rate = findStoredRateServer(payoutsObj, betType, key);
    return { payout: rate !== null ? Math.round((Number(amount) / 100) * rate) : 0, refunded: 0 };
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
  if (statements.length) await runBatchInChunks(db, statements);
  return { updated: statements.length };
}

// ---- 複数レースをまとめて処理するバルク版 ----
// results-import.js(JRAレース結果PDF一括登録)が、12レース分などをまとめて処理する際に
// レースごとの逐次呼び出しによるサブリクエスト数超過を避けるために使う。
// updates: [{ raceId, finishOrder, payoutsObj, entries }, ...]
//
// raceIds の件数は、results-import.js呼び出し時は1ファイルぶん(~12件)で自然に
// バウンドされるが、tickets/bulk.js(馬券かご一括購入)呼び出し時は「1回のかご購入に
// 含まれるユニークレース数」に依存し、かご自体(localStorage)には件数上限が無いため
// D1の「1クエリ100バインドパラメータ」上限を超えうる。90件ずつチャンク分割して
// SELECTする(2026-09-19。graded_races一括インポートで同種の上限超過による登録失敗が
// 実際に発生したことを受けて横展開した)。
export async function recomputeTicketPayoutsForRaces(db, updates) {
  const targets = (updates || []).filter((u) => u && u.raceId);
  if (!db || !targets.length) return { updated: 0 };

  const raceIds = targets.map((u) => u.raceId);
  const tks = [];
  const items = [];
  for (let i = 0; i < raceIds.length; i += 90) {
    const idsChunk = raceIds.slice(i, i + 90);
    const placeholders = idsChunk.map(() => "?").join(",");
    const [{ results: tksChunk }, { results: itemsChunk }] = await Promise.all([
      db.prepare(`SELECT id, race_id, bet_type, selections, amount, payout, refunded FROM tickets WHERE race_id IN (${placeholders})`).bind(...idsChunk).all(),
      db.prepare(`SELECT id, race_id, bet_type, selections, amount, payout, is_hit FROM imported_ticket_items WHERE race_id IN (${placeholders})`).bind(...idsChunk).all(),
    ]);
    tks.push(...(tksChunk || []));
    items.push(...(itemsChunk || []));
  }
  if (!tks.length && !items.length) return { updated: 0 };

  const ticketsByRace = new Map();
  for (const t of tks) {
    if (!ticketsByRace.has(t.race_id)) ticketsByRace.set(t.race_id, []);
    ticketsByRace.get(t.race_id).push(t);
  }
  const importedByRace = new Map();
  for (const it of items) {
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

  if (statements.length) await runBatchInChunks(db, statements);
  return { updated: statements.length };
}
