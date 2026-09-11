import {
  parsePositiveIntId,
  jsonError,
  horseAliasKeyOf,
  loadHorseAliasMap,
  applyHorseAliasMap,
} from "../../_shared.js";

// 予想登録画面(prediction.js)で、出走各馬の「過去成績(出走履歴)」を表示するための取得API。
// race_results(JRAレース結果PDF取込済みの馬単位の確定結果)を馬名で横断検索し、
// 今開いているレース自身を除く過去出走分を新しい順に最大5走まで返す。
//
// race_results / races はどちらも全ユーザー共有データのため、ログインしていれば
// 誰でも閲覧できる(races 本体・GET /api/races/:id/results と同じ扱い。requireAdmin しない)。
//
// 馬名の突き合わせ・read側の設計(2026-09-11。D1の日次行読み取り上限超過障害への対応):
//   以前は race_results を「今のレース以外」全件取得し、行ごとに horseAliasKeyOf で
//   正規化してメモリ突き合わせしていた(SQLiteはNFKCができないため)。これは race_results
//   が育つほど毎回ほぼ全件スキャンになり、GET1回あたり数十万行の読み取りに達して
//   D1無料枠の日次上限(500万行)超過の主因になった。
//   そこで race_results.horse_key(= horseAliasKeyOf(horse_name)。書き込み時に計算して
//   保存する列。docs/design/horse-aliases.md 参照)にインデックスを張り、出走各馬の
//   キーだけを WHERE horse_key IN (...) で直接引くようにした。
//   検索キーは「entry の正規化キー」に加えて「horse_aliases 側でそのentryの正しい馬名を
//   指しているエイリアスキー(逆引き)」も含める。これにより、race_results 側がまだ
//   旧表記のまま(horse_key が旧表記のキー)でも一致する(既存データの一括補正前でも動く)。
//   バインド数は「出走馬(最大18頭程度)× (1 + その馬のエイリアス数)」で自然に
//   100バインド上限内に収まる(CLAUDE.md の不変条件参照)。
//   馬ごとに最大5走までは ROW_NUMBER() OVER (PARTITION BY horse_key ...) でSQL側に
//   絞らせる(欠番なく直近5走)。field_size(出走頭数)は行ごとの相関サブクエリをやめ、
//   対象レース(最大でも出走馬数×5走ぶん)だけの GROUP BY 1本にまとめた。
//
// レスポンスのキーはクライアント(prediction.js の normalizeHorseName=空白を半角1つに畳む)
// が引ける形にする。

const normalizeName = (v) => String(v ?? "").replace(/[　\s]+/g, " ").trim();
const MAX_PAST_RACES_PER_HORSE = 5;

// D1の「1クエリ100バインドパラメータ」上限に備えたチャンク分割(CLAUDE.md参照)。
// 本APIでは実質発生しない規模だが、field_size集計用のrace_id集合(出走馬数×5走)は
// 理論上90に達し得るため、念のためチャンク化しておく。
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const { id: raceId, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const race = await env.DB.prepare("SELECT entries FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);

  let entries = [];
  try { entries = JSON.parse(race.entries || "[]"); } catch {}

  const aliasMap = await loadHorseAliasMap(env.DB);

  // 逆引き: 正しい馬名 -> それを指すエイリアスキー一覧(canonical_nameが同じもの同士)
  const reverseAliasKeys = new Map();
  for (const [aliasKey, canonicalName] of aliasMap) {
    let list = reverseAliasKeys.get(canonicalName);
    if (!list) { list = []; reverseAliasKeys.set(canonicalName, list); }
    list.push(aliasKey);
  }

  // 突き合わせキー(正規化) -> レスポンスのキー(= クライアント突き合わせ用の正規化名)
  const keyMap = new Map();
  // race_results.horse_key が取り得る値 -> その馬のkeyMapキー(検索キー集合)
  const searchKeyToEntryKey = new Map();
  for (const e of entries) {
    const raw = e?.horse_name;
    if (raw === null || raw === undefined || raw === "") continue;
    const canon = applyHorseAliasMap(aliasMap, raw);
    const key = horseAliasKeyOf(canon);
    if (!key) continue;
    if (!keyMap.has(key)) keyMap.set(key, normalizeName(canon));
    searchKeyToEntryKey.set(key, key);
    for (const aliasKey of reverseAliasKeys.get(canon) || []) {
      searchKeyToEntryKey.set(aliasKey, key);
    }
  }
  if (!keyMap.size) return Response.json({});

  const searchKeys = [...searchKeyToEntryKey.keys()];
  const placeholders = searchKeys.map(() => "?").join(",");

  // 出走各馬について、直近5走(欠番なく)だけをSQL側で確定する。
  const { results: rankedRows } = await env.DB.prepare(
    `WITH ranked AS (
       SELECT rr.horse_key, rr.horse_name, rr.status, rr.finish_position, rr.win_popularity,
              rr.jockey, rr.weight_carried, rr.body_weight, rr.body_weight_change,
              rr.time_text, rr.margin, rr.sex_age, rr.race_id,
              r.race_date, r.track, r.race_number, r.race_name, r.course_type, r.distance,
              ROW_NUMBER() OVER (
                PARTITION BY rr.horse_key
                ORDER BY r.race_date DESC, r.race_number DESC
              ) AS rn
         FROM race_results rr
         JOIN races r ON r.id = rr.race_id
        WHERE rr.horse_key IN (${placeholders})
          AND rr.race_id <> ?
     )
     SELECT * FROM ranked WHERE rn <= ${MAX_PAST_RACES_PER_HORSE}
     ORDER BY horse_key, race_date DESC, race_number DESC`
  ).bind(...searchKeys, raceId).all();

  const rows = rankedRows || [];

  // field_size(出走頭数)は、対象レース(最大でも出走馬数×5走ぶん)だけを一括集計する。
  const raceIdsNeeded = [...new Set(rows.map((r) => r.race_id))];
  const fieldSizeByRaceId = new Map();
  for (const idsChunk of chunk(raceIdsNeeded, 90)) {
    if (!idsChunk.length) continue;
    const ph = idsChunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT race_id, COUNT(*) AS field_size
         FROM race_results
        WHERE race_id IN (${ph}) AND status IN ('finished','stopped')
        GROUP BY race_id`
    ).bind(...idsChunk).all();
    for (const r of results || []) fieldSizeByRaceId.set(r.race_id, r.field_size);
  }

  const out = {};
  for (const row of rows) {
    const entryKey = searchKeyToEntryKey.get(row.horse_key);
    const displayKey = entryKey && keyMap.get(entryKey);
    if (!displayKey) continue;
    if (!out[displayKey]) out[displayKey] = [];
    out[displayKey].push({
      race_date: row.race_date,
      track: row.track,
      race_number: row.race_number,
      race_name: row.race_name || null,
      course_type: row.course_type || null,
      distance: row.distance ?? null,
      status: row.status || "finished",
      finish_position: row.finish_position ?? null,
      field_size: fieldSizeByRaceId.get(row.race_id) ?? null,
      win_popularity: row.win_popularity ?? null,
      jockey: row.jockey || null,
      weight_carried: row.weight_carried ?? null,
      body_weight: row.body_weight ?? null,
      body_weight_change: row.body_weight_change || null,
      time_text: row.time_text || null,
      margin: row.margin || null,
    });
  }

  // ?debug=1: 過去成績が空になる原因の切り分け用。
  const url = new URL(context.request.url);
  if (url.searchParams.get("debug") === "1") {
    const totalRR = await env.DB.prepare("SELECT COUNT(*) AS n FROM race_results").first();
    // 出走各馬の先頭3文字で race_results.horse_name を部分一致検索し、実際の馬名・
    // 出走レース・突き合わせ成否を返す(表記ゆれ or 未取込 の切り分け)。
    const likeSamples = {};
    for (const [key, displayName] of keyMap) {
      const head = displayName.replace(/[　\s]+/g, "").slice(0, 3);
      if (!head) continue;
      const { results: hits } = await env.DB.prepare(
        `SELECT rr.horse_name, rr.race_id, r.race_date, r.track, r.race_number
           FROM race_results rr LEFT JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_name LIKE ? LIMIT 5`
      ).bind(`%${head}%`).all();
      likeSamples[displayName] = (hits || []).map((h) => ({
        name: h.horse_name,
        matchesKey: horseAliasKeyOf(applyHorseAliasMap(aliasMap, h.horse_name)) === key,
        race: `${h.race_date || "?"} ${h.track || "?"}${h.race_number || "?"}R (race_id ${h.race_id})`,
      }));
    }
    return Response.json({
      _debug: {
        raceId,
        entryHorseNames: entries.map((e) => e?.horse_name ?? null),
        matchKeys: [...keyMap.entries()].map(([k, v]) => ({ key: k, display: v })),
        searchKeys,
        aliasCount: aliasMap.size,
        raceResultsTotalRows: totalRR?.n ?? 0,
        rankedRowsFetched: rows.length,
        looseLikeSamplesByHead3: likeSamples,
      },
    });
  }

  return Response.json(out);
}
