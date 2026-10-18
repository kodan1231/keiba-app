import { paceJobStep } from "../_lib/pace-job.js";

// 夜間の計算(2026-10-18〜 GitHub Actions の scripts/pace-nightly.mjs。毎晩3:00〈日本時間〉。以前は Cloudflare の定時起動 workers/pace-cron〈削除済み〉)
// から呼ばれ、同じ馬の組から出す距離の換算の比を1歩進める(2026-10-14追加。比率の計算は 2026-10-18 から GitHub Actions が直接行う)。
// POST /api/cron/pace-step(ヘッダー X-Cron-Secret: 秘密情報 PACE_CRON_SECRET。認証は functions/_middleware.js)
//   → { idle: true }(やることが無い)か { did }
// 仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」。_lib/pace-job.js 参照。
export async function onRequestPost(context) {
  if (!context.data?.isCron) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    return Response.json({ ok: true, ...(await paceJobStep(context.env.DB)) });
  } catch (e) {
    console.error("pace-step failed", e);
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
