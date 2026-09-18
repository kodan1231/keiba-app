// データ検索画面「レース成績」タブ(GET /api/data-search/race-stats)向けの
// race_results 事前計算キャッシュ。
//
// race_results を race_id でグルーピングしたものを、1行固定ではなく複数行(チャンク)に
// 分割して保持する(races 側は _lib/races-cache.js を参照)。
//
// 2026-09-19修正: 当初は1行固定でrace_results全件のグルーピング結果を1つのJSONに
// まとめていたが、race_resultsが26,000行規模まで育った結果、1行のJSON(約2.3MB)が
// D1の「1行(1カラム値)あたり2,000,000バイト」の上限を超えてUPDATEが失敗し、
// GET /api/data-search/race-stats が500になる(データ検索画面「集計の取得に
// 失敗しました」)障害が発生した。races_cache が2026-09-12に同種の障害を経て
// チャンク分割方式へ変更されたのと同じ対処を、当時この race_stats_cache には
// 反映し忘れていた。races_cache と同様、累積バイト数がCHUNK_MAX_BYTESを超えたら
// 新しい行(チャンク)に切り替える(race_id単位でしか分割できないデータのため、
// 1レース分だけでCHUNK_MAX_BYTESを超えることは実質無いという前提)。
//
// 無効化はDB側のトリガー(schema.sql / migration.sql の @STEP: race_stats_cache_chunked
// 参照)で行う。race_results への INSERT/DELETE、および集計に使う列(horse_number/
// jockey/status/finish_position)の UPDATE があると race_stats_cache の全行が削除
// される(incident_note のみの編集では発火しない)。読み取り側(このファイル)は
// 行が無ければその場で再計算して保存する(次回以降は保存済みの行を読むだけで済む)。
// 保存(db.batch)の失敗は必ずbest-effortで握りつぶし、読み取れた結果はそのまま返す
// (races_cache の recomputeRacesCache() と同じ考え方。読み取り高速化のための
// キャッシュ書き込みが、保存失敗時に読み取り自体の失敗へ波及してはならないため。
// CLAUDE.md「絶対に破ってはいけない不変条件」参照)。
//
// 詳細・経緯は docs/design/data-search.md 参照。

// D1の1行(1カラム値)あたりの上限(2,000,000バイト)に対する安全マージン。
const CHUNK_MAX_BYTES = 1_500_000;

const encoder = new TextEncoder();
function byteLength(s) {
  return encoder.encode(s).length;
}

export async function getRaceResultsGroupedByRaceId(db) {
  const { results } = await db
    .prepare("SELECT payload FROM race_stats_cache ORDER BY chunk_index")
    .all();
  if (results && results.length) {
    try {
      const grouped = {};
      for (const r of results) {
        if (!r.payload) throw new Error("race_stats_cache: empty chunk");
        Object.assign(grouped, JSON.parse(r.payload));
      }
      return grouped;
    } catch {
      // 壊れていた場合は再計算にフォールバックする
    }
  }
  return recomputeRaceStatsCache(db);
}

export async function recomputeRaceStatsCache(db) {
  const { results } = await db.prepare(
    "SELECT race_id, horse_number, jockey, status, finish_position FROM race_results"
  ).all();
  const grouped = {};
  for (const row of results || []) {
    const list = grouped[row.race_id] || (grouped[row.race_id] = []);
    list.push({
      horse_number: row.horse_number,
      jockey: row.jockey,
      status: row.status,
      finish_position: row.finish_position,
    });
  }

  // race_id単位でチャンクに分割する(1レース分の出走馬リストは単位として分割しない)。
  const chunks = [];
  let current = {};
  let currentBytes = 2; // "{}" 分
  let currentCount = 0;
  for (const [raceId, list] of Object.entries(grouped)) {
    const entryBytes = byteLength(`"${raceId}":${JSON.stringify(list)}`) + 1; // カンマ区切り分
    if (currentCount && currentBytes + entryBytes > CHUNK_MAX_BYTES) {
      chunks.push(current);
      current = {};
      currentBytes = 2;
      currentCount = 0;
    }
    current[raceId] = list;
    currentBytes += entryBytes;
    currentCount++;
  }
  chunks.push(current); // grouped が空でも1チャンク("{}")を保存する

  const now = new Date().toISOString();
  const stmts = [db.prepare("DELETE FROM race_stats_cache")];
  chunks.forEach((chunk, i) => {
    stmts.push(
      db
        .prepare("INSERT INTO race_stats_cache (chunk_index, payload, updated_at) VALUES (?, ?, ?)")
        .bind(i, JSON.stringify(chunk), now)
    );
  });
  try {
    await db.batch(stmts);
  } catch (e) {
    // 保存の失敗(D1日次rows_written上限到達等)を握りつぶす。キャッシュは読み取りを
    // 速くするための最適化であり、保存の失敗が読み取り自体の失敗になってはならない
    // (次回のアクセスでまた保存を試みる)。
    console.error("race_stats_cache: failed to persist (ignored)", e);
  }

  return grouped;
}
