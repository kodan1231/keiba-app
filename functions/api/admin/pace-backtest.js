import { requireAdmin, jsonError, backtestChunk, getPaceScoreSettings } from "../_shared.js";

// 管理者向け(APIトークンでも可): 総合推奨馬の比率の計算の材料を数レースずつ返す(2026-10-14追加)。
// GET /api/admin/pace-backtest?kind=graded|course&key=<重賞ID | 競馬場|芝ダ障|距離>&offset=0&limit=6
//   → { kind, key, label, total, offset, missing_score, races: [{ race_id, race_date, pace_type, runners: [{ horse_number, place, scores, adj }] }] }
// 比率を選ぶ計算は呼び出し側(ブラウザの「今すぐ計算」・夜間の scripts/pace-nightly.mjs)が public/pace-search.js で行う。
// 1回で採点するのは最大6レース(CPU時間対策。_lib/pace-score.js の BACKTEST_CHUNK_MAX)。
// D1の読み取り(1回): キャッシュ(各約20行。使い回し)+ 6レースの race_results(約100行)+ 出走馬の全戦績(約1,500行)。
//   コース1年分(数十レース)の計算全体で約1万行。夜間・管理者のボタンのときだけ。
// 仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const url = new URL(context.request.url);
  const kind = url.searchParams.get("kind");
  const key = url.searchParams.get("key") || "";
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.max(1, Number(url.searchParams.get("limit")) || 6);
  const { missing_score } = await getPaceScoreSettings(context.env.DB);
  const r = await backtestChunk(context.env.DB, kind, key, offset, limit, { missingScore: missing_score });
  if (r.error) return jsonError(r.error, 400);
  return Response.json(r);
}
