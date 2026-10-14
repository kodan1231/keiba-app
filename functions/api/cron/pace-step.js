import { paceJobStep } from "../_lib/pace-job.js";

// 定時起動(workers/pace-cron。毎晩3:00〜4:50〈日本時間〉の10分ごと)から呼ばれ、総合推奨馬の比率の計算を1歩進める(2026-10-14追加)。
// POST /api/cron/pace-step(ヘッダー X-Cron-Secret: 秘密情報 PACE_CRON_SECRET。認証は functions/_middleware.js)
//   → { idle: true }(計算待ちも作業も無い)か { did }
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
