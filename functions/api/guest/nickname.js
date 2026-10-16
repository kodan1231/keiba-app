import {
  readJsonBody, jsonError, normalizeGuestNickname, guestNicknameKeyOf, createGuestCookie, getGuestSettings, requestIp,
} from "../_shared.js";

// ゲストのニックネームの登録(2026-10-16追加。ユーザー要望・仕様確認済み。docs/design/guest.md「ニックネーム」)。
//   POST { nickname } → 名前を端末の行に保存し、名前入りのゲストの Cookie(kbg)を渡す。{ ok, nickname }
//   - ゲスト(データ検索用アプリ search・手元の all)だけ。ミドルウェア(_lib/guest.js の resolveGuest)が名前の有無に関係なく通す
//   - 名前は1〜10文字(前後の空白は取る)。重複は断る(全角半角・大文字小文字・空白の違いは同じとみなす。409 nickname_taken)
//   - 端末の行(guest_devices)はここで作る。名前の無い端末(ボット等)は行を作らない
// D1: 同じ名前の行を UNIQUE インデックスで1行引く+端末の行を1行書く(登録のときだけ)
export async function onRequestPost(context) {
  const { request, env, data: ctx } = context;
  if (!ctx?.isGuest || !ctx.guestDeviceId) return jsonError("ゲストだけが使えます", 403);
  const { data, error } = await readJsonBody(request);
  if (error) return error;
  const nickname = normalizeGuestNickname(data?.nickname);
  if (!nickname) return jsonError("名前は1〜10文字で入れてください", 400, { error_code: "nickname_invalid" });
  const key = guestNicknameKeyOf(nickname);
  const db = env.DB;
  const deviceId = ctx.guestDeviceId;

  const taken = await db.prepare("SELECT device_id FROM guest_devices WHERE nickname_key = ?").bind(key).first();
  if (taken && taken.device_id !== deviceId) {
    return jsonError("その名前は使われています。別の名前にしてください", 409, { error_code: "nickname_taken" });
  }
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO guest_devices (device_id, first_seen, last_seen, ip, user_agent, hits, blocked, nickname, nickname_key)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen, ip = excluded.ip, user_agent = excluded.user_agent,
         nickname = excluded.nickname, nickname_key = excluded.nickname_key`
    ).bind(deviceId, now, now, requestIp(request), String(request.headers.get("User-Agent") || "").slice(0, 200), nickname, key).run();
  } catch (e) {
    // 同時に同じ名前が登録された等(UNIQUE 違反)
    if (/UNIQUE/i.test(String(e?.message || e))) {
      return jsonError("その名前は使われています。別の名前にしてください", 409, { error_code: "nickname_taken" });
    }
    throw e;
  }
  const settings = await getGuestSettings(db);
  const cookie = await createGuestCookie(env, deviceId, ctx.guestVersion ?? settings.version, nickname);
  return new Response(JSON.stringify({ ok: true, nickname }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
