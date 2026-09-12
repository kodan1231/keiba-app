// データ検索画面「レース成績」タブ(GET /api/data-search/race-stats)向けの
// race_results 事前計算キャッシュ。
//
// race_results を race_id でグルーピングしたものだけを1行(id=1)のJSONとして持つ
// (races 側は元々軽いテーブルなので、race-stats.js は毎回ライブ取得のままでよい)。
//
// 無効化はDB側のトリガー(schema.sql / migration.sql の @STEP: race_stats_cache 参照)で
// 行う。race_results への INSERT/DELETE、および集計に使う列(horse_number/jockey/status/
// finish_position)の UPDATE があると payload が NULL に戻る(incident_note のみの編集
// では発火しない)。読み取り側(このファイル)はそれを見て、無ければその場で再計算して
// 保存する(次回以降は保存済みの1行を読むだけで済む)。
//
// 詳細・経緯は docs/design/data-search.md 参照。

export async function getRaceResultsGroupedByRaceId(db) {
  const row = await db.prepare("SELECT payload FROM race_stats_cache WHERE id = 1").first();
  if (row && row.payload) {
    try {
      return JSON.parse(row.payload);
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
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE race_stats_cache SET payload = ?, updated_at = ? WHERE id = 1"
  ).bind(JSON.stringify(grouped), now).run();
  return grouped;
}
