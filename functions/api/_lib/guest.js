// ゲスト閲覧(2026-10-14追加。ユーザー要望)。仕様は docs/design/guest.md。
// ログインせずに、ゲスト用URL(/g/<合言葉>)を知っている人が「次の開催週末の中央のレース」と「データ検索」を見られる。
//   - /g/<合言葉> を開くと端末ID入りの署名つきCookie(kbg)を渡す(functions/g/[key].js)。
//   - /api/* ではセッションが無く kbg があればゲストとして扱う(functions/_middleware.js → resolveGuest)。
//     使えるのは読み取りの決まったAPIだけ(GUEST_API_RULES)。レース単位のAPIは期間内の中央のレースだけ。
//   - 設定は app_settings の key='guest': { enabled, key(合言葉), version }。合言葉を作り直すと version が上がり、
//     古いURLから入った端末の Cookie は使えなくなる。
//   - 端末ごと・IPごとにブロックできる(guest_devices.blocked / guest_ip_blocks)。
// D1: 設定とブロックの一覧は同じ実行環境で1分使い回す。アクセスの記録は1端末につき10分に1回まで書く。
import { memoized, invalidateMemo } from "./memo-cache.js";

export const GUEST_COOKIE = "kbg"; // 注意: 名前を "...session" にしない(_lib/auth.js の verifySessionToken が /session=/ で探すため)
const GUEST_COOKIE_DAYS = 365;
const GUEST_SETTINGS_KEY = "guest";
const MEMO_GUEST_SETTINGS = "guest_settings";
const MEMO_GUEST_BLOCKS = "guest_blocks";
const RECORD_INTERVAL_MS = 10 * 60 * 1000;
export const JRA_TRACKS = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];

// ---- 署名(セッションCookieと同じく env.APP_PASSWORD で HMAC-SHA256) ----
function toB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
export function randomToken(bytes = 18) {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Cookie の値を作る: { d: 端末ID, v: 合言葉の版 }
export async function createGuestCookie(env, deviceId, version) {
  const payload = toB64url(new TextEncoder().encode(JSON.stringify({ d: deviceId, v: version, exp: Date.now() + GUEST_COOKIE_DAYS * 86400000 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.APP_PASSWORD, "sign"), new TextEncoder().encode(payload));
  const value = `${payload}.${toB64url(new Uint8Array(sig))}`;
  return `${GUEST_COOKIE}=${value}; Path=/; Max-Age=${GUEST_COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

// Cookie を検証して { deviceId, version } か null
export async function readGuestCookie(env, cookieHeader) {
  const m = String(cookieHeader || "").match(new RegExp(`(?:^|;\\s*)${GUEST_COOKIE}=([^;]+)`));
  if (!m || !env.APP_PASSWORD) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.APP_PASSWORD, "verify"), fromB64url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (!(p.exp > Date.now()) || typeof p.d !== "string" || !Number.isInteger(p.v)) return null;
    return { deviceId: p.d, version: p.v };
  } catch {
    return null;
  }
}

// ---- 設定 ----
function normalizeSettings(raw) {
  return {
    enabled: Boolean(raw?.enabled),
    key: typeof raw?.key === "string" && raw.key ? raw.key : null,
    version: Number.isInteger(raw?.version) ? raw.version : 0,
  };
}

export async function getGuestSettings(db, { fresh = false } = {}) {
  const load = async () => {
    try {
      const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(GUEST_SETTINGS_KEY).first();
      return normalizeSettings(row ? JSON.parse(row.value) : null);
    } catch {
      return normalizeSettings(null);
    }
  };
  return fresh ? load() : memoized(MEMO_GUEST_SETTINGS, load, 60 * 1000);
}

export async function saveGuestSettings(db, settings) {
  const s = normalizeSettings(settings);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(GUEST_SETTINGS_KEY, JSON.stringify(s), new Date().toISOString())
    .run();
  invalidateMemo(MEMO_GUEST_SETTINGS);
  return s;
}

// ---- ブロック ----
// { devices: Set(端末ID), ips: Set(IP) }。表が無い等で読めなければ空(止めない)
export async function getGuestBlocks(db, { fresh = false } = {}) {
  const load = async () => {
    try {
      const [d, i] = await Promise.all([
        db.prepare("SELECT device_id FROM guest_devices WHERE blocked = 1").all(),
        db.prepare("SELECT ip FROM guest_ip_blocks").all(),
      ]);
      return { devices: new Set((d.results || []).map((r) => r.device_id)), ips: new Set((i.results || []).map((r) => r.ip)) };
    } catch (e) {
      console.error("guest blocks read failed (ignored)", e);
      return { devices: new Set(), ips: new Set() };
    }
  };
  return fresh ? load() : memoized(MEMO_GUEST_BLOCKS, load, 60 * 1000);
}
export function invalidateGuestBlocks() {
  invalidateMemo(MEMO_GUEST_BLOCKS);
}

export function requestIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "";
}

// ---- アクセスの記録(1端末につき10分に1回まで書く。回数はその間の分をまとめて足す) ----
const lastWrite = new Map(); // 端末ID -> { at, pending }
export function recordGuestAccess(context, deviceId) {
  const now = Date.now();
  let s = lastWrite.get(deviceId);
  if (!s) lastWrite.set(deviceId, (s = { at: 0, pending: 0 }));
  s.pending++;
  if (now - s.at < RECORD_INTERVAL_MS) return;
  const hits = s.pending;
  s.at = now;
  s.pending = 0;
  const iso = new Date(now).toISOString();
  const ua = String(context.request.headers.get("User-Agent") || "").slice(0, 200);
  const p = context.env.DB.prepare(
    `INSERT INTO guest_devices (device_id, first_seen, last_seen, ip, user_agent, hits, blocked) VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen, ip = excluded.ip, user_agent = excluded.user_agent,
       hits = guest_devices.hits + excluded.hits`
  ).bind(deviceId, iso, iso, requestIp(context.request), ua, hits).run().catch((e) => console.error("guest access record failed (ignored)", e));
  if (context.waitUntil) context.waitUntil(p);
}

// ---- 見せるレースの期間: 今日〜次の月曜(日本時間。月曜は祝日開催のため)。今日が月曜なら翌週の月曜まで ----
export function guestRaceWindow(now = Date.now()) {
  const jst = new Date(now + 9 * 3600 * 1000);
  const from = jst.toISOString().slice(0, 10);
  const dow = jst.getUTCDay(); // 0=日 … 1=月
  const daysToMonday = ((8 - dow) % 7) || 7;
  const to = new Date(jst.getTime() + daysToMonday * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

export function isGuestRace(race, win = guestRaceWindow()) {
  if (!race) return false;
  const d = String(race.race_date || "");
  return d >= win.from && d <= win.to && JRA_TRACKS.includes(String(race.track || "").trim());
}

// ---- ゲストが使えるAPI(GETだけ) ----
// raceId: そのレースが期間内の中央のレースでなければ断る(パスの :id か ?race_id=)
const GUEST_API_RULES = [
  { re: /^\/api\/auth\/check$/ },
  { re: /^\/api\/races$/, query: (q) => q.get("index") === "1" }, // 一覧は races/index.js で期間内に絞る
  { re: /^\/api\/races\/(\d+)$/, raceFromPath: true },
  { re: /^\/api\/races\/(\d+)\/horse-history$/, raceFromPath: true },
  { re: /^\/api\/races\/(\d+)\/horse-best$/, raceFromPath: true },
  { re: /^\/api\/data-search\/(race-factors|jockey-course)$/, raceFromQuery: true },
  { re: /^\/api\/data-search\/[a-z-]+$/ },
  { re: /^\/api\/pace-weights$/ },
];

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ゲストとして通すか判定する。戻り値: null(ゲストのCookieが無い)/ Response(断る)/ { deviceId }(通す)
export async function resolveGuest(context) {
  const { request, env } = context;
  const cookie = await readGuestCookie(env, request.headers.get("Cookie"));
  if (!cookie) return null;
  const db = env.DB;
  const settings = await getGuestSettings(db);
  if (!settings.enabled || cookie.version !== settings.version) return json({ error: "guest_invalid" }, 401);
  const blocks = await getGuestBlocks(db);
  if (blocks.devices.has(cookie.deviceId) || blocks.ips.has(requestIp(request))) return json({ error: "guest_blocked" }, 403);

  const url = new URL(request.url);
  const rule = request.method === "GET" ? GUEST_API_RULES.find((r) => r.re.test(url.pathname)) : null;
  if (!rule || (rule.query && !rule.query(url.searchParams))) return json({ error: "guest_forbidden" }, 403);
  let raceId = null;
  if (rule.raceFromPath) raceId = Number(url.pathname.match(rule.re)[1]);
  if (rule.raceFromQuery) raceId = Number(url.searchParams.get("race_id"));
  if (raceId !== null) {
    // races を主キーで1行(日付・競馬場だけ)
    const race = Number.isInteger(raceId) && raceId > 0
      ? await db.prepare("SELECT race_date, track FROM races WHERE id = ?").bind(raceId).first()
      : null;
    if (!isGuestRace(race)) return json({ error: "guest_out_of_range" }, 403);
  }
  recordGuestAccess(context, cookie.deviceId);
  return { deviceId: cookie.deviceId };
}
