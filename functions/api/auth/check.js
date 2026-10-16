// ミドルウェアを通過できた = ログイン済み、という確認に加えて、
// フロント側で表示名・管理者向けUIの出し分けに使うユーザー名・管理者フラグも返す。
//
// password_reset_pending(2026-09-10追加): 管理者にパスワードをリセットされた本人に、
// 全画面共通のバナーで「パスワードを変更してください」と促すためのフラグ。本人が
// 自分でパスワードを変更すると0へ戻る。詳細はdocs/design/auth-multiuser.md
// 「管理者によるパスワードリセット」参照。
//
// is_guest(2026-10-14追加): ゲスト用URLから入った閲覧専用の利用者(docs/design/guest.md)。
export async function onRequestGet(context) {
  const { env } = context;

  // guest_nickname / need_nickname(2026-10-16): ゲストのニックネーム。未登録なら画面が登録画面を出す(docs/design/guest.md「ニックネーム」)
  if (context.data?.isGuest) {
    const nickname = context.data.guestNickname || null;
    return Response.json({ ok: true, username: null, is_admin: false, is_guest: true, password_reset_pending: false,
      guest_nickname: nickname, need_nickname: !nickname });
  }

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
    is_guest: false,
    password_reset_pending: passwordResetPending,
  });
}
