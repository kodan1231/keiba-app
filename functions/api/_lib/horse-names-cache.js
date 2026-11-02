// 馬名ごとのレース数のキャッシュ(horse_names_cache。2026-10-08追加)。
// データ検索「馬情報検索」タブの候補(GET /api/data-search/horse-search)と、管理画面の登録馬一覧
// (GET /api/admin/horses)で使う。仕様・経緯は docs/design/data-model.md「キャッシュを範囲ごとに作り直す」。
//
// 背景: 2026-10-07 に両方を「全レースの出走表を SQL の json_each で展開して数える」形にしたところ、展開した
// 出走馬1頭ずつが D1 の読み取り行数に数えられ、1回約10万行になった(馬情報検索は入力のたびに走る)。
// 2026-10-08 に D1 の1日の読み取り上限を超える原因の一つになった。
//
// races.id の範囲(200件)ごとの行で持ち、変わったレースだけ差し替える(_lib/range-chunk-cache.js)。
// 保存形式(2026-11-02〜 v3): { "v": 3,
//   "e": [[race_id, 表記, 表記, ...], ...],   // races.entries の horse_name(レースごと・重複なし)
//   "r": [[race_id, 表記, 表記, ...], ...] }  // race_results.horse_name(同上)
// 表記はエイリアス適用前の保存済みの表記のまま(呼び出し側でエイリアス・突き合わせキーを通す)。
// 無効化は DB トリガー(cache_dirty)。
// 2026-11-02: 以前(v2)は範囲ごと・表記ごとのレース数([表記, 数])で持っており、レースごとに差し替えられないため、
// 変わったレースのある範囲(200レース分・約6千行)を作り直していた。過去分の取り込みの日は多くの範囲が変わり、
// 10/28 は全範囲の作り直し12回で約376万行、10/31 は範囲の作り直し12回で約81万行を読んだ。
// レースごとの形にしてほかのキャッシュと同じ差し替え(1レース数十行)にした。大きさは v2 の約461万文字に対し約400万文字の見込み
// (1つの範囲に同じ馬が2回出ることは少なく、[表記, 数] の数の分が無くなるため)。

import { loadRangeChunks, rangeCondition, rangeIndexOf } from "./range-chunk-cache.js";
import { memoized } from "./memo-cache.js";

const PAYLOAD_VERSION = 3;

// 戻り値: { entries: Map<表記, レース数>, results: Map<表記, レース数> }(全範囲の合計)
// 2026-10-13: 読み込みと合算(約144万文字・約2万頭分)に手元で約38ミリ秒かかり、馬情報検索は入力のたびに呼ばれるため、
// 同じ実行環境で60秒使い回す(_lib/memo-cache.js)。取り込みの反映は最大60秒遅れる。戻り値の Map は書き換えないこと(使い回すため)。
export const MEMO_HORSE_NAME_COUNTS = "horse_name_counts";
// 一度に変わったレースが差し替えの上限(range-chunk-cache の MAX_PATCH_RACES)を超えたとき(一括補正の直後など)は範囲を作り直すが、
// その作り直しは10分に1回までにまとめる(2026-10-16。馬情報検索の候補・登録馬一覧はその間、最大10分遅れて反映される)
const HORSE_NAMES_MIN_REBUILD_MS = 10 * 60 * 1000;
export function getHorseNameCounts(db) {
  return memoized(MEMO_HORSE_NAME_COUNTS, async () => {
    const chunks = await loadRangeChunks(db, "horse_names_cache", buildHorseNameChunks, {
      version: PAYLOAD_VERSION,
      patch: patchHorseNames,
      minRebuildMs: HORSE_NAMES_MIN_REBUILD_MS,
    });
    const entries = new Map();
    const results = new Map();
    for (const c of chunks) {
      for (const row of c.e || []) for (let k = 1; k < row.length; k++) entries.set(row[k], (entries.get(row[k]) || 0) + 1);
      for (const row of c.r || []) for (let k = 1; k < row.length; k++) results.set(row[k], (results.get(row[k]) || 0) + 1);
    }
    return { entries, results };
  }, 60 * 1000);
}

// 範囲の payload から idSet のレースを除き、partial のレースを足す(e・r の両方)
function patchHorseNames(payload, idSet, partial) {
  const merge = (rows, add) => {
    const out = (rows || []).filter((row) => !idSet.has(row[0]));
    for (const row of add || []) out.push(row);
    return out.sort((a, b) => a[0] - b[0]);
  };
  return { ...payload, e: merge(payload?.e, partial?.e), r: merge(payload?.r, partial?.r) };
}

// indices: 範囲の番号の配列・null(全件)・{ ids }(そのレースだけ。差し替え用)
async function buildHorseNameChunks(db, indices) {
  const raceCond = rangeCondition("r.id", indices);
  const rrCond = rangeCondition("race_id", indices);
  // レースごとの表記を SQL で重複なしにして受け取る。json_each で展開した要素は読み取り行数に数えられるが、
  // 読むのは変わったレース(差し替え)か作り直す範囲(200レース分)だけ
  const [{ results: entryRows }, { results: rrRows }] = await Promise.all([
    db.prepare(
      `SELECT DISTINCT r.id AS id, json_extract(e.value, '$.horse_name') AS name
         FROM races r, json_each(r.entries) e
        WHERE json_valid(r.entries)${raceCond ? ` AND (${raceCond.sql})` : ""}`
    ).bind(...(raceCond ? raceCond.binds : [])).all(),
    db.prepare(
      `SELECT DISTINCT race_id AS id, horse_name AS name
         FROM race_results
        WHERE horse_name IS NOT NULL AND horse_name <> ''${rrCond ? ` AND (${rrCond.sql})` : ""}`
    ).bind(...(rrCond ? rrCond.binds : [])).all(),
  ]);
  const byRace = { e: new Map(), r: new Map() }; // race_id -> [race_id, 表記...]
  const add = (kind, id, name) => {
    const m = byRace[kind];
    if (!m.has(id)) m.set(id, [id]);
    m.get(id).push(String(name));
  };
  for (const row of entryRows || []) {
    if (row.name === null || row.name === undefined || row.name === "") continue;
    add("e", Number(row.id), row.name);
  }
  for (const row of rrRows || []) add("r", Number(row.id), row.name);
  const out = new Map();
  for (const kind of ["e", "r"]) {
    for (const [id, row] of byRace[kind]) {
      const ci = rangeIndexOf(id);
      if (!out.has(ci)) out.set(ci, { e: [], r: [] });
      out.get(ci)[kind].push(row);
    }
  }
  for (const p of out.values()) { p.e.sort((a, b) => a[0] - b[0]); p.r.sort((a, b) => a[0] - b[0]); }
  return out;
}
