// 総合推奨馬の比率の計算待ちを、このブラウザで処理する(2026-10-14追加。管理者のみ。仕様は docs/design/screens.md「比率の計算」)。
// 使う場面: 管理画面「重賞・予想」タブの「計算待ちを今すぐ計算」・各行の「今すぐ計算」(admin.js)。
//          (以前は出馬表を取り込んだ直後にも裏で動かしていたが、2026-10-18 にやめた)
// 夜間の計算(2026-10-18〜 GitHub Actions の scripts/pace-nightly.mjs。以前は workers/pace-cron)と同じ規則: 手で保存した比率は計算せず(2026-10-18: 「前の自動計算から7日未満」で外すのはやめた)
// 計算待ちから外す。それ以外は採点を数レースずつ受け取り(/api/admin/pace-backtest)、public/pace-search.js で比率を選んで
// 保存し(/api/admin/pace-weights/auto-result)、外す。途中で画面を閉じた分は計算待ちに残り、夜間に続きを行う。2026-10-18 から使うのは管理画面の「今すぐ計算」だけ(取り込み直後の自動の計算はやめた)。
// 普通の <script> として読み込む(関数をグローバルに置く)。計算部分だけ import() で ES モジュールを読む。

let paceRunnerBusy = false;

// 採点(GET /api/admin/pace-backtest)を1回受け取る。サーバーの1回の処理が無料枠のCPU時間を超えると 503 等になるため、
// 失敗したら1回で採点するレース数を減らして(6 → 3 → 1 → 1)少し待ってやり直す(2026-10-14)。入力の誤り(4xx)はやり直さない。
// 管理画面(admin.js)の「今すぐ計算」「評価点の既定値の自動で計算」からも使う。
const PACE_FETCH_LIMITS = [6, 3, 1, 1];
async function paceFetchBacktestChunk(kind, key, offset) {
  let lastError = null;
  for (let i = 0; i < PACE_FETCH_LIMITS.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * i));
    try {
      const res = await authedFetch(`/api/admin/pace-backtest?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}&offset=${offset}&limit=${PACE_FETCH_LIMITS[i]}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      lastError = new Error(data.error || `HTTP ${res.status}`);
      if (res.status < 500) throw lastError;
    } catch (e) {
      lastError = e;
      if (e && /^HTTP 4|が不正|見つかりません/.test(e.message)) throw e;
    }
  }
  throw new Error(`採点を受け取れませんでした(${PACE_FETCH_LIMITS.length}回やり直しました。${lastError?.message || ""})`);
}

// 計算待ち1件を計算して保存する。戻り値: { ok, message }(採点できる過去のレースが無いときも ok: true〈外してよい〉)
async function paceRunnerComputeOne(kind, key, onProgress = () => {}) {
  const { collectAndChoose } = await import("./pace-search.js");
  const { result, info } = await collectAndChoose((offset) => paceFetchBacktestChunk(kind, key, offset), onProgress);
  const label = info?.label || key;
  if (result.error) return { ok: true, message: `${label}: ${result.error}` };
  const res = await authedFetch("/api/admin/pace-weights/auto-result", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, key, result }),
  });
  const d = result.detail;
  return res.ok
    ? { ok: true, message: `${label}: 計算して保存しました(${d.races}レース: 軸の3着以内${d.best.show}・1着${d.best.win}回 / 軸+相手に1着馬${d.partner.best.win}回)` }
    : { ok: false, message: `${label}: 保存できませんでした` };
}

// 計算待ちを全部処理する。onStatus(text) で進み具合を知らせる。戻り値: { done, skipped, failed, total }
async function runPaceQueueInBrowser(onStatus = () => {}) {
  if (paceRunnerBusy) return { done: 0, skipped: 0, failed: 0, total: 0, busy: true };
  paceRunnerBusy = true;
  let done = 0, skipped = 0, failed = 0, total = 0;
  try {
    const res = await authedFetch("/api/admin/pace-queue");
    if (!res.ok) return { done, skipped, failed, total };
    const items = (await res.json()).items || [];
    total = items.length;
    for (const [i, it] of items.entries()) {
      onStatus(`推奨馬の比率を計算中…(${i + 1}/${total})`);
      try {
        if (!it.manual) {
          const r = await paceRunnerComputeOne(it.kind, it.key);
          if (!r.ok) { failed++; continue; }
          done++;
        } else {
          skipped++;
        }
        await authedFetch(`/api/admin/pace-queue?kind=${encodeURIComponent(it.kind)}&key=${encodeURIComponent(it.key)}`, { method: "DELETE" });
      } catch {
        failed++;
      }
    }
  } finally {
    paceRunnerBusy = false;
  }
  return { done, skipped, failed, total };
}
