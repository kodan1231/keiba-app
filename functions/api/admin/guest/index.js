import {
  requireAdmin, readJsonBody, jsonError, getGuestSettings, saveGuestSettings, randomToken, guestRaceWindow,
  invalidateGuestBlocks,
} from "../../_shared.js";

// 管理者向け: ゲスト閲覧の設定・端末・IPブロック(2026-10-14追加)。仕様は docs/design/guest.md。
//   GET  → { settings: { enabled, version, path }, window: { from, to }, devices: [...], ip_blocks: [...] }
//          devices は最終アクセスの新しい順に最大200件(guest_devices は端末の数だけの小さな表)
//   PUT  { enabled } → 公開する/止める
//   POST { action: "regenerate" } → 合言葉を作り直す(古いURL・古いURLで入った端末の Cookie は使えなくなる)
//   POST { action: "block_device"|"unblock_device", device_id } / { action: "note_device", device_id, note }
//   POST { action: "block_ip", ip, note? } / { action: "unblock_ip", ip }
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const settings = await getGuestSettings(db, { fresh: true });
  const [devices, ips] = await Promise.all([
    db.prepare("SELECT device_id, first_seen, last_seen, ip, user_agent, hits, blocked, note FROM guest_devices ORDER BY last_seen DESC LIMIT 200")
      .all().then((r) => r.results || []).catch(() => []),
    db.prepare("SELECT ip, created_at, note FROM guest_ip_blocks ORDER BY created_at DESC").all().then((r) => r.results || []).catch(() => []),
  ]);
  return Response.json({
    ok: true,
    settings: { enabled: settings.enabled, version: settings.version, path: settings.key ? `/g/${settings.key}` : null },
    window: guestRaceWindow(),
    devices,
    ip_blocks: ips,
  });
}

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const s = await getGuestSettings(db, { fresh: true });
  // 初めて公開するときは合言葉を作る
  const next = { ...s, enabled: Boolean(data?.enabled) };
  if (next.enabled && !next.key) next.key = randomToken(18);
  await saveGuestSettings(db, next);
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
    case "regenerate": {
      const s = await getGuestSettings(db, { fresh: true });
      await saveGuestSettings(db, { ...s, key: randomToken(18), version: s.version + 1 });
      return Response.json({ ok: true });
    }
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
