import { getGuestSettings, getGuestBlocks, readGuestCookie, createGuestCookie, randomToken, requestIp } from "../api/_shared.js";

// ゲスト用URL(2026-10-14。docs/design/guest.md): GET /g/<合言葉>
// 合言葉が今の設定と一致すれば、端末ID入りのCookie(kbg)を渡してゲスト用のレース一覧(/guest)へ移る。
// 同じ版のCookieを既に持っていれば端末IDはそのまま(端末ごとの履歴・ブロックのため)。
// 端末の行はここで作る(1回の書き込み)。以後の最終アクセスの更新は _lib/guest.js の recordGuestAccess(10分に1回まで)。
const page = (title, text, status) =>
  new Response(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
      `<body style="font-family:sans-serif;padding:24px;line-height:1.7"><h1 style="font-size:18px">${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const db = env.DB;
  const settings = await getGuestSettings(db, { fresh: true });
  const key = String(params.key || "");
  if (!settings.enabled || !settings.key || key !== settings.key) {
    return page("このURLは使えません", "ゲスト用のURLが変わったか、公開を終了しました。URLを教えてくれた人に確認してください。", 404);
  }

  const current = await readGuestCookie(env, request.headers.get("Cookie"));
  // 合言葉を作り直した後に新しいURLから入り直した端末も、同じ端末IDを使い続ける(履歴とブロックを引き継ぐ)
  const deviceId = current?.deviceId || randomToken(16);
  const ip = requestIp(request);
  const blocks = await getGuestBlocks(db, { fresh: true });
  if (blocks.devices.has(deviceId) || blocks.ips.has(ip)) {
    return page("利用できません", "この端末からは利用できません。", 403);
  }

  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO guest_devices (device_id, first_seen, last_seen, ip, user_agent, hits, blocked) VALUES (?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen, ip = excluded.ip, user_agent = excluded.user_agent`
      )
      .bind(deviceId, now, now, ip, String(request.headers.get("User-Agent") || "").slice(0, 200))
      .run();
  } catch (e) {
    console.error("guest device insert failed (ignored)", e);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: "/guest", "Set-Cookie": await createGuestCookie(env, deviceId, settings.version), "Cache-Control": "no-store" },
  });
}
