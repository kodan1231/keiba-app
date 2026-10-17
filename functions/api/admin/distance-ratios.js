import { requireAdmin, distanceRatiosState, distanceRatiosStep } from "../_shared.js";

// 管理者向け: 同じ馬の組から出す距離の換算の比(2026-10-16追加。_lib/distance-ratios.js)。
//   GET  → { ok, computed_at, count(組み合わせ数), usable(20組以上で使える数), newer(前回から結果が増えたか),
//            stale(今夜の定時実行で計算し直すか。新しい結果があり前回から7日たった。2026-10-18), next_after(7日たつ日時), running, progress }
//   POST → 1歩進める(作業が無ければ、前回から結果が増えていなくても始める)。画面は done になるまで繰り返し呼ぶ。
//          { ok, did: "start" | "scan" | "done", read, count?, usable? }。計算全体で約28万行を読む
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  return Response.json({ ok: true, ...(await distanceRatiosState(context.env.DB)) });
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  return Response.json({ ok: true, ...(await distanceRatiosStep(context.env.DB, { force: true })) });
}
