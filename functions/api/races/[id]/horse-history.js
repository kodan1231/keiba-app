import { parsePositiveIntId, jsonError } from "../../_shared.js";

// 予想登録画面(prediction.js)で、出走各馬の「過去成績(出走履歴)」を表示するための取得API。
// race_results(JRAレース結果PDF取込済みの馬単位の確定結果)を馬名で横断検索し、
// 今開いているレース自身を除く過去出走分を新しい順に全件返す。
//
// race_results / races はどちらも全ユーザー共有データのため、ログインしていれば
// 誰でも閲覧できる(races 本体・GET /api/races/:id/results と同じ扱い。requireAdmin しない)。
//
// 突き合わせキーは馬名。ただし race_results.horse_name は取込時に空白正規化されて
// おらず(parser の生値。全角/半角スペースの入り方がまちまち)、races.entries 側の
// 馬名(出走馬一覧PDF由来。mergeEntriesByHorseName で正規化済み)と単純一致しないことが
// ある。そこで「空白を全部除去した文字列」を突き合わせキーにする(JRAの馬名は全国で
// 一意なので、空白を落としても別馬と衝突しない)。SQL 側は replace() で列の空白を
// 除去して IN 比較する。バインド数は出走頭数で自然にバウンドされ、D1 の 1クエリ
// 100バインドパラメータ上限に収まる(18頭 + 1)。
//
// レスポンスのキーはクライアント(prediction.js の normalizeHorseName)が引ける
// 「空白を半角1つに畳んだ馬名」にする。

const normalizeName = (v) => String(v ?? "").replace(/[　\s]+/g, " ").trim();
const stripSpaces = (v) => String(v ?? "").replace(/[　\s]+/g, "");

export async function onRequestGet(context) {
  const { env, params } = context;
  const { id: raceId, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const race = await env.DB.prepare("SELECT entries FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);

  let entries = [];
  try { entries = JSON.parse(race.entries || "[]"); } catch {}

  // 空白除去キー -> レスポンスのキー(= クライアント突き合わせ用の正規化名)
  const keyMap = new Map();
  for (const e of entries) {
    const raw = e?.horse_name;
    if (raw === null || raw === undefined || raw === "") continue;
    const stripped = stripSpaces(raw);
    if (stripped && !keyMap.has(stripped)) keyMap.set(stripped, normalizeName(raw));
  }
  if (!keyMap.size) return Response.json({});
  const strippedKeys = [...keyMap.keys()];

  const placeholders = strippedKeys.map(() => "?").join(",");
  // 頭数(field_size)は相関サブクエリで数える。過去レースIDの集合は使い込むと増えるため、
  // race_id を IN で渡す方式にすると 100バインド上限に抵触しうる。JOIN + 相関サブクエリで
  // クエリ1本にまとめることで、バインドを出走馬名の集合(頭数バウンド)だけに抑える。
  //
  // field_size(頭数)は「実際に発走した頭数」を出すため status='finished'/'stopped'(中止=
  // 発走はしている)だけを数える。取消(scratched)・除外(excluded)は race_results に行が
  // 残るが発走していないので除く。結果PDF未取込のレースは race_results 行が無く JOIN から
  // 落ちるため、そもそもこの一覧には出ない。
  const { results } = await env.DB.prepare(
    `SELECT rr.horse_name, rr.status, rr.finish_position, rr.win_popularity,
            rr.jockey, rr.weight_carried, rr.body_weight, rr.body_weight_change,
            rr.time_text, rr.margin, rr.sex_age,
            r.race_date, r.track, r.race_number, r.race_name, r.course_type, r.distance,
            (SELECT COUNT(*) FROM race_results x
              WHERE x.race_id = rr.race_id AND x.status IN ('finished','stopped')) AS field_size
       FROM race_results rr
       JOIN races r ON r.id = rr.race_id
      WHERE rr.race_id <> ?
        AND replace(replace(rr.horse_name, '　', ''), ' ', '') IN (${placeholders})
      ORDER BY r.race_date DESC, r.race_number DESC`
  ).bind(raceId, ...strippedKeys).all();

  // ?debug=1: 過去成績が空になる原因の切り分け用。
  const url = new URL(context.request.url);
  if (url.searchParams.get("debug") === "1") {
    const { results: dbg } = await env.DB.prepare(
      `SELECT replace(replace(rr.horse_name, '　', ''), ' ', '') AS k, COUNT(*) AS n
         FROM race_results rr
        WHERE rr.race_id <> ?
          AND replace(replace(rr.horse_name, '　', ''), ' ', '') IN (${placeholders})
        GROUP BY k`
    ).bind(raceId, ...strippedKeys).all();
    const counts = Object.fromEntries((dbg || []).map((r) => [r.k, r.n]));
    const totalRR = await env.DB.prepare("SELECT COUNT(*) AS n FROM race_results").first();
    const namedRR = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM race_results WHERE horse_name IS NOT NULL AND horse_name <> ''"
    ).first();
    // 突き合わせキーの先頭3文字での部分一致で、race_results 側の実際の馬名を拾う
    // (空白違い以外のズレ=異体字・半角カナ等を目視できるように、生の horse_name と
    //  そのレースの日付/場/Rも返す)
    const likeSamples = {};
    for (const k of strippedKeys) {
      const head = k.slice(0, 3);
      if (!head) continue;
      const { results: hits } = await env.DB.prepare(
        `SELECT rr.horse_name, rr.race_id, r.race_date, r.track, r.race_number
           FROM race_results rr LEFT JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_name LIKE ? LIMIT 5`
      ).bind(`%${head}%`).all();
      likeSamples[k] = (hits || []).map((h) => ({
        name: h.horse_name,
        matchesStrippedKey: stripSpaces(h.horse_name) === k,
        race: `${h.race_date || "?"} ${h.track || "?"}${h.race_number || "?"}R (race_id ${h.race_id})`,
      }));
    }
    return Response.json({
      _debug: {
        raceId,
        entryHorseNames: entries.map((e) => e?.horse_name ?? null),
        strippedKeys,
        raceResultsTotalRows: totalRR?.n ?? 0,
        raceResultsRowsWithName: namedRR?.n ?? 0,
        exactMatchCounts: counts,
        looseLikeSamplesByHead3: likeSamples,
        joinedRows: (results || []).length,
      },
    });
  }

  const out = {};
  for (const row of results || []) {
    const key = keyMap.get(stripSpaces(row.horse_name));
    if (!key) continue;
    if (!out[key]) out[key] = [];
    out[key].push({
      race_date: row.race_date,
      track: row.track,
      race_number: row.race_number,
      race_name: row.race_name || null,
      course_type: row.course_type || null,
      distance: row.distance ?? null,
      status: row.status || "finished",
      finish_position: row.finish_position ?? null,
      field_size: row.field_size ?? null,
      win_popularity: row.win_popularity ?? null,
      jockey: row.jockey || null,
      weight_carried: row.weight_carried ?? null,
      body_weight: row.body_weight ?? null,
      body_weight_change: row.body_weight_change || null,
      time_text: row.time_text || null,
      margin: row.margin || null,
    });
  }
  return Response.json(out);
}
