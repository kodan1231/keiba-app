// レース一覧用の軽いキャッシュ(races_index_cache。2026-10-07追加)。
// races の「一覧に要る列」だけを持つ(出走馬 entries・着順 finish_order・払戻 payouts の中身は持たず、
// 「結果確定済みか」「払戻レートがあるか」「出走頭数」「馬番未確定の馬がいるか」の印だけを持つ)。
// 仕様・経緯は docs/design/data-model.md「レース一覧用の軽いキャッシュ」。
//
// 背景: races_cache(races の全カラム。2026-10-07時点で約10MB)を丸ごと解析する処理が、
// Cloudflare Workers のCPU時間上限を超えるようになった(exceededResources)。さらに予想登録画面・
// レース管理画面は全レース・全出走馬を丸ごと画面に送っており、利用者の通信量も大きかった。
// 一覧に要る列だけのこのキャッシュに切り替え、出走馬等はレース1件ぶんだけ GET /api/races/:id で取る。
//
// 保存形式(2026-10-08〜。1行= races.id の範囲1つ分。_lib/range-chunk-cache.js):
//   {"v":2,"r":[[id, race_date, track, race_number, race_name, race_base_name, course_type, distance,
//     class_flags, weight_type, weather, track_condition, post_time,
//     has_finish_order(0/1), has_payout_rates(0/1), entry_count, has_unconfirmed_numbers(0/1)], ...]}
// 作り直しは DB から必要な列だけを読み、印は SQL(json_each 等)で計算する(大きなJSONを解析しない)。
// 保存の失敗は握りつぶす(best-effort)。無効化は DB トリガー(@STEP: range_chunk_caches。変わったレースの範囲の行だけ消す)。
// 2026-10-08: 以前は1行に詰められるだけ詰め、レースを1件変えると丸ごと作り直していた(1回約5.8万行の読み取り。
// json_each で展開した要素も読み取り行数に数えられる)。変わった範囲だけ作り直すようにした。

import { loadRangeChunks, rangeCondition, rangeIndexOf } from "./range-chunk-cache.js";

// 画面・APIに返すときの列名(保存形式の並びと同じ)
export const RACE_INDEX_FIELDS = [
  "id", "race_date", "track", "race_number", "race_name", "race_base_name", "course_type", "distance",
  "class_flags", "weight_type", "weather", "track_condition", "post_time",
  "has_finish_order", "has_payout_rates", "entry_count", "has_unconfirmed_numbers",
];

// キャッシュを読み、保存形式の配列(行の配列)を返す。並びは 開催日の新しい順→競馬場→R(以前の作り直しの SQL と同じ)。
export async function getRaceIndexRows(db) {
  const chunks = await loadRangeChunks(db, "races_index_cache", buildRaceIndexChunks);
  const rows = [];
  for (const c of chunks) for (const r of c.r || []) rows.push(r);
  // [1]=race_date, [2]=track, [3]=race_number。SQLite の並び(文字コード順)と同じになるよう < で比べる
  rows.sort((a, b) =>
    a[1] === b[1] ? (a[2] === b[2] ? (a[3] ?? 0) - (b[3] ?? 0) : String(a[2] ?? "") < String(b[2] ?? "") ? -1 : 1)
      : String(a[1] ?? "") < String(b[1] ?? "") ? 1 : -1);
  return rows;
}

// 行(配列)をオブジェクトへ。サーバー内で使う側(購入履歴のコース付与・重賞検索等)向け。
export function raceIndexRowToObject(row) {
  const o = {};
  RACE_INDEX_FIELDS.forEach((f, i) => { o[f] = row[i]; });
  return o;
}

export async function getRaceIndex(db) {
  return (await getRaceIndexRows(db)).map(raceIndexRowToObject);
}

// 指定した範囲(null は全件)のレースを読み、範囲ごとの payload({ r: [行, ...] })にする。
async function buildRaceIndexChunks(db, indices) {
  const cond = rangeCondition("id", indices);
  const { results } = await db.prepare(
    `SELECT id, race_date, track, race_number, race_name, race_base_name, course_type, distance,
            class_flags, weight_type, weather, track_condition, post_time,
            CASE WHEN finish_order IS NOT NULL AND finish_order <> '' AND finish_order <> 'null' THEN 1 ELSE 0 END AS has_finish_order,
            CASE WHEN json_valid(payouts) AND EXISTS (
                   SELECT 1 FROM json_each(payouts)
                    WHERE key <> 'refunds' AND type = 'array' AND json_array_length(value) > 0)
                 THEN 1 ELSE 0 END AS has_payout_rates,
            CASE WHEN json_valid(entries) THEN json_array_length(entries) ELSE 0 END AS entry_count,
            CASE WHEN json_valid(entries) AND EXISTS (
                   SELECT 1 FROM json_each(entries)
                    WHERE json_extract(value, '$.horse_number') IS NULL)
                 THEN 1 ELSE 0 END AS has_unconfirmed_numbers
       FROM races${cond ? ` WHERE ${cond.sql}` : ""}`
  ).bind(...(cond ? cond.binds : [])).all();
  const out = new Map();
  for (const r of results || []) {
    const i = rangeIndexOf(r.id);
    if (!out.has(i)) out.set(i, { r: [] });
    out.get(i).r.push(RACE_INDEX_FIELDS.map((f) => (r[f] === undefined ? null : r[f])));
  }
  return out;
}

