// データ検索画面「重賞検索」タブ(GET /api/data-search/graded-race・graded-race-horses)
// 向けの共通ロジック。DBアクセスは持たない(呼び出し側が races_cache / race_stats_cache /
// race_results から読んだものを渡す)。仕様は docs/design/graded-race-search.md。

import { gradedRaceNameKey, resolveGradedKey } from "./race-classification.js";

// 着別度数・走数として数えるステータス(取消・除外は数えない。中止は「着外」)
export const RAN_STATUSES = new Set(["finished", "stopped"]);

const JOCKEY_MARK_RE = /^[☆▲△★◇]/;

// 騎手名の名寄せキー(data-search/race-stats.js の jockeyKey と同じ考え方。
// 先頭の見習い減量記号を除去し、空白を除去する)。
export function gradedJockeyKey(name) {
  return String(name ?? "").replace(JOCKEY_MARK_RE, "").replace(/[　\s]+/g, "").trim();
}

// 日本時間の現在年
export function jstYear(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
}

// race_results.time_text("1:25.0" / "58.3" 等の生テキスト)を秒へ換算する。解釈できなければ null。
export function timeTextToSeconds(text) {
  const s = String(text ?? "").normalize("NFKC").trim();
  if (!s) return null;
  let m = s.match(/^(\d+)[:.](\d{1,2}(?:\.\d+)?)$/);
  if (m && m[2].includes(".")) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]);
  return null;
}

// race_results.corner_positions("3-3-2-1" 等)の最初のコーナー通過順位。無ければ null。
export function firstCornerPosition(text) {
  const m = String(text ?? "").normalize("NFKC").match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return n > 0 ? n : null;
}

// 脚質の判定(1走ぶん)。最初のコーナー通過順位 ÷ 頭数で判定する。
//   1番手 → 逃げ / 1/3以下 → 先行 / 2/3以下 → 差し / それより後ろ → 追込
export function runningStyleOf(cornerText, fieldSize) {
  const pos = firstCornerPosition(cornerText);
  if (!pos || !fieldSize || fieldSize <= 0) return null;
  if (pos === 1) return "逃げ";
  const ratio = pos / fieldSize;
  if (ratio <= 1 / 3) return "先行";
  if (ratio <= 2 / 3) return "差し";
  return "追込";
}

// 複数走の脚質から代表脚質を決める(最多。同数ならより最近の走の脚質)。
// styles は新しい順の配列(null は判定不能として無視)。
export function dominantRunningStyle(styles) {
  const counts = new Map();
  const latestIndex = new Map();
  styles.forEach((s, i) => {
    if (!s) return;
    counts.set(s, (counts.get(s) || 0) + 1);
    if (!latestIndex.has(s)) latestIndex.set(s, i);
  });
  let best = null;
  for (const [s, c] of counts) {
    if (
      !best ||
      c > counts.get(best) ||
      (c === counts.get(best) && latestIndex.get(s) < latestIndex.get(best))
    ) {
      best = s;
    }
  }
  return best;
}

// 着別度数 [1着, 2着, 3着, 着外] へ1走ぶん加算する(取消・除外は数えない。
// 中止は着外。着順不明の finished は数えない)。
export function addPlacing(counts, status, finishPosition) {
  if (!RAN_STATUSES.has(status || "finished")) return;
  if ((status || "finished") === "stopped") {
    counts[3] += 1;
    return;
  }
  const fp = Number(finishPosition);
  if (!Number.isInteger(fp) || fp <= 0) return;
  if (fp <= 3) counts[fp - 1] += 1;
  else counts[3] += 1;
}

// race_stats_cache の1レースぶんの行(または race_results 行)から出走頭数
// (取消・除外を除く)を数える。行が無ければ fallback(entries の頭数等)を返す。
export function fieldSizeOf(rows, fallback = null) {
  if (Array.isArray(rows) && rows.length) {
    const n = rows.filter((r) => RAN_STATUSES.has(r.status || "finished")).length;
    if (n > 0) return n;
  }
  return fallback;
}

export function parseJsonSafe(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// races_cache の全レースから、重賞マスタのキーに一致するレースを抜き出す。
// nameKeys: キー1つ(文字列)またはキーの集合(保存済み name_key と、名前から計算し直したキー)。
// 冠(スポンサー名)付きのレース名(例「産経賞セントウルステークス」)も resolveGradedKey で一致させる
// (2026-10-06。それまでは gradedRaceNameKey の完全一致だけで、冠付き・ハンデキャップ表記の重賞が
// 拾えなかった)。
export function findRacesByGradedKey(allRaces, nameKeys) {
  const keys = nameKeys instanceof Set ? nameKeys : new Set([nameKeys].filter(Boolean));
  if (!keys.size) return [];
  const hasKey = (k) => keys.has(k);
  return allRaces.filter((r) => r.race_name && resolveGradedKey(gradedRaceNameKey(r.race_name), hasKey));
}

// 画面表示用のレース概要
export function raceSummaryOf(race) {
  if (!race) return null;
  return {
    id: race.id,
    race_date: race.race_date,
    track: race.track,
    race_number: race.race_number,
    race_name: race.race_name || null,
    course_type: race.course_type || null,
    distance: race.distance ?? null,
    weather: race.weather || null,
    track_condition: race.track_condition || null,
    post_time: race.post_time || null,
    weight_type: race.weight_type || null,
    class_flags: race.class_flags || null,
  };
}
