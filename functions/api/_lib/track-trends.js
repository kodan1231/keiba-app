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

// 補正値(秒。プラスは遅い)。
//   trackOff(競馬場) = その競馬場の良馬場の平均 − 全競馬場の良馬場の平均
//                      (良馬場のレースが少なければ、馬場を問わない平均どうしの差)
//   condOff(馬場)    = 全競馬場のその馬場の平均 − 全競馬場の良馬場の平均(良は0)
// レースが TREND_MIN_RACES 未満で出せないものは null。
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
  const condOff = new Map([["良", 0]]);
  for (const c of TRACK_CONDITIONS) {
    if (c === "良") continue;
    condOff.set(c, ok(ov[c]) && ok(ov["良"]) ? ov[c].avg - ov["良"].avg : null);
  }
  return { trackOff, condOff };
}

// ある走のタイムを「今回の競馬場・良馬場」で走った場合のタイムに換算する。
//   補正後 = 元のタイム − trackOff(走った競馬場) − condOff(走った日の馬場) + trackOff(今回の競馬場)
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
  const condAdj = -part(runCondition ? offsets.condOff.get(runCondition) : null);
  const adj = Math.round((trackAdj + condAdj) * 100) / 100;
  return { seconds: Math.round((seconds + adj) * 100) / 100, adj, partial };
}
