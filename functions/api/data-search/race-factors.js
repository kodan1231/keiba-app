import {
  jsonError,
  parsePositiveIntId,
  parseJsonSafe,
  loadHorseAliasMapCached,
  buildHorseSearchKeys,
  applyHorseAliasMap,
  horseAliasKeyOf,
  loadJockeyAliasMapCached,
  getRaceLineups,
  getRaceTimes,
  createFactorContext,
  computeRaceFactors,
  FACTOR_KEYS, GLOBAL_ADJUST_KEYS,
  getPaceScoreSettings,
  getPaceWeights,
  prevYearGradedRaceId,
  loadGradedRaceMapCached,
  gradedRaceOf,
} from "../_shared.js";

// 予想登録画面「展開・時計」タブの総合推奨馬・推奨馬(2026-10-13追加)。
// GET /api/data-search/race-factors?race_id=N
//   → { pace_type, counts: { nige, senko, unknown, n }, horses: [{ horse_name, horse_number, waku_number, jockey,
//        factors: { pace|number|jockey|time|sexage|weight|course: { score, rank, value, missing } } }] }(後ろ3つは2026-10-14追加)
// 点数の規則は _lib/race-factors.js(重賞の比率の自動算出と同じ1か所)。仕様は docs/design/screens.md「総合推奨馬」。
// /api/data-search/ の下なので、使用量が多い日の自動一時停止(データ検索)の対象。
//
// D1の読み取り: races 1行 + 出走馬の全戦績(race_results の horse_key インデックス。18頭×数十走で数百行)+
//   集計用キャッシュ・勝ちタイムのキャッシュ(各約20行。同じ実行環境で60秒使い回す)+ 評価点を選ぶための比率の行(主キーで最大3行。2026-10-14)
//   + 重賞一覧(2分使い回し)+(重賞のときだけ)前年の同レースを探す重賞1行+レース一覧のキャッシュ約20行。展開・時計タブを開いたときにレースごとに1回。
// 評価点(初距離・初競馬場・継続騎乗。2026-10-14)は、このレースの重賞・コースの評価点(_lib/pace-score.js の getPaceWeights の adjust)、
//   無ければ設定の既定値を掛ける。value に「初距離−10」等を足し、タイム・騎手の順位は掛けた後の点で付け直す。
// バインド数: 出走馬の名寄せキー(最大18頭 ×〈1+その馬のエイリアス数〉)+ 1。horse-best と同じく100バインド上限内。
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
  if (error) return error;

  const race = await db
    .prepare("SELECT id, race_date, track, course_type, distance, race_name, class_flags, entries FROM races WHERE id = ?")
    .bind(raceId)
    .first();
  if (!race) return jsonError("レースが見つかりません", 404);
  // 出走取消の印(entries[].scratched。2026-10-15)の馬は採点・ペース予想から外す
  const entries = (parseJsonSafe(race.entries, []) || []).filter((e) => e && e.horse_name && !e.scratched);
  if (!entries.length || !race.course_type || !race.distance || !race.race_date) {
    return Response.json({ pace_type: null, counts: null, horses: [] });
  }

  const [horseAliasMap, jockeyAliasMap, lineups, raceTimes, scoreSettings, gradedMap] = await Promise.all([
    loadHorseAliasMapCached(db),
    loadJockeyAliasMapCached(db),
    getRaceLineups(db),
    getRaceTimes(db),
    getPaceScoreSettings(db), // データ無しの点・評価点の既定値(2026-10-14。app_settings 1行。2分使い回し)
    loadGradedRaceMapCached(db),
  ]);
  const graded = gradedRaceOf(gradedMap, race);
  const [weights, prevRaceId] = await Promise.all([
    getPaceWeights(db, graded ? graded.id : 0, race),
    graded ? prevYearGradedRaceId(db, graded.id, race) : null,
  ]);
  // 重賞・コースの評価点に無い項目(後から足した前年の同レース等)は設定の既定値
  // 間隔(2026-10-15)など全レース共通の項目は、いつも設定の既定値
  const adjust = { ...scoreSettings.adjust, ...(weights.adjust || {}) };
  for (const k of GLOBAL_ADJUST_KEYS) adjust[k] = scoreSettings.adjust[k];
  const { searchKeyToKey } = buildHorseSearchKeys(horseAliasMap, entries.map((e) => e.horse_name));
  const searchKeys = [...searchKeyToKey.keys()];
  const runsByHorse = new Map();
  if (searchKeys.length) {
    const { results } = await db
      .prepare(
        `SELECT rr.horse_key, rr.race_id, rr.status, rr.finish_position, rr.corner_positions, rr.time_text, rr.final_furlong_time,
                rr.body_weight, rr.jockey, r.race_date, r.race_number, r.track, r.course_type, r.distance, r.track_condition
           FROM race_results rr JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_key IN (${searchKeys.map(() => "?").join(",")}) AND r.race_date < ?`
      )
      .bind(...searchKeys, race.race_date)
      .all();
    for (const row of results || []) {
      const key = searchKeyToKey.get(row.horse_key);
      if (!key) continue;
      if (!runsByHorse.has(key)) runsByHorse.set(key, []);
      runsByHorse.get(key).push(row);
    }
  }

  const keyOfEntry = (e) => horseAliasKeyOf(applyHorseAliasMap(horseAliasMap, e.horse_name));
  const runners = entries.map((e) => ({ key: keyOfEntry(e), horse_number: e.horse_number ?? null, jockey: e.jockey || null, sex_age: e.sex_age || null }));
  const ctx = createFactorContext(lineups, raceTimes, jockeyAliasMap);
  const rf = computeRaceFactors(ctx, race, runners, runsByHorse, { missingScore: scoreSettings.missing_score, adjust, prevRaceId });

  const horses = entries.map((e, i) => {
    const key = runners[i].key;
    const factors = {};
    for (const f of FACTOR_KEYS) {
      const v = rf.factors[f].get(key);
      factors[f] = { score: Math.round(v.score * 10) / 10, rank: v.rank, value: v.value, missing: v.missing };
    }
    // total_adjust: 総合点(軸指数・相手指数)へ直接足す点と内訳(間隔。2026-10-15。無ければ value 0)
    const ta = rf.totalAdjust.get(key) || { value: 0, note: "" };
    return { horse_name: e.horse_name, horse_number: e.horse_number ?? null, waku_number: e.waku_number ?? null, jockey: e.jockey || null, factors, total_adjust: ta };
  });
  return Response.json({ pace_type: rf.pace_type, counts: rf.counts, horses });
}
