import { getPaceWeights } from "./_shared.js";

// 総合推奨馬の重視度の比率(2026-10-13追加)。ログインユーザー全員が読める(比率は全ユーザー共通)。
// GET /api/pace-weights?graded_race_id=N(省略可)
//   → { w_pace, w_number, w_jockey, source, updated_at, scope: "graded"|"default"|"builtin" }
// その重賞の比率が無ければ標準の比率、標準も無ければ既定値(34/33/33)。読み取りは主キーで最大2行。
// 変更は管理者のみ(/api/admin/pace-weights)。仕様は docs/design/screens.md「総合推奨馬」。
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("graded_race_id");
  const id = raw ? Number(raw) : 0;
  return Response.json(await getPaceWeights(context.env.DB, Number.isInteger(id) && id > 0 ? id : 0));
}
