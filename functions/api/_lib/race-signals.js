// 予想登録画面「展開・時計」タブの点数(GET /api/data-search/race-factors)の計算と、馬券購入画面のレース一覧の目印「複」「ワ」(2026-11-01)。
// 仕様は docs/design/screens.md「総合推奨馬」「レース一覧の目印(複・ワ)」。
import { parseJsonSafe } from "./graded-race-search.js";
import { loadHorseAliasMapCached, buildHorseSearchKeys, applyHorseAliasMap, horseAliasKeyOf } from "./horse-alias.js";
import { loadJockeyAliasMapCached } from "./jockey-alias.js";
import { getRaceLineups } from "./race-lineup-cache.js";
import { getRaceTimes } from "./race-time-cache.js";
import { createFactorContext, computeRaceFactors, FACTOR_KEYS, GLOBAL_ADJUST_KEYS } from "./race-factors.js";
import { getDistanceRatios } from "./distance-ratios.js";
import { getPaceScoreSettings } from "./pace-settings.js";
import { getPaceWeights, prevYearGradedRaceId, paceIndexOf, pickRecommended } from "./pace-score.js";
import { loadGradedRaceMapCached, gradedRaceOf } from "./race-classification.js";
import { memoizedKeyed, textFingerprint } from "./memo-cache.js";

// 呼び出し側が読む races の列(race-factors・race-signal・race-signals で同じ)
export const RACE_FACTOR_COLUMNS = "id, race_date, track, course_type, distance, race_name, class_flags, entries";

// 出走取消の印(entries[].scratched。2026-10-15)の馬は採点・ペース予想から外す
export function raceFactorEntries(race) {
  return (parseJsonSafe(race.entries, []) || []).filter((e) => e && e.horse_name && !e.scratched);
}

// 点数を出せるレースか(出走馬・コース・距離・日付がある)
export function canScoreRace(race) {
  return Boolean(raceFactorEntries(race).length && race.course_type && race.distance && race.race_date);
}

// race-factors の応答の本体。同じ実行環境で60秒、同じレース・同じ出走馬表の結果を使い回す(2026-10-16。D1 の負荷軽減)。週末は同じレースを
// 何人も(ゲストを含む)開き、1回あたり数百行の戦績を読んでいた。出走馬表やコースが変われば名前が変わるので、
// 出馬表の取り込み直しはすぐ反映される。他のレースの結果の取り込み・比率の変更は最大60秒遅れる。
// 2026-11-01: レース一覧の目印(race-signal)と同じ使い回しにするため、race-factors.js からここへ移した
export async function getRaceFactorsBody(db, race) {
  const entries = raceFactorEntries(race);
  if (!entries.length || !race.course_type || !race.distance || !race.race_date) return { pace_type: null, counts: null, horses: [] };
  const memoName = `race_factors:${race.id}:${race.race_date}|${race.track}|${race.course_type}|${race.distance}|${race.race_name}|${race.class_flags}:${textFingerprint(race.entries)}`;
  return memoizedKeyed(memoName, () => computeRaceFactorsBody(db, race, entries), 60 * 1000);
}

async function computeRaceFactorsBody(db, race, entries) {
  const [horseAliasMap, jockeyAliasMap, lineups, raceTimes, scoreSettings, gradedMap, distanceRatios] = await Promise.all([
    loadHorseAliasMapCached(db),
    loadJockeyAliasMapCached(db),
    getRaceLineups(db),
    getRaceTimes(db),
    getPaceScoreSettings(db), // データ無しの点・評価点の既定値(2026-10-14。app_settings 1行。2分使い回し)
    loadGradedRaceMapCached(db),
    getDistanceRatios(db), // 同じ馬の組から出した距離の比(2026-10-16。app_settings 1行。10分使い回し)
  ]);
  const graded = gradedRaceOf(gradedMap, race);
  const [weights, prevRaceId] = await Promise.all([
    getPaceWeights(db, graded ? graded.id : 0, race),
    graded ? prevYearGradedRaceId(db, graded.id, race) : null,
  ]);
  // 重賞・コースの評価点に無い項目(後から足した前年の同レース等)は設定の既定値
  // 間隔(2026-10-15)など全レース共通の項目は、いつも設定の既定値
  const adjust = { ...scoreSettings.adjust, ...(weights.adjust || {}) };
  for (const k of GLOBAL_ADJUST_KEYS) adjust[k] = scoreSettings.adjust[k];
  const { searchKeyToKey } = buildHorseSearchKeys(horseAliasMap, entries.map((e) => e.horse_name));
  const searchKeys = [...searchKeyToKey.keys()];
  const runsByHorse = new Map();
  // IN句のキー数: 出走馬の馬名+逆引きエイリアス。重賞の特別登録を手で入れると頭数に上限が無く(2026-10-15)、
  // 100バインドを超えうるため90件ずつ(+日付1)に分ける
  for (let i = 0; i < searchKeys.length; i += 90) {
    const keys = searchKeys.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT rr.horse_key, rr.race_id, rr.status, rr.finish_position, rr.corner_positions, rr.time_text, rr.final_furlong_time,
                rr.body_weight, rr.jockey, rr.weight_carried, r.race_date, r.race_number, r.track, r.course_type, r.distance, r.track_condition
           FROM race_results rr JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_key IN (${keys.map(() => "?").join(",")}) AND r.race_date < ?`
      )
      .bind(...keys, race.race_date)
      .all();
    for (const row of results || []) {
      const key = searchKeyToKey.get(row.horse_key);
      if (!key) continue;
      if (!runsByHorse.has(key)) runsByHorse.set(key, []);
      runsByHorse.get(key).push(row);
    }
  }

  const keyOfEntry = (e) => horseAliasKeyOf(applyHorseAliasMap(horseAliasMap, e.horse_name));
  const runners = entries.map((e) => ({ key: keyOfEntry(e), horse_number: e.horse_number ?? null, jockey: e.jockey || null, sex_age: e.sex_age || null, weight_carried: e.weight_carried ?? null }));
  const ctx = createFactorContext(lineups, raceTimes, jockeyAliasMap);
  const rf = computeRaceFactors(ctx, race, runners, runsByHorse, { missingScore: scoreSettings.missing_score, adjust, prevRaceId, weightSecPerKg: scoreSettings.weight_sec_per_kg, distanceRatios });

  const horses = entries.map((e, i) => {
    const key = runners[i].key;
    const factors = {};
    for (const f of FACTOR_KEYS) {
      const v = rf.factors[f].get(key);
      factors[f] = { score: Math.round(v.score * 10) / 10, rank: v.rank, value: v.value, missing: v.missing };
    }
    // total_adjust: 総合点(軸指数・相手指数)へ直接足す点と内訳(間隔。2026-10-15。無ければ value 0)
    const ta = rf.totalAdjust.get(key) || { value: 0, note: "" };
    return { horse_name: e.horse_name, horse_number: e.horse_number ?? null, waku_number: e.waku_number ?? null, jockey: e.jockey || null, factors, total_adjust: ta };
  });
  return { pace_type: rf.pace_type, counts: rf.counts, horses };
}

// ---- レース一覧の目印(2026-11-01 ユーザー要望。試算は docs/design/screens.md「レース一覧の目印(複・ワ)」) ----
// 合計 = 軸指数+相手指数(予想登録画面の総合推奨馬の表と同じ計算)。◎〇は推奨馬の印(pickRecommended)
//   複: ◎の合計が SIGNAL_FUKU_MIN 以上で、合計2位の馬と SIGNAL_FUKU_GAP 点以上の差(複勝◎・ワイド◎-〇向き)
//   ワ: ◎〇の合計がどちらも SIGNAL_WIDE_MIN 以上で、ほかの馬は全部 ◎〇の低い方より SIGNAL_WIDE_GAP 点以上下
//   両方を満たせば両方。出走が SIGNAL_MIN_RUNNERS 頭未満のレースは出さない(試算の対象外)
export const SIGNAL_FUKU_MIN = 125;
export const SIGNAL_FUKU_GAP = 10;
export const SIGNAL_WIDE_MIN = 120;
export const SIGNAL_WIDE_GAP = 10;
export const SIGNAL_MIN_RUNNERS = 5;

// body: getRaceFactorsBody の戻り値、weights: getPaceWeights の戻り値 → "" | "複" | "ワ" | "複ワ"
export function raceSignalsOf(body, weights) {
  if (!body.pace_type || body.horses.length < SIGNAL_MIN_RUNNERS) return "";
  const pick = (d) => (body.pace_type && d.paces?.[body.pace_type]) || d;
  const wa = pick(weights), wp = pick(weights.partner || weights);
  const extra = (h) => Number(h.total_adjust?.value) || 0;
  const horses = body.horses.map((h) => ({
    horse_number: h.horse_number,
    axis: paceIndexOf(h.factors, wa) + extra(h),
    partner: paceIndexOf(h.factors, wp) + extra(h),
    pace: h.factors.pace?.score, time: h.factors.time?.score, timeMissing: Boolean(h.factors.time?.missing),
  }));
  const total = (x) => x.axis + x.partner;
  const picked = pickRecommended(horses).map((p) => p.x);
  const [hon, tai] = picked;
  if (!hon || !tai) return "";
  let out = "";
  const second = Math.max(...horses.filter((x) => x !== hon).map(total));
  if (total(hon) >= SIGNAL_FUKU_MIN && total(hon) - second >= SIGNAL_FUKU_GAP) out += "複";
  const low = Math.min(total(hon), total(tai));
  const rest = horses.filter((x) => x !== hon && x !== tai).map(total);
  if (low >= SIGNAL_WIDE_MIN && rest.every((t) => t <= low - SIGNAL_WIDE_GAP)) out += "ワ";
  return out;
}

export const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 保存した目印が今のレースに合うかを見る指紋(出走馬表・コース・レース名・条件)
export function raceSignalFingerprint(race) {
  return textFingerprint(`${race.race_date}|${race.track}|${race.course_type}|${race.distance}|${race.race_name}|${race.class_flags}|${race.entries}`);
}

// 保存した目印を計算し直すか。出走馬表等が変わった、または今日以降のレースで今日より前に計算した(比率・ほかのレースの結果が
// 夜のうちに変わるため、1日1回は計算し直す)。過去のレースは出走馬表が変わったときだけ
export function raceSignalStale(race, saved, today = todayJst()) {
  if (!saved || saved.fp !== raceSignalFingerprint(race)) return true;
  return race.race_date >= today && saved.computed_on < today;
}

// 1レースの目印を計算して保存する。保存は best-effort(失敗しても目印は返す)
export async function computeAndSaveRaceSignal(db, race) {
  const body = await getRaceFactorsBody(db, race);
  let signals = "";
  if (body.pace_type) {
    const gradedMap = await loadGradedRaceMapCached(db);
    const graded = gradedRaceOf(gradedMap, race);
    const weights = await getPaceWeights(db, graded ? graded.id : 0, race);
    signals = raceSignalsOf(body, weights);
  }
  try {
    await db
      .prepare(
        `INSERT INTO race_signals (race_id, race_date, fp, signals, computed_on) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(race_id) DO UPDATE SET race_date = excluded.race_date, fp = excluded.fp, signals = excluded.signals, computed_on = excluded.computed_on`
      )
      .bind(Number(race.id), race.race_date, raceSignalFingerprint(race), signals, todayJst())
      .run();
  } catch (e) {
    console.error("race_signals save failed (ignored)", e);
  }
  return signals;
}
