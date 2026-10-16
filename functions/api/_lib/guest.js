// ゲスト閲覧(2026-10-14追加。ユーザー要望)。仕様は docs/design/guest.md。
// ログインせずに「次の開催週末の中央のレース」と「データ検索」を見られる。
//   - データ検索用アプリ(search)の画面を開くと、端末ID入りの署名つきCookie(kbg)を渡す(functions/_middleware.js の issueGuestCookie。
//     手元の開発環境〈all〉では /guest を開いたときだけ)。
//     2026-10-15: 以前の合言葉つきURL(/g/<合言葉>。functions/g/[key].js)と合言葉の作り直しは削除した(2026-10-14 のアプリ分離で
//     本番では使われなくなっていたため)。本番の /g/... は _lib/app-role.js の pageRedirect が search の /guest へ移す。
//   - /api/* ではセッションが無く kbg があればゲストとして扱う(functions/_middleware.js → resolveGuest)。
//     使えるのは読み取りの決まったAPIだけ(GUEST_API_RULES)。レース単位のAPIは期間内の中央のレースだけ。
//   - 設定は app_settings の key='guest': { enabled, version }(以前の合言葉 key が残っていても読まない)。
//     version は Cookie に入れる版(今は変える操作は無い)。
//   - 端末ごと・IPごとにブロックできる(guest_devices.blocked / guest_ip_blocks)。
//   - ニックネーム(2026-10-16追加。ユーザー要望・仕様確認済み): 初めて開いたときに名前だけ(1〜10文字・パスワードなし)を登録してもらう。
//     名前は署名つき Cookie(kbg)の n に入れる(API のたびに D1 を読まない)。名前が無いうちは /api/auth/check と登録
//     (POST /api/guest/nickname。functions/api/guest/nickname.js)以外は 403 guest_need_name。名前は重複を断る
//     (guest_devices.nickname_key の UNIQUE。@STEP: guest_nickname)。端末の行は登録のときに作る(名前の無い端末〈ボット等〉は行を作らない)
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

// Cookie の値を作る: { d: 端末ID, v: 設定の版, n: ニックネーム(2026-10-16。未登録なら無し) }
export async function createGuestCookie(env, deviceId, version, nickname = null) {
  const body = { d: deviceId, v: version, exp: Date.now() + GUEST_COOKIE_DAYS * 86400000 };
  if (nickname) body.n = nickname;
  const payload = toB64url(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.APP_PASSWORD, "sign"), new TextEncoder().encode(payload));
  const value = `${payload}.${toB64url(new Uint8Array(sig))}`;
  return `${GUEST_COOKIE}=${value}; Path=/; Max-Age=${GUEST_COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

// Cookie を検証して { deviceId, version, nickname } か null
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
    return { deviceId: p.d, version: p.v, nickname: typeof p.n === "string" && p.n ? p.n : null };
  } catch {
    return null;
  }
}

// ---- 設定 ----
function normalizeSettings(raw) {
  return {
    enabled: Boolean(raw?.enabled),
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

// ---- ニックネーム(2026-10-16) ----
export const GUEST_NICKNAME_MAX = 10;
export const GUEST_NICKNAME_PATH = "/api/guest/nickname";
// 重複を比べるキー(全角半角・大文字小文字・空白の違いは同じとみなす)
export function guestNicknameKeyOf(name) {
  return String(name || "").normalize("NFKC").toLowerCase().replace(/\s/g, "");
}
// 入力をそろえる(前後の空白を取る・制御文字は不可)。1〜GUEST_NICKNAME_MAX 文字でなければ null
export function normalizeGuestNickname(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null;
  const len = [...s].length;
  return len >= 1 && len <= GUEST_NICKNAME_MAX ? s : null;
}

// ---- ゲストが使えるAPI(GETだけ) ----
// raceId: そのレースが期間内の中央のレースでなければ断る(パスの :id か ?race_id=)
const GUEST_API_RULES = [
  { re: /^\/api\/auth\/check$/ },
  { re: /^\/api\/races$/, query: (q) => q.get("index") === "1" }, // 一覧は races/index.js で期間内に絞る
  { re: /^\/api\/races\/(\d+)$/, raceFromPath: true },
  { re: /^\/api\/races\/(\d+)\/horse-history$/, raceFromPath: true },
  { re: /^\/api\/races\/(\d+)\/horse-best$/, raceFromPath: true },
  { re: /^\/api\/races\/(\d+)\/results$/, raceFromPath: true }, // 予想登録画面の結果タブ(2026-10-14)
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
  // ニックネームの登録(2026-10-16): 名前の有無に関係なく POST だけ通す(アクセスの記録はしない。行は登録の API が作る)
  if (url.pathname === GUEST_NICKNAME_PATH) {
    return request.method === "POST" ? { deviceId: cookie.deviceId, nickname: cookie.nickname, version: cookie.version } : json({ error: "guest_forbidden" }, 403);
  }
  // 名前が未登録なら、画面が登録画面を出すための /api/auth/check だけ通す
  if (!cookie.nickname) {
    if (request.method === "GET" && url.pathname === "/api/auth/check") return { deviceId: cookie.deviceId, nickname: null, version: cookie.version };
    return json({ error: "guest_need_name" }, 403);
  }
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
  return { deviceId: cookie.deviceId, nickname: cookie.nickname, version: cookie.version };
}
