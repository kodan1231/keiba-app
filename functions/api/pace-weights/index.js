import { parsePositiveIntId, getPaceWeights, isAutoWeightsStale, raceForStaleCheck } from "../_shared.js";

// 総合推奨馬の重視度の比率(2026-10-13追加)。ログインユーザー全員が読める(比率は全ユーザー共通)。
// GET /api/pace-weights?graded_race_id=N&race_id=R(どちらも省略可)
//   → { w_*(7要素), source, updated_at, scope: "graded"|"default"|"builtin", pace_type, auto: {...}|null,
//       paces: { high|middle|slow: 同じ形 }, stale }
// その重賞の比率が無ければ標準の比率、標準も無ければ既定値(各25)。paces はペース予想ごとの比率(2026-10-14追加。
// 画面はレースのペース予想〈race-factors の pace_type〉で選ぶ。選ぶ順は _lib/pace-score.js の getPaceWeights)。
// stale: 重賞のレース(race_id)を開いたとき、その重賞の自動の比率が無い・古い(_lib/pace-score.js の isAutoWeightsStale)。
//   画面はこれを見て POST /api/pace-weights/recompute で計算し直しを頼み、終わったら取り直す。
//   2026-10-13: 当初はこの GET の中で計算し直していたが、計算(候補の採点)とキャッシュの読み込みで無料枠のCPU上限(10ミリ秒)を
//   超えうるため分けた(超えても表示は今ある比率のまま壊れない)。
// 読み取り: 比率の表を主キーで最大2行+(race_id があれば)レース1行・比率1行。
// 変更は管理者のみ(/api/admin/pace-weights)。仕様は docs/design/screens.md「総合推奨馬」。
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("graded_race_id");
  const gradedId = raw && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0;

  let stale = false;
  if (gradedId && url.searchParams.get("race_id")) {
    const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
    if (error) return error;
    try {
      const [race, row] = await Promise.all([
        db.prepare("SELECT id, race_date, finish_order FROM races WHERE id = ?").bind(raceId).first(),
        db.prepare("SELECT source, detail FROM pace_weights WHERE graded_race_id = ?").bind(gradedId).first(),
      ]);
      stale = Boolean(race && isAutoWeightsStale(row, raceForStaleCheck(race)));
    } catch (e) {
      console.error("pace_weights stale check failed (ignored)", e);
    }
  }
  return Response.json({ ...(await getPaceWeights(db, gradedId)), stale });
}
