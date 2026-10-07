import { requireAdmin, parsePositiveIntId, jsonError, invalidateMemo, MEMO_HORSE_ALIASES } from "../../_shared.js";

// 管理者向け: 馬名エイリアスの削除。
export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  invalidateMemo(MEMO_HORSE_ALIASES); // この実行環境で使い回している分を捨てる(2026-10-07。_lib/memo-cache.js)

  const { env, params } = context;
  const { id, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const existing = await env.DB.prepare("SELECT id FROM horse_aliases WHERE id = ?").bind(id).first();
  if (!existing) return jsonError("エイリアスが見つかりません", 404);

  await env.DB.prepare("DELETE FROM horse_aliases WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
