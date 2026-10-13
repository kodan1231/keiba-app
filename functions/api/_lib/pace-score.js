// 総合推奨馬(2026-10-13追加。予想登録画面「展開・時計」タブ)の重視度の比率と、重賞の過去の結果からの自動算出。
// 仕様は docs/design/screens.md「総合推奨馬」。
//
// 点数の付け方は _lib/race-factors.js に一本化した(2026-10-13。以前は画面〈prediction.js〉とここに二重に持っていた)。
import { findRacesByGradedKey, jstYear } from "./graded-race-search.js";
import { gradedRaceNameKey } from "./race-classification.js";
import { getRaceIndex } from "./races-index-cache.js";
import { getRaceLineups } from "./race-lineup-cache.js";
import { loadJockeyAliasMap } from "./jockey-alias.js";
import { getRaceTimes } from "./race-time-cache.js";
import { FACTOR_KEYS, MISSING_SCORE, createFactorContext, computeRaceFactors } from "./race-factors.js";

export const PACE_FACTORS = FACTOR_KEYS;
export const DEFAULT_PACE_WEIGHTS = { w_pace: 25, w_number: 25, w_jockey: 25, w_time: 25 };
// 自動算出の方式の版。変えたら上げる(古い版で保存した自動の比率は、次に開かれたときに計算し直す)
const AUTO_METHOD_VERSION = 3; // 3: 2026-10-13 データの無い馬を25点・近い条件で補う(race-factors.js)
export const PACE_TOP_N = 5;
const AUTO_PAST_YEARS = 10;

// 比率の入力を検証して整数%(合計100)にする。不正なら null。
export function normalizePaceWeights(w) {
  const vals = PACE_FACTORS.map((f) => Number(w?.[`w_${f}`] ?? 0));
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return toPercents(vals);
}

// 0以上の値の並びを、合計100の整数%にする(端数は大きい順に配る)。
function toPercents(vals) {
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...DEFAULT_PACE_WEIGHTS };
  const raw = vals.map((v) => (v * 100) / sum);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return Object.fromEntries(PACE_FACTORS.map((f, i) => [`w_${f}`, out[i]]));
}

// 標準(graded_race_id=0)と、その重賞の比率を読む。重賞の比率が無ければ標準、標準も無ければ既定値。
// 読み取りは主キーで最大2行。
export async function getPaceWeights(db, gradedRaceId) {
  const ids = [0];
  if (gradedRaceId) ids.push(Number(gradedRaceId));
  let rows = [];
  try {
    const { results } = await db
      .prepare(`SELECT graded_race_id, w_pace, w_number, w_jockey, w_time, source, detail, updated_at FROM pace_weights WHERE graded_race_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    rows = results || [];
  } catch (e) {
    console.error("pace_weights read failed (ignored)", e); // 表がまだ無い等。既定値で返す
  }
  const byId = new Map(rows.map((r) => [Number(r.graded_race_id), r]));
  // auto: 自動算出の要約(画面に「過去の的中」を出す用。年ごとの根拠は管理画面の一覧で見る)
  const autoOf = (r) => {
    if (r.source !== "auto" || !r.detail) return null;
    try {
      const d = JSON.parse(r.detail);
      return d.method === "backtest" ? { races: d.races, top3: d.top3, best: d.best, equal: d.equal } : null;
    } catch { return null; }
  };
  const pick = (r, scope) => ({ w_pace: r.w_pace, w_number: r.w_number, w_jockey: r.w_jockey, w_time: r.w_time ?? 0, source: r.source, updated_at: r.updated_at, scope, auto: autoOf(r) });
  if (gradedRaceId && byId.has(Number(gradedRaceId))) return pick(byId.get(Number(gradedRaceId)), "graded");
  if (byId.has(0)) return pick(byId.get(0), "default");
  return { ...DEFAULT_PACE_WEIGHTS, source: "builtin", updated_at: null, scope: "builtin", auto: null };
}

// 比率の候補(10%刻み・合計100の全組み合わせ。4要素で286通り)
function weightCandidates(step = 10) {
  const out = [];
  for (let p = 0; p <= 100; p += step)
    for (let n = 0; n <= 100 - p; n += step)
      for (let j = 0; j <= 100 - p - n; j += step) out.push({ w_pace: p, w_number: n, w_jockey: j, w_time: 100 - p - n - j });
  return out;
}

// 1年分を、ある比率で採点したときの { hits(総合ベスト5に入った3着以内の頭数), posSum(3着以内の馬の総合の位置の合計) }。
// 総合点 = Σ 比率 × 点(データ無しは50点)÷ 100。
// 同点の馬がベスト5の境目をまたぐときは、残りの枠を同点の馬で按分して数える(例: 5位以下に4頭が同点で残り1枠なら1頭あたり1/4)。
// 2026-10-13: 当初は同点を同順位にして全員をベスト5に数えており、ある要素のデータが全頭に無い(全頭50点で同点)と
// 全頭がベスト5扱いになって当たりが多く数えられ、その要素の比率が不当に高く選ばれた。位置も同点の中の平均にする。
// CPU時間対策(2026-10-13): 候補286通り×最大11年を採点するため、年ごとの点を先に数値の配列にしておき(compileYear)、
// 採点ではオブジェクトを作らない。Map を引く素朴な書き方だと手元で約46ミリ秒かかり、無料枠のCPU上限(10ミリ秒)を超えた。
function compileYear(keys, top3Keys, scores) {
  const n = keys.length;
  const F = PACE_FACTORS.length;
  const S = new Float64Array(n * F);
  const top3 = new Uint8Array(n);
  keys.forEach((key, h) => {
    PACE_FACTORS.forEach((f, k) => {
      const s = scores[f].get(key);
      S[h * F + k] = s == null ? MISSING_SCORE : s;
    });
    top3[h] = top3Keys.has(key) ? 1 : 0;
  });
  return { n, S, top3, totals: new Float64Array(n), order: Array.from({ length: n }, (_, i) => i) };
}

// w: 比率の配列(PACE_FACTORS の順)
function evaluateYear(year, w) {
  const { n, S, top3, totals, order } = year;
  const F = w.length;
  for (let h = 0; h < n; h++) {
    let t = 0;
    for (let k = 0; k < F; k++) t += w[k] * S[h * F + k];
    totals[h] = Math.round(t * 1000); // 浮動小数の誤差で同点が崩れないよう整数にする
  }
  order.sort((a, b) => totals[b] - totals[a]);
  let hits = 0;
  let posSum = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && totals[order[j + 1]] === totals[order[i]]) j++;
    let inTop3 = 0;
    for (let x = i; x <= j; x++) inTop3 += top3[order[x]];
    if (inTop3) {
      const slots = Math.max(0, Math.min(j + 1, PACE_TOP_N) - i); // この同点の組に残っているベスト5の枠
      hits += (inTop3 * slots) / (j - i + 1);
      posSum += inTop3 * ((i + j) / 2 + 1);
    }
    i = j + 1;
  }
  return { hits, posSum };
}

// 重賞の過去(最大10年)の結果から比率を自動算出する(2026-10-13 に方式を変更)。
// 各年について、そのレースより前のデータだけで4要素の点を付け直し(画面と同じ規則)、比率の候補(10%刻み。4要素で286通り)ごとに
// 総合点のベスト5に3着以内の馬が何頭入ったかを数え、過去の全年で一番多く当たった比率を採用する。
// 同じ当たり数なら3着以内の馬の総合の位置の合計が小さい方、それも同じなら均等(34/33/33)に近い方。
// 2026-10-13 以前は「各要素のベスト5の的中率 − 偶然の割合」に比例させていたが、偶然以下の要素が0%に切り捨てられ、
// 富士S・秋華賞が騎手100%になった(展開のデータが少なく、馬番が偶然をわずかに下回ったため)。要素ごとの的中率は参考として detail に残す。
// 対象は今日まで(当日を含む)に行われ着順のある年。opts.targetRace(画面で開いたレース)があれば、その年を detail.target_year に記録する。
// D1の読み取り: 一覧用キャッシュ・集計用キャッシュ(各約20行)+ 対象レースの race_results(約200行)+
//   その出走馬の全戦績(race_results の horse_key インデックス。毎日王冠で約800行)。
export async function autoPaceWeights(db, gradedRaceId, opts = {}) {
  const master = await db.prepare("SELECT id, name, name_key FROM graded_races WHERE id = ?").bind(gradedRaceId).first();
  if (!master) return { error: "重賞が見つかりません" };

  const [allRaces, lineups, aliasMap, raceTimes] = await Promise.all([getRaceIndex(db), getRaceLineups(db), loadJockeyAliasMap(db), getRaceTimes(db)]);
  const matches = findRacesByGradedKey(allRaces, new Set([master.name_key, gradedRaceNameKey(master.name)].filter(Boolean)));
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const currentYear = jstYear();
  const byYear = new Map();
  for (const r of matches) {
    const year = Number(String(r.race_date || "").slice(0, 4));
    if (!year || year < currentYear - AUTO_PAST_YEARS || String(r.race_date) > today) continue;
    const prev = byYear.get(year);
    if (!prev || String(r.race_date) > String(prev.race_date)) byYear.set(year, r);
  }
  const targets = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, r]) => ({ year, race: r }));
  if (!targets.length) return { error: "過去の結果が取り込まれていません" };

  // 対象レース(最大11件。100バインド上限に届かない)の出走馬と着順
  const targetIds = targets.map((t) => Number(t.race.id));
  const { results: rrRows } = await db
    .prepare(
      `SELECT race_id, horse_key, horse_number, jockey, status, finish_position
         FROM race_results WHERE race_id IN (${targetIds.map(() => "?").join(",")})`
    )
    .bind(...targetIds)
    .all();
  const runnersByRace = new Map();
  for (const r of rrRows || []) {
    if (r.status !== "finished" && r.status !== "stopped") continue;
    if (!runnersByRace.has(r.race_id)) runnersByRace.set(r.race_id, []);
    runnersByRace.get(r.race_id).push(r);
  }

  // 出走馬の全戦績(horse_key は最大 11レース×18頭 ≒ 200件になりうるため90件ずつ)
  const horseKeys = [...new Set((rrRows || []).map((r) => r.horse_key).filter(Boolean))];
  const runsByHorse = new Map();
  for (let i = 0; i < horseKeys.length; i += 90) {
    const keys = horseKeys.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT rr.horse_key, rr.race_id, rr.status, rr.corner_positions, rr.time_text, rr.final_furlong_time,
                r.race_date, r.race_number, r.track, r.course_type, r.distance, r.track_condition
           FROM race_results rr JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_key IN (${keys.map(() => "?").join(",")})`
      )
      .bind(...keys)
      .all();
    for (const row of results || []) {
      if (!runsByHorse.has(row.horse_key)) runsByHorse.set(row.horse_key, []);
      runsByHorse.get(row.horse_key).push(row);
    }
  }
  const ctx = createFactorContext(lineups, raceTimes, aliasMap);

  const factorTotal = { top3: 0 };
  for (const f of PACE_FACTORS) factorTotal[f] = { hits: 0, expected: 0 };
  const years = []; // 年ごとの採点結果(比率の候補の評価に使う)
  const yearsOut = []; // detail に残す根拠

  for (const { year, race } of targets) {
    const runnersAll = runnersByRace.get(Number(race.id)) || [];
    const n = runnersAll.length;
    const top3 = runnersAll.filter((r) => r.status === "finished" && r.finish_position >= 1 && r.finish_position <= 3);
    if (!n || !top3.length) continue;
    const date = String(race.race_date);

    const runners = runnersAll.map((h) => ({ key: h.horse_key, horse_number: h.horse_number, jockey: h.jockey }));
    const rf = computeRaceFactors(ctx, race, runners, runsByHorse);
    const pace = rf.pace_type;
    // 各要素の並び(データのある馬だけ・順位順)
    const orders = Object.fromEntries(PACE_FACTORS.map((f) => [f,
      [...rf.factors[f].entries()].filter(([, v]) => !v.missing).map(([key, v]) => ({ key, rank: v.rank })).sort((a, b) => a.rank - b.rank)]));
    const top3Keys = new Set(top3.map((r) => r.horse_key));
    years.push(compileYear(
      runners.map((h) => h.key),
      top3Keys,
      Object.fromEntries(PACE_FACTORS.map((f) => [f, new Map([...rf.factors[f]].map(([k, v]) => [k, v.score]))]))
    ));
    const yearOut = { year, race_id: race.id, field_size: n, pace_type: pace, top3: top3.length };
    factorTotal.top3 += top3.length;
    for (const f of PACE_FACTORS) {
      const best = orders[f].slice(0, PACE_TOP_N);
      const hits = best.filter((x) => top3Keys.has(x.key)).length;
      factorTotal[f].hits += hits;
      factorTotal[f].expected += (top3.length * best.length) / n;
      yearOut[f] = { hits, picked: best.length };
    }
    yearsOut.push(yearOut);
  }
  if (!factorTotal.top3) return { error: "過去の着順が取り込まれていません" };

  // 比率の候補ごとに過去の全年を採点し、一番当たった比率を選ぶ
  const evalWeights = (w) => {
    const wArr = PACE_FACTORS.map((f) => w[`w_${f}`]);
    let hits = 0, posSum = 0;
    const perYear = years.map((y) => {
      const r = evaluateYear(y, wArr);
      hits += r.hits;
      posSum += r.posSum;
      return Math.round(r.hits * 100) / 100;
    });
    return { hits: Math.round(hits * 100) / 100, posSum, perYear };
  };
  const distFromEqual = (w) => PACE_FACTORS.reduce((a, f) => a + Math.abs(w[`w_${f}`] - DEFAULT_PACE_WEIGHTS[`w_${f}`]), 0);
  // 2段階で探す(CPU時間対策): 20%刻み(56通り)で一番当たった比率を見つけ、その周り(各要素±10%)を10%刻みで探す。
  // 10%刻みの全通り(286通り)を試すと採点だけで約6ミリ秒かかり、キャッシュの読み込みと合わせて無料枠の上限(10ミリ秒)を超えうるため。
  let best = null;
  const consider = (w) => {
    const r = { w, ...evalWeights(w) };
    if (
      !best ||
      r.hits > best.hits ||
      (r.hits === best.hits && r.posSum < best.posSum) ||
      (r.hits === best.hits && r.posSum === best.posSum && distFromEqual(w) < distFromEqual(best.w))
    ) best = r;
  };
  for (const w of weightCandidates(20)) consider(w);
  const coarse = best.w;
  for (const w of weightCandidates(10)) {
    if (PACE_FACTORS.every((f) => Math.abs(w[`w_${f}`] - coarse[`w_${f}`]) <= 10) && PACE_FACTORS.some((f) => w[`w_${f}`] % 20 !== 0)) consider(w);
  }
  const equal = evalWeights(DEFAULT_PACE_WEIGHTS);
  yearsOut.forEach((y, i) => {
    y.total_hits = best.perYear[i];
    y.equal_hits = equal.perYear[i];
  });

  const summary = {};
  for (const f of PACE_FACTORS) {
    summary[f] = {
      hits: factorTotal[f].hits,
      hit_rate: Math.round((factorTotal[f].hits / factorTotal.top3) * 1000) / 1000,
      chance_rate: Math.round((factorTotal[f].expected / factorTotal.top3) * 1000) / 1000,
    };
  }
  const rate = (h) => Math.round((h / factorTotal.top3) * 1000) / 1000;
  const targetYear = opts.targetRace ? Number(String(opts.targetRace.race_date || "").slice(0, 4)) || null : opts.targetYear || null;
  return {
    weights: { ...best.w },
    detail: {
      method: "backtest",
      version: AUTO_METHOD_VERSION,
      computed_at: new Date().toISOString(),
      target_year: targetYear,
      race_ids: yearsOut.map((y) => y.race_id),
      // 着順のあったレース(全頭の結果がそろわず採点に使えなかった年も含む)。古いかどうかの判定に使う
      // (着順の無かった今年のレースは入れない。結果が入ったら計算し直すため)
      checked_race_ids: targets.filter((t) => t.race.has_finish_order || runnersByRace.has(Number(t.race.id))).map((t) => Number(t.race.id)),
      races: yearsOut.length,
      top3: factorTotal.top3,
      best: { hits: best.hits, hit_rate: rate(best.hits) },
      equal: { hits: equal.hits, hit_rate: rate(equal.hits) },
      summary,
      years: yearsOut,
    },
  };
}

// 自動の比率が古くなっていないか(画面で開いたレース race で判定)。
//   - そのレースの結果が入っているのに、計算に含まれていない → 古い(結果を含めて計算し直し、翌年に活かす)
//   - そのレースの年より前の年のために計算したもの → 古い(今年の出走馬が登録されたら、過去10年で計算し直す)
// 管理者が手で保存した比率(source='manual')は自動で上書きしない。
export function isAutoWeightsStale(row, race) {
  if (!row) return true;
  if (row.source !== "auto") return false;
  let detail = null;
  try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { /* 壊れていれば計算し直す */ }
  if (!detail || detail.method !== "backtest" || detail.version !== AUTO_METHOD_VERSION) return true;
  const year = Number(String(race.race_date || "").slice(0, 4));
  // 計算の対象(過去10年)より前のレースを開いたときは、計算し直さない(含められないため、毎回古いと判定されてしまう)
  if (!year || year < jstYear() - AUTO_PAST_YEARS) return false;
  const checked = (detail.checked_race_ids || detail.race_ids || []).map(Number);
  if (race.has_result && !checked.includes(Number(race.id))) return true;
  return !detail.target_year || detail.target_year < year;
}

// races の行(id, race_date, finish_order)を isAutoWeightsStale に渡す形にする(結果が入っているか)。
export function raceForStaleCheck(race) {
  return { ...race, has_result: Boolean(race.finish_order && race.finish_order !== "[]" && race.finish_order !== "null") };
}

// 自動算出して保存する(画面から呼ばれたとき・管理者のボタン)。戻り値は autoPaceWeights と同じ(保存したら saved: true)。
export async function computeAndSaveAutoPaceWeights(db, gradedRaceId, opts = {}) {
  const result = await autoPaceWeights(db, gradedRaceId, opts);
  if (result.error) return result;
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pace_weights (graded_race_id, w_pace, w_number, w_jockey, w_time, source, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, ?)
     ON CONFLICT(graded_race_id) DO UPDATE SET w_pace = excluded.w_pace, w_number = excluded.w_number,
       w_jockey = excluded.w_jockey, w_time = excluded.w_time, source = 'auto', detail = excluded.detail, updated_at = excluded.updated_at`
  ).bind(gradedRaceId, result.weights.w_pace, result.weights.w_number, result.weights.w_jockey, result.weights.w_time, JSON.stringify(result.detail), now).run();
  return { ...result, saved: true, updated_at: now };
}
