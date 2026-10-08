// 集計用の小さいキャッシュ(race_lineup_cache。2026-10-07追加)。
// データ検索画面のレース成績タブ・騎手検索タブ向けに、各レースの「日付・競馬場・コース種別・
// 距離・単勝の値・馬連の値・出走した各馬の[馬番, 騎手, 着順]」だけを詰めて持つ。
// 仕様・経緯は docs/design/data-search.md「集計用の小さいキャッシュ」。
//
// 背景: 以前は races_cache(約10MB)と race_stats_cache(約3.8MB)を丸ごと解析して集計しており、
// 2026-10-07に Cloudflare Workers のCPU時間上限超過(exceededResources)で失敗するようになった。
//
// 保存形式(2026-10-08〜。1行= races.id の範囲1つ分。_lib/range-chunk-cache.js):
//   { "v": 2,
//     "j": [騎手名, ...],   // この行の中の騎手名の辞書
//     "r": [[id, race_date, track, course_type, distance, tan, umaren, lineup], ...] }
//   lineup: 出走した馬だけを [馬番(0=不明), 騎手の辞書番号(-1=騎手不明), 着順(1〜3、着外0)] を平らに並べた配列。
//           着順データが取れないレースは null。
//
// 作り直しは DB から必要な列だけを読む(重いJSON解析をしない)。保存の失敗は握りつぶす(best-effort)。
// 無効化は DB トリガー(@STEP: range_chunk_caches。変わったレース・結果のレースの範囲の行だけ消す)。
// 2026-10-08: 以前はレースや結果を1件変えると丸ごと作り直しており(1回で race_results 約5万行を読む)、
// 編集・取込の多い日に数十回起きて D1 の1日の読み取り上限の92%に達した。変わった範囲だけ作り直すようにした。

import { loadRangeChunks, rangeCondition, rangeIndexOf } from "./range-chunk-cache.js";

const RIDDEN_STATUSES = new Set(["finished", "stopped"]);
const FIELD_SEP = "\u001f"; // group_concat の項目区切り(馬名等に出てこない制御文字)
const ROW_SEP = "\u001e"; // group_concat の馬ごとの区切り

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// キャッシュを読み、レースの配列を返す(races.id の順)。
// 各要素: { id, race_date, track, course_type, distance, tan, umaren,
//           lineup: [[horse_number, jockey, pos], ...] | null }
//   lineup は出走した馬だけ。pos は 1/2/3(3着以内)または null(着外)。
export async function getRaceLineups(db) {
  const chunks = await loadRangeChunks(db, "race_lineup_cache", buildLineupChunks);
  const out = [];
  for (const c of chunks) for (const x of c.r || []) out.push(expandRace(x, c.j || []));
  return out;
}

function expandRace(x, dict) {
  const [id, race_date, track, course_type, distance, tan, umaren, flat] = x;
  let lineup = null;
  if (Array.isArray(flat)) {
    lineup = [];
    for (let i = 0; i < flat.length; i += 3) {
      const ji = flat[i + 1];
      lineup.push([flat[i] || null, ji >= 0 ? dict[ji] : null, flat[i + 2] || null]);
    }
  }
  return { id, race_date, track, course_type, distance, tan, umaren, lineup };
}

// 指定した範囲(null は全件)のレースを読み、範囲ごとの payload({ j, r })にする。
async function buildLineupChunks(db, indices) {
  const raceCond = rangeCondition("id", indices);
  const rrCond = rangeCondition("race_id", indices);
  // races: 必要な列だけ。entries 本体は読まず頭数だけ(不正なJSONでSQLが失敗しないよう json_valid で守る)
  // 単勝・馬連の値(同着は平均。rate > 0 のものだけ)もSQL側で計算する(JSの解析を減らすため)。
  const [{ results: raceRows }, { results: rrRows }] = await Promise.all([
    db.prepare(
      `SELECT id, race_date, track, course_type, distance, finish_order,
              CASE WHEN json_valid(payouts) AND json_type(payouts, '$.tan') = 'array' THEN
                (SELECT AVG(CAST(json_extract(value, '$.rate') AS REAL)) FROM json_each(payouts, '$.tan')
                  WHERE CAST(json_extract(value, '$.rate') AS REAL) > 0) END AS tan,
              CASE WHEN json_valid(payouts) AND json_type(payouts, '$.umaren') = 'array' THEN
                (SELECT AVG(CAST(json_extract(value, '$.rate') AS REAL)) FROM json_each(payouts, '$.umaren')
                  WHERE CAST(json_extract(value, '$.rate') AS REAL) > 0) END AS umaren,
              CASE WHEN json_valid(entries) THEN json_array_length(entries) ELSE 0 END AS entry_count
         FROM races${raceCond ? ` WHERE ${raceCond.sql}` : ""}
        ORDER BY id`
    ).bind(...(raceCond ? raceCond.binds : [])).all(),
    // race_results: race_id ごとに1行へまとめた文字列
    db.prepare(
      `SELECT race_id, COUNT(*) AS n,
              group_concat(IFNULL(horse_number, '') || char(31) || IFNULL(jockey, '') || char(31) ||
                           IFNULL(status, '') || char(31) || IFNULL(finish_position, ''), char(30)) AS packed
         FROM race_results${rrCond ? ` WHERE ${rrCond.sql}` : ""} GROUP BY race_id`
    ).bind(...(rrCond ? rrCond.binds : [])).all(),
  ]);
  const rrByRace = new Map();
  for (const r of rrRows || []) rrByRace.set(r.race_id, r);

  // race_results が全頭そろっていないレースのうち、finish_order があるものは entries で補う
  // (レース成績タブ「③④⑤ 共通」と同じ規則)。対象レース数はデータ次第で数百に達しうるため90件ずつ読む。
  const needEntries = [];
  for (const race of raceRows || []) {
    const rr = rrByRace.get(race.id);
    const complete = rr && race.entry_count > 0 && rr.n >= race.entry_count;
    if (!complete && race.finish_order && race.entry_count > 0) needEntries.push(race.id);
  }
  const entriesById = new Map();
  for (let i = 0; i < needEntries.length; i += 90) {
    const ids = needEntries.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id, entries FROM races WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    for (const r of results || []) entriesById.set(r.id, parseJson(r.entries, []));
  }

  // 範囲ごとに、騎手名の辞書+平らな配列に詰める
  const out = new Map(); // chunk_index -> { j, r }
  const dictIndexByChunk = new Map();
  const numOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const race of raceRows || []) {
    const ci = rangeIndexOf(race.id);
    if (!out.has(ci)) { out.set(ci, { j: [], r: [] }); dictIndexByChunk.set(ci, new Map()); }
    const chunk = out.get(ci);
    const dictIndex = dictIndexByChunk.get(ci);
    const pushHorse = (flat, hn, jockey, pos) => {
      let ji = -1;
      if (jockey) {
        ji = dictIndex.get(jockey);
        if (ji === undefined) { ji = chunk.j.length; dictIndex.set(jockey, ji); chunk.j.push(jockey); }
      }
      flat.push(hn > 0 ? hn : 0, ji, pos);
    };

    const rr = rrByRace.get(race.id);
    let flat = null;
    if (rr && race.entry_count > 0 && rr.n >= race.entry_count) {
      flat = [];
      const packed = String(rr.packed || "");
      let start = 0;
      while (start <= packed.length) {
        let end = packed.indexOf(ROW_SEP, start);
        if (end < 0) end = packed.length;
        const f1 = packed.indexOf(FIELD_SEP, start);
        const f2 = packed.indexOf(FIELD_SEP, f1 + 1);
        const f3 = packed.indexOf(FIELD_SEP, f2 + 1);
        const status = packed.slice(f2 + 1, f3) || "finished";
        if (RIDDEN_STATUSES.has(status)) {
          const fp = Number(packed.slice(f3 + 1, end));
          pushHorse(flat, Number(packed.slice(start, f1)) || 0, packed.slice(f1 + 1, f2), fp >= 1 && fp <= 3 ? fp : 0);
        }
        start = end + 1;
      }
    } else if (entriesById.has(race.id)) {
      const finishOrder = parseJson(race.finish_order, null);
      const entries = entriesById.get(race.id);
      if (Array.isArray(finishOrder) && finishOrder.length && Array.isArray(entries) && entries.length) {
        flat = [];
        for (const e of entries) {
          const i = finishOrder.indexOf(e.horse_number);
          pushHorse(flat, Number(e.horse_number) || 0, e.jockey || "", i >= 0 && i < 3 ? i + 1 : 0);
        }
      }
    }
    chunk.r.push([race.id, race.race_date ?? null, race.track || null, race.course_type || null,
      numOrNull(race.distance), numOrNull(race.tan), numOrNull(race.umaren), flat]);
  }
  return out;
}
