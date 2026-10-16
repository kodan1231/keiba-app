// 競馬場傾向(2026-10-12追加): 同じ芝ダ障・距離での、競馬場ごと・馬場状態ごとの勝ちタイムの平均と、
// それをもとにしたタイムの補正。データ検索「競馬場傾向」タブと、予想登録画面の補正タイム(horse-best)で使う。
// 仕様は docs/design/data-search.md「競馬場傾向タブ」。DB は使わない(集計用の小さいキャッシュ getRaceLineups の配列を渡す)。
import { TRACK_CONDITIONS } from "./race-lineup-cache.js";

// 補正値を出すのに必要なレース数(これ未満の平均は当てにならないので補正に使わない)
export const TREND_MIN_RACES = 3;

function newCell() {
  return { n: 0, sum: 0 };
}
function cellOut(c) {
  return { n: c.n, avg: c.n ? Math.round((c.sum / c.n) * 100) / 100 : null };
}
function newRow() {
  const row = { all: newCell() };
  for (const c of TRACK_CONDITIONS) row[c] = newCell();
  return row;
}
function addTo(row, cond, sec) {
  row.all.n++;
  row.all.sum += sec;
  if (cond && row[cond]) {
    row[cond].n++;
    row[cond].sum += sec;
  }
}
function rowOut(row) {
  const out = { all: cellOut(row.all) };
  for (const c of TRACK_CONDITIONS) out[c] = cellOut(row[c]);
  return out;
}

// lineups: getRaceLineups() の配列。raceClass: null(すべて)か RACE_CLASSES の1つ。
// 戻り値: { overall: { all: {n, avg}, 良: {...}, ... }, tracks: [{ track, all, 良, 稍重, 重, 不良 }](レース数の多い順) }
export function buildTrackTrends(lineups, { courseType, distance, raceClass = null }) {
  const overall = newRow();
  const byTrack = new Map();
  for (const r of lineups) {
    if (r.win_time == null || !r.track) continue;
    if (r.course_type !== courseType || Number(r.distance) !== Number(distance)) continue;
    if (raceClass && r.race_class !== raceClass) continue;
    addTo(overall, r.track_condition, r.win_time);
    if (!byTrack.has(r.track)) byTrack.set(r.track, newRow());
    addTo(byTrack.get(r.track), r.track_condition, r.win_time);
  }
  const tracks = [...byTrack.entries()]
    .map(([track, row]) => ({ track, ...rowOut(row) }))
    .sort((a, b) => b.all.n - a.all.n || a.track.localeCompare(b.track, "ja"));
  return { overall: rowOut(overall), tracks };
}

// 勝ちタイムのあるレースの (芝ダ障, 距離) ごとのレース数。タブの距離の選択肢用。
export function trendDistanceOptions(lineups) {
  const counts = new Map(); // "芝|1600" -> n
  for (const r of lineups) {
    if (r.win_time == null || !r.course_type || !r.distance) continue;
    const k = `${r.course_type}|${Number(r.distance)}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = {};
  for (const [k, n] of counts) {
    const [ct, d] = k.split("|");
    (out[ct] ||= []).push({ distance: Number(d), races: n });
  }
  for (const ct of Object.keys(out)) out[ct].sort((a, b) => a.distance - b.distance);
  return out;
}

// 競馬場ごとの馬場の差を使うのに要るレース数(その競馬場の良・その馬場とも。2026-10-16)
export const COND_TRACK_MIN_RACES = 5;

// 補正値(秒。プラスは遅い)。芝ダ・距離ごと(呼び出し側が buildTrackTrends に渡した芝ダ・距離)。
//   trackOff(競馬場) = その競馬場の良馬場の平均 − 全競馬場の良馬場の平均
//                      (良馬場のレースが少なければ、馬場を問わない平均どうしの差)
//   condOffByTrack(競馬場 → 馬場) = その競馬場のその馬場の平均 − その競馬場の良馬場の平均
//                      (その競馬場で良・その馬場とも COND_TRACK_MIN_RACES 以上あるときだけ。良は0)
//   condOff(馬場)    = 競馬場ごとの「その馬場の平均 − 良の平均」を、その馬場のレース数で重み付けした平均(良は0。
//                      良が TREND_MIN_RACES 以上ある競馬場だけ。合計 TREND_MIN_RACES 未満なら null)
//   走の補正には condOffOf(競馬場ごと → 無ければ condOff)を使う。
// 2026-10-16 変更(ユーザー指摘・仕様確認済み): 以前の condOff は「全競馬場のその馬場の平均 − 全競馬場の良の平均」で、
//   馬場ごとに競馬場の混ざり方が違うと見かけの差が出た(ダ1400 の不良は遅い川崎が4割を占め、競馬場ごとには同じか速いのに
//   「不良は1.8秒遅い」となり、川崎・不良の走が1.8秒速く補正されていた)。競馬場の差を除いてから馬場の差を出し、
//   レースが十分ある競馬場はその競馬場の差を使うようにした。
// レースが足りず出せないものは null。
export function trackTimeOffsets(trends) {
  const ov = trends.overall;
  const ok = (c) => c && c.n >= TREND_MIN_RACES && c.avg != null;
  const trackOff = new Map();
  for (const t of trends.tracks) {
    let off = null;
    if (ok(t["良"]) && ok(ov["良"])) off = t["良"].avg - ov["良"].avg;
    else if (ok(t.all) && ok(ov.all)) off = t.all.avg - ov.all.avg;
    trackOff.set(t.track, off);
  }
  const condOffByTrack = new Map();
  const pooled = new Map(); // 馬場 -> { sum, w }
  for (const t of trends.tracks) {
    const good = t["良"];
    if (!ok(good)) continue;
    const m = new Map([["良", 0]]);
    for (const c of TRACK_CONDITIONS) {
      if (c === "良") continue;
      const x = t[c];
      if (!x || !x.n || x.avg == null) continue;
      const d = x.avg - good.avg;
      if (x.n >= COND_TRACK_MIN_RACES && good.n >= COND_TRACK_MIN_RACES) m.set(c, d);
      const p = pooled.get(c) || { sum: 0, w: 0 };
      p.sum += d * x.n;
      p.w += x.n;
      pooled.set(c, p);
    }
    condOffByTrack.set(t.track, m);
  }
  const condOff = new Map([["良", 0]]);
  for (const c of TRACK_CONDITIONS) {
    if (c === "良") continue;
    const p = pooled.get(c);
    condOff.set(c, p && p.w >= TREND_MIN_RACES ? p.sum / p.w : null);
  }
  return { trackOff, condOff, condOffByTrack };
}

// 同じ競馬場の中での距離の比(2026-10-16): その競馬場の「換算先の距離の平均 ÷ 走った距離の平均」(良が TREND_MIN_RACES 以上ならその平均、
// 無ければ馬場を問わない平均)。trendsFrom / trendsTo は buildTrackTrends の結果(同じ芝ダの、走った距離 / 換算先の距離)。出せなければ null。
// 全場の平均どうしの比は、距離ごとに競馬場の混ざり方が違う(例: ダ1400 は中央中心、ダ1500 は地方中心)と偏るため、同じ競馬場の中で比べる
export function sameTrackDistanceRatio(trendsFrom, trendsTo, track) {
  const avgOf = (tr) => {
    const t = (tr?.tracks || []).find((x) => x.track === track);
    if (!t) return null;
    if (t["良"] && t["良"].n >= TREND_MIN_RACES && t["良"].avg != null) return t["良"].avg;
    if (t.all && t.all.n >= TREND_MIN_RACES && t.all.avg != null) return t.all.avg;
    return null;
  };
  const a = avgOf(trendsFrom), b = avgOf(trendsTo);
  return a && b ? b / a : null;
}

// 走った競馬場・馬場の補正値: その競馬場の値(レースが十分あるとき)→ 無ければ競馬場の差を除いた全場の値。出せなければ null
export function condOffOf(offsets, track, condition) {
  if (!condition) return null;
  const byTrack = offsets.condOffByTrack?.get(track)?.get(condition);
  if (byTrack != null) return byTrack;
  return offsets.condOff.get(condition) ?? null;
}

// ある走のタイムを「今回の競馬場・良馬場」で走った場合のタイムに換算する。
//   補正後 = 元のタイム − trackOff(走った競馬場) − condOffOf(走った競馬場・その日の馬場) + trackOff(今回の競馬場)
// 補正値が出せない部分は 0 として足し、partial: true を付ける。
export function correctRunTime(seconds, { runTrack, runCondition, targetTrack }, offsets) {
  let partial = false;
  const part = (v) => {
    if (v == null) {
      partial = true;
      return 0;
    }
    return v;
  };
  const same = runTrack && runTrack === targetTrack;
  const trackAdj = same ? 0 : -part(offsets.trackOff.get(runTrack)) + part(offsets.trackOff.get(targetTrack));
  const condAdj = -part(runCondition ? condOffOf(offsets, runTrack, runCondition) : null);
  const adj = Math.round((trackAdj + condAdj) * 100) / 100;
  return { seconds: Math.round((seconds + adj) * 100) / 100, adj, partial };
}
