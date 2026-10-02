import {
  parsePositiveIntId,
  jsonError,
  loadHorseAliasMap,
  buildHorseSearchKeys,
  timeTextToSeconds,
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
//   track_condition, finish_position }。キーは prediction.js の normalizeHorseName と同じ形。

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

  const aliasMap = await loadHorseAliasMap(env.DB);
  const { canonByKey, searchKeyToKey } = buildHorseSearchKeys(aliasMap, entries.map((e) => e?.horse_name));
  const keyMap = new Map([...canonByKey].map(([k, canon]) => [k, normalizeName(canon)]));
  if (!keyMap.size) return Response.json({ condition: null, horses: {}, pedigree: {} });

  // 父・母(馬柱の馬の列に出す。2026-10-03追加)。horses(馬情報マスタ)に保存済みの分だけを返し、
  // netkeiba への取得はしない(未登録は画面側で「不明」)。horses.horse_key は正しい馬名の
  // horseAliasKeyOf で、canonByKey のキーと同じ。キー数は出走頭数(最大18)で100バインド内。
  const pedigree = {};
  const masterKeys = [...canonByKey.keys()];
  const { results: masterRows } = await env.DB.prepare(
    `SELECT horse_key, sire, dam FROM horses WHERE horse_key IN (${masterKeys.map(() => "?").join(",")})`
  ).bind(...masterKeys).all();
  for (const r of masterRows || []) {
    const name = keyMap.get(r.horse_key);
    if (name) pedigree[name] = { sire: r.sire || null, dam: r.dam || null };
  }

  // 今回のコース種別・距離が未登録なら「同条件」を決められないため持ちタイムは空で返す。
  if (!race.course_type || !race.distance || !race.race_date) {
    return Response.json({ condition: null, horses: {}, pedigree });
  }
  const condition = { track: race.track || null, course_type: race.course_type, distance: race.distance };

  const searchKeys = [...searchKeyToKey.keys()];
  const placeholders = searchKeys.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT rr.horse_key, rr.time_text, rr.final_furlong_time, rr.finish_position,
            r.race_date, r.track, r.race_name, r.track_condition
       FROM race_results rr
       JOIN races r ON r.id = rr.race_id
      WHERE rr.horse_key IN (${placeholders})
        AND rr.status = 'finished'
        AND r.course_type = ?
        AND r.distance = ?
        AND r.race_date < ?`
  ).bind(...searchKeys, race.course_type, race.distance, race.race_date).all();

  // 1つの走を集計枠(all / track)へ反映する。最速タイム・最速上がりはそれぞれ別の走でもよい。
  const consider = (slot, row, base) => {
    const sec = timeTextToSeconds(row.time_text);
    if (sec != null && (!slot.time || sec < slot.time.seconds)) {
      slot.time = { time_text: row.time_text, seconds: sec, ...base };
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
      horses[name] = { all: { time: null, last3f: null }, track: { time: null, last3f: null } };
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
  }

  return Response.json({ condition, horses, pedigree });
}
