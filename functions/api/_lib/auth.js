// 認証関連のヘルパー関数(パスワードハッシュ化・管理者判定・セッションCookie発行/検証)。
// 2026-09-01: functions/api/_shared.js から分割(リファクタリング。トークン消費削減のため
// 機能単位でファイルを分けた。functions/api/_shared.js は本ファイルを含む各モジュールを
// re-export するだけの薄いファイルとして残しており、既存のimport文(`from "../_shared.js"`等)は
// 変更不要)。

// ---- パスワードハッシュ化 ----
// Web Crypto の PBKDF2(SHA-256, 100000回)でハッシュ化する。
// 保存形式: "pbkdf2$<反復回数>$<salt(base64)>$<ハッシュ(base64)>"
// (バージョン管理のためアルゴリズム名・反復回数を保存文字列に含めている)
const PBKDF2_ITERATIONS = 100000;

function bufToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bufToBase64(salt)}$${bufToBase64(derived)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt, expected;
  try {
    salt = base64ToBuf(parts[2]);
    expected = parts[3];
  } catch {
    return false;
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const actual = bufToBase64(derived);
  // タイミング攻撃を避けるため、長さが同じ場合は必ず全バイトを比較する。
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ---- 管理者判定 ----
// 管理者かどうかはDBのフラグではなく、Cloudflare Pagesの環境変数
// ADMIN_USERNAMES(カンマ区切りのユーザー名リスト)で判定する。
// 環境変数を編集するだけで管理者を増減できるようにするための設計。
export function isAdminUsername(env, username) {
  if (!username) return false;
  const list = String(env.ADMIN_USERNAMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(username);
}

// 管理者専用エンドポイントの先頭で呼び出す。管理者でなければ403のResponseを返す。
// 管理者であればnullを返すので、呼び出し側は `if (deny) return deny;` のように使う。
export function requireAdmin(context) {
  if (!context.data?.isAdmin) {
    return Response.json({ error: "管理者のみ実行できます" }, { status: 403 });
  }
  return null;
}

// ---- セッションCookieの発行・検証 ----
// user_id・username・有効期限をセッションペイロードに含める。
// 署名鍵は env.APP_PASSWORD を流用する(ログイン用パスワードとしては使わないが、
// セッション署名用の秘密鍵としてはそのまま使い続ける)。
const SESSION_DAYS = 30;

function strToBase64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToStr(str) {
  const fixed = str.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(fixed)));
}
function bufToBase64url(buf) {
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBuffer(str) {
  const fixed = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(fixed);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

export async function createSessionToken(env, { userId, username }) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * SESSION_DAYS;
  const payloadB64 = strToBase64url(JSON.stringify({ uid: userId, username, exp }));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.APP_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const token = `${payloadB64}.${bufToBase64url(sig)}`;
  return { token, maxAgeSeconds: 60 * 60 * 24 * SESSION_DAYS };
}

export async function verifySessionToken(cookieHeader, secret) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;

  const [payloadB64, sigB64] = match[1].split(".");
  if (!payloadB64 || !sigB64) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify("HMAC", key, base64urlToBuffer(sigB64), enc.encode(payloadB64));
  if (!valid) return null;

  try {
    const payload = JSON.parse(base64urlToStr(payloadB64));
    if (!(payload.exp > Date.now())) return null;
    // uid が無い旧形式のセッションは無効として扱う。
    if (!Number.isInteger(payload.uid)) return null;
    return { userId: payload.uid, username: payload.username || null };
  } catch {
    return null;
  }
}
