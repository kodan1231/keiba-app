// データ検索画面「騎手検索」タブ(2026-10-03追加)の集計処理。
// 仕様は docs/design/data-search.md「騎手検索タブ」。
//
// races は races_cache、race_results は race_stats_cache(いずれも事前計算キャッシュ)から
// 読み、メモリ上で集計する。race_results / races を直接全件SELECTしない
// (CLAUDE.md「レース単位のループで1件ずつ DB へ問い合わせない」「races全件を都度SELECTしない」)。
import { getAllRacesRaw } from "./races-cache.js";
import { getRaceResultsGroupedByRaceId } from "./race-stats-cache.js";
import { loadJockeyAliasMap, applyJockeyAliasMap, jockeyAliasKeyOf } from "./jockey-alias.js";
import { buildRaceLineup, jockeyDisplayName } from "./race-lineup.js";

function parseJson(text, fallback) {
  if (!text) return fallback;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// 全レースの「騎乗1回」ごとに fn({ key, display, race, pos }) を呼ぶ。
//   key     … 騎手の名寄せキー(エイリアス適用後の jockeyAliasKeyOf)
//   display … 表示名(見習い記号を除き空白を1つに畳んだ形)
//   race    … races の行(race_date / track / course_type / distance 等)
//   pos     … 1/2/3(3着以内)または null(着外)
// 着順ソースはレース成績タブと同じ buildRaceLineup()(race_results が全頭ぶん揃っていれば
// それ、無ければ entries + finish_order)。出走しなかった馬(取消・除外)は呼ばない。
// 障害レースも含める(騎手検索の仕様)。
export async function forEachJockeyRide(db, fn) {
  const [raceRows, rrByRace, aliasMap] = await Promise.all([
    getAllRacesRaw(db),
    getRaceResultsGroupedByRaceId(db),
    loadJockeyAliasMap(db),
  ]);
  for (const race of raceRows || []) {
    const entries = parseJson(race.entries, []) || [];
    const finishOrder = parseJson(race.finish_order, null);
    const lineup = buildRaceLineup(Array.isArray(entries) ? entries : [], finishOrder, rrByRace[race.id]);
    if (!lineup) continue;
    for (const h of lineup) {
      if (!h.ran || !h.jockey || !String(h.jockey).trim()) continue;
      const canon = applyJockeyAliasMap(aliasMap, String(h.jockey));
      const key = jockeyAliasKeyOf(canon);
      if (!key) continue;
      fn({ key, display: jockeyDisplayName(canon), race, pos: h.pos });
    }
  }
}

export function emptyRideCounts() {
  return { rides: 0, first: 0, second: 0, third: 0 };
}

export function addRide(counts, pos) {
  counts.rides++;
  if (pos === 1) counts.first++;
  else if (pos === 2) counts.second++;
  else if (pos === 3) counts.third++;
}

// 着外・各率を付けた出力用の形にする。
export function finalizeRideCounts(c) {
  const top3 = c.first + c.second + c.third;
  return {
    rides: c.rides,
    first: c.first,
    second: c.second,
    third: c.third,
    other: c.rides - top3,
    winRate: c.rides ? c.first / c.rides : 0,
    quinellaRate: c.rides ? (c.first + c.second) / c.rides : 0,
    showRate: c.rides ? top3 / c.rides : 0,
  };
}
