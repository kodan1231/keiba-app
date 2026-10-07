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
// 保存形式(1行=1チャンク。races_cache と同じく CHUNK_MAX_BYTES 手前で次の行):
//   [[id, race_date, track, race_number, race_name, race_base_name, course_type, distance,
//     class_flags, weight_type, weather, track_condition, post_time,
//     has_finish_order(0/1), has_payout_rates(0/1), entry_count, has_unconfirmed_numbers(0/1)], ...]
// 作り直しは DB から必要な列だけを読み、印は SQL(json_each 等)で計算する(大きなJSONを解析しない)。
// 保存の失敗は握りつぶす(best-effort)。無効化は DB トリガー(@STEP: races_index_cache)。

const CHUNK_MAX_BYTES = 1_500_000;

// 画面・APIに返すときの列名(保存形式の並びと同じ)
export const RACE_INDEX_FIELDS = [
  "id", "race_date", "track", "race_number", "race_name", "race_base_name", "course_type", "distance",
  "class_flags", "weight_type", "weather", "track_condition", "post_time",
  "has_finish_order", "has_payout_rates", "entry_count", "has_unconfirmed_numbers",
];

// キャッシュを読み、保存形式の配列(行の配列)を返す。
export async function getRaceIndexRows(db) {
  let rows = null;
  try {
    const { results } = await db.prepare("SELECT payload FROM races_index_cache ORDER BY chunk_index").all();
    rows = results;
  } catch (e) {
    console.error("races_index_cache: read failed (ignored)", e);
  }
  if (rows && rows.length) {
    try {
      const out = [];
      for (const r of rows) {
        if (!r.payload) throw new Error("races_index_cache: empty chunk");
        out.push(...JSON.parse(r.payload));
      }
      return out;
    } catch {
      // 壊れていた場合は作り直す
    }
  }
  return recomputeRaceIndexCache(db);
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

export async function recomputeRaceIndexCache(db) {
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
       FROM races
      ORDER BY race_date DESC, track ASC, race_number ASC`
  ).all();
  const rows = (results || []).map((r) => RACE_INDEX_FIELDS.map((f) => (r[f] === undefined ? null : r[f])));

  // チャンクに詰めて保存(バイト数は「文字数×3」で保守的に見積もる)
  const chunks = [];
  let cur = [], est = 2;
  for (const row of rows) {
    const s = JSON.stringify(row);
    if (cur.length && est + s.length * 3 + 1 > CHUNK_MAX_BYTES) { chunks.push(`[${cur.join(",")}]`); cur = []; est = 2; }
    cur.push(s);
    est += s.length * 3 + 1;
  }
  chunks.push(`[${cur.join(",")}]`); // 0件でも1チャンク保存する

  const now = new Date().toISOString();
  const stmts = [db.prepare("DELETE FROM races_index_cache")];
  chunks.forEach((payload, i) => {
    stmts.push(db.prepare("INSERT INTO races_index_cache (chunk_index, payload, updated_at) VALUES (?, ?, ?)").bind(i, payload, now));
  });
  try {
    await db.batch(stmts); // チャンク数は数個(2026-10-07時点で1)なので分割不要
  } catch (e) {
    console.error("races_index_cache: failed to persist (ignored)", e);
  }
  return rows;
}
