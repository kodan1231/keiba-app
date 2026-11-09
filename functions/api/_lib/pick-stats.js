// データ検索画面「推奨馬比較」タブ(2026-11-10 追加。ユーザー要望)。仕様は docs/design/data-search.md「推奨馬比較タブ」。
// 結果のあるレースの推奨馬の印(◎〇▲☆)ごとに、単勝・複勝の的中と払戻を「年×競馬場×芝ダ×印の出どころ」で数える。
// 印の出どころ(ユーザー確認済み):
//   r = 記録した印: 結果を登録する直前に、race_signals の印を表 race_pick_records へ写したもの(トリガー。ユーザーが購入時に参考にした印)
//   c = 今の印: 記録の無いレース(この仕組みの前のレース・誰も開かなかったレース)を、そのレースより前のデータだけ・今の比率で採点し直したもの
//       (予想登録画面の総合推奨馬と同じ計算。_lib/pace-score.js の pickRecommended)
// 夜間の計算(scripts/pace-nightly.mjs の 2a)が、すでに読んでいる結果の表(約19.5万行)と races(約1.5万行)をメモリに持ったまま数え、
// POST /api/cron/pick-stats で app_settings の1行(key = pick_stats)に保存する。画面(GET /api/data-search/pick-stats)はその1行を読むだけ。
// 1行の大きさ: 組(今は約190。記録が増えると最大その2倍)× 21個の数。今は約15KB で、1年で数KB増えるだけ(D1 の1行の上限 200万バイトに届かない)。
import { computeRaceFactors, FACTOR_KEYS, GLOBAL_ADJUST_KEYS } from "./race-factors.js";
import { paceIndexOf, pickRecommended, RECOMMEND_MARKS } from "./pace-score.js";
import { gradedRaceOf } from "./race-classification.js";
import { horseAliasKeyOf } from "./horse-alias.js";

export const PICK_STATS_KEY = "pick_stats";
export const PICK_STATS_VERSION = 2;
export const PICK_STATS_COURSE_TYPES = ["芝", "ダート"]; // 障害は数えない
export const PICK_STATS_SOURCES = ["r", "c"]; // 記録した印・今の印
export const PICK_MIN_RUNNERS = 5; // 馬券購入画面の目印(SIGNAL_MIN_RUNNERS)と同じ。これ未満のレースは数えない
// 1組の数の並び: [レース数, 印ごとに(買えた数, 単勝的中, 複勝的中, 単勝払戻, 複勝払戻)]
export const PICK_CELL_LEN = 1 + RECOMMEND_MARKS.length * 5;

// 1レースの払戻(races.payouts の JSON)から、その馬番の単勝・複勝の払戻(100円あたり。無ければ0)
function rateOf(pay, type, horseNumber) {
  let sum = 0;
  for (const p of pay?.[type] || []) {
    const c = p?.combo || [];
    if (c.length === 1 && Number(c[0]) === Number(horseNumber)) sum += Number(p.rate) || 0;
  }
  return sum;
}

// 記録した印(race_pick_records.marks の JSON [[印, 馬番|null, 馬名], ...])を、このレースの出走馬(完走・中止)に当てる。
// 馬番が無ければ馬名で探す。出走しなかった馬(取消・除外。馬券なら返還)の印は null(その印はこのレースで数えない)
function recordedPicks(marksJson, runners) {
  let arr;
  try { arr = JSON.parse(marksJson); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const byNumber = new Map(runners.map((h) => [Number(h.horse_number), h]));
  const byName = new Map(runners.map((h) => [horseAliasKeyOf(h.horse_name || ""), h]));
  return RECOMMEND_MARKS.map((mark) => {
    const m = arr.find((x) => Array.isArray(x) && x[0] === mark);
    if (!m) return null;
    const h = (m[1] != null ? byNumber.get(Number(m[1])) : null) || (m[2] ? byName.get(horseAliasKeyOf(m[2])) : null);
    // 馬番で当たっても馬名が違えば(馬番の付け直し等)馬名を優先する
    if (h && m[2] && horseAliasKeyOf(h.horse_name || "") !== horseAliasKeyOf(m[2])) return byName.get(horseAliasKeyOf(m[2]))?.horse_number ?? null;
    return h ? h.horse_number : null;
  });
}

// races: Map(id -> { id, race_date, race_number, track, course_type, distance, track_condition, race_name, class_flags, payouts })
// results: race_results の行(horse_key, horse_name, race_id, status, finish_position, time_text, corner_positions, final_furlong_time,
//   horse_number, jockey, sex_age, weight_carried, body_weight)
// records: Map(race_id -> marks の JSON)(race_pick_records)
// ctx: createFactorContext の戻り値、weightsOf: loadPaceWeightsResolver の戻り値、gradedPastOf: gradedPastResolver の戻り値
// 戻り値: { v: 2, races, recorded, cells: { "年|競馬場|芝ダ|r or c": [PICK_CELL_LEN 個の数] } }
// onRace(省略可。手元の確かめ用): (race, src, 印ごとの馬番) を数えたレースごとに呼ぶ
export function computePickStats({ races, results, records = new Map(), ctx, scoreSettings, distanceRatios = null, courseHistory = null, weightsOf, gradedMap, gradedPastOf, onProgress = null, onRace = null }) {
  // 各馬の全戦績(採点の材料。採点はそのレースより前の走だけを使う)と、レースごとの出走馬
  const runsByHorse = new Map();
  const runnersByRace = new Map();
  for (const x of results) {
    const r = races.get(x.race_id);
    if (!r || !x.horse_key) continue;
    if (!runsByHorse.has(x.horse_key)) runsByHorse.set(x.horse_key, []);
    runsByHorse.get(x.horse_key).push({
      horse_key: x.horse_key, race_id: x.race_id, status: x.status, finish_position: x.finish_position, corner_positions: x.corner_positions,
      time_text: x.time_text, final_furlong_time: x.final_furlong_time, body_weight: x.body_weight, jockey: x.jockey, weight_carried: x.weight_carried,
      race_date: r.race_date, race_number: r.race_number, track: r.track, course_type: r.course_type, distance: r.distance, track_condition: r.track_condition,
    });
    // 出走馬: 完走・中止(取消・除外は除く。_lib/pace-score.js の scoreRaces と同じ)
    if (x.status !== "finished" && x.status !== "stopped") continue;
    if (!runnersByRace.has(x.race_id)) runnersByRace.set(x.race_id, []);
    runnersByRace.get(x.race_id).push(x);
  }

  // 今の印(採点し直し)。点数を出せなければ null
  const currentPicks = (race, runnersAll) => {
    const graded = gradedRaceOf(gradedMap, race);
    const weights = weightsOf(graded ? graded.id : 0, race);
    const past = graded ? gradedPastOf(graded.id, race) : null;
    // 予想登録画面(_lib/race-signals.js の computeRaceFactorsBody)と同じ比率・評価点・前年の同レース
    const adjust = { ...scoreSettings.adjust, ...(weights.adjust || {}) };
    for (const k of GLOBAL_ADJUST_KEYS) adjust[k] = scoreSettings.adjust[k];
    const runners = runnersAll.map((h) => ({ key: h.horse_key, horse_number: h.horse_number, jockey: h.jockey || null, sex_age: h.sex_age || null, weight_carried: h.weight_carried ?? null }));
    const rf = computeRaceFactors(ctx, race, runners, runsByHorse, {
      missingScore: scoreSettings.missing_score, adjust, prevRaceId: past?.prevId ?? null, gradedPastIds: past?.pastIds || null,
      weightSecPerKg: scoreSettings.weight_sec_per_kg, distanceRatios, courseHistory,
    });
    if (!rf.pace_type) return null;
    const pick = (d) => d.paces?.[rf.pace_type] || d;
    const wa = pick(weights), wp = pick(weights.partner || weights);
    const horses = runners.map((h) => {
      const factors = Object.fromEntries(FACTOR_KEYS.map((f) => [f, rf.factors[f].get(h.key)]));
      const extra = Number(rf.totalAdjust.get(h.key)?.value) || 0;
      return {
        horse_number: h.horse_number, axis: paceIndexOf(factors, wa) + extra, partner: paceIndexOf(factors, wp) + extra,
        pace: factors.pace?.score, time: factors.time?.score, timeMissing: Boolean(factors.time?.missing),
      };
    });
    const picked = pickRecommended(horses);
    return RECOMMEND_MARKS.map((mark) => picked.find((p) => p.mark === mark)?.x.horse_number ?? null);
  };

  const cells = {};
  let counted = 0, recorded = 0, seen = 0;
  for (const race of races.values()) {
    seen++;
    if (onProgress && seen % 2000 === 0) onProgress(seen, counted);
    const ct = String(race.course_type || "").trim();
    const track = String(race.track || "").trim();
    if (!PICK_STATS_COURSE_TYPES.includes(ct) || !track || !(Number(race.distance) > 0) || !race.race_date) continue;
    let pay;
    try { pay = JSON.parse(race.payouts || "null"); } catch { pay = null; }
    if (!pay?.tan?.length || !pay?.fuku?.length) continue;
    const runnersAll = (runnersByRace.get(race.id) || []).filter((h) => h.horse_number != null);
    if (runnersAll.length < PICK_MIN_RUNNERS) continue;

    const rec = records.get(race.id);
    const recPicks = rec ? recordedPicks(rec, runnersAll) : null;
    const src = recPicks ? "r" : "c";
    const numbers = recPicks || currentPicks(race, runnersAll);
    if (!numbers) continue;
    if (onRace) onRace(race, src, numbers);
    const key = `${String(race.race_date).slice(0, 4)}|${track}|${ct}|${src}`;
    const cell = cells[key] || (cells[key] = new Array(PICK_CELL_LEN).fill(0));
    cell[0]++;
    numbers.forEach((num, i) => {
      if (num == null) return; // 印が無い・出走しなかった(返還)
      const tan = rateOf(pay, "tan", num);
      const fuku = rateOf(pay, "fuku", num);
      const o = 1 + i * 5;
      cell[o]++;
      if (tan > 0) cell[o + 1]++;
      if (fuku > 0) cell[o + 2]++;
      cell[o + 3] += tan;
      cell[o + 4] += fuku;
    });
    counted++;
    if (src === "r") recorded++;
  }
  return { v: PICK_STATS_VERSION, races: counted, recorded, cells };
}

// 保存(POST /api/cron/pick-stats から)。app_settings の1行
export async function savePickStats(db, { marker = null, stats }) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(PICK_STATS_KEY, JSON.stringify({ computed_at: now, marker, ...stats }), now).run();
  return { computed_at: now };
}

// 読み取り(主キーで1行)。無ければ null
export async function loadPickStats(db) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(PICK_STATS_KEY).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// 記録した印を全部読む(夜間の 2a で1晩1回。race_pick_records は1日に結果を取り込むレースの数〈約100〜200行〉ずつ増える。
// 1年で約5万行)。表がまだ無ければ(マイグレーション前)空。戻り値: Map(race_id -> marks の JSON)
export async function loadPickRecords(db) {
  const out = new Map();
  try {
    for (let last = 0; ;) {
      const { results } = await db.prepare("SELECT race_id, marks FROM race_pick_records WHERE race_id > ? ORDER BY race_id LIMIT 5000").bind(last).all();
      for (const r of results || []) out.set(Number(r.race_id), r.marks);
      if (!results || results.length < 5000) return out;
      last = results[results.length - 1].race_id;
    }
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return out;
    throw e;
  }
}
