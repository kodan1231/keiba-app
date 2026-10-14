// 総合推奨馬の比率の夜間計算の定時起動(2026-10-14追加。仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」)。
// Cloudflare Workers の Cron Trigger(wrangler.toml の crons。毎晩3:00〜4:50〈日本時間〉の10分ごと)で起動し、
// アプリの POST /api/cron/pace-step を最大 MAX_STEPS 回、やることが無くなるまで呼ぶ。
// 計算そのものはアプリ側(Pages Functions)が1歩ずつ行う(1回の呼び出しは別の処理なので、それぞれがCPU上限10ミリ秒に収まる)。
// このWorker自身は呼ぶだけ(CPUはほぼ使わない)。1回の起動で外へ出せるリクエストは無料枠で50までなので45回で止め、続きは次の起動で行う。
// 必要な設定: 変数 KEIBA_BASE_URL(アプリのURL)、秘密情報 PACE_CRON_SECRET(アプリ側〈Pages〉と同じ値)。
const MAX_STEPS = 45;

async function run(env) {
  const base = String(env.KEIBA_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !env.PACE_CRON_SECRET) {
    console.error("KEIBA_BASE_URL / PACE_CRON_SECRET が設定されていません");
    return;
  }
  for (let i = 0; i < MAX_STEPS; i++) {
    const res = await fetch(`${base}/api/cron/pace-step`, { method: "POST", headers: { "X-Cron-Secret": env.PACE_CRON_SECRET } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`pace-step HTTP ${res.status}`, data.error || "");
      return;
    }
    if (data.idle) return;
    console.log(data.did);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
