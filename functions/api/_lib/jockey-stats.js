// データ検索画面「騎手検索」タブ(2026-10-03追加)の集計処理。
// 仕様は docs/design/data-search.md「騎手検索タブ」。
//
// 集計用の小さいキャッシュ(race_lineup_cache。_lib/race-lineup-cache.js)から読み、メモリ上で集計する。
// race_results / races を直接全件SELECTしない
// (CLAUDE.md「レース単位のループで1件ずつ DB へ問い合わせない」「races全件を都度SELECTしない」)。
import { getRaceLineups } from "./race-lineup-cache.js";
import { loadJockeyAliasMap, applyJockeyAliasMap, jockeyAliasKeyOf } from "./jockey-alias.js";
import { jockeyDisplayName } from "./race-lineup.js";

// 全レースの「騎乗1回」ごとに fn({ key, display, race, pos }) を呼ぶ。
//   key     … 騎手の名寄せキー(エイリアス適用後の jockeyAliasKeyOf)
//   display … 表示名(見習い記号を除き空白を1つに畳んだ形)
//   race    … races の行(race_date / track / course_type / distance 等)
//   pos     … 1/2/3(3着以内)または null(着外)
// 着順ソースはレース成績タブと同じ規則(race_results が全頭ぶん揃っていればそれ、無ければ
// entries + finish_order)。出走しなかった馬(取消・除外)は呼ばない。障害レースも含める(騎手検索の仕様)。
// 2026-10-07: 以前は races_cache(約10MB)と race_stats_cache(約3.8MB)を丸ごと解析して
// buildRaceLineup() で組み立てており、CPU時間上限超過(exceededResources)の恐れがあったため、
// 出走馬の一覧を作り直し時に確定済みの集計用キャッシュ(_lib/race-lineup-cache.js)から読む形にした。
export async function forEachJockeyRide(db, fn) {
  const [races, aliasMap] = await Promise.all([getRaceLineups(db), loadJockeyAliasMap(db)]);
  // 同じ騎手名の変換は1回だけ行う(CPU時間の節約。騎手名は数百種類)
  const resolved = new Map(); // 生の騎手名 -> { key, display } | null
  const resolveJockey = (raw) => {
    if (resolved.has(raw)) return resolved.get(raw);
    const canon = applyJockeyAliasMap(aliasMap, raw);
    const key = jockeyAliasKeyOf(canon);
    const v = key ? { key, display: jockeyDisplayName(canon) } : null;
    resolved.set(raw, v);
    return v;
  };
  for (const race of races) {
    if (!race.lineup) continue;
    for (const [, jockey, pos] of race.lineup) {
      if (!jockey || !String(jockey).trim()) continue;
      const j = resolveJockey(String(jockey));
      if (!j) continue;
      fn({ key: j.key, display: j.display, race, pos });
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
