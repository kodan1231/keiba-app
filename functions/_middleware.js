// /api/* 以下すべてのリクエストで認証Cookieを検証するミドルウェア
// /api/auth/login だけは未認証でもアクセス可能(ログイン処理そのものなので)

function base64urlFix(str) {
  return str.replace(/-/g, "+").replace(/_/g, "/");
}

function base64urlToBuffer(str) {
  const bin = atob(base64urlFix(str));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function verifySession(cookieHeader, secret) {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return false;

  const [payloadB64, sigB64] = match[1].split(".");
  if (!payloadB64 || !sigB64) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlToBuffer(sigB64),
    enc.encode(payloadB64)
  );
  if (!valid) return false;

  try {
    const payload = JSON.parse(atob(base64urlFix(payloadB64)));
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const isApi = url.pathname.startsWith("/api/");
  const isLogin = url.pathname === "/api/auth/login";

  if (isApi && !isLogin) {
    if (!env.APP_PASSWORD) {
      return new Response(
        JSON.stringify({ error: "サーバー側にAPP_PASSWORDが設定されていません" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    const ok = await verifySession(request.headers.get("Cookie"), env.APP_PASSWORD);
    if (!ok) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return next();
}
