import { requireAdmin, readJsonBody, jsonError, computeAndSaveAutoPaceWeights, jstYear } from "../../_shared.js";

// 管理者向け: 重賞の過去の結果から総合推奨馬の比率を自動算出して保存する(2026-10-13追加)。
// POST { graded_race_id } → { ok, graded_race_id, w_pace, w_number, w_jockey, source: "auto", detail }
// 計算は _lib/pace-score.js の autoPaceWeights(比率の候補66通りで過去の各年を採点し、一番当たった比率)。
// 予想登録画面で重賞のレースを開いたときにも、必要なら自動で同じ計算をする(/api/pace-weights)。
// 過去の結果が無いときは保存せず 400。仕様は docs/design/screens.md「総合推奨馬」。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const id = Number(data?.graded_race_id);
  if (!Number.isInteger(id) || id <= 0) return jsonError("graded_race_id が不正です", 400);

  const result = await computeAndSaveAutoPaceWeights(db, id, { targetYear: jstYear() });
  if (result.error) return jsonError(result.error, 400);
  return Response.json({ ok: true, graded_race_id: id, ...result.weights, source: "auto", detail: result.detail, updated_at: result.updated_at });
}
