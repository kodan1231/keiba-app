// ミドルウェアを通過できた = ログイン済み、という確認に加えて、
// フロント側で表示名・管理者向けUIの出し分けに使うユーザー名・管理者フラグも返す。
export async function onRequestGet(context) {
  return Response.json({
    ok: true,
    username: context.data?.username || null,
    is_admin: Boolean(context.data?.isAdmin),
  });
}
