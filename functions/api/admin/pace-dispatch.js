import { requireAdmin, jsonError, readJsonBody, parseCourseKey } from "../_shared.js";

// 管理者向け: 「今すぐ計算」を GitHub Actions(.github/workflows/pace-nightly.yml。夜間の計算と同じ scripts/pace-nightly.mjs)で動かす
// (2026-10-25。仕様は docs/design/screens.md「今すぐ計算を GitHub Actions で」)。
// 以前は管理画面のブラウザが採点の API(/api/admin/pace-backtest)を何度も呼び、Cloudflare で採点していたため、1回の CPU 時間が
// 無料枠の上限を超えて止められていた(2026-10-23 11時台に140回。Cloudflare から警告メール)。ここは GitHub に頼むだけで CPU をほぼ使わない。
// 秘密情報 GITHUB_DISPATCH_TOKEN(keiba-app だけ・権限 Actions: Read and write の fine-grained トークン)。無ければ dispatched: false を返し、
// 画面は今までどおりブラウザで計算する(public/pace-runner.js の runPaceViaGithub)。
//   POST { kind?, key? } → kind・key があれば計算待ちに1件入れてから、手動実行を頼む。{ ok, dispatched, since, reason? }
//   GET ?since=ISO      → since 以降に頼んだ実行の状態と計算待ちの残り。{ ok, run: { status, conclusion, html_url } | null, remaining, busy }
//   GET(since なし)    → GitHub で計算中か。{ ok, running, remaining }(管理画面を開いたとき)
// D1: POST は計算待ちへの書き込み1行(kind・key があるとき)。GET は計算待ちの件数(表は数十行まで)。

const REPO = "kodan1231/keiba-app";
const WORKFLOW = "pace-nightly.yml";

function githubFetch(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "keiba-admin",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { env, request } = context;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  if (data?.kind || data?.key) {
    const kind = String(data.kind || "");
    const key = String(data.key || "");
    if (kind === "graded" ? !(Number(key) > 0) : kind === "course" ? !parseCourseKey(key) : true) {
      return jsonError("kind・key が不正です", 400);
    }
    await env.DB.prepare("INSERT OR IGNORE INTO pace_recompute_queue (kind, key, race_id, created_at) VALUES (?, ?, NULL, ?)")
      .bind(kind, kind === "graded" ? String(Number(key)) : key, new Date().toISOString()).run();
  }

  const since = new Date().toISOString();
  if (!env.GITHUB_DISPATCH_TOKEN) return Response.json({ ok: true, dispatched: false, since, reason: "GitHub のトークンが登録されていません" });
  try {
    // 手動実行は距離の換算の比を飛ばす(30秒ほどかかるため。距離の換算の比は夜間に任せる)
    const res = await githubFetch(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs: { skip_distance: "true" } }),
    });
    if (res.status === 204) return Response.json({ ok: true, dispatched: true, since });
    const reason = res.status === 401 ? "GitHub のトークンが無効か期限切れです" : `GitHub に頼めませんでした(HTTP ${res.status})`;
    return Response.json({ ok: true, dispatched: false, since, reason });
  } catch (e) {
    return Response.json({ ok: true, dispatched: false, since, reason: `GitHub に頼めませんでした(${e.message})` });
  }
}

export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { env, request } = context;
  const sinceRaw = new URL(request.url).searchParams.get("since");
  const since = Date.parse(sinceRaw || "");
  if (sinceRaw && !Number.isFinite(since)) return jsonError("since が不正です", 400);

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pace_recompute_queue").first();
  const remaining = Number(count?.n) || 0;
  if (!env.GITHUB_DISPATCH_TOKEN) return Response.json({ ok: true, run: null, remaining, running: false });

  // since なし(2026-10-25): 管理画面を開いた・読み込み直したときに、GitHub で計算中か(定時実行・手動実行のどれか)だけを返す
  // { ok, running, remaining }。画面は計算中なら「今すぐ計算」を押せなくして、終わるまで5秒おきに見る(admin.js の watchPaceGithub)
  if (!sinceRaw) {
    try {
      const res = await githubFetch(env, `/actions/workflows/${WORKFLOW}/runs?per_page=5`);
      const runs = res.ok ? (await res.json()).workflow_runs || [] : [];
      const running = runs.some((r) => r.status !== "completed");
      return Response.json({ ok: true, running, remaining });
    } catch {
      return Response.json({ ok: true, running: false, remaining });
    }
  }
  try {
    // 定時実行も含めて新しい順に10件(前の計算が動いているかを見るため。2026-10-25)
    const res = await githubFetch(env, `/actions/workflows/${WORKFLOW}/runs?per_page=10`);
    if (!res.ok) return Response.json({ ok: true, run: null, remaining, reason: `HTTP ${res.status}` });
    const runs = (await res.json()).workflow_runs || [];
    // 頼んだ時刻(サーバーの時計)の10秒前以降に作られた、いちばん古い手動実行(GitHub との時計のずれを見込む)
    const mine = runs
      .filter((r) => r.event === "workflow_dispatch" && Date.parse(r.created_at) >= since - 10_000)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    // busy: 自分より前の実行(定時実行・前の手動実行)が動いている。同じ計算は同時に1つしか動かない(ワークフローの concurrency)ので、
    // その間は自分の実行が順番待ちになる。画面はこのとき「動き出さない」とみなさずに待つ(2026-10-25 12:35 に取り違えてブラウザに切り替えた)
    const busy = runs.some((r) => r !== mine && r.status === "in_progress");
    return Response.json({
      ok: true, remaining, busy,
      run: mine ? { status: mine.status, conclusion: mine.conclusion, html_url: mine.html_url } : null,
    });
  } catch (e) {
    return Response.json({ ok: true, run: null, remaining, reason: e.message });
  }
}
