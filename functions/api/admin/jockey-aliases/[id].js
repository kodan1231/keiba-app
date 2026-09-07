import { requireAdmin, parsePositiveIntId, jsonError } from "../../_shared.js";

// 管理者向け: 騎手名エイリアスの削除。
export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, params } = context;
  const { id, error } = parsePositiveIntId(params.id);
  if (error) return error;

  const existing = await env.DB.prepare("SELECT id FROM jockey_aliases WHERE id = ?").bind(id).first();
  if (!existing) {
    return jsonError("エイリアスが見つかりません", 404);
  }

  await env.DB.prepare("DELETE FROM jockey_aliases WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
