// races の id の範囲ごとに分けて持つ事前計算キャッシュの共通処理(2026-10-08追加)。
// レース一覧用の軽いキャッシュ(races_index_cache)・集計用の小さいキャッシュ(race_lineup_cache)で使う。
// 仕様・経緯は docs/design/data-model.md「キャッシュを範囲ごとに作り直す」。
//
// 背景: 以前はレースや結果を1件でも変えるとキャッシュが丸ごと消え、次に使われたときに全レース・
// 全結果(race_results 約5万行)を読み直していた。レースの編集・取込が多い日に作り直しが数十回起き、
// 2026-10-08 に D1 の1日の読み取り上限の92%に達した。
//
// 仕組み:
//   - 1行(chunk_index)= races.id が [chunk_index*RANGE_SIZE, (chunk_index+1)*RANGE_SIZE) のレース分。
//     1行に入るのは最大 RANGE_SIZE レース分なので、1行の大きさは数十〜数百KBに収まり、D1 の
//     1行2MBの上限には届かない(念のため CHUNK_MAX_BYTES を超える行は保存しない)。
//   - DB トリガーは、変わったレース(または結果のレース)の行だけを消す(@STEP: range_chunk_caches)。
//     トリガーが古い(表を丸ごと消す)ままでも、全部の行を作り直すだけで正しく動く。
//   - 読むときは全行を読み、足りない範囲(消えた行)だけを DB から読み直して保存する(best-effort)。
//   - payload は {"v":2, ...}。v が無い行(以前の、バイト数で区切っていた形式)があれば全部作り直す。

export const RANGE_SIZE = 200;
const CHUNK_MAX_BYTES = 1_500_000;
const PAYLOAD_VERSION = 2;
// 足りない範囲がこれより多いときは、範囲を指定せず全件を読む(IN/BETWEEN の条件が長くなりすぎないように)
const MAX_RANGES_PER_QUERY = 20;

// 保存に失敗したときの予備(2026-10-08)。D1 の書き込み上限・一時的な不調等でキャッシュを保存できないと、
// 画面を開くたびに同じ範囲を作り直し、読み取りが膨らんで読み取り上限まで超える(2026-09-12 の races_cache 障害と
// 同じ構図)。保存できなかった範囲は、作り直した内容をこの実行環境のメモリに FALLBACK_TTL_MS だけ持ち、
// その間は作り直さずに使う(その間にデータが変わっても反映が最大この時間遅れる)。
const FALLBACK_TTL_MS = 5 * 60 * 1000;
const fallback = new Map(); // table -> Map<chunk_index, { at, payload }>

function fallbackGet(table, i) {
  const f = fallback.get(table)?.get(i);
  return f && Date.now() - f.at < FALLBACK_TTL_MS ? f.payload : null;
}
function fallbackPut(table, entries) {
  if (!fallback.has(table)) fallback.set(table, new Map());
  const m = fallback.get(table);
  const at = Date.now();
  for (const [i, payload] of entries) m.set(i, { at, payload });
}

export function rangeIndexOf(id) {
  return Math.floor(Number(id) / RANGE_SIZE);
}

// 足りない範囲 → SQL の条件。null は「全件」。
// 戻り値: { sql: "(col BETWEEN ? AND ?) OR ...", binds: [...] }(連続する範囲はまとめる。バインド数は最大 2×20=40)
export function rangeCondition(column, indices) {
  if (!indices) return null;
  const sorted = [...indices].sort((a, b) => a - b);
  const spans = [];
  for (const i of sorted) {
    const last = spans[spans.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else spans.push([i, i]);
  }
  return {
    sql: spans.map(() => `(${column} BETWEEN ? AND ?)`).join(" OR "),
    binds: spans.flatMap(([a, b]) => [a * RANGE_SIZE, (b + 1) * RANGE_SIZE - 1]),
  };
}

// table: キャッシュの表名。build(db, indices|null) → Map<chunk_index, payloadオブジェクト(v は付けなくてよい)>。
// indices が null のときは全範囲を作る(build は存在するレースの範囲だけ返せばよい。空の範囲はここで補う)。
// 戻り値: 範囲の番号順の payload オブジェクトの配列。
export async function loadRangeChunks(db, table, build) {
  const [cacheRes, maxRes] = await Promise.all([
    db.prepare(`SELECT chunk_index, payload FROM ${table}`).all().catch((e) => {
      console.error(`${table}: read failed (ignored)`, e); // 表が無い等。作り直した結果をそのまま使う
      return null;
    }),
    db.prepare("SELECT MAX(id) AS m FROM races").first(),
  ]);
  const maxIndex = maxRes && maxRes.m !== null && maxRes.m !== undefined ? rangeIndexOf(maxRes.m) : -1;

  const have = new Map();
  let legacy = false;
  for (const r of cacheRes?.results || []) {
    let p = null;
    try { p = JSON.parse(r.payload); } catch { /* 壊れた行は作り直す */ }
    if (!p || p.v !== PAYLOAD_VERSION) { legacy = true; continue; }
    if (r.chunk_index <= maxIndex) have.set(r.chunk_index, p);
  }
  if (legacy) have.clear();

  // 保存できずにメモリに持っている範囲があれば、作り直さずにそれを使う
  for (let i = 0; i <= maxIndex; i++) {
    if (have.has(i)) continue;
    const f = fallbackGet(table, i);
    if (f) have.set(i, f);
  }
  const missing = [];
  for (let i = 0; i <= maxIndex; i++) if (!have.has(i)) missing.push(i);

  if (missing.length) {
    const full = legacy || missing.length > MAX_RANGES_PER_QUERY;
    const built = await build(db, full ? null : missing);
    const now = new Date().toISOString();
    const stmts = [];
    const builtEntries = [];
    if (legacy || !cacheRes) stmts.push(db.prepare(`DELETE FROM ${table}`));
    // 末尾のレースが消えて範囲が減った場合の残りも消す
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE chunk_index > ?`).bind(maxIndex));
    for (const i of missing) {
      const p = { v: PAYLOAD_VERSION, ...(built.get(i) || {}) };
      have.set(i, p);
      builtEntries.push([i, p]);
      const text = JSON.stringify(p);
      if (text.length * 3 > CHUNK_MAX_BYTES) {
        console.error(`${table}: chunk ${i} too large, not saved`);
        continue;
      }
      stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (chunk_index, payload, updated_at) VALUES (?, ?, ?)`).bind(i, text, now));
    }
    try {
      // 1回に積む文は「足りない範囲の数+2」。全範囲でも races 4,000件で約20、10万件でも約500件なので分割して送る
      for (let k = 0; k < stmts.length; k += 100) await db.batch(stmts.slice(k, k + 100));
      if (!cacheRes) fallbackPut(table, builtEntries); // 表が読めなかった(無い等)ときも次回の作り直しを避ける
    } catch (e) {
      console.error(`${table}: failed to persist (ignored)`, e);
      fallbackPut(table, builtEntries);
    }
  }

  const out = [];
  for (let i = 0; i <= maxIndex; i++) if (have.has(i)) out.push(have.get(i));
  return out;
}
