function strToBase64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function bufToBase64url(buf) {
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SESSION_DAYS = 30;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.APP_PASSWORD) {
    return new Response(
      JSON.stringify({ error: "サーバー側にAPP_PASSWORDが設定されていません" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  if (body.password !== env.APP_PASSWORD) {
    return new Response(JSON.stringify({ error: "パスワードが違います" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const exp = Date.now() + 1000 * 60 * 60 * 24 * SESSION_DAYS;
  const payloadB64 = strToBase64url(JSON.stringify({ exp }));

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.APP_PASSWORD),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const token = `${payloadB64}.${bufToBase64url(sig)}`;

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${
      60 * 60 * 24 * SESSION_DAYS
    }`
  );

  return new Response(JSON.stringify({ ok: true }), { headers });
}
