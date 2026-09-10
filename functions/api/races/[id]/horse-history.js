import {
  parsePositiveIntId,
  jsonError,
  horseAliasKeyOf,
  loadHorseAliasMap,
  applyHorseAliasMap,
} from "../../_shared.js";

// 予想登録画面(prediction.js)で、出走各馬の「過去成績(出走履歴)」を表示するための取得API。
// race_results(JRAレース結果PDF取込済みの馬単位の確定結果)を馬名で横断検索し、
// 今開いているレース自身を除く過去出走分を新しい順に全件返す。
//
// race_results / races はどちらも全ユーザー共有データのため、ログインしていれば
// 誰でも閲覧できる(races 本体・GET /api/races/:id/results と同じ扱い。requireAdmin しない)。
//
// 馬名の突き合わせ:
//   race_results.horse_name は取込時に空白正規化されておらず(parser の生値)、
//   races.entries 側の馬名と表記(半角/全角カナ・互換文字・空白)が食い違うことがある。
//   そこで両側を horseAliasKeyOf(NFKC + 全空白除去)＋ horse_aliases の明示エイリアスで
//   正規化したキーで突き合わせる(docs/design/horse-aliases.md 参照)。
//   SQLite では NFKC ができないため、race_results は「今のレース以外」を全件取得し
//   メモリで突き合わせる(1クエリ・サブリクエスト増なし。管理者以外も開く読み取りだが
//   低頻度。件数が問題になったら race_date 上限等でのバウンドを検討)。
//
// レスポンスのキーはクライアント(prediction.js の normalizeHorseName=空白を半角1つに畳む)
// が引ける形にする。

const normalizeName = (v) => String(v ?? "").replace(/[　\s]+/g, " ").trim();

export async function onRequestGet(context) {
  const { env, params } = context;
  const { id: raceId, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const race = await env.DB.prepare("SELECT entries FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);

  let entries = [];
  try { entries = JSON.parse(race.entries || "[]"); } catch {}

  const aliasMap = await loadHorseAliasMap(env.DB);

  // 突き合わせキー(正規化) -> レスポンスのキー(= クライアント突き合わせ用の正規化名)
  const keyMap = new Map();
  for (const e of entries) {
    const raw = e?.horse_name;
    if (raw === null || raw === undefined || raw === "") continue;
    const canon = applyHorseAliasMap(aliasMap, raw);
    const key = horseAliasKeyOf(canon);
    if (key && !keyMap.has(key)) keyMap.set(key, normalizeName(canon));
  }
  if (!keyMap.size) return Response.json({});

  // 今のレース以外の race_results を全件、races と JOIN して取得する。
  // field_size(頭数)は「実際に発走した頭数」= status finished/stopped のみを数える
  // (取消 scratched・除外 excluded は行が残るが発走していないので除く)。
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
      ORDER BY r.race_date DESC, r.race_number DESC`
  ).bind(raceId).all();

  const matched = [];
  const out = {};
  for (const row of results || []) {
    const rowKey = horseAliasKeyOf(applyHorseAliasMap(aliasMap, row.horse_name));
    const key = rowKey && keyMap.get(rowKey);
    if (!key) continue;
    matched.push(row);
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
        aliasCount: aliasMap.size,
        raceResultsTotalRows: totalRR?.n ?? 0,
        raceResultsScanned: (results || []).length,
        matchedRows: matched.length,
        looseLikeSamplesByHead3: likeSamples,
      },
    });
  }

  return Response.json(out);
}
