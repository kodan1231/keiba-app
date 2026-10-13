import { readJsonBody, parsePositiveIntId, isAutoWeightsStale, computeAndSaveAutoPaceWeights, raceForStaleCheck } from "../_shared.js";

// 総合推奨馬の重賞の比率を、過去の結果から計算し直して保存する(2026-10-13追加)。ログインユーザー全員が呼べる
// (予想登録画面が GET /api/pace-weights の stale を見て、裏で呼ぶ。結果は全ユーザー共通の比率として保存される)。
// POST { graded_race_id, race_id } → { ok, recomputed, error? }
// 本当に古いときだけ計算する(同時に何人かが開いても、2人目以降は古くないので計算しない)。管理者が手で保存した比率は上書きしない。
// 読み取りは計算し直すときだけ約1,500行(重賞1つにつき年に1〜2回)。仕様は docs/design/screens.md「総合推奨馬」。

// 計算に失敗した重賞(過去の結果が無い等)は、同じ実行環境で10分間は計算し直さない(画面を開くたびに試さないため)
const failedAt = new Map(); // graded_race_id -> 時刻
const RETRY_MS = 10 * 60 * 1000;

export async function onRequestPost(context) {
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const { id: gradedId, error: gErr } = parsePositiveIntId(data?.graded_race_id, "graded_race_id");
  if (gErr) return gErr;
  const { id: raceId, error: rErr } = parsePositiveIntId(data?.race_id, "race_id");
  if (rErr) return rErr;
  if (Date.now() - (failedAt.get(gradedId) || 0) < RETRY_MS) return Response.json({ ok: true, recomputed: false, skipped: "recent_failure" });

  const [race, row] = await Promise.all([
    db.prepare("SELECT id, race_date, finish_order FROM races WHERE id = ?").bind(raceId).first(),
    db.prepare("SELECT source, detail FROM pace_weights WHERE graded_race_id = ?").bind(gradedId).first(),
  ]);
  if (!race || !isAutoWeightsStale(row, raceForStaleCheck(race))) return Response.json({ ok: true, recomputed: false });

  try {
    const r = await computeAndSaveAutoPaceWeights(db, gradedId, { targetRace: race });
    if (!r.saved) {
      failedAt.set(gradedId, Date.now());
      return Response.json({ ok: true, recomputed: false, error: r.error || null });
    }
    return Response.json({ ok: true, recomputed: true });
  } catch (e) {
    failedAt.set(gradedId, Date.now());
    console.error("pace_weights recompute failed", e);
    return Response.json({ ok: false, recomputed: false, error: "計算に失敗しました" }, { status: 500 });
  }
}
