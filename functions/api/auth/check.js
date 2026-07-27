// ミドルウェアを通過できた = ログイン済み、という確認だけを行う軽量エンドポイント。
// 各ページはこれを叩いて、200ならアプリ画面、401ならログイン画面を出す。
export async function onRequestGet() {
  return Response.json({ ok: true });
}
