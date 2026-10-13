// 勝ちタイムの小さいキャッシュ(race_time_cache。2026-10-13追加)。
// データ検索「競馬場傾向」タブと、予想登録画面の補正タイム(horse-best)用に、各レースの
// 「競馬場・芝ダ障・距離・馬場状態・クラス・勝ちタイム(秒)」だけを持つ。仕様は docs/design/data-search.md「競馬場傾向タブ」。
//
// 背景: 2026-10-12 は集計用の小さいキャッシュ(race_lineup_cache。約80万文字)を読んで集計していたが、
// 読み込み(JSON の解析と展開)に約9ミリ秒かかり、Cloudflare 無料枠のCPU時間の上限(1リクエスト10ミリ秒)に近かった。
// 馬柱タブを開くたびに呼ばれる horse-best で上限を超えると持ちタイムごと出なくなるため、必要な列だけの別キャッシュにした
// (約16万文字。読み込み約1ミリ秒)。
//
// 保存形式(_lib/range-chunk-cache.js。1行 = races.id の範囲1つ分):
//   { "v": 1, "r": [[id, track, course_type, distance, track_condition, race_class, win_time], ...] }
//   勝ちタイムのあるレースだけ。track_condition は 良/稍重/重/不良 か null、race_class は raceClassOf() か null。
// 無効化は DB トリガー(@STEP: race_time_cache。変わったレース・結果のレースの範囲の行だけ消す)。
// 同じ実行環境で 60 秒使い回す(_lib/memo-cache.js。取り込みの反映は最大60秒遅れる)。
import { loadRangeChunks, rangeCondition, rangeIndexOf } from "./range-chunk-cache.js";
import { raceClassOf } from "./race-classification.js";
import { timeTextToSeconds } from "./graded-race-search.js";
import { normalizeTrackConditionText } from "./race-lineup-cache.js";
import { memoized } from "./memo-cache.js";

const RACE_TIME_CACHE_VERSION = 1;
export const MEMO_RACE_TIMES = "race_times";
const MEMO_TTL_MS = 60 * 1000;

// 戻り値: [{ id, track, course_type, distance, track_condition, race_class, win_time }](races.id の順)
export function getRaceTimes(db) {
  return memoized(MEMO_RACE_TIMES, async () => {
    const chunks = await loadRangeChunks(db, "race_time_cache", buildRaceTimeChunks, { version: RACE_TIME_CACHE_VERSION });
    const out = [];
    for (const c of chunks) {
      for (const [id, track, course_type, distance, track_condition, race_class, win_time] of c.r || []) {
        out.push({ id, track, course_type, distance, track_condition, race_class, win_time });
      }
    }
    return out;
  }, MEMO_TTL_MS);
}

// 指定した範囲(null は全件)のレースを読み、範囲ごとの payload({ r })にする。
// 読み取り: races の該当範囲 + race_results の該当範囲(race_id のインデックスで範囲を読み、1着の行だけ使う)。
async function buildRaceTimeChunks(db, indices) {
  const raceCond = rangeCondition("id", indices);
  const rrCond = rangeCondition("race_id", indices);
  const [{ results: raceRows }, { results: winRows }] = await Promise.all([
    db.prepare(
      `SELECT id, track, course_type, distance, track_condition, class_flags, race_name
         FROM races${raceCond ? ` WHERE ${raceCond.sql}` : ""} ORDER BY id`
    ).bind(...(raceCond ? raceCond.binds : [])).all(),
    db.prepare(
      `SELECT race_id, time_text FROM race_results
        WHERE finish_position = 1 AND status = 'finished'${rrCond ? ` AND (${rrCond.sql})` : ""}`
    ).bind(...(rrCond ? rrCond.binds : [])).all(),
  ]);
  const winById = new Map();
  for (const w of winRows || []) {
    if (winById.has(w.race_id)) continue; // 同着は先の1頭(同タイム)
    const sec = timeTextToSeconds(w.time_text);
    if (sec != null && sec > 0) winById.set(w.race_id, Math.round(sec * 10) / 10);
  }
  const out = new Map();
  for (const race of raceRows || []) {
    const ci = rangeIndexOf(race.id);
    if (!out.has(ci)) out.set(ci, { r: [] });
    const win = winById.get(race.id);
    if (win == null || !race.track || !race.course_type || !race.distance) continue;
    out.get(ci).r.push([race.id, race.track, race.course_type, Number(race.distance),
      normalizeTrackConditionText(race.track_condition), raceClassOf(race), win]);
  }
  return out;
}
