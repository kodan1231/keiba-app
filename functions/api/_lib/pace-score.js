// 総合推奨馬(2026-10-13追加。予想登録画面「展開・時計」タブ)の重視度の比率と、重賞の過去の結果からの自動算出。
// 仕様は docs/design/screens.md「総合推奨馬」。
//
// 点数の付け方(画面側 public/prediction.js の paceFactorScores 等と同じ規則。変えるときは両方そろえる):
//   - 展開: 前走の脚質でペースを予想(逃げ2頭以上 or 逃げ+先行が頭数の半分以上→ハイ、逃げ0〜1頭 かつ 逃げ+先行が
//     頭数の1/4以下→スロー、それ以外→ミドル)。ハイは同場・同距離の持ちタイム順、スローは同場・同距離の最速上がり3F順、
//     ミドルは両方の順位の合計順(両方ある馬だけ)
//   - 馬番: 同コースの馬番別の複勝率順(同じなら単勝率→騎乗の多い順)
//   - 騎手: 同コースの複勝率順(同じなら単勝率→騎乗の多い順)。騎乗5回未満は対象外
//   - 各要素の順位を 100(1位)〜0(最下位)の等間隔の点にする。データの無い馬は50点。総合点 = Σ 比率% × 点 / 100
import { runningStyleOf, timeTextToSeconds, findRacesByGradedKey, jstYear } from "./graded-race-search.js";
import { gradedRaceNameKey } from "./race-classification.js";
import { getRaceIndex } from "./races-index-cache.js";
import { getRaceLineups } from "./race-lineup-cache.js";
import { loadJockeyAliasMap, applyJockeyAliasMap, jockeyAliasKeyOf } from "./jockey-alias.js";

export const PACE_FACTORS = ["pace", "number", "jockey"];
export const DEFAULT_PACE_WEIGHTS = { w_pace: 34, w_number: 33, w_jockey: 33 };
export const PACE_TOP_N = 5;
export const PACE_MIN_JOCKEY_RIDES = 5;
const AUTO_PAST_YEARS = 10;

// 比率の入力を検証して整数%(合計100)にする。不正なら null。
export function normalizePaceWeights(w) {
  const vals = [Number(w?.w_pace), Number(w?.w_number), Number(w?.w_jockey)];
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
  return { w_pace: out[0], w_number: out[1], w_jockey: out[2] };
}

// 標準(graded_race_id=0)と、その重賞の比率を読む。重賞の比率が無ければ標準、標準も無ければ既定値。
// 読み取りは主キーで最大2行。
export async function getPaceWeights(db, gradedRaceId) {
  const ids = [0];
  if (gradedRaceId) ids.push(Number(gradedRaceId));
  let rows = [];
  try {
    const { results } = await db
      .prepare(`SELECT graded_race_id, w_pace, w_number, w_jockey, source, updated_at FROM pace_weights WHERE graded_race_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    rows = results || [];
  } catch (e) {
    console.error("pace_weights read failed (ignored)", e); // 表がまだ無い等。既定値で返す
  }
  const byId = new Map(rows.map((r) => [Number(r.graded_race_id), r]));
  const pick = (r, scope) => ({ w_pace: r.w_pace, w_number: r.w_number, w_jockey: r.w_jockey, source: r.source, updated_at: r.updated_at, scope });
  if (gradedRaceId && byId.has(Number(gradedRaceId))) return pick(byId.get(Number(gradedRaceId)), "graded");
  if (byId.has(0)) return pick(byId.get(0), "default");
  return { ...DEFAULT_PACE_WEIGHTS, source: "builtin", updated_at: null, scope: "builtin" };
}

// ---- 点数付け(画面側と同じ規則) ----

export function predictPace(styles, fieldSize) {
  let nige = 0, senko = 0;
  for (const s of styles) {
    if (s === "逃げ") nige++;
    else if (s === "先行") senko++;
  }
  const front = nige + senko;
  return nige >= 2 || front >= fieldSize / 2 ? "high" : nige <= 1 && front <= fieldSize / 4 ? "slow" : "middle";
}

// 小さい順(lowerIsBetter)に並べて同値同順位。[{key, rank}]
function rankBy(list, valueOf) {
  const sorted = [...list].sort((a, b) => valueOf(a) - valueOf(b));
  let rank = 0;
  return sorted.map((x, i) => {
    if (i === 0 || valueOf(x) !== valueOf(sorted[i - 1])) rank = i + 1;
    return { ...x, rank };
  });
}

// 展開の並び。horses: [{ key, time: 秒|null, l3: 秒|null }] → 順位付きの配列(データのある馬だけ)
export function paceOrder(horses, pace) {
  if (pace === "high") return rankBy(horses.filter((h) => h.time != null), (h) => h.time);
  if (pace === "slow") return rankBy(horses.filter((h) => h.l3 != null), (h) => h.l3);
  const both = horses.filter((h) => h.time != null && h.l3 != null);
  const tr = new Map(rankBy(both, (h) => h.time).map((h) => [h.key, h.rank]));
  const lr = new Map(rankBy(both, (h) => h.l3).map((h) => [h.key, h.rank]));
  return rankBy(both.map((h) => ({ ...h, sum: tr.get(h.key) + lr.get(h.key) })), (h) => h.sum);
}

// 複勝率の並び。list: [{ key, stats: {rides, winRate, showRate} }] → 順位付き(複勝率・単勝率が同じなら同順位)
export function rateOrder(list) {
  const sorted = [...list].sort(
    (a, b) => b.stats.showRate - a.stats.showRate || b.stats.winRate - a.stats.winRate || b.stats.rides - a.stats.rides
  );
  let rank = 0;
  return sorted.map((x, i) => {
    const p = sorted[i - 1];
    if (i === 0 || x.stats.showRate !== p.stats.showRate || x.stats.winRate !== p.stats.winRate) rank = i + 1;
    return { ...x, rank };
  });
}

// ---- 自動算出 ----

function newCounts() {
  return { rides: 0, first: 0, show: 0 };
}
function statsOf(c) {
  return { rides: c.rides, winRate: c.rides ? c.first / c.rides : 0, showRate: c.rides ? c.show / c.rides : 0 };
}

// 重賞の過去(最大10年。今日より前に行われ、着順のある年)の結果から比率を出す。
// 各年について、そのレースより前のデータだけで3要素の順位を付け直し、各要素のベスト5に3着以内の馬が何頭入ったかを数える。
//   的中率 = 入った頭数 ÷ 3着以内の頭数、偶然の割合 = Σ(3着以内の頭数 × ベスト5の頭数 ÷ 出走頭数) ÷ 3着以内の頭数
//   比率 ∝ max(的中率 − 偶然の割合, 0)(すべて0なら既定値)
// D1の読み取り: 一覧用キャッシュ・集計用キャッシュ(各約20行)+ 対象レースの race_results(約200行)+
//   その出走馬の全戦績(race_results の horse_key インデックス。数千行)。管理者がボタンを押したときだけ。
export async function autoPaceWeights(db, gradedRaceId) {
  const master = await db.prepare("SELECT id, name, name_key FROM graded_races WHERE id = ?").bind(gradedRaceId).first();
  if (!master) return { error: "重賞が見つかりません" };

  const [allRaces, lineups, aliasMap] = await Promise.all([getRaceIndex(db), getRaceLineups(db), loadJockeyAliasMap(db)]);
  const matches = findRacesByGradedKey(allRaces, new Set([master.name_key, gradedRaceNameKey(master.name)].filter(Boolean)));
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const currentYear = jstYear();
  const byYear = new Map();
  for (const r of matches) {
    const year = Number(String(r.race_date || "").slice(0, 4));
    if (!year || year < currentYear - AUTO_PAST_YEARS || !(String(r.race_date) < today)) continue;
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
                r.race_date, r.race_number, r.track, r.course_type, r.distance
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
  const fieldSizeByRace = new Map(lineups.filter((r) => r.lineup).map((r) => [Number(r.id), r.lineup.length]));
  const jockeyKeyCache = new Map();
  const jockeyKeyOf = (name) => {
    if (!name) return "";
    if (!jockeyKeyCache.has(name)) jockeyKeyCache.set(name, jockeyAliasKeyOf(applyJockeyAliasMap(aliasMap, name)));
    return jockeyKeyCache.get(name);
  };

  const total = { top3: 0 };
  for (const f of PACE_FACTORS) total[f] = { hits: 0, expected: 0 };
  const years = [];

  for (const { year, race } of targets) {
    const runners = runnersByRace.get(Number(race.id)) || [];
    const n = runners.length;
    const top3 = runners.filter((r) => r.status === "finished" && r.finish_position >= 1 && r.finish_position <= 3);
    if (!n || !top3.length) continue;
    const date = String(race.race_date);

    // 展開: 前走の脚質・同場同距離の最速タイム/上がり(このレースより前)
    const styles = [];
    const paceHorses = [];
    for (const h of runners) {
      const runs = (runsByHorse.get(h.horse_key) || [])
        .filter((x) => String(x.race_date) < date)
        .sort((a, b) => String(b.race_date).localeCompare(String(a.race_date)) || b.race_number - a.race_number);
      const last = runs.find((x) => x.status !== "scratched" && x.status !== "excluded");
      styles.push(last ? runningStyleOf(last.corner_positions, fieldSizeByRace.get(Number(last.race_id))) : null);
      let time = null, l3 = null;
      for (const x of runs) {
        if (x.status !== "finished" || x.track !== race.track || x.course_type !== race.course_type || Number(x.distance) !== Number(race.distance)) continue;
        const sec = timeTextToSeconds(x.time_text);
        if (sec != null && (time == null || sec < time)) time = sec;
        const f = Number(x.final_furlong_time);
        if (x.final_furlong_time != null && f > 0 && (l3 == null || f < l3)) l3 = f;
      }
      paceHorses.push({ key: h.horse_key, time, l3 });
    }
    const pace = predictPace(styles, n);

    // 馬番・騎手: 同コースのこのレースより前の成績
    const numCounts = new Map();
    const jockeyCounts = new Map();
    for (const r of lineups) {
      if (!r.lineup || String(r.race_date) >= date || r.track !== race.track || r.course_type !== race.course_type || Number(r.distance) !== Number(race.distance)) continue;
      for (const [hn, jockey, pos] of r.lineup) {
        const add = (m, k) => {
          if (!m.has(k)) m.set(k, newCounts());
          const c = m.get(k);
          c.rides++;
          if (pos === 1) c.first++;
          if (pos >= 1 && pos <= 3) c.show++;
        };
        if (hn > 0) add(numCounts, Number(hn));
        const jk = jockeyKeyOf(jockey);
        if (jk) add(jockeyCounts, jk);
      }
    }
    const numberList = runners
      .filter((h) => numCounts.has(Number(h.horse_number)))
      .map((h) => ({ key: h.horse_key, stats: statsOf(numCounts.get(Number(h.horse_number))) }));
    const jockeyList = runners
      .map((h) => ({ key: h.horse_key, c: jockeyCounts.get(jockeyKeyOf(h.jockey)) }))
      .filter((x) => x.c && x.c.rides >= PACE_MIN_JOCKEY_RIDES)
      .map((x) => ({ key: x.key, stats: statsOf(x.c) }));

    const orders = { pace: paceOrder(paceHorses, pace), number: rateOrder(numberList), jockey: rateOrder(jockeyList) };
    const top3Keys = new Set(top3.map((r) => r.horse_key));
    const yearOut = { year, race_id: race.id, field_size: n, pace_type: pace, top3: top3.length };
    total.top3 += top3.length;
    for (const f of PACE_FACTORS) {
      const best = orders[f].slice(0, PACE_TOP_N);
      const hits = best.filter((x) => top3Keys.has(x.key)).length;
      total[f].hits += hits;
      total[f].expected += (top3.length * best.length) / n;
      yearOut[f] = { hits, picked: best.length };
    }
    years.push(yearOut);
  }
  if (!total.top3) return { error: "過去の着順が取り込まれていません" };

  const edges = PACE_FACTORS.map((f) => Math.max(total[f].hits / total.top3 - total[f].expected / total.top3, 0));
  const weights = edges.some((e) => e > 0) ? toPercents(edges) : { ...DEFAULT_PACE_WEIGHTS };
  const summary = {};
  for (const f of PACE_FACTORS) {
    summary[f] = {
      hits: total[f].hits,
      hit_rate: Math.round((total[f].hits / total.top3) * 1000) / 1000,
      chance_rate: Math.round((total[f].expected / total.top3) * 1000) / 1000,
    };
  }
  return { weights, detail: { computed_at: new Date().toISOString(), races: years.length, top3: total.top3, summary, years } };
}
