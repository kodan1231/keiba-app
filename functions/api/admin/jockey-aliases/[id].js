import { requireAdmin } from "../../_shared.js";

// 管理者向け: 騎手名エイリアスの削除。
export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, params } = context;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "IDが不正です" }, { status: 400 });
  }

  const existing = await env.DB.prepare("SELECT id FROM jockey_aliases WHERE id = ?").bind(id).first();
  if (!existing) {
    return Response.json({ error: "エイリアスが見つかりません" }, { status: 404 });
  }

  await env.DB.prepare("DELETE FROM jockey_aliases WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
