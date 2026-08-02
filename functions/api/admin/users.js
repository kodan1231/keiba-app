import { requireAdmin } from "../_shared.js";

// 管理者向け: 登録済みユーザーの一覧(閲覧のみ。編集・削除機能は無し)。
// 自己登録制(招待コード無し)のため、管理者が誰が登録したかを把握できるようにする。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT id, username, created_at FROM users ORDER BY created_at ASC, id ASC`
  ).all();

  return Response.json({ ok: true, items: results || [] });
}
