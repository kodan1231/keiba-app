import {
  jsonError,
  parsePositiveIntId,
  parseJsonSafe,
  getRaceLineups,
  loadJockeyAliasMapCached,
  applyJockeyAliasMap,
  jockeyAliasKeyOf,
  jockeyDisplayName,
  emptyRideCounts,
  addRide,
  finalizeRideCounts,
} from "../_shared.js";

// 予想登録画面「展開・時計」タブの「騎手の同コース成績」(2026-10-12追加)。
// GET /api/data-search/jockey-course?race_id=N
// そのレースに騎乗する各騎手の、同じ競馬場・芝ダ障・距離での成績(このレースより前の取り込み済み全期間)。
// 仕様は docs/design/screens.md「予想登録画面」の「展開・時計」。
// /api/data-search/ の下に置き、使用量が多い日の自動一時停止(service-guard の data_search)の対象にする。
//
// D1の読み取り: races を主キーで1行(出走馬・コース)+ 集計用の小さいキャッシュ race_lineup_cache
// (範囲〈200レース〉ごとの行。全部で約20行)+ 騎手名エイリアス(2分使い回し)。races / race_results は
// 全件SELECTしない。数え方は騎手検索タブ(forEachJockeyRide)と同じ: 出走した馬だけ・1〜3着以外は着外。
// 騎手名はエイリアスを通して名寄せする(見習い記号は jockeyAliasKeyOf で除く)。
//
// レスポンス: { condition: { track, course_type, distance } | null,
//   jockeys: [{ horse_number, waku_number, horse_name, jockey, stats: { rides, first, second, third, other,
//              winRate, quinellaRate, showRate } | null }] }(出走馬の並び。騎手が空欄の馬は stats: null)

export async function onRequestGet(context) {
  const { env, request } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
  if (error) return error;

  const target = await db
    .prepare("SELECT id, race_date, track, course_type, distance, entries FROM races WHERE id = ?")
    .bind(raceId)
    .first();
  if (!target) return jsonError("レースが見つかりません", 404);

  const entries = (parseJsonSafe(target.entries, []) || []).filter((e) => e && e.horse_name);
  if (!target.track || !target.course_type || !target.distance) {
    return Response.json({ condition: null, jockeys: [] });
  }
  const condition = { track: target.track, course_type: target.course_type, distance: Number(target.distance) };

  const aliasMap = await loadJockeyAliasMapCached(db);
  const keyOf = (name) => jockeyAliasKeyOf(applyJockeyAliasMap(aliasMap, name));
  const counts = new Map(); // 騎手キー -> 集計
  for (const e of entries) {
    const k = e.jockey ? keyOf(e.jockey) : "";
    if (k && !counts.has(k)) counts.set(k, emptyRideCounts());
  }

  if (counts.size) {
    const lineups = await getRaceLineups(db);
    const keyCache = new Map(); // 生の騎手名 -> キー(同じ名前の変換は1回だけ)
    for (const r of lineups) {
      if (
        !r.lineup ||
        Number(r.id) === raceId ||
        !(String(r.race_date) < String(target.race_date)) ||
        r.track !== condition.track ||
        r.course_type !== condition.course_type ||
        Number(r.distance) !== condition.distance
      ) continue;
      for (const [, jockey, pos] of r.lineup) {
        if (!jockey) continue;
        let k = keyCache.get(jockey);
        if (k === undefined) {
          k = keyOf(jockey);
          keyCache.set(jockey, k);
        }
        const c = k && counts.get(k);
        if (c) addRide(c, pos);
      }
    }
  }

  const jockeys = entries.map((e) => {
    const k = e.jockey ? keyOf(e.jockey) : "";
    return {
      horse_number: e.horse_number ?? null,
      waku_number: e.waku_number ?? null,
      horse_name: e.horse_name,
      jockey: e.jockey ? jockeyDisplayName(applyJockeyAliasMap(aliasMap, e.jockey)) : null,
      stats: k ? finalizeRideCounts(counts.get(k)) : null,
    };
  });
  return Response.json({ condition, jockeys });
}
