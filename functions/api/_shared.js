// 複数のAPIエンドポイントで共有するヘルパー関数。
// ファイル名を "_" で始めているため、Cloudflare Pages Functions では
// このファイル自体はルートとして扱われない(_middleware.js と同じ扱い)。

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

// レースが未登録の間にインポートされた imported_ticket_groups / imported_ticket_items は
// race_id が NULL のまま保存されている。管理者がそのレースを登録(または編集)したタイミングで、
// 日付・競馬場・レース番号が一致する未紐付けデータを探してレースに紐付ける。
export async function linkUnregisteredImportsToRace(db, raceId, raceDate, track, raceNumber) {
  if (!db || !raceId || !raceDate || !track || !raceNumber) return { linkedGroups: 0 };
  const { results: groups } = await db.prepare(
    `SELECT id FROM imported_ticket_groups WHERE race_id IS NULL AND race_date = ? AND track = ? AND race_number = ?`
  ).bind(raceDate, track, raceNumber).all();
  if (!groups || !groups.length) return { linkedGroups: 0 };
  const groupIds = groups.map((g) => g.id);
  const placeholders = groupIds.map(() => "?").join(",");
  await db.batch([
    db.prepare(`UPDATE imported_ticket_groups SET race_id = ? WHERE id IN (${placeholders})`).bind(raceId, ...groupIds),
    db.prepare(`UPDATE imported_ticket_items SET race_id = ? WHERE group_id IN (${placeholders})`).bind(raceId, ...groupIds),
  ]);
  return { linkedGroups: groupIds.length };
}

// CSVインポート時点では馬名・騎手が分からず、購入履歴(imported_ticket_items / tickets)の
// selections には馬番だけが入っている場合がある。レース管理画面で出走馬表(馬名・騎手)を
// 登録・更新したタイミングで、同じレース・馬番を参照している購入履歴の selections に
// 馬名・騎手を書き戻す(バックフィルする)。
//
// 対象は race_id で紐付く imported_ticket_items と tickets のみ。
// (レース登録より前にインポートされ、まだ race_id と紐付いていない旧形式の
//  imported_tickets 生データは対象外。CSV再取込で自然に解消される想定)
export async function backfillHorseNamesForRace(db, raceId, entries) {
  if (!db || !raceId || !Array.isArray(entries) || entries.length === 0) return { updated: 0 };

  const nameByNumber = new Map();
  for (const e of entries) {
    const horseNumber = Number(e?.horse_number);
    if (!Number.isInteger(horseNumber)) continue;
    const horse_name = e?.horse_name ? String(e.horse_name).trim() : "";
    const jockey = e?.jockey ? String(e.jockey).trim() : "";
    if (!horse_name && !jockey) continue;
    nameByNumber.set(horseNumber, { horse_name: horse_name || null, jockey: jockey || null });
  }
  if (nameByNumber.size === 0) return { updated: 0 };

  let updated = 0;
  for (const table of ["imported_ticket_items", "tickets"]) {
    const { results } = await db.prepare(`SELECT id, selections FROM ${table} WHERE race_id = ?`).bind(raceId).all();
    const statements = [];
    for (const row of results || []) {
      let selections;
      try {
        selections = JSON.parse(row.selections || "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(selections) || selections.length === 0) continue;

      let changed = false;
      const next = selections.map((s) => {
        const info = nameByNumber.get(Number(s?.horse_number));
        if (!info) return s;
        const merged = { ...s };
        if (info.horse_name && merged.horse_name !== info.horse_name) {
          merged.horse_name = info.horse_name;
          changed = true;
        }
        if (info.jockey && merged.jockey !== info.jockey) {
          merged.jockey = info.jockey;
          changed = true;
        }
        return merged;
      });

      if (changed) {
        statements.push(db.prepare(`UPDATE ${table} SET selections = ? WHERE id = ?`).bind(JSON.stringify(next), row.id));
        updated++;
      }
    }
    if (statements.length) await db.batch(statements);
  }

  return { updated };
}

// ---- 払戻確定時の全ユーザーticket反映 ----
// races.finish_order / races.payouts が確定した際、そのレースを購入した
// 全ユーザーの tickets.payout を再計算して反映する。races は共有データ、
// tickets はユーザーごとに分離されたデータであるため、user_idで絞り込まず
// race_id単位で全ユーザーのticketsを対象にする必要がある。
// (ロジックは public/payout.js の computeWinningCombos 等をサーバー側へ移植したもの。
//  クライアント側と実装がずれないよう、変更する際は両方を確認すること)
//
// 呼び出し元:
//   - functions/api/races/[id].js (レース管理画面の払戻編集モーダルからの保存)
//   - functions/api/races/results-import.js (JRAレース結果PDF一括登録)
// 新しく finish_order / payouts を更新する処理を追加する場合は、必ずここも
// 呼び出すこと(呼び忘れると、購入済みの馬券のpayoutが更新されないまま
// 「未確定」表示が残ってしまう)。

const ORDERED_BET_TYPES = new Set(["umatan", "sanrentan"]);

function computeWinningCombos(betType, finishOrder, entries) {
  if (!finishOrder || finishOrder.length === 0) return [];
  const wakuOf = (h) => {
    const e = (entries || []).find((x) => x.horse_number === h);
    return e ? e.waku_number : null;
  };
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const top = (n) => finishOrder.slice(0, n);

  if (betType === "tan") return [{ combo: [top(1)[0]] }];
  if (betType === "fuku") return top(3).map((h) => ({ combo: [h] }));
  if (betType === "umaren") { const t = top(2); return [{ combo: sorted(t) }]; }
  if (betType === "wide") {
    const t3 = top(3);
    return [[t3[0], t3[1]], [t3[0], t3[2]], [t3[1], t3[2]]].map((p) => ({ combo: sorted(p) }));
  }
  if (betType === "umatan") { const t = top(2); return [{ combo: t }]; }
  if (betType === "sanrenpuku") { const t = top(3); return [{ combo: sorted(t) }]; }
  if (betType === "sanrentan") { const t = top(3); return [{ combo: t }]; }
  if (betType === "wakuren") {
    const t = top(2);
    const w = [wakuOf(t[0]), wakuOf(t[1])];
    if (w.some((x) => x === null || x === undefined)) return [{ combo: null }];
    return [{ combo: sorted(w) }];
  }
  return [];
}

function ticketMatchesComboServer(betType, selections, combo) {
  if (!combo) return false;
  if (betType === "wakuren") {
    const w = selections
      .map((s) => s.waku_number)
      .filter((x) => x !== null && x !== undefined)
      .sort((a, b) => a - b);
    return JSON.stringify(w) === JSON.stringify(combo);
  }
  const nums = selections.map((s) => s.horse_number);
  const target = ORDERED_BET_TYPES.has(betType) ? nums : [...nums].sort((a, b) => a - b);
  return JSON.stringify(target) === JSON.stringify(combo);
}

function findStoredRateServer(payouts, betType, combo) {
  if (!payouts || !payouts[betType] || !combo) return null;
  const found = payouts[betType].find((p) => JSON.stringify(p.combo) === JSON.stringify(combo));
  return found ? found.rate : null;
}

// レースの着順・払戻レートが確定/更新された際、そのレースに紐づく
// 「全ユーザーの」tickets.payout を再計算して反映する(user_idで絞り込まない)。
// finishOrder / payoutsObj が無い(未確定に戻った)場合は payout を null に戻す。
export async function recomputeTicketPayoutsForRace(db, raceId, finishOrder, payoutsObj, entries) {
  if (!db || !raceId) return { updated: 0 };
  const { results } = await db
    .prepare(`SELECT id, bet_type, selections, amount, payout FROM tickets WHERE race_id = ?`)
    .bind(raceId)
    .all();
  if (!results || !results.length) return { updated: 0 };

  const statements = [];
  for (const t of results) {
    let newPayout = null;
    if (finishOrder && payoutsObj && payoutsObj[t.bet_type]) {
      let selections;
      try {
        selections = JSON.parse(t.selections || "[]");
      } catch {
        selections = [];
      }
      const combos = computeWinningCombos(t.bet_type, finishOrder, entries);
      // 枠番(waku_number)が未確定の出走馬が絡む枠連など、的中組み合わせ自体を
      // 算出できない(combo === null)ケースでは、「不的中(0円)」と断定せず
      // 判定不能(null=未確定のまま)として扱う(0円へフォールバックすると、
      // 実際には的中している可能性がある馬券まで不的中扱いになってしまうため)。
      if (combos.some((c) => c.combo === null)) {
        newPayout = null;
      } else {
        let matchedRate = null;
        for (const c of combos) {
          const rate = findStoredRateServer(payoutsObj, t.bet_type, c.combo);
          if (rate !== null && ticketMatchesComboServer(t.bet_type, selections, c.combo)) {
            matchedRate = rate;
            break;
          }
        }
        newPayout = matchedRate !== null ? Math.round((Number(t.amount) / 100) * matchedRate) : 0;
      }
    }
    const current = t.payout === undefined ? null : t.payout;
    if (newPayout !== current) {
      statements.push(db.prepare(`UPDATE tickets SET payout = ? WHERE id = ?`).bind(newPayout, t.id));
    }
  }
  if (statements.length) await db.batch(statements);
  return { updated: statements.length };
}
