// races の id の範囲ごとに分けて持つ事前計算キャッシュの共通処理(2026-10-08追加)。
// レース一覧用の軽いキャッシュ(races_index_cache)・集計用の小さいキャッシュ(race_lineup_cache)・勝ちタイムの
// キャッシュ(race_time_cache)・馬名ごとのレース数のキャッシュ(horse_names_cache)で使う。
// 仕様・経緯は docs/design/data-model.md「キャッシュを範囲ごとに作り直す」「変わったレースだけ差し替える」。
//
// 背景: 以前はレースや結果を1件でも変えるとキャッシュが丸ごと消え、次に使われたときに全レース・
// 全結果(race_results 約5万行)を読み直していた。レースの編集・取込が多い日に作り直しが数十回起き、
// 2026-10-08 に D1 の1日の読み取り上限の92%に達した。
//
// 仕組み:
//   - 1行(chunk_index)= races.id が [chunk_index*RANGE_SIZE, (chunk_index+1)*RANGE_SIZE) のレース分。
//     1行に入るのは最大 RANGE_SIZE レース分なので、1行の大きさは数十〜数百KBに収まり、D1 の
//     1行2MBの上限には届かない(念のため CHUNK_MAX_BYTES を超える行は保存しない)。
//   - 読むときは全行を読み、足りない範囲(消えた行・まだ無い範囲)だけを DB から読み直して保存する(best-effort)。
//   - payload は {"v":2, ...}。v が無い行(以前の、バイト数で区切っていた形式)があれば全部作り直す。
//     中身の形を変えた表は、呼び出し側で version を上げる(2026-10-12〜。その表だけ全部作り直す)。
//
// 変わったレースだけ差し替える(2026-10-16。@STEP: cache_dirty):
//   以前は DB トリガーが「変わったレースの範囲の行」を消し、次に読んだときにその範囲(200レース分)を作り直していた。
//   開催日は取り込みのたびに一番新しい範囲が消え、4つのキャッシュの作り直しで1回あたり合わせて約2万行を読んでいた
//   (直近3日でレース一覧のキャッシュ約75万行・馬名のキャッシュ約80万行)。
//   今はトリガーが cache_dirty に「どのキャッシュの、どのレースが変わったか」を控えるだけにし、読むときに
//   そのレースだけを読み直して、範囲の行の中のそのレースの分を差し替える(patch。1レースで数十行の読み取り)。
//   - 控えの取り出し: 読む前に、その表の控えに「処理中(claimed=1)」の印を付けて番号を受け取る。
//     処理中に同じレースがまた変わると、トリガーが印を0に戻す(処理が終わっても消えず、次回もう一度差し替える)。
//     差し替えを保存するときに、印が1のままの控えだけを消す(同じ batch の中。保存が失敗すれば控えも残る)。
//   - 差し替えは「読んだときの行(updated_at)」が今も同じときだけ保存する(別の実行環境が先に差し替えていたら保存せず、
//     控えも残して次回やり直す)。
//   - 差し替えの仕組みが無い表(horse_names_cache。中身が範囲ごとの合計で、レースごとに引けない)は、その範囲を作り直す。
//     ただし minRebuildMs より新しい行は作り直さず、少し古い内容のまま使う(取り込みが続く日に作り直しを1回にまとめる)。
//   - 控えの表が無い(マイグレーション前)ときは、以前と同じく「トリガーが消した範囲を作り直す」だけで正しく動く。

export const RANGE_SIZE = 200;
const CHUNK_MAX_BYTES = 1_500_000;
const PAYLOAD_VERSION = 2;
// 足りない範囲がこれより多いときは、範囲を指定せず全件を読む(IN/BETWEEN の条件が長くなりすぎないように)
const MAX_RANGES_PER_QUERY = 20;
// 1回の読み込みで差し替えるレースの数の上限。これより多い(一括補正の直後など)ときは、その範囲ごと作り直す
const MAX_PATCH_RACES = 300;
// 差し替えで1回の問い合わせに渡すレースIDの数(D1 の1クエリ100バインド上限の内側)
const PATCH_IDS_PER_QUERY = 90;

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
// { ids: [...] } を渡すと、そのレースだけの条件(col IN (...))。ids は PATCH_IDS_PER_QUERY(90)件以下で渡すこと(2026-10-16)
export function rangeCondition(column, indices) {
  if (!indices) return null;
  if (!Array.isArray(indices) && Array.isArray(indices.ids)) {
    return { sql: `${column} IN (${indices.ids.map(() => "?").join(",")})`, binds: indices.ids };
  }
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

// 範囲の行の版(updated_at)。保存した時刻+乱数(差し替えの保存で「読んだときと同じ行か」を比べるため)
function newToken() {
  return `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`;
}
function tokenTime(token) {
  const t = Date.parse(String(token || "").split("#")[0]);
  return Number.isFinite(t) ? t : 0;
}

// 控えに処理中の印を付けて、変わったレースの番号を受け取る。控えの表が無ければ null。
// 印を付けるのはまだ印の無い控えだけ(書き込みを増やさないため)。前回の処理が途中で終わった控え(印が1のまま)も一緒に受け取る。
// 同じ batch(1つのトランザクション)で印付けと読み取りをするので、その間に増えた控えも取りこぼさない
async function claimDirty(db, table) {
  try {
    const res = await db.batch([
      db.prepare("UPDATE cache_dirty SET claimed = 1 WHERE tbl = ? AND claimed = 0").bind(table),
      db.prepare("SELECT race_id FROM cache_dirty WHERE tbl = ?").bind(table),
    ]);
    return (res?.[1]?.results || []).map((r) => Number(r.race_id)).filter((n) => Number.isInteger(n));
  } catch {
    return null;
  }
}

// 処理し終えた控え(印が1のまま=処理中に変わっていないもの)を消す文。ids は90件ずつ。
// guard を渡すと「その範囲の行が今保存した版のときだけ」消す(差し替えの保存が別の実行環境に負けたら控えを残す)
function clearDirtyStatements(db, table, ids, guard = null) {
  const stmts = [];
  for (let k = 0; k < ids.length; k += PATCH_IDS_PER_QUERY) {
    const part = ids.slice(k, k + PATCH_IDS_PER_QUERY);
    const ph = part.map(() => "?").join(",");
    if (guard) {
      stmts.push(db.prepare(
        `DELETE FROM cache_dirty WHERE tbl = ? AND claimed = 1 AND race_id IN (${ph})
           AND EXISTS (SELECT 1 FROM ${table} WHERE chunk_index = ? AND updated_at = ?)`
      ).bind(table, ...part, guard.chunk, guard.token));
    } else {
      stmts.push(db.prepare(`DELETE FROM cache_dirty WHERE tbl = ? AND claimed = 1 AND race_id IN (${ph})`).bind(table, ...part));
    }
  }
  return stmts;
}

// table: キャッシュの表名。build(db, indices|null|{ids}) → Map<chunk_index, payloadオブジェクト(v は付けなくてよい)>。
// indices が null のときは全範囲を作る(build は存在するレースの範囲だけ返せばよい。空の範囲はここで補う)。
// { ids } のときはそのレースだけを読んで、レースのある範囲だけ返す(patch を使う表だけ)。
// version: payload の版数(省略時 PAYLOAD_VERSION)。中身の形を変えたら上げると、その表だけ全部作り直す。
// patch(payload, idSet, partial): 範囲の payload から idSet のレースを除き、partial(build(db,{ids}) のその範囲の分。
//   無ければ null = レースが消えた)を足した新しい payload を返す(payload は書き換えず新しく作る)。無い表はその範囲を作り直す。
// minRebuildMs: patch の無い表で、控えのある範囲を作り直すのは、行の保存からこの時間が過ぎてから(既定0=すぐ)。
// 戻り値: 範囲の番号順の payload オブジェクトの配列。
export async function loadRangeChunks(db, table, build, { version = PAYLOAD_VERSION, patch = null, minRebuildMs = 0 } = {}) {
  const dirtyIds = await claimDirty(db, table);
  const [cacheRes, maxRes] = await Promise.all([
    db.prepare(`SELECT chunk_index, payload, updated_at FROM ${table}`).all().catch((e) => {
      console.error(`${table}: read failed (ignored)`, e); // 表が無い等。作り直した結果をそのまま使う
      return null;
    }),
    db.prepare("SELECT MAX(id) AS m FROM races").first(),
  ]);
  const maxIndex = maxRes && maxRes.m !== null && maxRes.m !== undefined ? rangeIndexOf(maxRes.m) : -1;

  const have = new Map();
  const tokens = new Map(); // chunk_index -> updated_at(読んだときの版)
  let legacy = false;
  for (const r of cacheRes?.results || []) {
    let p = null;
    try { p = JSON.parse(r.payload); } catch { /* 壊れた行は作り直す */ }
    if (!p || p.v !== version) { legacy = true; continue; }
    if (r.chunk_index <= maxIndex) { have.set(r.chunk_index, p); tokens.set(r.chunk_index, r.updated_at); }
  }
  if (legacy) { have.clear(); tokens.clear(); }

  // 変わったレースを範囲ごとに分ける(行が無い範囲のレースは、下の作り直しで一緒に新しくなる)
  const dirtyByChunk = new Map(); // chunk_index -> [race_id]
  for (const id of dirtyIds || []) {
    const ci = rangeIndexOf(id);
    if (!dirtyByChunk.has(ci)) dirtyByChunk.set(ci, []);
    dirtyByChunk.get(ci).push(id);
  }
  const patchChunks = []; // 差し替える範囲
  const rebuildChunks = new Set(); // 行はあるが作り直す範囲
  const dirtyInHave = [...dirtyByChunk.keys()].filter((ci) => have.has(ci));
  const dirtyRaceCount = dirtyInHave.reduce((s, ci) => s + dirtyByChunk.get(ci).length, 0);
  for (const ci of dirtyInHave) {
    if (patch && dirtyRaceCount <= MAX_PATCH_RACES) patchChunks.push(ci);
    else if (!patch && minRebuildMs > 0 && Date.now() - tokenTime(tokens.get(ci)) < minRebuildMs) continue; // 少し古いまま使う
    else rebuildChunks.add(ci);
  }

  // 保存できずにメモリに持っている範囲があれば、作り直さずにそれを使う
  for (let i = 0; i <= maxIndex; i++) {
    if (have.has(i)) continue;
    const f = fallbackGet(table, i);
    if (f) have.set(i, f);
  }
  const missing = [];
  for (let i = 0; i <= maxIndex; i++) if (!have.has(i) || rebuildChunks.has(i)) missing.push(i);

  if (missing.length) {
    const full = legacy || missing.length > MAX_RANGES_PER_QUERY;
    const built = await build(db, full ? null : missing);
    const token = newToken();
    const stmts = [];
    const builtEntries = [];
    if (legacy || !cacheRes) stmts.push(db.prepare(`DELETE FROM ${table}`));
    // 末尾のレースが消えて範囲が減った場合の残りも消す
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE chunk_index > ?`).bind(maxIndex));
    const clearedIds = [];
    for (const i of missing) {
      const p = { v: version, ...(built.get(i) || {}) };
      have.set(i, p);
      builtEntries.push([i, p]);
      const text = JSON.stringify(p);
      if (text.length * 3 > CHUNK_MAX_BYTES) {
        console.error(`${table}: chunk ${i} too large, not saved`);
        continue;
      }
      stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (chunk_index, payload, updated_at) VALUES (?, ?, ?)`).bind(i, text, token));
      clearedIds.push(...(dirtyByChunk.get(i) || []));
    }
    // 作り直した範囲の控えは、作り直しの読み取りより前に処理中の印を付けているので、印が1のままなら消してよい
    if (dirtyIds) stmts.push(...clearDirtyStatements(db, table, clearedIds));
    try {
      // 1回に積む文は「足りない範囲の数+2+控えの文」。全範囲でも races 4,000件で約20、10万件でも約500件なので分割して送る
      for (let k = 0; k < stmts.length; k += 100) await db.batch(stmts.slice(k, k + 100));
      if (!cacheRes) fallbackPut(table, builtEntries); // 表が読めなかった(無い等)ときも次回の作り直しを避ける
    } catch (e) {
      console.error(`${table}: failed to persist (ignored)`, e);
      fallbackPut(table, builtEntries);
    }
  }

  // 末尾のレースが消えて範囲ごと無くなったレースの控えは、差し替える先が無いので消す
  const orphanIds = (dirtyIds || []).filter((id) => rangeIndexOf(id) > maxIndex);
  if (orphanIds.length) {
    try { await db.batch(clearDirtyStatements(db, table, orphanIds)); } catch { /* 次回また消す */ }
  }

  if (patchChunks.length) {
    try {
      await applyPatches(db, table, build, patch, version, have, tokens, patchChunks, dirtyByChunk);
    } catch (e) {
      // 差し替えに失敗しても控えは残る(次回やり直す)。今回は読んだときの内容を返す
      console.error(`${table}: patch failed (ignored)`, e);
    }
  }

  const out = [];
  for (let i = 0; i <= maxIndex; i++) if (have.has(i)) out.push(have.get(i));
  return out;
}

// 変わったレースだけを読み直して、範囲の行の中のそのレースの分を差し替える(2026-10-16)
async function applyPatches(db, table, build, patch, version, have, tokens, patchChunks, dirtyByChunk) {
  const ids = patchChunks.flatMap((ci) => dirtyByChunk.get(ci));
  const partial = new Map(); // chunk_index -> payload(そのレースたちの分)
  for (let k = 0; k < ids.length; k += PATCH_IDS_PER_QUERY) {
    const built = await build(db, { ids: ids.slice(k, k + PATCH_IDS_PER_QUERY) });
    for (const [ci, p] of built) {
      // 同じ範囲が2回に分かれたときは、後の分を前の分へ足す(差し替えの関数で足し合わせる)
      partial.set(ci, partial.has(ci) ? patch(partial.get(ci), new Set(), p) : p);
    }
  }
  for (const ci of patchChunks) {
    const raceIds = dirtyByChunk.get(ci);
    const next = { ...patch(have.get(ci), new Set(raceIds), partial.get(ci) || null), v: version };
    const text = JSON.stringify(next);
    if (text.length * 3 > CHUNK_MAX_BYTES) {
      console.error(`${table}: chunk ${ci} too large after patch, not saved`);
      continue;
    }
    const token = newToken();
    const stmts = [
      db.prepare(`UPDATE ${table} SET payload = ?, updated_at = ? WHERE chunk_index = ? AND updated_at IS ?`)
        .bind(text, token, ci, tokens.get(ci) ?? null),
      ...clearDirtyStatements(db, table, raceIds, { chunk: ci, token }),
    ];
    const res = await db.batch(stmts);
    // 別の実行環境が先に差し替えていた(保存されなかった)ときも、今回の画面には差し替えた内容を返す(控えは残り次回やり直す)
    have.set(ci, next);
    if (!res?.[0]?.meta?.changes) console.warn(`${table}: chunk ${ci} changed concurrently; will retry`);
  }
}

// patch の共通版: payload.r が [id, ...] の行の配列の表(races_index_cache・race_time_cache)
export function patchRowsById(payload, idSet, partial) {
  const rows = (payload?.r || []).filter((row) => !idSet.has(row[0]));
  for (const row of partial?.r || []) rows.push(row);
  rows.sort((a, b) => a[0] - b[0]);
  return { ...payload, r: rows };
}
