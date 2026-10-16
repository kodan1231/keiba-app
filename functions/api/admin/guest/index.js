import {
  requireAdmin, readJsonBody, jsonError, getGuestSettings, saveGuestSettings, guestRaceWindow,
  invalidateGuestBlocks,
} from "../../_shared.js";

// 管理者向け: ゲスト閲覧の設定・端末・IPブロック(2026-10-14追加)。仕様は docs/design/guest.md。
//   GET  → { settings: { enabled, version }, window: { from, to }, devices: [...], ip_blocks: [...] }
//          devices は最終アクセスの新しい順に最大200件(guest_devices は端末の数だけの小さな表)
//   PUT  { enabled } → 公開する/止める
//   2026-10-15: 合言葉の作り直し(POST { action: "regenerate" })と GET の path(/g/<合言葉>)は合言葉の廃止で削除した
//   POST { action: "block_device"|"unblock_device", device_id } / { action: "note_device", device_id, note }
//   POST { action: "block_ip", ip, note? } / { action: "unblock_ip", ip }
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const settings = await getGuestSettings(db, { fresh: true });
  // 2026-10-16: ニックネーム(nickname)を返し、既定では名前のある端末だけ(?all=1 で名前の無い端末〈ボット等・登録前〉も)。
  // unnamed_count: 名前の無い端末の数。guest_devices は端末の数だけの小さな表(全件を読んでも数十〜数百行)
  const all = new URL(context.request.url).searchParams.get("all") === "1";
  const [devices, ips, unnamed] = await Promise.all([
    db.prepare(
      `SELECT device_id, nickname, first_seen, last_seen, ip, user_agent, hits, blocked, note FROM guest_devices
        WHERE ? = 1 OR nickname IS NOT NULL ORDER BY last_seen DESC LIMIT 200`
    ).bind(all ? 1 : 0).all().then((r) => r.results || []).catch(() => []),
    db.prepare("SELECT ip, created_at, note FROM guest_ip_blocks ORDER BY created_at DESC").all().then((r) => r.results || []).catch(() => []),
    db.prepare("SELECT COUNT(*) AS n FROM guest_devices WHERE nickname IS NULL").first().then((r) => Number(r?.n || 0)).catch(() => 0),
  ]);
  return Response.json({
    ok: true,
    settings: { enabled: settings.enabled, version: settings.version },
    window: guestRaceWindow(),
    devices,
    ip_blocks: ips,
    all,
    unnamed_count: unnamed,
  });
}

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const s = await getGuestSettings(db, { fresh: true });
  await saveGuestSettings(db, { ...s, enabled: Boolean(data?.enabled) });
  return Response.json({ ok: true });
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const now = new Date().toISOString();
  const deviceId = String(data?.device_id || "");
  const ip = String(data?.ip || "").trim();
  switch (data?.action) {
    case "block_device":
    case "unblock_device":
      if (!deviceId) return jsonError("device_id を指定してください", 400);
      await db.prepare("UPDATE guest_devices SET blocked = ? WHERE device_id = ?").bind(data.action === "block_device" ? 1 : 0, deviceId).run();
      invalidateGuestBlocks();
      return Response.json({ ok: true });
    case "note_device":
      if (!deviceId) return jsonError("device_id を指定してください", 400);
      await db.prepare("UPDATE guest_devices SET note = ? WHERE device_id = ?").bind(String(data.note || "").slice(0, 100), deviceId).run();
      return Response.json({ ok: true });
    case "block_ip":
      if (!ip) return jsonError("IPを指定してください", 400);
      await db.prepare("INSERT INTO guest_ip_blocks (ip, created_at, note) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET note = excluded.note")
        .bind(ip, now, String(data.note || "").slice(0, 100)).run();
      invalidateGuestBlocks();
      return Response.json({ ok: true });
    case "unblock_ip":
      if (!ip) return jsonError("IPを指定してください", 400);
      await db.prepare("DELETE FROM guest_ip_blocks WHERE ip = ?").bind(ip).run();
      invalidateGuestBlocks();
      return Response.json({ ok: true });
    default:
      return jsonError("action が不正です", 400);
  }
}
