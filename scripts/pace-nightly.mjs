// 夜間の計算(2026-10-14追加。2026-10-18 から GitHub Actions〈.github/workflows/pace-nightly.yml〉で毎晩動かす。
// 仕様は docs/design/screens.md「比率の選び方の見直し」「比率の計算(夜間・今すぐ計算)」)。
//   1. 総合推奨馬の比率の計算待ち(pace_recompute_queue)の重賞・コースごとに、手で保存した比率なら計算せず計算待ちから外す
//      (計算待ちに積むのは結果が入ったとき・まだ今の方式で計算していないときだけ〈_lib/pace-queue.js〉で、同じ条件は1晩1回)。
//      それ以外は過去のレースを採点し、public/pace-search.js の総当たりで比率を選んで保存し(PUT /api/admin/pace-weights/auto-result)、
//      計算待ちから外す(DELETE /api/admin/pace-queue)。
//      **採点はこの Node で行う**(2026-10-19。CF_D1_TOKEN があるとき): D1 を Cloudflare の API で読み(scripts/lib/d1-rest.mjs)、
//      サーバーと同じ採点のコード(functions/api/_lib/pace-score.js の backtestChunk)を動かす。以前は採点の API(/api/admin/pace-backtest)を
//      数レースずつ呼んでいたが、Cloudflare の1回の処理の CPU 時間の上限を続けて超え、途中から呼び出しがまとめて 503 で断られた
//      (2026-10-19 の手動実行で30件中11件)。CF_D1_TOKEN が無ければ従来どおり採点の API を呼ぶ。
//   2a.(2026-11-04)毎晩1回、結果の表を Node で読み、距離の換算の比と換算の組み合わせごとの偏りを出して POST /api/cron/conversion で保存する。
//   2. 同じ馬の組から出す距離の換算の比を、POST /api/cron/pace-step を「やることが無い」と返るまで呼んで1歩ずつ進める
//      (2a で保存した晩は何もしない。D1 を読めないときの予備)。
// 失敗した条件は計算待ちに残し、最後に1分待ってもう一度やり直す。それでも残ったものを一覧に出し、終了コード1(GitHub のメールで分かる)。
// 環境変数: KEIBA_BASE_URL(管理者用アプリ)、KEIBA_CRON_SECRET(管理者用アプリの秘密情報 PACE_CRON_SECRET と同じ値。ヘッダー X-Cron-Secret)
//   CF_D1_TOKEN(D1 を読める Cloudflare の API トークン)、CF_ACCOUNT_ID・CF_D1_DATABASE_ID(省略時は本番の値)
//   DRY_RUN=1(手元の確認用): 計算待ちを D1 から読み、計算だけして保存・計算待ちの削除・距離の比はしない(KEIBA_* は要らない)
//   手で動かすときは KEIBA_CRON_SECRET の代わりに KEIBA_API_TOKEN(管理者の API トークン)でもよい(2 の距離の比は秘密情報が要る)
import { collectAndChoose } from "../public/pace-search.js";
import { createD1Rest } from "./lib/d1-rest.mjs";

const BASE = String(process.env.KEIBA_BASE_URL || "").replace(/\/+$/, "");
const SECRET = process.env.KEIBA_CRON_SECRET || "";
const TOKEN = process.env.KEIBA_API_TOKEN || "";
const D1_TOKEN = process.env.CF_D1_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "c3dc56a1eaad703f636e2a990aaa7d1c";
const DATABASE_ID = process.env.CF_D1_DATABASE_ID || "82cd3353-2185-4c83-bcde-4cf8db2b905b"; // keiba-yosou-db(wrangler.toml)
const LOCAL_CHUNK = 30; // Node で1回に採点するレース数(対象レースの IN の数。100バインド上限より小さく)
const DISTANCE_STEPS_MAX = 2000; // 距離の比の1歩の上限(1回の計算は約40歩)

if (DRY_RUN ? !D1_TOKEN : !BASE || (!SECRET && !TOKEN)) {
  console.error(DRY_RUN ? "DRY_RUN には CF_D1_TOKEN が要ります" : "KEIBA_BASE_URL と、KEIBA_CRON_SECRET か KEIBA_API_TOKEN を設定してください");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => encodeURIComponent(s);
const authHeaders = SECRET ? { "X-Cron-Secret": SECRET } : { Authorization: `Bearer ${TOKEN}` };

// アプリの API。混雑・CPU の上限(503)・一時的な失敗は 5秒→15秒→30秒→60秒 待ってやり直す
async function api(path, init = {}) {
  let last = null;
  for (const wait of [0, 5000, 15000, 30000, 60000]) {
    if (wait) await sleep(wait);
    try {
      const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders, "Content-Type": "application/json", ...(init.headers || {}) } });
      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text); } catch { data = {}; }
      if (res.ok) return data;
      last = new Error(`${init.method || "GET"} ${path} → HTTP ${res.status} ${data.error || text.slice(0, 80)}`);
      if (res.status !== 429 && res.status < 500) throw Object.assign(last, { permanent: true });
    } catch (e) {
      if (e.permanent) throw e;
      last = e;
    }
  }
  throw last;
}

// 採点: Node(D1 を API で読む)か、従来の採点の API
let d1 = null, backtestChunk = null, getPaceScoreSettings = null;
if (D1_TOKEN) {
  d1 = createD1Rest({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, token: D1_TOKEN });
  ({ backtestChunk } = await import("../functions/api/_lib/pace-score.js"));
  ({ getPaceScoreSettings } = await import("../functions/api/_lib/pace-settings.js"));
}
// 出走馬の全戦績を1回の実行の間使い回す(2026-10-27。D1 の読み取りを減らす。_lib/pace-score.js の scoreRaces の runsCache)
const runsCache = new Map();
async function fetchChunk(kind, key, offset) {
  if (d1) {
    const s = await getPaceScoreSettings(d1);
    const r = await backtestChunk(d1, kind, key, offset, LOCAL_CHUNK, { missingScore: s.missing_score, chunkMax: LOCAL_CHUNK, runsCache });
    // 重賞が見つからない等は採点するレースが無いのと同じ扱い(計算待ちから外す)
    if (r.error) return { kind, key: String(key), label: key, total: 0, offset, races: [], missing_score: s.missing_score, adjust_default: s.adjust, note: r.error };
    return { ...r, adjust_default: s.adjust };
  }
  return api(`/api/admin/pace-backtest?kind=${q(kind)}&key=${q(key)}&offset=${offset}&limit=6`);
}

async function loadQueue() {
  if (DRY_RUN) {
    const { results } = await d1.prepare("SELECT kind, key FROM pace_recompute_queue ORDER BY created_at").all();
    return results || [];
  }
  return (await api("/api/admin/pace-queue")).items || [];
}

// 1条件を計算して保存する。戻り値: 結果の一行の説明(失敗は throw)
async function processItem(it) {
  const label = `${it.kind} ${it.key}`;
  if (it.manual) {
    if (!DRY_RUN) await api(`/api/admin/pace-queue?kind=${q(it.kind)}&key=${q(it.key)}`, { method: "DELETE" });
    return `${label}: 手で保存した比率のため計算しない`;
  }
  const started = Date.now();
  const { result, info } = await collectAndChoose((offset) => fetchChunk(it.kind, it.key, offset));
  if (result.error) {
    if (!DRY_RUN) await api(`/api/admin/pace-queue?kind=${q(it.kind)}&key=${q(it.key)}`, { method: "DELETE" });
    return `${label}: ${result.error}${info?.note ? `(${info.note})` : ""}(計算待ちから外す)`;
  }
  if (!DRY_RUN) {
    await api("/api/admin/pace-weights/auto-result", { method: "PUT", body: JSON.stringify({ kind: it.kind, key: it.key, result }) });
    await api(`/api/admin/pace-queue?kind=${q(it.kind)}&key=${q(it.key)}`, { method: "DELETE" });
  }
  const d = result.detail;
  return `${label}(${info?.label || ""}): ${d.races}レースで計算${DRY_RUN ? "(DRY_RUN・保存しない)" : "・保存"}(${((Date.now() - started) / 1000).toFixed(1)}秒)`
    + ` 軸3着以内${d.best.show} / 4頭に1着馬${d.partner.best.win}${d.flat?.length ? ` / 差がつかない要素 ${d.flat.join(",")}` : ""}`
    + `${Object.keys(result.byPace || {}).length ? ` / ペースごと ${Object.keys(result.byPace).join(",")}` : ""}`;
}

// ---- 2a. 距離の換算の比と、換算の組み合わせごとの偏り(2026-11-04。Node で計算。D1 を読めて秘密情報があるときだけ) ----
// 比率の計算(1)の採点が新しい換算を使うよう、1 より先に行う
// 新しい結果があり前回から20時間たっていれば(distanceRatiosState の stale)、結果の表を主キーの順に読み(約19.5万行)、races を1回読み(約1.5万行)、
// 距離の比(同じ競馬場の ±200m の組)と換算の組み合わせごとの偏り(_lib/distance-ratios.js の computeConversionTables)を出して
// POST /api/cron/conversion で保存する。Cloudflare 側の1歩ずつの計算(下の 2)は、保存した後は「やることが無い」になる。
// FORCE_CONVERSION=1 なら前回からの時間を問わず計算する(手で動かすとき)
let conversionFailed = null;
if (d1 && SECRET && !DRY_RUN && process.env.SKIP_DISTANCE !== "true") {
  try {
    const { distanceRatiosState, computeConversionTables } = await import("../functions/api/_lib/distance-ratios.js");
    const st = await distanceRatiosState(d1);
    if (st.running) {
      console.log("換算の比と偏り: Cloudflare 側の距離の比の計算の途中なので、今夜はそちらに任せる");
    } else if (!st.stale && process.env.FORCE_CONVERSION !== "1") {
      console.log(`換算の比と偏り: 計算しない(前回 ${st.computed_at}${st.newer ? "・新しい結果あり(20時間たっていない)" : "・新しい結果なし"})`);
    } else {
      const started = Date.now();
      const { convertTime, makeCourseOf } = await import("../functions/api/_lib/race-factors.js");
      const { getRaceTimes } = await import("../functions/api/_lib/race-time-cache.js");
      const { timeTextToSeconds } = await import("../functions/api/_lib/graded-race-search.js");
      const readAll = async (sql, page) => {
        const out = [];
        for (let last = 0; ;) {
          const { results } = await d1.prepare(`${sql} WHERE id > ? ORDER BY id LIMIT ${page}`).bind(last).all();
          out.push(...results);
          if (results.length < page) return out;
          last = results[results.length - 1].id;
        }
      };
      const races = new Map((await readAll("SELECT id, race_date, race_number, track, course_type, distance, track_condition FROM races", 3000)).map((r) => [r.id, r]));
      const results = await readAll("SELECT id, horse_key, race_id, status, time_text FROM race_results", 5000);
      const runsByHorse = new Map();
      for (const x of results) {
        if (x.status !== "finished" || !x.horse_key) continue;
        const r = races.get(x.race_id);
        const sec = timeTextToSeconds(x.time_text);
        if (!r || sec == null || !r.track || !(r.course_type === "芝" || r.course_type === "ダート") || !(Number(r.distance) > 0)) continue;
        if (!runsByHorse.has(x.horse_key)) runsByHorse.set(x.horse_key, []);
        runsByHorse.get(x.horse_key).push({ t: r.track, ct: r.course_type, d: Number(r.distance), sec, date: String(r.race_date), rn: Number(r.race_number) || 0, cond: r.track_condition });
      }
      const ctx = { courseOf: makeCourseOf(await getRaceTimes(d1)) };
      // 偏りを測る換算は、新しく出した距離の比を使い、偏りは掛けない(ratios は pairBias を持たない Map)
      const { pairs, bias } = computeConversionTables(runsByHorse, (sec, run, dst, ratios) => convertTime(ctx, sec, run, dst, ratios));
      const marker = results.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
      const saved = await api("/api/cron/conversion", { method: "POST", body: JSON.stringify({ marker, pairs, bias: Object.fromEntries(bias) }) });
      console.log(`換算の比と偏り: 結果${results.length}行・${runsByHorse.size}頭から 距離の比${saved.ratios}件・偏り${saved.bias_pairs}件(${saved.bias_tracks}場)を保存(${((Date.now() - started) / 1000).toFixed(1)}秒)`);
    }
  } catch (e) {
    conversionFailed = `失敗(次の晩にやり直す) ${e.message}`;
    console.error(`換算の比と偏り: ${conversionFailed}`);
  }
}

// ---- 1. 比率 ----
const items = await loadQueue();
console.log(`比率の計算待ち ${items.length}件(採点: ${d1 ? "Node〈D1 を API で読む〉" : "採点の API"})`);
let pending = items;
const failures = new Map();
for (let round = 0; round < 2 && pending.length; round++) {
  if (round) {
    console.log(`失敗した ${pending.length}件を1分後にやり直す`);
    await sleep(60000);
  }
  const next = [];
  for (const it of pending) {
    try {
      console.log(await processItem(it));
      failures.delete(`${it.kind} ${it.key}`);
    } catch (e) {
      failures.set(`${it.kind} ${it.key}`, e.message);
      console.error(`${it.kind} ${it.key}: 失敗(${round ? "計算待ちに残す" : "後でやり直す"}) ${e.message}`);
      next.push(it);
    }
  }
  pending = next;
}

// ---- 2. 距離の換算の比(秘密情報があるときだけ) ----
// 2026-11-04〜 上の 2a で保存した晩は「やることが無い」で終わる(D1 を読めないときの予備と、古い比率の作業の片付け)
let distanceFailed = null;
// SKIP_DISTANCE=true(2026-10-25): 管理画面の「今すぐ計算」から頼まれた手動実行。比率だけをすぐ計算し、距離の換算の比は夜間に任せる
if (SECRET && !DRY_RUN && process.env.SKIP_DISTANCE !== "true") {
  let steps = 0;
  try {
    for (; steps < DISTANCE_STEPS_MAX; steps++) {
      const r = await api("/api/cron/pace-step", { method: "POST" });
      if (r.idle) break;
      if (steps % 10 === 0 || /done|cleared/.test(r.did || "")) console.log(`pace-step: ${r.did}`);
    }
    console.log(`距離の換算の比: ${steps}歩`);
  } catch (e) {
    distanceFailed = `${steps}歩目で失敗(次の晩に続きから) ${e.message}`;
    console.error(`距離の換算の比: ${distanceFailed}`);
  }
}

// ---- まとめ ----
if (d1) console.log(`D1 の読み取り: ${d1.stats().rowsRead}行(${d1.stats().queries}回)`);
console.log(`まとめ: 比率 ${items.length - failures.size}/${items.length}件 完了${failures.size ? ` / 残り ${failures.size}件` : ""}${distanceFailed ? " / 距離の換算の比 失敗" : ""}${conversionFailed ? " / 換算の比と偏り 失敗" : ""}`);
for (const [k, msg] of failures) console.log(`  残り: ${k} … ${msg}`);
if (failures.size || distanceFailed || conversionFailed) process.exit(1);
