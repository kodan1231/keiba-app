import {
  parsePositiveIntId,
  jsonError,
  loadHorseAliasMapCached,
  buildHorseSearchKeys,
  timeTextToSeconds,
  loadJockeyAliasMapCached,
  applyJockeyAliasMap,
  jockeyDisplayName,
  getRaceTimes,
  buildTrackTrends,
  trackTimeOffsets,
  correctRunTime,
  normalizeTrackConditionText,
} from "../../_shared.js";

// 予想登録画面の馬柱表示(近5走)で、馬名と前走の間に出す「同条件の持ちタイム・上がり」の取得API
// (2026-10-03追加)。GET /api/races/:id/horse-best
//
// 同条件 = 今回のレースと同じ芝/ダート/障害(course_type)・同じ距離。これを
//   all   … 競馬場は問わない(データ検索「重賞検索」タブの「持ちタイム(同距離)」と同じ定義)
//   track … さらに今回と同じ競馬場(重賞検索タブの「持ちタイム(同コース)」と同じ定義)
// の2通りで集計して返す(2026-10-03。当初は all のみだったが、同場と全場を並べて見たいとの要望で追加)。
//   - 対象は今回のレースの開催日より前の、status='finished' の走のみ(取消・除外・中止は除く)
//   - 持ちタイム = time_text を秒に換算して最速の走。上がり = final_furlong_time が最速の走
//   - 直近5走に限らず全過去走が対象(そのため horse-history とは別のAPIにした)
//
// 読み取りは race_results.horse_key のインデックスで出走各馬の行だけを引く(horse-history と
// 同じ設計。races/race_results を全件スキャンしない)。バインド数は
// 「出走馬(最大18頭程度)× (1 + その馬のエイリアス数)」+ 3 で、horse-history と同じく
// 100バインド上限内に収まる(CLAUDE.md の不変条件参照)。
// races / race_results は全ユーザー共有データのため requireAdmin しない。
//
// レスポンス:
//   { condition: { track, course_type, distance } | null,
//     pedigree: { <正規化馬名>: { sire, dam } }(horses に保存済みの馬のみ。2026-10-03追加),
//     horses: { <正規化馬名>: { all:   { time: {...} | null, last3f: {...} | null },
//                               track: { time: {...} | null, last3f: {...} | null } } } }
//   time / last3f は { time_text, seconds | last3f, race_date, track, race_name,
//   track_condition, finish_position }。time には、その走の上がり3F run_last3f・斤量 weight_carried・騎手 jockey(無ければ null)も付く。
//   corrected(2026-10-12追加): 全場・同距離の走のうち、今回の競馬場・良馬場に換算したタイムが最速の走。time と同じ項目に
//   corrected_seconds(換算後)・adj(足した補正値)・partial(補正値が出せず一部0で計算した)を足したもの。無ければ null。キーは prediction.js の normalizeHorseName と同じ形。

const normalizeName = (v) => String(v ?? "").replace(/[　\s]+/g, " ").trim();

export async function onRequestGet(context) {
  const { env, params } = context;
  const { id: raceId, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const race = await env.DB.prepare(
    "SELECT entries, track, course_type, distance, race_date FROM races WHERE id = ?"
  ).bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);

  let entries = [];
  try { entries = JSON.parse(race.entries || "[]"); } catch {}

  const aliasMap = await loadHorseAliasMapCached(env.DB);
  const { canonByKey, searchKeyToKey } = buildHorseSearchKeys(aliasMap, entries.map((e) => e?.horse_name));
  const keyMap = new Map([...canonByKey].map(([k, canon]) => [k, normalizeName(canon)]));
  if (!keyMap.size) return Response.json({ condition: null, horses: {}, pedigree: {} });

  // 父・母(馬柱の馬の列に出す。2026-10-03追加)。horses(馬情報マスタ)に保存済みの分だけを返し、
  // netkeiba への取得はしない(未登録は画面側で「不明」)。horses.horse_key は正しい馬名の
  // horseAliasKeyOf で、canonByKey のキーと同じ。キー数は出走頭数。重賞の特別登録を手で入れると上限が無い(2026-10-15)ため90件ずつ。
  const pedigree = {};
  const masterKeys = [...canonByKey.keys()];
  const masterRows = [];
  for (let i = 0; i < masterKeys.length; i += 90) {
    const keys = masterKeys.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT horse_key, sire, dam FROM horses WHERE horse_key IN (${keys.map(() => "?").join(",")})`
    ).bind(...keys).all();
    masterRows.push(...(results || []));
  }
  for (const r of masterRows) {
    const name = keyMap.get(r.horse_key);
    if (name) pedigree[name] = { sire: r.sire || null, dam: r.dam || null };
  }

  // 今回のコース種別・距離が未登録なら「同条件」を決められないため持ちタイムは空で返す。
  if (!race.course_type || !race.distance || !race.race_date) {
    return Response.json({ condition: null, horses: {}, pedigree });
  }
  const condition = { track: race.track || null, course_type: race.course_type, distance: race.distance };

  const searchKeys = [...searchKeyToKey.keys()];
  // 出走馬の馬名+逆引きエイリアス。特別登録では頭数に上限が無いため90件ずつ(+3)
  const results = [];
  for (let i = 0; i < searchKeys.length; i += 90) {
    const keysChunk = searchKeys.slice(i, i + 90);
    const placeholders = keysChunk.map(() => "?").join(",");
    const { results: chunkRows } = await env.DB.prepare(
      `SELECT rr.horse_key, rr.time_text, rr.final_furlong_time, rr.finish_position, rr.weight_carried, rr.jockey,
              r.race_date, r.track, r.race_name, r.track_condition
         FROM race_results rr
         JOIN races r ON r.id = rr.race_id
        WHERE rr.horse_key IN (${placeholders})
          AND rr.status = 'finished'
          AND r.course_type = ?
          AND r.distance = ?
          AND r.race_date < ?`
    ).bind(...keysChunk, race.course_type, race.distance, race.race_date).all();
    results.push(...(chunkRows || []));
  }

  // 騎手名は表示用なのでエイリアスを2分使い回す版で正しい表記へ寄せる(_lib/memo-cache.js)。
  const jockeyAliasMap = await loadJockeyAliasMapCached(env.DB);

  // 補正タイム(2026-10-12追加。docs/design/data-search.md「競馬場傾向タブ」): 全場・同距離の各走を、
  // 競馬場・馬場の補正値で「今回の競馬場・良馬場」のタイムに換算し、換算後が最速の走を corrected に入れる。
  // 補正値は勝ちタイムの小さいキャッシュ(race_time_cache。約20行。同じ実行環境で60秒使い回す)から全クラスの勝ちタイムで出す。
  // 2026-10-13: 当初は集計用の小さいキャッシュ race_lineup_cache を読んでいたが、読み込みのCPU時間が約9ミリ秒と
  // 無料枠の上限(10ミリ秒)に近かったため、必要な列だけの別キャッシュにした。
  const offsets = trackTimeOffsets(buildTrackTrends(await getRaceTimes(env.DB), { courseType: race.course_type, distance: race.distance }));

  // そのタイムを出した走の情報。run_last3f・weight_carried・jockey は2026-10-12追加(展開・時計タブの表で表示)
  const timeInfo = (row, sec, base) => {
    const runL3 = Number(row.final_furlong_time);
    const w = Number(row.weight_carried);
    return {
      time_text: row.time_text, seconds: sec, run_last3f: row.final_furlong_time != null && runL3 > 0 ? runL3 : null,
      weight_carried: row.weight_carried != null && w > 0 ? w : null,
      jockey: row.jockey ? jockeyDisplayName(applyJockeyAliasMap(jockeyAliasMap, row.jockey)) : null,
      ...base,
    };
  };

  // 1つの走を集計枠(all / track)へ反映する。最速タイム・最速上がりはそれぞれ別の走でもよい。
  const consider = (slot, row, base) => {
    const sec = timeTextToSeconds(row.time_text);
    if (sec != null && (!slot.time || sec < slot.time.seconds)) {
      slot.time = timeInfo(row, sec, base);
    }
    const l3 = Number(row.final_furlong_time);
    if (row.final_furlong_time != null && Number.isFinite(l3) && l3 > 0 && (!slot.last3f || l3 < slot.last3f.last3f)) {
      slot.last3f = { last3f: l3, ...base };
    }
  };

  const horses = {};
  for (const row of results || []) {
    const entryKey = searchKeyToKey.get(row.horse_key);
    const name = entryKey && keyMap.get(entryKey);
    if (!name) continue;
    if (!horses[name]) {
      horses[name] = { all: { time: null, last3f: null }, track: { time: null, last3f: null }, corrected: null };
    }
    const base = {
      race_date: row.race_date,
      track: row.track || null,
      race_name: row.race_name || null,
      track_condition: row.track_condition || null,
      finish_position: row.finish_position ?? null,
    };
    consider(horses[name].all, row, base);
    if (race.track && row.track === race.track) consider(horses[name].track, row, base);

    const sec = timeTextToSeconds(row.time_text);
    if (sec != null && race.track) {
      const c = correctRunTime(sec, { runTrack: row.track, runCondition: normalizeTrackConditionText(row.track_condition), targetTrack: race.track }, offsets);
      const cur = horses[name].corrected;
      if (!cur || c.seconds < cur.corrected_seconds) {
        horses[name].corrected = { ...timeInfo(row, sec, base), corrected_seconds: c.seconds, adj: c.adj, partial: c.partial };
      }
    }
  }

  return Response.json({ condition, horses, pedigree });
}
