import {
  jsonError,
  getRaceTimes,
  buildTrackTrends,
  trendDistanceOptions,
  RACE_CLASSES,
  TRACK_CONDITIONS,
  TREND_MIN_RACES,
} from "../_shared.js";

// データ検索画面「競馬場傾向」タブ(2026-10-12追加)。
// GET /api/data-search/track-trends                                  → { distances: { 芝: [{distance, races}], ダート: [...], ... } }
// GET /api/data-search/track-trends?course_type=芝&distance=1600&class=all|maiden|1win|2win|3win|open
//   → { distances, condition: {course_type, distance, class}, conditions: ["良",...], min_races,
//       overall: { all: {n, avg}, 良: {...}, ... }, tracks: [{ track, all, 良, 稍重, 重, 不良 }] }
// 平均は勝ち馬(1着)のタイム(秒)。差(補正値)は画面側で全競馬場の平均との差として出す。
// 仕様は docs/design/data-search.md「競馬場傾向タブ」。
//
// D1の読み取り: 勝ちタイムの小さいキャッシュ(race_time_cache。範囲〈200レース〉ごとの行で約20行。2026-10-13〜。
// 以前は集計用の小さいキャッシュ race_lineup_cache を読んでいたが、読み込みのCPU時間が約9ミリ秒と重かった)だけ。
// races / race_results は読まない(キャッシュの作り直しが必要な範囲があるときだけ、その範囲を読む)。
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const lineups = await getRaceTimes(context.env.DB);
  const distances = trendDistanceOptions(lineups);

  const courseType = url.searchParams.get("course_type");
  const distanceRaw = url.searchParams.get("distance");
  if (!courseType && !distanceRaw) return Response.json({ distances });

  const distance = Number(distanceRaw);
  if (!courseType || !Number.isInteger(distance) || distance <= 0) return jsonError("芝ダ・距離の指定が不正です", 400);
  const cls = url.searchParams.get("class") || "all";
  if (cls !== "all" && !RACE_CLASSES.includes(cls)) return jsonError("クラスの指定が不正です", 400);

  const trends = buildTrackTrends(lineups, { courseType, distance, raceClass: cls === "all" ? null : cls });
  return Response.json({
    distances,
    condition: { course_type: courseType, distance, class: cls },
    conditions: TRACK_CONDITIONS,
    min_races: TREND_MIN_RACES,
    ...trends,
  });
}
