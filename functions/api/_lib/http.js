// HTTPリクエスト/レスポンスの定型処理。
// 2026-09-07新設: 各エンドポイントに散在していた以下の定型コードを集約する。
//   - JSONボディのparse + 失敗時の400レスポンス
//     (`let data; try { data = await request.json(); } catch { return ... }` が13ファイル)
//   - 正の整数IDのバリデーション + 不正時の400レスポンス(6ファイル)
//   - エラーJSONレスポンスの組み立て
// 以前は predictions/index.js だけが独自の `jsonError` を持ち、他は
// `Response.json({ error }, { status })` と `new Response(JSON.stringify({ error }), ...)` が
// 混在していた。本モジュールは前者(`Response.json`相当。Content-Typeが必ず付く)へ統一する。
//
// 使い方はいずれも「成功時は値・失敗時は { error: Response } を返す」形に揃えており、
// 呼び出し側は `const { data, error } = await readJsonBody(request); if (error) return error;`
// のように書く。

/**
 * エラーJSON(`{ error: message, ...extra }`)を指定ステータスで返す。
 * @param {string} message - 画面に表示するエラーメッセージ
 * @param {number} [status=400]
 * @param {object} [extra] - error以外に含める追加フィールド(requires_confirmation 等)
 * @returns {Response}
 */
export function jsonError(message, status = 400, extra) {
  return Response.json({ error: message, ...(extra || {}) }, { status });
}

/**
 * リクエストボディをJSONとしてparseする。
 * @param {Request} request
 * @returns {Promise<{ data: any } | { error: Response }>} 成功時 { data }、失敗時 { error }(400)
 */
export async function readJsonBody(request) {
  try {
    return { data: await request.json() };
  } catch {
    return { error: jsonError("リクエストが不正です", 400) };
  }
}

/**
 * 正の整数ID(1以上)をparse・検証する。
 * @param {*} raw - `params.id` やクエリパラメータの生値
 * @param {string} [label="ID"] - エラーメッセージに使う名称(例: "race_id" → "race_idが不正です")
 * @returns {{ id: number } | { error: Response }} 成功時 { id }、失敗時 { error }(400)
 */
export function parsePositiveIntId(raw, label = "ID") {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: jsonError(`${label}が不正です`, 400) };
  }
  return { id };
}

// db.batch()に一度に積む文の数の上限(安全のためのチャンク分割)。
// 2026-09-19新設: 元々 functions/api/tickets/bulk.js にローカル実装していたものを
// 共通化した。管理画面の「既存データの馬名/騎手名を一括補正する」ボタン
// (_lib/horse-alias.js・_lib/jockey-alias.js の normalizeExisting*)は対象行数が
// races/race_results/tickets等の全件規模になり得るため(数万件の実績あり。
// CLAUDE.md「大きな一括処理」参照)、チャンク分割せずに db.batch() へ一括で
// 渡すとD1側の1リクエストあたりの処理量の上限に抵触するおそれがある。
// db.batch()自体は1回のサブリクエストにまとまるため、通常規模の処理なら
// 分割しなくても1回で収まるが、想定外に大量の文が積まれた場合に備えて分割する
// (1回のdb.batch()呼び出しごとに1サブリクエストを消費するため、分割しすぎると
// かえってサブリクエスト数上限に近づく点に注意。目安として超えることがまず無い
// 200件をチャンクサイズとした)。
export async function runBatchInChunks(db, statements, chunkSize = 200) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}
