import { requireAdmin, readJsonBody, jsonError, autoPaceWeights } from "../../_shared.js";

// 管理者向け: 重賞の過去の結果から総合推奨馬の比率を自動算出して保存する(2026-10-13追加)。
// POST { graded_race_id } → { ok, graded_race_id, w_pace, w_number, w_jockey, source: "auto", detail }
// 計算は _lib/pace-score.js の autoPaceWeights(読み取りは数千行。ボタンを押したときだけ)。
// 過去の結果が無いときは保存せず 400。仕様は docs/design/screens.md「総合推奨馬」。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const id = Number(data?.graded_race_id);
  if (!Number.isInteger(id) || id <= 0) return jsonError("graded_race_id が不正です", 400);

  const result = await autoPaceWeights(db, id);
  if (result.error) return jsonError(result.error, 400);
  const { weights, detail } = result;
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pace_weights (graded_race_id, w_pace, w_number, w_jockey, source, detail, updated_at)
     VALUES (?, ?, ?, ?, 'auto', ?, ?)
     ON CONFLICT(graded_race_id) DO UPDATE SET w_pace = excluded.w_pace, w_number = excluded.w_number,
       w_jockey = excluded.w_jockey, source = 'auto', detail = excluded.detail, updated_at = excluded.updated_at`
  ).bind(id, weights.w_pace, weights.w_number, weights.w_jockey, JSON.stringify(detail), now).run();
  return Response.json({ ok: true, graded_race_id: id, ...weights, source: "auto", detail, updated_at: now });
}
