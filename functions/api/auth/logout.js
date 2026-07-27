export async function onRequestPost() {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
  );
  return new Response(JSON.stringify({ ok: true }), { headers });
}
