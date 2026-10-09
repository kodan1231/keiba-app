// 馬名ごとのレース数のキャッシュ(horse_names_cache。2026-10-08追加)。
// データ検索「馬情報検索」タブの候補(GET /api/data-search/horse-search)と、管理画面の登録馬一覧
// (GET /api/admin/horses)で使う。仕様・経緯は docs/design/data-model.md「キャッシュを範囲ごとに作り直す」。
//
// 背景: 2026-10-07 に両方を「全レースの出走表を SQL の json_each で展開して数える」形にしたところ、展開した
// 出走馬1頭ずつが D1 の読み取り行数に数えられ、1回約10万行になった(馬情報検索は入力のたびに走る)。
// 2026-10-08 に D1 の1日の読み取り上限を超える原因の一つになった。
//
// races.id の範囲(200件)ごとの行で持ち、変わったレース・結果の範囲だけ作り直す(_lib/range-chunk-cache.js)。
// 保存形式: { "v": 2,
//   "e": [[表記, その範囲で出走表に載ったレース数], ...],     // races.entries の horse_name
//   "r": [[表記, その範囲で結果に載ったレース数], ...] }      // race_results.horse_name
// 表記はエイリアス適用前の保存済みの表記のまま(呼び出し側でエイリアス・突き合わせキーを通す)。
// 無効化は DB トリガー(@STEP: range_chunk_caches)。

import { loadRangeChunks, rangeCondition, RANGE_SIZE } from "./range-chunk-cache.js";

// 戻り値: { entries: Map<表記, レース数>, results: Map<表記, レース数> }(全範囲の合計)
export async function getHorseNameCounts(db) {
  const chunks = await loadRangeChunks(db, "horse_names_cache", buildHorseNameChunks);
  const entries = new Map();
  const results = new Map();
  for (const c of chunks) {
    for (const [name, n] of c.e || []) entries.set(name, (entries.get(name) || 0) + n);
    for (const [name, n] of c.r || []) results.set(name, (results.get(name) || 0) + n);
  }
  return { entries, results };
}

async function buildHorseNameChunks(db, indices) {
  const raceCond = rangeCondition("r.id", indices);
  const rrCond = rangeCondition("race_id", indices);
  // 範囲ごと・表記ごとの数を SQL で数える(JS では大きな JSON を解析しない)。
  // json_each で展開した要素は読み取り行数に数えられるが、作り直すのは変わった範囲(200レース分)だけ。
  const [{ results: entryRows }, { results: rrRows }] = await Promise.all([
    db.prepare(
      `SELECT r.id / ${RANGE_SIZE} AS ci, json_extract(e.value, '$.horse_name') AS name, COUNT(DISTINCT r.id) AS n
         FROM races r, json_each(r.entries) e
        WHERE json_valid(r.entries)${raceCond ? ` AND (${raceCond.sql})` : ""}
        GROUP BY ci, name`
    ).bind(...(raceCond ? raceCond.binds : [])).all(),
    db.prepare(
      `SELECT race_id / ${RANGE_SIZE} AS ci, horse_name AS name, COUNT(DISTINCT race_id) AS n
         FROM race_results
        WHERE horse_name IS NOT NULL AND horse_name <> ''${rrCond ? ` AND (${rrCond.sql})` : ""}
        GROUP BY ci, name`
    ).bind(...(rrCond ? rrCond.binds : [])).all(),
  ]);
  const out = new Map();
  const chunk = (ci) => {
    if (!out.has(ci)) out.set(ci, { e: [], r: [] });
    return out.get(ci);
  };
  for (const row of entryRows || []) {
    if (row.name === null || row.name === undefined || row.name === "") continue;
    chunk(Number(row.ci)).e.push([String(row.name), Number(row.n) || 0]);
  }
  for (const row of rrRows || []) chunk(Number(row.ci)).r.push([String(row.name), Number(row.n) || 0]);
  return out;
}
