// 総合推奨馬の比率の計算待ちを、手元の Node で処理する(2026-10-14追加。仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」)。
// 当初は GitHub Actions で毎晩動かしていたが、2026-10-14 に Cloudflare の定時起動(workers/pace-cron)と取り込み直後のブラウザでの
// 計算(public/pace-runner.js)に置き換えた。このスクリプトは手で動かしたいとき用:
//   KEIBA_BASE_URL=https://<アプリのURL> KEIBA_API_TOKEN=<管理者のAPIトークン> node scripts/pace-nightly.mjs
// 流れ: 計算待ち(GET /api/admin/pace-queue)の重賞・コースごとに、
//   前の自動計算から7日未満、または手で保存した比率なら計算せず計算待ちから外す。
//   それ以外は採点を数レースずつ受け取り(GET /api/admin/pace-backtest)、public/pace-search.js で比率を選んで
//   保存し(PUT /api/admin/pace-weights/auto-result)、計算待ちから外す(DELETE /api/admin/pace-queue)。
// 失敗した分は計算待ちに残る(次の晩にやり直す)。1件でも失敗したら終了コード1。
import { collectAndChoose } from "../public/pace-search.js";

const BASE = String(process.env.KEIBA_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.KEIBA_API_TOKEN || "";
const SKIP_DAYS = 7;

if (!BASE || !TOKEN) {
  console.error("KEIBA_BASE_URL と KEIBA_API_TOKEN を設定してください");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status} ${data.error || ""}`);
  return data;
}

const q = (s) => encodeURIComponent(s);
const removeFromQueue = (it) => api(`/api/admin/pace-queue?kind=${q(it.kind)}&key=${q(it.key)}`, { method: "DELETE" });

const { items } = await api("/api/admin/pace-queue");
console.log(`計算待ち ${items.length}件`);
let failed = 0;
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
    const { result, info } = await collectAndChoose(
      (offset) => api(`/api/admin/pace-backtest?kind=${q(it.kind)}&key=${q(it.key)}&offset=${offset}&limit=6`),
    );
    if (result.error) {
      console.log(`${label}: ${result.error}(計算待ちから外す)`);
      await removeFromQueue(it);
      continue;
    }
    await api("/api/admin/pace-weights/auto-result", { method: "PUT", body: JSON.stringify({ kind: it.kind, key: it.key, result }) });
    await removeFromQueue(it);
    console.log(`${label}(${info?.label || ""}): ${result.detail.races}レースで計算・保存(${((Date.now() - started) / 1000).toFixed(1)}秒)`
      + ` 軸3着以内${result.detail.best.show} / 相手に1着馬${result.detail.partner.best.win}`);
  } catch (e) {
    failed++;
    console.error(`${label}: 失敗(計算待ちに残す) ${e.message}`);
  }
}
if (failed) process.exit(1);
