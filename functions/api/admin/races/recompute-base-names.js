import { requireAdmin, recomputeAllRaceBaseNames, jsonError } from "../../_shared.js";

// 管理者向け: races全件のrace_base_name(race_nameから「第N回」等の回次を除いた
// ベース名)を再計算する。race_base_name列追加時の初回バックフィル用。
// 詳細はdocs/design/data-model.md「races.race_base_name」参照。
//
// 明示的にこのエンドポイントを呼んだ時だけ実行される(自動実行はしない)。
// 何度実行しても安全(冪等)。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  try {
    const result = await recomputeAllRaceBaseNames(env.DB);
    return Response.json({ ok: true, updated: result.updated });
  } catch (e) {
    console.error("race base name recompute error", e);
    return jsonError("再計算に失敗しました", 500);
  }
}
