// D1 の1日の上限(読み取り500万行・書き込み10万行。アカウント全体)を超えたときに、画面へ状況を伝える応答を返す(2026-10-16追加)。
// 仕様は docs/design/ops.md「D1の上限を超えたときの画面の案内」。
//
// 背景: 上限を超えると D1 への問い合わせはすべて断られ(日本時間の朝9時に戻る)、各APIはばらばらの 500 を返していた。
// 画面は何も出ない・ログイン画面に戻る・ゲストには「公開していません」と出るなどで、利用者には何が起きているか分からなかった。
//
// _middleware.js が、API が失敗したとき(500番台・例外。データ検索用アプリのゲストの 401 も)だけ isD1LimitReached で確かめ、
// 上限なら 503 + X-D1-Limit: 1 + { error: 案内文, d1_limit: true, retry_at } に置き換える。画面側(public/auth.js)は
// この応答を受けたら画面の上に案内を出す。普段(成功した応答)は何もしない(問い合わせも増えない)。

// D1 が上限で断ったときのエラー文(例: "Your account has exceeded D1's free tier daily row read limit. ... [code: 7500]")
const LIMIT_PATTERN = /exceeded D1'?s .*daily|daily row (read|write) limit|free tier daily/i;

export function isD1LimitError(e) {
  return LIMIT_PATTERN.test(String(e?.message || e || ""));
}

// 確かめるのは `SELECT 1`(読み取り0行)。上限のときはこれも断られる。同じ実行環境で30秒使い回す
const PROBE_TTL_MS = 30 * 1000;
let probe = null; // { at, limited }

export async function isD1LimitReached(db) {
  if (!db) return false;
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.limited;
  let limited = false;
  try {
    await db.prepare("SELECT 1 AS ok").first();
  } catch (e) {
    limited = isD1LimitError(e);
  }
  probe = { at: Date.now(), limited };
  return limited;
}

// 次に使えるようになる時刻(UTC 0時 = 日本時間 朝9時)
export function d1ResetAt(now = new Date()) {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return t;
}

// 「明日(10月17日)の朝9時」「今日(10月17日)の朝9時」(日本時間の日付で比べる)
function resetLabel(now = new Date()) {
  const reset = d1ResetAt(now);
  const jst = (d) => new Date(d.getTime() + 9 * 3600 * 1000);
  const r = jst(reset);
  const n = jst(now);
  const sameDay = r.getUTCFullYear() === n.getUTCFullYear() && r.getUTCMonth() === n.getUTCMonth() && r.getUTCDate() === n.getUTCDate();
  return `${sameDay ? "今日" : "明日"}(${r.getUTCMonth() + 1}月${r.getUTCDate()}日)の朝9時`;
}

export function d1LimitMessage(now = new Date()) {
  return `ただいまデータベースの1日の利用上限に達したため、データを表示・保存できません。${resetLabel(now)}以降にもう一度アクセスしてください。`;
}

export function d1LimitResponse(now = new Date()) {
  const reset = d1ResetAt(now);
  const retrySec = Math.max(60, Math.round((reset.getTime() - now.getTime()) / 1000));
  return new Response(
    JSON.stringify({ error: d1LimitMessage(now), d1_limit: true, retry_at: reset.toISOString() }),
    { status: 503, headers: { "Content-Type": "application/json", "X-D1-Limit": "1", "Retry-After": String(retrySec), "Cache-Control": "no-store" } }
  );
}
