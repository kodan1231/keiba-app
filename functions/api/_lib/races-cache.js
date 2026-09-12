// races テーブル全件取得の事前計算キャッシュ。
//
// GET /api/races(全画面共通の入口)をはじめ、データ検索画面・購入履歴画面の
// CSV取込一覧(コース種別・距離の付与)など、races を無条件に全件SELECTする箇所が
// 複数あった。races は「元々軽いテーブル」という前提で許容されてきたが、開催が
// 積み重なるほど育ち続けるテーブルであり、2026-09-12に imported_ticket_items で
// 実際に発生した障害(全ユーザー・全件SELECTをテーブルが育つ前提の無い設計のまま
// 放置し、D1日次行読み取り上限の75%を1エンドポイントだけで消費した)と同じ構造の
// リスクがあったため、先回りで導入した。
//
// races の全カラムをJSON配列として保持するが、1行固定ではなく複数行(チャンク)に
// 分割して保持する。2026-09-12に「races_cacheを1行固定・races全カラムをまとめて
// 1つのJSONにする」設計で導入した直後、結果CSV18ファイルの一括インポートで
// races.entries/finish_order/payouts が多数のレース分まとめて埋まり、累積JSONが
// D1の「1行(1カラム値)あたり2,000,000バイト」の上限を超えてUPDATEが失敗し、
// GET /api/races に依存する馬券購入画面・データ検索画面・レース管理画面が軒並み
// 500になる障害が発生した。races は今後も無制限に育ち続けるため、1行固定に戻すと
// 件数を絞っても遅かれ早かれ再発する。そのため、累積バイト数がCHUNK_MAX_BYTESを
// 超えたら新しい行(チャンク)に切り替える方式にした(件数ベースではなくバイト数
// ベースで区切るのは、1レースあたりのJSONサイズが entries/finish_order/payouts の
// 内容量によって大きくばらつくため)。無効化はDB側のトリガー(schema.sql /
// migration.sql の @STEP: races_cache_chunked 参照)で行う。races への
// INSERT/UPDATE/DELETE があると races_cache の全行が削除される(races_cache は
// races 全カラムをキャッシュしているため、race_stats_cache と異なり列を限定せず
// 全ての更新で無効化する)。読み取り側(このファイル)は行が無ければその場で
// 再計算して保存する(次回以降は保存済みの行を読むだけで済む)。
//
// 詳細・経緯は docs/design/data-model.md 参照。

// D1の1行(1カラム値)あたりの上限(2,000,000バイト)に対する安全マージン。
const CHUNK_MAX_BYTES = 1_500_000;

const encoder = new TextEncoder();
function byteLength(s) {
  return encoder.encode(s).length;
}

export async function getAllRacesRaw(db) {
  const { results } = await db
    .prepare("SELECT payload FROM races_cache ORDER BY chunk_index")
    .all();
  if (results && results.length) {
    try {
      const rows = [];
      for (const r of results) {
        if (!r.payload) throw new Error("races_cache: empty chunk");
        rows.push(...JSON.parse(r.payload));
      }
      return rows;
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

  const chunks = [];
  let current = [];
  let currentBytes = 2; // "[]" 分
  for (const row of rows) {
    const rowBytes = byteLength(JSON.stringify(row)) + 1; // カンマ区切り分
    if (current.length && currentBytes + rowBytes > CHUNK_MAX_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  chunks.push(current); // rows が空でも1チャンク("[]")を保存する

  const now = new Date().toISOString();
  const stmts = [db.prepare("DELETE FROM races_cache")];
  chunks.forEach((chunk, i) => {
    stmts.push(
      db
        .prepare("INSERT INTO races_cache (chunk_index, payload, updated_at) VALUES (?, ?, ?)")
        .bind(i, JSON.stringify(chunk), now)
    );
  });
  try {
    await db.batch(stmts);
  } catch (e) {
    // 2026-09-12: ここでの保存失敗(D1日次rows_written上限到達等)を無視せず例外を
    // 投げていたため、「保存できない→次回また再計算→また保存に失敗」というループに
    // 陥り、GET /api/races 依存の全画面が読み取り専用の操作even含めて動かなくなる
    // (キャッシュが原因で読み取り上限=rows_read 500万/日まで食いつぶす)障害の一因に
    // なった。キャッシュは読み取りを速くするための最適化であり、保存の失敗が
    // 読み取り自体の失敗になってはならないため、ここでは握りつぶして rows をそのまま返す
    // (次回のアクセスでまた保存を試みる。DBの一時的な問題であれば自然に回復する)。
    console.error("races_cache: failed to persist (ignored)", e);
  }

  return rows;
}
