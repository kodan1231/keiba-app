// ミドルウェアを通過できた = ログイン済み、という確認に加えて、
// フロント側で表示名・管理者向けUIの出し分けに使うユーザー名・管理者フラグも返す。
//
// password_reset_pending(2026-09-10追加): 管理者にパスワードをリセットされた本人に、
// 全画面共通のバナーで「パスワードを変更してください」と促すためのフラグ。本人が
// 自分でパスワードを変更すると0へ戻る。詳細はdocs/design/auth-multiuser.md
// 「管理者によるパスワードリセット」参照。
export async function onRequestGet(context) {
  const { env } = context;

  let passwordResetPending = false;
  try {
    const row = await env.DB.prepare(
      "SELECT password_reset_pending FROM users WHERE id = ?"
    ).bind(context.data?.userId).first();
    passwordResetPending = Boolean(row && row.password_reset_pending);
  } catch (e) {
    // フラグ取得の失敗はログイン状態の確認自体を妨げない(バナー非表示にフォールバック)。
    console.error("password_reset_pending lookup failed", e);
  }

  return Response.json({
    ok: true,
    username: context.data?.username || null,
    is_admin: Boolean(context.data?.isAdmin),
    password_reset_pending: passwordResetPending,
  });
}
