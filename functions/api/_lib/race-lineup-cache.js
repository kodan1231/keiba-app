// 集計用の小さいキャッシュ(race_lineup_cache。2026-10-07追加)。
// データ検索画面のレース成績タブ・騎手検索タブ向けに、各レースの「日付・競馬場・コース種別・
// 距離・単勝の値・馬連の値・出走した各馬の[馬番, 騎手, 着順]」だけを詰めて持つ。
// 仕様・経緯は docs/design/data-search.md「集計用の小さいキャッシュ」。
//
// 背景: 以前は races_cache(約10MB)と race_stats_cache(約3.8MB)を丸ごと解析して集計しており、
// 2026-10-07に Cloudflare Workers のCPU時間上限超過(exceededResources)で失敗するようになった。
//
// 保存形式(2026-10-08〜。1行= races.id の範囲1つ分。_lib/range-chunk-cache.js):
//   { "v": 3,
//     "j": [騎手名, ...],   // この行の中の騎手名の辞書
//     "r": [[id, race_date, track, course_type, distance, tan, umaren, lineup, win_time, track_condition, race_class], ...] }
//   lineup: 出走した馬だけを [馬番(0=不明), 騎手の辞書番号(-1=騎手不明), 着順(1〜3、着外0)] を平らに並べた配列。
//           着順データが取れないレースは null。
//   win_time: 勝ち馬(1着)のタイム(秒)。race_results に無ければ null。track_condition: 良/稍重/重/不良 か null。
//   race_class: raceClassOf()(maiden/1win/2win/3win/open)か null。
//   (2026-10-12: データ検索「競馬場傾向」タブ・予想登録画面の補正タイム用に win_time 以降を追加し、v を 3 にした。
//    v が違う行は全部作り直す〈1回だけ。races と race_results を全件読む〉)
//   (2026-10-13: 競馬場傾向・補正タイムは勝ちタイムの小さいキャッシュ race_time_cache を読むようにしたため、
//    win_time 以降は今は使っていない。版数を戻すと全件の作り直しが起きるので、そのまま残している)
//   (2026-10-14: 総合推奨馬の「性齢」「馬体重」用に lineup を [馬番, 騎手, 着順, 性齢コード, 馬体重帯] の5つ組にし、v を 4 にした。
//    性齢コード: sexAgeCodeOf(牡=1・牝=2・セ=3 を100倍+年齢。不明0)。馬体重帯: weightBandOf(1〜6。不明0)。
//    entries で補うレースは馬体重が無いので0)
//   (2026-10-15: 総合推奨馬の「週目」用に lineup を6つ組にし、6つ目に脚質の組〈1=逃げ・先行、2=差し・追込、0=不明。
//    最初のコーナーの通過順 ÷ 出走した頭数。runningStyleOf と同じ〉を足して v を 5 にした。entries で補うレースは0。
//    反映後に1回だけ全件作り直す〈races と race_results を全件読む〉)
//   (2026-10-27: 騎手検索タブの「脚質別成績」用に lineup を7つ組にし、7つ目に脚質〈1=逃げ・2=先行・3=差し・4=追込、0=不明。
//    styleCodeOf〉を足して v を 6 にした。6つ目の脚質の組はそのまま。反映後に1回だけ全件作り直す)
//
// 作り直しは DB から必要な列だけを読む(重いJSON解析をしない)。保存の失敗は握りつぶす(best-effort)。
// 無効化は DB トリガー(@STEP: range_chunk_caches。変わったレース・結果のレースの範囲の行だけ消す)。
// 2026-10-08: 以前はレースや結果を1件変えると丸ごと作り直しており(1回で race_results 約5万行を読む)、
// 編集・取込の多い日に数十回起きて D1 の1日の読み取り上限の92%に達した。変わった範囲だけ作り直すようにした。

import { loadRangeChunks, rangeCondition, rangeIndexOf } from "./range-chunk-cache.js";
import { memoized } from "./memo-cache.js";
import { raceClassOf } from "./race-classification.js";
import { timeTextToSeconds, runningStyleOf } from "./graded-race-search.js";

const LINEUP_CACHE_VERSION = 6;
const LINEUP_STRIDE = 7; // lineup の1頭あたりの数(v6〜。v5 は6、v4 は5)

// 脚質 → 脚質の組(1=逃げ・先行、2=差し・追込、0=不明)。総合推奨馬の「週目」で使う(2026-10-15)
export const STYLE_GROUP_LABELS = ["", "逃げ・先行", "差し・追込"];
export function styleGroupOf(style) {
  return style === "逃げ" || style === "先行" ? 1 : style === "差し" || style === "追込" ? 2 : 0;
}

// 脚質 → 脚質のコード(1=逃げ・2=先行・3=差し・4=追込、0=不明)。騎手検索の脚質別成績で使う(2026-10-27)
export const STYLE_CODE_LABELS = ["不明", "逃げ", "先行", "差し", "追込"];
export function styleCodeOf(style) {
  const i = STYLE_CODE_LABELS.indexOf(style);
  return i > 0 ? i : 0;
}

// 性齢("牡3" "牝4" "セ5")→ コード(牡=1・牝=2・セ=3 を100倍+年齢。例: 牝3 → 203)。読めなければ0。
const SEX_CODES = { 牡: 1, 牝: 2, セ: 3, 騸: 3 };
export function sexAgeCodeOf(text) {
  const m = String(text ?? "").normalize("NFKC").replace(/\s/g, "").match(/^(牡|牝|セ|騸)(\d{1,2})/);
  return m ? SEX_CODES[m[1]] * 100 + Number(m[2]) : 0;
}
export function sexAgeLabelOf(code) {
  return code > 0 ? `${["", "牡", "牝", "セ"][Math.floor(code / 100)] || ""}${code % 100}` : "";
}

// 馬体重(kg)→ 体重帯(〜439=1, 440-459=2, 460-479=3, 480-499=4, 500-519=5, 520〜=6)。不明0。
export const WEIGHT_BAND_LABELS = ["", "〜439kg", "440-459kg", "460-479kg", "480-499kg", "500-519kg", "520kg〜"];
export function weightBandOf(kg) {
  const w = Number(kg);
  if (!(w > 0)) return 0;
  return w < 440 ? 1 : w < 460 ? 2 : w < 480 ? 3 : w < 500 ? 4 : w < 520 ? 5 : 6;
}

// 馬場状態の表記をそろえる("稍" → "稍重")。それ以外の値は null。
export const TRACK_CONDITIONS = ["良", "稍重", "重", "不良"];
export function normalizeTrackConditionText(v) {
  const s = String(v ?? "").normalize("NFKC").trim();
  if (s === "稍") return "稍重";
  return TRACK_CONDITIONS.includes(s) ? s : null;
}

const RIDDEN_STATUSES = new Set(["finished", "stopped"]);
const FIELD_SEP = "\u001f"; // group_concat の項目区切り(馬名等に出てこない制御文字)
const ROW_SEP = "\u001e"; // group_concat の馬ごとの区切り

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// 勝ち馬(1着・完走)のタイム(秒)。結果が無い・タイムが読めないときは null。全頭そろっていなくてもよい。
function winnerTimeOf(rr) {
  if (!rr || !rr.packed) return null;
  for (const row of String(rr.packed).split(ROW_SEP)) {
    const f = row.split(FIELD_SEP);
    if ((f[2] || "finished") === "finished" && Number(f[3]) === 1) {
      const sec = timeTextToSeconds(f[4]);
      if (sec != null && sec > 0) return Math.round(sec * 10) / 10;
    }
  }
  return null;
}

// キャッシュを読み、レースの配列を返す(races.id の順)。
// 各要素: { id, race_date, track, course_type, distance, tan, umaren,
//           lineup: [[horse_number, jockey, pos, sexAgeCode, weightBand, styleGroup, styleCode], ...] | null, win_time, track_condition, race_class }
//   lineup は出走した馬だけ。pos は 1/2/3(3着以内)または null(着外)。sexAgeCode・weightBand・styleGroup・styleCode は不明なら0。
// 2026-10-13: 読み込み(JSON の解析と展開)に約9ミリ秒かかるため、同じ実行環境で60秒使い回す(_lib/memo-cache.js)。
// 取り込みの反映は最大60秒遅れる。戻り値の配列・要素は書き換えないこと(使い回すため)。
// 2026-10-14: 本番(4,667レース・6.3万騎乗)で読み込みが約15ミリ秒(解析7+展開8)になったため、lineup の展開は
// 初めて読まれたときにレースごとに行う(LineupRace の getter)。全レースを見ない処理は、競馬場等で絞ってから .lineup を読むこと。
// 平らな配列のまま速く数えたい処理(_lib/race-factors.js)は flat / dict / size を使う。
export const MEMO_RACE_LINEUPS = "race_lineups";
export { LINEUP_STRIDE };
export function getRaceLineups(db) {
  return memoized(MEMO_RACE_LINEUPS, async () => {
    const chunks = await loadRangeChunks(db, "race_lineup_cache", buildLineupChunks, { version: LINEUP_CACHE_VERSION, patch: patchLineupChunk }); // 変わったレースだけ差し替える(2026-10-16)
    const out = [];
    for (const c of chunks) {
      const dict = c.j || [];
      for (const x of c.r || []) out.push(new LineupRace(x, dict));
    }
    return out;
  }, 60 * 1000);
}

// 1レース分。lineup は読まれたときに展開して持つ。
//   flat: [馬番, 騎手の辞書番号, 着順(1〜3、着外0), 性齢コード, 馬体重帯, 脚質の組, 脚質のコード] の繰り返し(LINEUP_STRIDE ずつ)か null
//   dict: 騎手名の辞書(同じ範囲のレースで共有する配列)、size: 出走した頭数(flat が無ければ0)
class LineupRace {
  constructor(x, dict) {
    const [id, race_date, track, course_type, distance, tan, umaren, flat, win_time, track_condition, race_class] = x;
    this.id = id;
    this.race_date = race_date;
    this.track = track;
    this.course_type = course_type;
    this.distance = distance;
    this.tan = tan;
    this.umaren = umaren;
    this.win_time = win_time ?? null;
    this.track_condition = track_condition ?? null;
    this.race_class = race_class ?? null;
    this.flat = Array.isArray(flat) ? flat : null;
    this.dict = dict;
    this.size = this.flat ? this.flat.length / LINEUP_STRIDE : 0;
    this._lineup = undefined;
  }

  // [[horse_number, jockey, pos, sexAgeCode, weightBand, styleGroup, styleCode], ...] | null
  get lineup() {
    if (this._lineup !== undefined) return this._lineup;
    const flat = this.flat;
    let lineup = null;
    if (flat) {
      const dict = this.dict;
      lineup = [];
      for (let i = 0; i < flat.length; i += LINEUP_STRIDE) {
        const ji = flat[i + 1];
        lineup.push([flat[i] || null, ji >= 0 ? dict[ji] : null, flat[i + 2] || null, flat[i + 3] || 0, flat[i + 4] || 0, flat[i + 5] || 0, flat[i + 6] || 0]);
      }
    }
    return (this._lineup = lineup);
  }
}

// 範囲の payload({ j, r })から idSet のレースを除き、partial(そのレースたちだけで作った { j, r })を足す(2026-10-16)。
// partial の騎手の辞書番号は、範囲の辞書(j)の番号へ付け替える(辞書は足すだけ。使われなくなった名前は残るが小さい)
function patchLineupChunk(payload, idSet, partial) {
  const j = [...(payload?.j || [])];
  const index = new Map(j.map((name, i) => [name, i]));
  const rows = (payload?.r || []).filter((row) => !idSet.has(row[0]));
  const pj = partial?.j || [];
  for (const row of partial?.r || []) {
    const flat = row[7];
    let nextFlat = flat;
    if (Array.isArray(flat)) {
      nextFlat = flat.slice();
      for (let i = 0; i < nextFlat.length; i += LINEUP_STRIDE) {
        const ji = nextFlat[i + 1];
        if (!(ji >= 0)) continue;
        const name = pj[ji];
        let ni = index.get(name);
        if (ni === undefined) { ni = j.length; j.push(name); index.set(name, ni); }
        nextFlat[i + 1] = ni;
      }
    }
    const next = row.slice();
    next[7] = nextFlat;
    rows.push(next);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return { ...payload, j, r: rows };
}

// 指定した範囲(null は全件。{ ids } はそのレースだけ)のレースを読み、範囲ごとの payload({ j, r })にする。
async function buildLineupChunks(db, indices) {
  const raceCond = rangeCondition("id", indices);
  const rrCond = rangeCondition("race_id", indices);
  // races: 必要な列だけ。entries 本体は読まず頭数だけ(不正なJSONでSQLが失敗しないよう json_valid で守る)
  // 単勝・馬連の値(同着は平均。rate > 0 のものだけ)もSQL側で計算する(JSの解析を減らすため)。
  const [{ results: raceRows }, { results: rrRows }] = await Promise.all([
    db.prepare(
      `SELECT id, race_date, track, course_type, distance, finish_order, track_condition, class_flags, race_name,
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
                           IFNULL(status, '') || char(31) || IFNULL(finish_position, '') || char(31) ||
                           IFNULL(time_text, '') || char(31) || IFNULL(sex_age, '') || char(31) ||
                           IFNULL(body_weight, '') || char(31) || IFNULL(corner_positions, ''), char(30)) AS packed
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
    const pushHorse = (flat, hn, jockey, pos, sexAge, bodyWeight, style = null) => {
      let ji = -1;
      if (jockey) {
        ji = dictIndex.get(jockey);
        if (ji === undefined) { ji = chunk.j.length; dictIndex.set(jockey, ji); chunk.j.push(jockey); }
      }
      flat.push(hn > 0 ? hn : 0, ji, pos, sexAgeCodeOf(sexAge), weightBandOf(bodyWeight), styleGroupOf(style), styleCodeOf(style));
    };

    const rr = rrByRace.get(race.id);
    let flat = null;
    if (rr && race.entry_count > 0 && rr.n >= race.entry_count) {
      flat = [];
      const packed = String(rr.packed || "");
      // 脚質の組は「最初のコーナーの通過順 ÷ 出走した頭数」なので、先に出走した馬を集めてから詰める(2026-10-15)
      const ridden = [];
      let start = 0;
      while (start <= packed.length) {
        let end = packed.indexOf(ROW_SEP, start);
        if (end < 0) end = packed.length;
        const f1 = packed.indexOf(FIELD_SEP, start);
        const f2 = packed.indexOf(FIELD_SEP, f1 + 1);
        const f3 = packed.indexOf(FIELD_SEP, f2 + 1);
        const f4 = packed.indexOf(FIELD_SEP, f3 + 1); // 以降はタイム(2026-10-12追加)
        const f5 = packed.indexOf(FIELD_SEP, f4 + 1); // 以降は性齢・馬体重(2026-10-14追加)
        const f6 = packed.indexOf(FIELD_SEP, f5 + 1);
        const f7 = packed.indexOf(FIELD_SEP, f6 + 1); // 以降は通過順(2026-10-15追加)
        const status = packed.slice(f2 + 1, f3) || "finished";
        if (RIDDEN_STATUSES.has(status)) {
          const fp = Number(packed.slice(f3 + 1, f4));
          const bwEnd = f7 >= 0 && f7 < end ? f7 : end;
          ridden.push([Number(packed.slice(start, f1)) || 0, packed.slice(f1 + 1, f2), fp >= 1 && fp <= 3 ? fp : 0,
            packed.slice(f5 + 1, f6), packed.slice(f6 + 1, bwEnd), bwEnd < end ? packed.slice(bwEnd + 1, end) : ""]);
        }
        start = end + 1;
      }
      for (const [hn, jockey, pos, sexAge, bodyWeight, corners] of ridden) {
        pushHorse(flat, hn, jockey, pos, sexAge, bodyWeight, runningStyleOf(corners, ridden.length));
      }
    } else if (entriesById.has(race.id)) {
      const finishOrder = parseJson(race.finish_order, null);
      const entries = entriesById.get(race.id);
      if (Array.isArray(finishOrder) && finishOrder.length && Array.isArray(entries) && entries.length) {
        flat = [];
        for (const e of entries) {
          const i = finishOrder.indexOf(e.horse_number);
          pushHorse(flat, Number(e.horse_number) || 0, e.jockey || "", i >= 0 && i < 3 ? i + 1 : 0, e.sex_age, null);
        }
      }
    }
    chunk.r.push([race.id, race.race_date ?? null, race.track || null, race.course_type || null,
      numOrNull(race.distance), numOrNull(race.tan), numOrNull(race.umaren), flat,
      winnerTimeOf(rr), normalizeTrackConditionText(race.track_condition), raceClassOf(race)]);
  }
  return out;
}
