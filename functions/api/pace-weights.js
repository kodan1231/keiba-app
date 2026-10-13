import { parsePositiveIntId, getPaceWeights, isAutoWeightsStale, computeAndSaveAutoPaceWeights } from "./_shared.js";

// 総合推奨馬の重視度の比率(2026-10-13追加)。ログインユーザー全員が読める(比率は全ユーザー共通)。
// GET /api/pace-weights?graded_race_id=N&race_id=R(どちらも省略可)
//   → { w_pace, w_number, w_jockey, source, updated_at, scope: "graded"|"default"|"builtin", auto: {...}|null, recomputed }
// その重賞の比率が無ければ標準の比率、標準も無ければ既定値(34/33/33)。
// 重賞のレース(race_id)を開いたとき、その重賞の自動の比率が無い・古いなら、ここで自動算出して保存する(2026-10-13〜。
// _lib/pace-score.js の isAutoWeightsStale)。今年の出走馬が登録されて最初に開かれたとき(過去10年で計算)と、
// 今年の結果が入った後に開かれたとき(今年を含めて計算し直し、翌年に活かす)。管理者が手で保存した比率は上書きしない。
// 読み取り: 普段は主キーで最大2行+レース1行。計算し直すときだけ約1,500行(重賞1つにつき年に1〜2回)。
// 変更は管理者のみ(/api/admin/pace-weights)。仕様は docs/design/screens.md「総合推奨馬」。
// 自動算出に失敗した重賞(過去の結果が無い等)は、同じ実行環境で10分間は計算し直さない(画面を開くたびに試さないため)
const failedAt = new Map(); // graded_race_id -> 時刻
const RETRY_MS = 10 * 60 * 1000;

export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("graded_race_id");
  const gradedId = raw && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0;

  let recomputed = false;
  if (gradedId && url.searchParams.get("race_id") && !(Date.now() - (failedAt.get(gradedId) || 0) < RETRY_MS)) {
    const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
    if (error) return error;
    try {
      const [race, row] = await Promise.all([
        db.prepare("SELECT id, race_date, finish_order FROM races WHERE id = ?").bind(raceId).first(),
        db.prepare("SELECT source, detail FROM pace_weights WHERE graded_race_id = ?").bind(gradedId).first(),
      ]);
      if (race && isAutoWeightsStale(row, { ...race, has_result: Boolean(race.finish_order && race.finish_order !== "[]") })) {
        const r = await computeAndSaveAutoPaceWeights(db, gradedId, { targetRace: race });
        recomputed = Boolean(r.saved);
        if (!r.saved) failedAt.set(gradedId, Date.now());
      }
    } catch (e) {
      failedAt.set(gradedId, Date.now());
      console.error("pace_weights auto recompute failed (ignored)", e); // 失敗しても今ある比率で表示する
    }
  }
  return Response.json({ ...(await getPaceWeights(db, gradedId)), recomputed });
}
