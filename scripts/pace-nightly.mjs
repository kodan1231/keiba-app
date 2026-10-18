// 夜間の計算(2026-10-14追加。2026-10-18 から GitHub Actions〈.github/workflows/pace-nightly.yml〉で毎晩動かす。
// 仕様は docs/design/screens.md「比率の選び方の見直し」「比率の計算(夜間・今すぐ計算)」)。
//   1. 総合推奨馬の比率の計算待ち(GET /api/admin/pace-queue)の重賞・コースごとに、
//      前の自動計算から7日未満、または手で保存した比率なら計算せず計算待ちから外す。
//      それ以外は採点を数レースずつ受け取り(GET /api/admin/pace-backtest)、public/pace-search.js の総当たりで比率を選んで
//      保存し(PUT /api/admin/pace-weights/auto-result)、計算待ちから外す(DELETE /api/admin/pace-queue)。
//      総当たりはサーバーの1回の処理の CPU 上限(10ミリ秒)では終わらないため、ここ(Node)で計算する。
//   2. 同じ馬の組から出す距離の換算の比を、POST /api/cron/pace-step を「やることが無い」と返るまで呼んで1歩ずつ進める
//      (以前は Cloudflare の定時起動 workers/pace-cron が最大45回ずつ呼んでいた)。
// 認証: KEIBA_CRON_SECRET(管理者用アプリの秘密情報 PACE_CRON_SECRET と同じ値。ヘッダー X-Cron-Secret)。
//   手で動かすときは代わりに KEIBA_API_TOKEN(管理者の API トークン)でもよい(2 の距離の比は秘密情報が要る)。
//   KEIBA_BASE_URL=https://keiba-admin.pages.dev KEIBA_CRON_SECRET=... node scripts/pace-nightly.mjs
// 失敗した分は計算待ちに残る(次の晩にやり直す)。1件でも失敗したら終了コード1。
import { collectAndChoose } from "../public/pace-search.js";

const BASE = String(process.env.KEIBA_BASE_URL || "").replace(/\/+$/, "");
const SECRET = process.env.KEIBA_CRON_SECRET || "";
const TOKEN = process.env.KEIBA_API_TOKEN || "";
const SKIP_DAYS = 7;
const DISTANCE_STEPS_MAX = 2000; // 距離の比の1歩の上限(1回の計算は約40歩)

if (!BASE || (!SECRET && !TOKEN)) {
  console.error("KEIBA_BASE_URL と、KEIBA_CRON_SECRET か KEIBA_API_TOKEN を設定してください");
  process.exit(1);
}

const authHeaders = SECRET ? { "X-Cron-Secret": SECRET } : { Authorization: `Bearer ${TOKEN}` };

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status} ${data.error || ""}`);
  return data;
}

// 採点は D1 や CPU の都合で 503 になることがあるので、レース数を減らして最大3回やり直す(public/pace-runner.js と同じ考え方)
async function fetchChunk(kind, key, offset) {
  let last = null;
  for (const limit of [6, 3, 1, 1]) {
    try {
      return await api(`/api/admin/pace-backtest?kind=${q(kind)}&key=${q(key)}&offset=${offset}&limit=${limit}`);
    } catch (e) {
      last = e;
      if (!/HTTP 5\d\d/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last;
}

const q = (s) => encodeURIComponent(s);
const removeFromQueue = (it) => api(`/api/admin/pace-queue?kind=${q(it.kind)}&key=${q(it.key)}`, { method: "DELETE" });

let failed = 0;

// ---- 1. 比率 ----
const { items } = await api("/api/admin/pace-queue");
console.log(`比率の計算待ち ${items.length}件`);
for (const it of items) {
  const label = `${it.kind} ${it.key}`;
  try {
    if (it.manual) {
      console.log(`${label}: 手で保存した比率のため計算しない`);
      await removeFromQueue(it);
      continue;
    }
    if (it.last_computed_at && Date.now() - Date.parse(it.last_computed_at) < SKIP_DAYS * 86400000) {
      console.log(`${label}: 前の計算から${SKIP_DAYS}日未満のため計算しない(${it.last_computed_at})`);
      await removeFromQueue(it);
      continue;
    }
    const started = Date.now();
    const { result, info } = await collectAndChoose((offset) => fetchChunk(it.kind, it.key, offset));
    if (result.error) {
      console.log(`${label}: ${result.error}(計算待ちから外す)`);
      await removeFromQueue(it);
      continue;
    }
    await api("/api/admin/pace-weights/auto-result", { method: "PUT", body: JSON.stringify({ kind: it.kind, key: it.key, result }) });
    await removeFromQueue(it);
    const d = result.detail;
    console.log(`${label}(${info?.label || ""}): ${d.races}レースで計算・保存(${((Date.now() - started) / 1000).toFixed(1)}秒)`
      + ` 軸3着以内${d.best.show} / 4頭に1着馬${d.partner.best.win}${d.flat?.length ? ` / 差がつかない要素 ${d.flat.join(",")}` : ""}`
      + `${Object.keys(result.byPace || {}).length ? ` / ペースごと ${Object.keys(result.byPace).join(",")}` : ""}`);
  } catch (e) {
    failed++;
    console.error(`${label}: 失敗(計算待ちに残す) ${e.message}`);
  }
}

// ---- 2. 距離の換算の比(秘密情報があるときだけ) ----
if (SECRET) {
  let steps = 0;
  try {
    for (; steps < DISTANCE_STEPS_MAX; steps++) {
      const r = await api("/api/cron/pace-step", { method: "POST" });
      if (r.idle) break;
      if (steps % 10 === 0 || /done|cleared/.test(r.did || "")) console.log(`pace-step: ${r.did}`);
    }
    console.log(`距離の換算の比: ${steps}歩`);
  } catch (e) {
    failed++;
    console.error(`距離の換算の比: 失敗(${steps}歩目。次の晩に続きから) ${e.message}`);
  }
}

if (failed) process.exit(1);
