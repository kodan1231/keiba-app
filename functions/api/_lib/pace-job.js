// 夜間の1歩ずつの計算(POST /api/cron/pace-step。2026-10-14追加)。
// 2026-10-18 から: 呼ぶのは GitHub Actions(.github/workflows/pace-nightly.yml の scripts/pace-nightly.mjs。以前は Cloudflare の定時起動
// workers/pace-cron)で、ここで行うのは**同じ馬の組から出す距離の換算の比**(_lib/distance-ratios.js)を1歩進めることだけ。
// 総合推奨馬の比率の計算待ち(pace_recompute_queue)は、同じ GitHub Actions が Node で総当たりして保存する
// (サーバーの1回の処理の CPU 上限〈10ミリ秒〉では総当たりが終わらないため。docs/design/screens.md「比率の選び方の見直し」)。
// 以前はここで比率の作業(pace_jobs の kind='graded' / 'course')を採点 → 山登りの段ごとに1歩ずつ進めていた。
// 残っている古い比率の作業は1歩目で消す(計算待ちは残すので GitHub Actions が計算する)。
import { distanceRatiosStep } from "./distance-ratios.js";

// 1歩進める。戻り値: { idle: true }(やることが無い)か { did: "..." }
export async function paceJobStep(db) {
  const old = await db.prepare("SELECT COUNT(*) AS n FROM pace_jobs WHERE kind <> 'distance'").first().catch(() => null);
  if (old && Number(old.n) > 0) {
    await db.prepare("DELETE FROM pace_jobs WHERE kind <> 'distance'").run();
    return { did: `cleared ${old.n} old pace jobs` };
  }
  // 同じ馬の組から出す距離の比(週1回。新しい結果があり前回から7日たったときに始める)。失敗しても次の晩にやり直す
  try {
    const r = await distanceRatiosStep(db);
    if (!r.idle) return { did: `distance-ratios ${r.did}${r.read != null ? ` ${r.read}` : ""}${r.count != null ? ` ${r.usable}/${r.count}` : ""}` };
  } catch (e) {
    console.error("distance ratios step failed (ignored)", e);
  }
  return { idle: true };
}
