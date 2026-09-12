// races テーブル全件取得の事前計算キャッシュ(1行固定)。
//
// GET /api/races(全画面共通の入口)をはじめ、データ検索画面・購入履歴画面の
// CSV取込一覧(コース種別・距離の付与)など、races を無条件に全件SELECTする箇所が
// 複数あった。races は「元々軽いテーブル」という前提で許容されてきたが、開催が
// 積み重なるほど育ち続けるテーブルであり、2026-09-12に imported_ticket_items で
// 実際に発生した障害(全ユーザー・全件SELECTをテーブルが育つ前提の無い設計のまま
// 放置し、D1日次行読み取り上限の75%を1エンドポイントだけで消費した)と同じ構造の
// リスクがあったため、先回りで導入した。
//
// races の全カラムをJSON配列で1行に持つ。無効化はDB側のトリガー(schema.sql /
// migration.sql の @STEP: races_cache 参照)で行う。races への INSERT/UPDATE/DELETE が
// あると payload が NULL に戻る(races は列を絞らず全カラムをキャッシュしているため、
// race_stats_cache と異なり列を限定せず全ての更新で無効化する)。読み取り側(この
// ファイル)はそれを見て、無ければその場で再計算して保存する(次回以降は保存済みの
// 1行を読むだけで済む)。
//
// 詳細・経緯は docs/design/data-model.md 参照。

export async function getAllRacesRaw(db) {
  const row = await db.prepare("SELECT payload FROM races_cache WHERE id = 1").first();
  if (row && row.payload) {
    try {
      return JSON.parse(row.payload);
    } catch {
      // 壊れていた場合は再計算にフォールバックする
    }
  }
  return recomputeRacesCache(db);
}

export async function recomputeRacesCache(db) {
  const { results } = await db.prepare(
    "SELECT * FROM races ORDER BY race_date DESC, track ASC, race_number ASC"
  ).all();
  const rows = results || [];
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE races_cache SET payload = ?, updated_at = ? WHERE id = 1"
  ).bind(JSON.stringify(rows), now).run();
  return rows;
}
