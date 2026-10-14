import { parsePositiveIntId, getPaceWeights } from "../_shared.js";

// 総合推奨馬の重視度の比率(2026-10-13追加)。ログインユーザー全員が読める(比率は全ユーザー共通)。
// GET /api/pace-weights?graded_race_id=N&race_id=R(どちらも省略可)
//   → { w_*(7要素。軸指数), source, updated_at, scope: "graded"|"course"|"default"|"builtin", pace_type, auto: {...}|null,
//       paces: { high|middle|slow: 同じ形 }, partner: { 相手指数の同じ形, paces } }
// race_id があれば、そのレースのコース(競馬場・芝ダ障・距離)の比率も見る(2026-10-14)。選ぶ順は重賞 → コース → 標準 → 既定値
// (_lib/pace-score.js の getPaceWeights)。
// 2026-10-14: 以前は重賞の自動の比率が古いと stale を返し、画面が裏で計算し直しを頼んでいた(/api/pace-weights/recompute)。
//   計算は夜間の定時実行と管理者の「今すぐ計算」(ブラウザ)へ移したため、ここでは読むだけ。
// 読み取り: 比率の表を主キーで最大2行+コースの比率1行+(race_id があれば)レース1行。
// 変更は管理者のみ(/api/admin/pace-weights)。仕様は docs/design/screens.md「総合推奨馬」。
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("graded_race_id");
  const gradedId = raw && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0;

  let course = null;
  if (url.searchParams.get("race_id")) {
    const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
    if (error) return error;
    course = await db.prepare("SELECT track, course_type, distance FROM races WHERE id = ?").bind(raceId).first();
  }
  return Response.json(await getPaceWeights(db, gradedId, course));
}
