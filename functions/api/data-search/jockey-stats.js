import {
  jsonError,
  forEachJockeyRide,
  emptyRideCounts,
  addRide,
  finalizeRideCounts,
  jockeyAliasKeyOf,
  loadJockeyAliasMapCached,
  applyJockeyAliasMap,
  STYLE_CODE_LABELS,
} from "../_shared.js";

// データ検索画面「騎手検索」タブの騎手成績API(2026-10-03追加)。
// GET /api/data-search/jockey-stats?name=騎手名
// 通算・脚質別(2026-10-27)・年度別・コース別(競馬場×芝/ダート/障害×距離)の騎乗数・着度数・単勝率・連対率・複勝率。
// races / race_results は全ユーザー共有データのため requireAdmin しない。
// 詳細は docs/design/data-search.md「騎手検索タブ」参照。
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) return jsonError("騎手名を指定してください", 400);
  if (name.length > 40) return jsonError("騎手名が長すぎます", 400);

  // 指定された名前もエイリアス適用後のキーで突き合わせる(一覧APIと同じ名寄せ)。
  const aliasMap = await loadJockeyAliasMapCached(env.DB);
  const targetKey = jockeyAliasKeyOf(applyJockeyAliasMap(aliasMap, name));
  if (!targetKey) return jsonError("騎手名が不正です", 400);

  let displayName = null;
  let from = null;
  let to = null;
  const total = emptyRideCounts();
  const byStyle = STYLE_CODE_LABELS.map(() => emptyRideCounts()); // 脚質のコード(0=不明・1=逃げ〜4=追込) -> counts
  const byYear = new Map(); // year -> counts
  const byCourse = new Map(); // "track|course_type|distance" -> { track, course_type, distance, counts }

  await forEachJockeyRide(env.DB, ({ key, display, race, pos, style }) => {
    if (key !== targetKey) return;
    if (!displayName) displayName = display;
    const date = race.race_date || "";
    if (date) {
      if (!from || date < from) from = date;
      if (!to || date > to) to = date;
    }

    addRide(total, pos);
    addRide(byStyle[byStyle[style] ? style : 0], pos);

    const year = Number(date.slice(0, 4));
    if (Number.isInteger(year) && year > 0) {
      if (!byYear.has(year)) byYear.set(year, emptyRideCounts());
      addRide(byYear.get(year), pos);
    }

    const track = race.track || null;
    const courseType = race.course_type || null;
    const distance = race.distance ?? null;
    const courseKey = `${track}|${courseType}|${distance}`;
    let c = byCourse.get(courseKey);
    if (!c) {
      c = { track, course_type: courseType, distance, counts: emptyRideCounts() };
      byCourse.set(courseKey, c);
    }
    addRide(c.counts, pos);
  });

  if (!total.rides) return jsonError("該当する騎手の騎乗データがありません", 404);

  return Response.json({
    name: displayName,
    period: { from, to },
    total: finalizeRideCounts(total),
    // 逃げ → 先行 → 差し → 追込 → 不明。騎乗0の脚質は省く
    byStyle: [1, 2, 3, 4, 0]
      .filter((code) => byStyle[code].rides)
      .map((code) => ({ style: STYLE_CODE_LABELS[code], ...finalizeRideCounts(byStyle[code]) })),
    byYear: [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, counts]) => ({ year, ...finalizeRideCounts(counts) })),
    byCourse: [...byCourse.values()]
      .map((c) => ({ track: c.track, course_type: c.course_type, distance: c.distance, ...finalizeRideCounts(c.counts) }))
      .sort((a, b) => b.rides - a.rides || String(a.track).localeCompare(String(b.track), "ja") || (a.distance ?? 0) - (b.distance ?? 0)),
  });
}
