import { requireAdmin } from "../_shared.js";

// 管理者向け: 登録済みユーザーの一覧(閲覧のみ。編集・削除機能は無し)。
// 自己登録制(招待コード無し)のため、管理者が誰が登録したかを把握できるようにする。
// 2026-08-30追加: last_login_at(最終ログイン日時)も返す。ログイン成功時に
// functions/api/auth/login.js が更新し、新規登録時はfunctions/api/auth/register.js が
// 登録日時を初期値として設定する(未ログインのユーザーは想定上存在しないが、
// 念のためNULLの可能性も考慮してフロント側で「未ログイン」表示にフォールバックする)。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT id, username, created_at, last_login_at FROM users ORDER BY created_at ASC, id ASC`
  ).all();

  return Response.json({ ok: true, items: results || [] });
}