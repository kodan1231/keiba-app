// 総合推奨馬の4要素(展開・馬番・騎手・補正タイム)の点数付け(2026-10-13追加)。
// 予想登録画面「展開・時計」タブ(GET /api/data-search/race-factors)と、重賞の比率の自動算出(_lib/pace-score.js の過去の年の採点)の
// 両方がこの1か所を使う(以前は画面〈prediction.js〉とサーバーに同じ規則を二重に持っていた)。仕様は docs/design/screens.md「総合推奨馬」。
//
// 規則(ユーザー確認済み。2026-10-13):
//   - 点は偏差値(2026-10-14 ユーザー要望で変更): 要素ごとに、データのある馬の元の値から 50 + 10 ×(値 − 平均)÷ 標準偏差。
//     全頭が同じ値なら全員50。データの無い馬は設定の点(既定40。管理画面で変更。_lib/pace-settings.js)。
//     元の値: 展開=ハイは補正タイム・スローは上がり3F(速いほど高い)・ミドルは両方の偏差値の平均、補正タイム=速いほど高い、
//     馬番・性齢・馬体重=帯の複勝率、騎手=平均に寄せた複勝率、同コース=掲示板内+1・外−1の合計。順位(rank)は表示用に残す。
//     以前(〜2026-10-14)は順位を100(1位)〜0(最下位)の等間隔にした点で、データ無しは25点(さらに前は50点)だった
//   - タイム(補正タイム): このレースより前の完走した走を、次の順で探して一番近い段の中の最速を使う
//       ①同じ芝ダ障・同じ距離 ②同じ芝ダ障・±200m ③同じ芝ダ障・全距離 ④芝⇔ダートの違い(障害は除く)
//     換算: 元のタイム − 走った競馬場の補正値 − 走った日の馬場の補正値(その走の芝ダ・距離の値)→ 距離が違えば
//       「今回の芝ダ・距離の平均勝ちタイム ÷ 走った芝ダ・距離の平均勝ちタイム」を掛ける(平均が出せなければ距離の比)
//       → 今回の競馬場の補正値を足す(_lib/track-trends.js)
//   - 上がり3F: 同じ順で探し、一番近い段の中の最速(換算はしない。競馬場別の補正は今後)
//   - 展開: 前走の脚質でペースを予想(predictPace)し、ハイ=タイム順、スロー=上がり3F順、ミドル=両方の順位の合計順(両方ある馬)
//   - 馬番: 同コース(競馬場・芝ダ障・距離)の馬番帯別の複勝率順。その馬番帯の騎乗が20回未満なら、同じ競馬場・芝ダ障の全距離、
//     それも20回未満なら全競馬場の同じ芝ダ障。馬番帯は3頭ずつ(1-3, 4-6, 7-9, 10-12, 13-15, 16-18。numberGroupOf)。
//     2026-10-14 ユーザー要望で馬番ごと→馬番帯に変更(馬番ごとでは騎乗が少なく揺れが大きいため。枠番は頭数で
//     同じ馬番でも枠が変わる〈8番が8枠になる等〉ので使わない)。同じ馬番帯の馬は同じ順位・同じ点になる
//   - 騎手: 同コースの複勝率を、騎乗が少ないほどそのコースの平均に寄せた値(10騎乗分の平均を足して割る)の順。
//     同コースで騎乗が無ければ同じ競馬場・芝ダ障、それも無ければ全成績で同じように出す
//   以下3つは 2026-10-14 追加(ユーザー確認済み):
//   - 性齢: 同コースの性齢(牝3・牡4 等。そのレースの時点の年齢)別の複勝率順。今回の馬の性齢は出走馬表(過去の年の採点は結果)の値。
//     騎乗が20回未満なら同場→全場(馬番と同じ)
//   - 馬体重: 前走(体重のある一番新しい走)の馬体重を20kg刻みの体重帯(〜439, 440-459, … 520〜)にし、同コースの体重帯別の
//     複勝率順(騎乗が20回未満なら同場→全場)。今回の馬体重は発走前に無いため前走を使う
//   - 同コース: その馬の同コース(競馬場・芝ダ障・距離)の過去の走ごとに、5着以内(掲示板)なら+1、6着以下なら−1 の合計の順。
//     同コースを走っていない馬は0(データ無しにはしない)。完走した走だけ数える
// 「このレースより前」: 戦績・同コース/同場の成績は日付で絞る。全競馬場の成績(馬番・騎手の最後の段)と補正値・平均勝ちタイムは
//   全期間(過去の年の採点ではわずかに先の情報が混ざる。年ごとに出し直すと重いため)。
import { runningStyleOf, timeTextToSeconds } from "./graded-race-search.js";
import { buildTrackTrends, trackTimeOffsets, TREND_MIN_RACES } from "./track-trends.js";
import { normalizeTrackConditionText, sexAgeCodeOf, sexAgeLabelOf, weightBandOf, WEIGHT_BAND_LABELS, LINEUP_STRIDE } from "./race-lineup-cache.js";
import { applyJockeyAliasMap, jockeyAliasKeyOf } from "./jockey-alias.js";

// 2026-10-14: sexage(性齢)・weight(馬体重)・course(同コース)を追加
export const FACTOR_KEYS = ["pace", "number", "jockey", "time", "sexage", "weight", "course"];
const BOARD_POSITION = 5; // 同コース: 掲示板(5着以内)
export const DEFAULT_MISSING_SCORE = 40; // データの無い馬の点(偏差値)の既定値。実際の値は設定(_lib/pace-settings.js)

// 値(大きいほど良い)の配列 → 偏差値の配列。全員同じ・1頭だけなら50
function deviations(vals) {
  const n = vals.length;
  if (!n) return [];
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return vals.map((v) => (sd > 1e-9 ? 50 + (10 * (v - mean)) / sd : 50));
}
const NUMBER_MIN_RIDES = 20;
const JOCKEY_PRIOR_RIDES = 10;
const NEAR_DISTANCE = 200;
const NUMBER_GROUP_SIZE = 3;

// 馬番 → 馬番帯(1-3 → 1, 4-6 → 2, … 16-18 → 6)
export function numberGroupOf(hn) {
  return Math.ceil(Number(hn) / NUMBER_GROUP_SIZE);
}
const numberGroupLabel = (g) => `${(g - 1) * NUMBER_GROUP_SIZE + 1}-${g * NUMBER_GROUP_SIZE}番`;

export function predictPace(styles, fieldSize) {
  let nige = 0, senko = 0;
  for (const s of styles) {
    if (s === "逃げ") nige++;
    else if (s === "先行") senko++;
  }
  const front = nige + senko;
  return nige >= 2 || front >= fieldSize / 2 ? "high" : nige <= 1 && front <= fieldSize / 4 ? "slow" : "middle";
}

// 小さい順に並べて同値同順位
export function rankBy(list, valueOf) {
  const sorted = [...list].sort((a, b) => valueOf(a) - valueOf(b));
  let rank = 0;
  return sorted.map((x, i) => {
    if (i === 0 || valueOf(x) !== valueOf(sorted[i - 1])) rank = i + 1;
    return { ...x, rank };
  });
}

// ---- 共通の下ごしらえ(集計用キャッシュ・勝ちタイムのキャッシュから。同じ配列なら使い回す) ----

const contextCache = new WeakMap(); // lineups 配列 -> { raceTimes, ctx }

function newCounts() {
  return { rides: 0, first: 0, show: 0 };
}
function addRide(m, k, pos) {
  let c = m.get(k);
  if (!c) m.set(k, (c = newCounts()));
  c.rides++;
  if (pos === 1) c.first++;
  if (pos >= 1 && pos <= 3) c.show++;
}

// lineups: getRaceLineups()、raceTimes: getRaceTimes()、aliasMap: 騎手名エイリアス(loadJockeyAliasMap 等)。
// 3つとも同じもの(使い回し中の同じ配列・Map)なら、前回の下ごしらえを使う(CPU時間対策)
export function createFactorContext(lineups, raceTimes, aliasMap) {
  const hit = contextCache.get(lineups);
  if (hit && hit.raceTimes === raceTimes && hit.aliasMap === aliasMap) return hit.ctx;
  const jockeyKeyOf = (name) => jockeyAliasKeyOf(applyJockeyAliasMap(aliasMap, name));

  // 2026-10-14 CPU時間対策: lineup を展開せず、集計用キャッシュの平らな配列(flat。LINEUP_STRIDE ずつ)のまま数える。
  // 騎手は範囲ごとの辞書(dict)の番号なので、辞書ごとに騎手キーの配列を1回だけ作る。
  const jockeyKey = new Map(); // 生の騎手名 -> キー
  const keyOf = (name) => {
    if (!name) return "";
    let k = jockeyKey.get(name);
    if (k === undefined) jockeyKey.set(name, (k = jockeyKeyOf(name)));
    return k;
  };
  const dictKeys = new Map(); // dict 配列 -> 騎手キーの配列
  const keysOfDict = (dict) => {
    let a = dictKeys.get(dict);
    if (!a) dictKeys.set(dict, (a = dict.map(keyOf)));
    return a;
  };
  const fieldSizeByRace = new Map();
  const byTrackCt = new Map(); // "競馬場|芝ダ障" -> [{ race_date, distance, flat, jk }]
  for (const r of lineups) {
    if (!r.flat) continue;
    fieldSizeByRace.set(Number(r.id), r.size);
    const g = `${r.track}|${r.course_type}`;
    if (!byTrackCt.has(g)) byTrackCt.set(g, []);
    byTrackCt.get(g).push({ race_date: String(r.race_date), distance: Number(r.distance), flat: r.flat, jk: keysOfDict(r.dict) });
  }
  // 全競馬場の成績(全期間)。同コース・同場に記録が無いときの最後の補いにしか使わないため、初めて必要になったときに
  // 種類ごとに数える(2026-10-14: 4種類まとめて数えると本番の6.3万騎乗で約14ミリ秒かかったため、要る種類だけにした)。
  //   numberAllByCt / sexAllByCt / weightAllByCt: 芝ダ障 -> Map(馬番帯 / 性齢コード / 体重帯 -> counts)、jockeyAll: 騎手キー -> counts
  const allCounts = {};
  const allOf = (kind) => {
    if (allCounts[kind]) return allCounts[kind];
    const out = new Map();
    const S = LINEUP_STRIDE;
    for (const r of lineups) {
      const flat = r.flat;
      if (!flat) continue;
      if (kind === "jockeyAll") {
        const jk = keysOfDict(r.dict);
        for (let i = 0; i < flat.length; i += S) {
          const ji = flat[i + 1];
          if (ji >= 0 && jk[ji]) addRide(out, jk[ji], flat[i + 2]);
        }
        continue;
      }
      let m = out.get(r.course_type);
      if (!m) out.set(r.course_type, (m = new Map()));
      for (let i = 0; i < flat.length; i += S) {
        const k = kind === "numberAllByCt" ? (flat[i] > 0 ? numberGroupOf(flat[i]) : 0) : kind === "sexAllByCt" ? flat[i + 3] : flat[i + 4];
        if (k) addRide(m, k, flat[i + 2]);
      }
    }
    return (allCounts[kind] = out);
  };

  // 芝ダ障・距離ごとの勝ちタイム(補正値と平均)
  const timesByCourse = new Map();
  for (const t of raceTimes) {
    const k = `${t.course_type}|${Number(t.distance)}`;
    if (!timesByCourse.has(k)) timesByCourse.set(k, []);
    timesByCourse.get(k).push(t);
  }
  const courseInfo = new Map();
  const courseOf = (ct, d) => {
    const k = `${ct}|${Number(d)}`;
    let v = courseInfo.get(k);
    if (!v) {
      const trends = buildTrackTrends(timesByCourse.get(k) || [], { courseType: ct, distance: d });
      const ov = trends.overall;
      const avg = ov["良"].n >= TREND_MIN_RACES ? ov["良"].avg : ov.all.n >= TREND_MIN_RACES ? ov.all.avg : null;
      v = { offsets: trackTimeOffsets(trends), avg };
      courseInfo.set(k, v);
    }
    return v;
  };

  const ctx = { fieldSizeByRace, byTrackCt, allOf, keyOf, courseOf };
  contextCache.set(lineups, { raceTimes, aliasMap, ctx });
  return ctx;
}

// ---- 1レース分の採点 ----

const fmtSec = (sec) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, "0")}` : s.toFixed(1);
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const TIER_LABEL = { 1: "", 2: "±200m換算", 3: "距離換算", 4: "芝ダ換算" };
const SCOPE_LABEL = { course: "同コース", track: "同場", all: "全場" };

// 走の段(1〜4。対象外は 0)
function tierOf(run, race) {
  if (run.course_type === race.course_type) {
    const diff = Math.abs(Number(run.distance) - Number(race.distance));
    return diff === 0 ? 1 : diff <= NEAR_DISTANCE ? 2 : 3;
  }
  const flat = (ct) => ct === "芝" || ct === "ダート";
  return flat(run.course_type) && flat(race.course_type) ? 4 : 0;
}

// 走のタイムを今回の競馬場・良馬場・芝ダ・距離に換算する
function convertTime(ctx, sec, run, race) {
  const src = ctx.courseOf(run.course_type, run.distance);
  const off = (m, k) => (k != null && m.get(k) != null ? m.get(k) : 0);
  let base = sec - off(src.offsets.trackOff, run.track) - off(src.offsets.condOff, normalizeTrackConditionText(run.track_condition));
  const tgt = ctx.courseOf(race.course_type, race.distance);
  if (run.course_type !== race.course_type || Number(run.distance) !== Number(race.distance)) {
    base *= src.avg && tgt.avg ? tgt.avg / src.avg : Number(race.distance) / Number(run.distance);
  }
  return base + off(tgt.offsets.trackOff, race.track);
}

// race: { id, race_date, track, course_type, distance }
// runners: [{ key, horse_number, jockey, sex_age }](key は馬の名寄せキー。runsByHorse のキーと同じ)
// runsByHorse: Map(key -> [{ race_id, race_date, race_number, status, finish_position, corner_positions, time_text, final_furlong_time,
//   body_weight, track, course_type, distance, track_condition }])(日付はここで「このレースより前」に絞る)
// 戻り値: { pace_type, counts: { nige, senko, unknown, n }, factors: { pace|number|jockey|time: Map(key -> {score, rank, value, missing}) } }
// opts.missingScore: データの無い馬の点(偏差値。設定 getPaceScoreSettings の missing_score。省略時は既定40)
export function computeRaceFactors(ctx, race, runners, runsByHorse, { missingScore = DEFAULT_MISSING_SCORE } = {}) {
  const date = String(race.race_date);
  const n = runners.length;

  // 戦績: 脚質・タイム・上がり
  const styles = [];
  const horses = runners.map((h) => {
    const runs = (runsByHorse.get(h.key) || [])
      .filter((x) => String(x.race_date) < date)
      .sort((a, b) => String(b.race_date).localeCompare(String(a.race_date)) || b.race_number - a.race_number);
    const last = runs.find((x) => x.status !== "scratched" && x.status !== "excluded");
    styles.push(last ? runningStyleOf(last.corner_positions, ctx.fieldSizeByRace.get(Number(last.race_id))) : null);
    let time = null, timeTier = 9, timeRun = null, l3 = null, l3Tier = 9;
    // 前走の馬体重(体重のある一番新しい走)と、同コースの掲示板(5着以内)の数
    const weightRun = runs.find((x) => x.status !== "scratched" && x.status !== "excluded" && Number(x.body_weight) > 0);
    let boardIn = 0, boardOut = 0;
    for (const x of runs) {
      if (x.status !== "finished") continue;
      if (x.track === race.track && x.course_type === race.course_type && Number(x.distance) === Number(race.distance) && Number(x.finish_position) > 0) {
        if (Number(x.finish_position) <= BOARD_POSITION) boardIn++;
        else boardOut++;
      }
      const tier = tierOf(x, race);
      if (!tier) continue;
      const sec = timeTextToSeconds(x.time_text);
      if (sec != null && tier <= timeTier) {
        const c = convertTime(ctx, sec, x, race);
        if (tier < timeTier || c < time) { time = c; timeTier = tier; timeRun = x; }
      }
      const f = Number(x.final_furlong_time);
      if (x.final_furlong_time != null && f > 0 && tier <= l3Tier && (tier < l3Tier || f < l3)) { l3 = f; l3Tier = tier; }
    }
    return { key: h.key, h, time, timeTier, timeRun, l3, l3Tier, bodyWeight: weightRun ? Number(weightRun.body_weight) : null, boardIn, boardOut };
  });
  let nige = 0, senko = 0, unknown = 0;
  for (const s of styles) {
    if (!s) unknown++;
    else if (s === "逃げ") nige++;
    else if (s === "先行") senko++;
  }
  const paceType = predictPace(styles, n);
  const timeText = (x) => `補${fmtSec(x.time)}${TIER_LABEL[x.timeTier] ? `(${x.timeRun.course_type}${x.timeRun.distance}m・${TIER_LABEL[x.timeTier]})` : ""}`;
  const l3Text = (x) => `上${x.l3.toFixed(1)}${TIER_LABEL[x.l3Tier] ? "(他距離)" : ""}`;

  // 馬番・騎手: 同コース・同場(芝ダ障が同じ)の成績(このレースより前)
  // 騎手は今回乗る騎手だけ数え、平均用に全騎乗の合計を別に数える(2026-10-14 CPU時間対策。結果は同じ)
  const numCourse = new Map(), numTrack = new Map(), jkCourse = new Map(), jkTrack = new Map();
  const sexCourse = new Map(), sexTrack = new Map(), wtCourse = new Map(), wtTrack = new Map();
  const runnerJk = new Set(runners.map((h) => ctx.keyOf(h.jockey)).filter(Boolean));
  const jkTotal = { course: newCounts(), track: newCounts() };
  const addTotal = (c, pos) => { c.rides++; if (pos === 1) c.first++; if (pos >= 1 && pos <= 3) c.show++; };
  const S = LINEUP_STRIDE;
  for (const r of ctx.byTrackCt.get(`${race.track}|${race.course_type}`) || []) {
    if (r.race_date >= date) continue;
    const same = r.distance === Number(race.distance);
    const flat = r.flat;
    for (let i = 0; i < flat.length; i += S) {
      const hn = flat[i], ji = flat[i + 1], pos = flat[i + 2], sa = flat[i + 3], wb = flat[i + 4];
      if (hn > 0) {
        const g = numberGroupOf(hn);
        addRide(numTrack, g, pos);
        if (same) addRide(numCourse, g, pos);
      }
      if (sa) {
        addRide(sexTrack, sa, pos);
        if (same) addRide(sexCourse, sa, pos);
      }
      if (wb) {
        addRide(wtTrack, wb, pos);
        if (same) addRide(wtCourse, wb, pos);
      }
      const jk = ji >= 0 ? r.jk[ji] : "";
      if (jk) {
        addTotal(jkTotal.track, pos);
        if (same) addTotal(jkTotal.course, pos);
        if (runnerJk.has(jk)) {
          addRide(jkTrack, jk, pos);
          if (same) addRide(jkCourse, jk, pos);
        }
      }
    }
  }
  // 馬番帯・性齢・体重帯: 同コース → 同場 → 全場(騎乗が NUMBER_MIN_RIDES 未満なら次の段)の複勝率
  const groupRate = (k, course, track, allKey) => {
    let c = course.get(k), scope = "course";
    if (!c || c.rides < NUMBER_MIN_RIDES) { c = track.get(k); scope = "track"; }
    if (!c || c.rides < NUMBER_MIN_RIDES) { c = (ctx.allOf(allKey).get(race.course_type) || new Map()).get(k); scope = "all"; }
    return c && c.rides ? { show: c.show / c.rides, win: c.first / c.rides, rides: c.rides, scope } : null;
  };
  const numberList = [], sexList = [], weightList = [];
  for (const h of runners) {
    const hn = Number(h.horse_number);
    if (!(hn > 0)) continue;
    const g = numberGroupOf(hn);
    const r = groupRate(g, numCourse, numTrack, "numberAllByCt");
    if (r) numberList.push({ key: h.key, ...r, group: g });
  }
  for (const h of runners) {
    const sa = sexAgeCodeOf(h.sex_age);
    if (!sa) continue;
    const r = groupRate(sa, sexCourse, sexTrack, "sexAllByCt");
    if (r) sexList.push({ key: h.key, ...r, sa });
  }
  for (const x of horses) {
    const wb = weightBandOf(x.bodyWeight);
    if (!wb) continue;
    const r = groupRate(wb, wtCourse, wtTrack, "weightAllByCt");
    if (r) weightList.push({ key: x.key, ...r, wb, kg: x.bodyWeight });
  }
  // 騎手: 段ごとの平均(そのコース等の全騎乗の複勝率・単勝率)に、騎乗が少ないほど寄せる
  const avgOf = (c) => ({ show: c.rides ? c.show / c.rides : 0, win: c.rides ? c.first / c.rides : 0 });
  const jkAvg = { course: avgOf(jkTotal.course), track: avgOf(jkTotal.track) };
  const jkAllAvg = () => {
    if (jkAvg.all) return jkAvg.all;
    const t = newCounts();
    for (const c of ctx.allOf("jockeyAll").values()) { t.rides += c.rides; t.show += c.show; t.first += c.first; }
    return (jkAvg.all = avgOf(t));
  };
  const jockeyList = [];
  for (const h of runners) {
    const jk = ctx.keyOf(h.jockey);
    if (!jk) continue;
    let c = jkCourse.get(jk), scope = "course";
    if (!c || !c.rides) { c = jkTrack.get(jk); scope = "track"; }
    if (!c || !c.rides) { c = ctx.allOf("jockeyAll").get(jk); scope = "all"; }
    if (!c || !c.rides) continue;
    const a = scope === "all" ? jkAllAvg() : jkAvg[scope], K = JOCKEY_PRIOR_RIDES;
    jockeyList.push({
      key: h.key, rides: c.rides, scope, rawShow: c.show / c.rides,
      show: (c.show + K * a.show) / (c.rides + K), win: (c.first + K * a.win) / (c.rides + K),
    });
  }
  const rateRank = (list) => {
    const sorted = [...list].sort((a, b) => b.show - a.show || b.win - a.win || b.rides - a.rides);
    let rank = 0;
    return sorted.map((x, i) => {
      const p = sorted[i - 1];
      if (i === 0 || x.show !== p.show || x.win !== p.win) rank = i + 1;
      return { ...x, rank };
    });
  };

  // 並び(rank は表示用)と偏差値の元の値 v(大きいほど良い。2026-10-14〜)
  const withTime = horses.filter((x) => x.time != null);
  const withL3 = horses.filter((x) => x.l3 != null);
  let paceRanked;
  if (paceType === "high") paceRanked = rankBy(withTime, (x) => x.time).map((x) => ({ ...x, v: -x.time, value: timeText(x) }));
  else if (paceType === "slow") paceRanked = rankBy(withL3, (x) => x.l3).map((x) => ({ ...x, v: -x.l3, value: l3Text(x) }));
  else {
    // ミドル: 補正タイムと上がり3Fそれぞれの偏差値の平均(両方ある馬)
    const both = horses.filter((x) => x.time != null && x.l3 != null);
    const dt = deviations(both.map((x) => -x.time)), dl = deviations(both.map((x) => -x.l3));
    paceRanked = rankBy(both.map((x, i) => ({ ...x, v: (dt[i] + dl[i]) / 2, direct: true })), (x) => -x.v)
      .map((x) => ({ ...x, value: `${timeText(x)} ${l3Text(x)}` }));
  }
  const ranked = {
    pace: paceRanked,
    time: rankBy(withTime, (x) => x.time).map((x) => ({ ...x, v: -x.time, value: timeText(x) })),
    number: rateRank(numberList).map((x) => ({ ...x, v: x.show, value: `${numberGroupLabel(x.group)} 複${pct(x.show)} 単${pct(x.win)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    jockey: rateRank(jockeyList).map((x) => ({ ...x, v: x.show, value: `複${pct(x.rawShow)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    sexage: rateRank(sexList).map((x) => ({ ...x, v: x.show, value: `${sexAgeLabelOf(x.sa)} 複${pct(x.show)} 単${pct(x.win)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    weight: rateRank(weightList).map((x) => ({ ...x, v: x.show, value: `前走${x.kg}kg(${WEIGHT_BAND_LABELS[x.wb]}) 複${pct(x.show)} 単${pct(x.win)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    // 同コース: 全頭を並べる(走っていない馬は0)。多い順
    course: rankBy(horses.map((x) => ({ ...x, sum: x.boardIn - x.boardOut })), (x) => -x.sum).map((x) => ({
      ...x,
      v: x.sum,
      value: x.boardIn || x.boardOut ? `同コース 5着以内${x.boardIn}回・6着以下${x.boardOut}回(${x.sum > 0 ? "+" : ""}${x.sum})` : "同コース未出走(0)",
    })),
  };
  const factors = {};
  for (const f of FACTOR_KEYS) {
    const list = ranked[f];
    // direct: 値がすでに偏差値(ミドルの展開)
    const dev = list.length && list[0].direct ? list.map((x) => x.v) : deviations(list.map((x) => x.v));
    const map = new Map();
    list.forEach((x, i) => map.set(x.key, { score: dev[i], rank: x.rank, value: x.value, missing: false }));
    for (const h of runners) if (!map.has(h.key)) map.set(h.key, { score: missingScore, rank: null, value: null, missing: true });
    factors[f] = map;
  }
  return { pace_type: paceType, counts: { nige, senko, unknown, n }, factors };
}
