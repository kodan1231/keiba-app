const PBKDF2_ITERATIONS = 100000;

function bufToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return Buffer.from(binary, "binary").toString("base64");
}

async function hashPassword(password) {
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

const password = process.argv[2];
if (!password) {
  console.error("使い方: node gen_hash.mjs <新しいパスワード>");
  process.exit(1);
}
console.log(await hashPassword(password));

pbkdf2$100000$f7mRe1UM2XJlBdJCkJ3Xsw==$eL8hr/sq7pYQv83nwudE/Mz4iWTGLeuxSK8lyY517Xo=