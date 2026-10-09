// D1 の使用量が増えたときに、重い機能だけを自動で一時停止する仕組み(2026-10-08追加)。
// 仕様は docs/design/ops.md「重い機能の自動一時停止」。
//
// 背景: 2026-10-08 に D1 の1日の読み取り上限(アカウント全体)を超え、日本時間の翌朝9時まで全画面が止まった。
// 上限に近づいたら重い機能(データ検索・一括補正等)だけを止め、購入・履歴・予想などの普段の操作は続けられるようにする。
//
// 設定(管理画面「重い機能の自動一時停止」で変更。app_settings の key='service_guard' に JSON で保存):
//   enabled          … 自動一時停止を使うか
//   thresholdPercent … 使用量(読み取り・書き込みの大きい方)がこの割合(%)以上で止める
//   targets          … 止める機能(下の FEATURES のキー)
//   manualPause      … 使用量に関係なく今すぐ止める(緊急用)
//   overrideUntil    … この時刻までは自動停止しない(管理者の「一時停止を解除」。次のリセット〈日本時間9時〉まで)
// 使用量は Cloudflare の分析API(_lib/d1-usage.js。CF_ANALYTICS_TOKEN が必要。未設定なら自動停止は働かない)。
// 普段の操作を遅くしないよう、判定は「止める対象の機能」へのリクエストのときだけ行い、設定は1分・使用量は5分
// 同じ実行環境で使い回す(古い使用量はすぐ返して裏で取り直す)。

import { memoized, invalidateMemo } from "./memo-cache.js";
import { getD1Usage, d1UsageRatio } from "./d1-usage.js";

export const SERVICE_GUARD_KEY = "service_guard";
const MEMO_GUARD_SETTINGS = "service_guard_settings";
const USAGE_MAX_AGE_MS = 5 * 60 * 1000;

// 止められる機能。match(request, url) が true のリクエストを止める。
export const SERVICE_GUARD_FEATURES = {
  data_search: {
    label: "データ検索(レース成績・馬情報検索・騎手検索・重賞検索)",
    match: (req, url) => url.pathname.startsWith("/api/data-search/"),
  },
  admin_bulk: {
    label: "一括補正・再計算(騎手名・馬名の一括補正、ベース名の再計算)",
    match: (req, url) =>
      /^\/api\/admin\/(jockey-aliases|horse-aliases)\/normalize-existing$/.test(url.pathname) ||
      url.pathname === "/api/admin/races/recompute-base-names",
  },
  imports: {
    label: "取り込み(出走馬一覧・結果のPDF/HTML/netkeiba、購入履歴CSV、馬柱)",
    match: (req, url) =>
      req.method === "POST" &&
      (url.pathname === "/api/races/results-import" ||
        url.pathname === "/api/races/entries-import" ||
        url.pathname === "/api/ticket-imports" ||
        url.pathname === "/api/admin/horses/paste-import"),
  },
  history_all: {
    label: "購入履歴・集計画面の全期間の表示",
    match: (req, url) =>
      req.method === "GET" &&
      (url.pathname === "/api/tickets" || url.pathname === "/api/ticket-imports") &&
      !url.searchParams.get("race_id") && !url.searchParams.get("since"),
  },
};

export const SERVICE_GUARD_DEFAULTS = {
  enabled: true,
  thresholdPercent: 80,
  targets: ["data_search", "admin_bulk"],
  manualPause: false,
  overrideUntil: null,
};

function normalizeSettings(raw) {
  const s = { ...SERVICE_GUARD_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  s.enabled = Boolean(s.enabled);
  const t = Number(s.thresholdPercent);
  s.thresholdPercent = Number.isFinite(t) ? Math.min(99, Math.max(10, Math.round(t))) : SERVICE_GUARD_DEFAULTS.thresholdPercent;
  s.targets = (Array.isArray(s.targets) ? s.targets : []).filter((k) => SERVICE_GUARD_FEATURES[k]);
  s.manualPause = Boolean(s.manualPause);
  s.overrideUntil = s.overrideUntil ? String(s.overrideUntil) : null;
  return s;
}

// 設定を読む(表が無い・読めないときは既定値)。fresh=false なら1分使い回す。
export async function getServiceGuardSettings(db, { fresh = false } = {}) {
  const load = async () => {
    try {
      const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SERVICE_GUARD_KEY).first();
      return normalizeSettings(row ? JSON.parse(row.value) : null);
    } catch {
      return normalizeSettings(null);
    }
  };
  return fresh ? load() : memoized(MEMO_GUARD_SETTINGS, load, 60 * 1000);
}

export async function saveServiceGuardSettings(db, settings) {
  const s = normalizeSettings(settings);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SERVICE_GUARD_KEY, JSON.stringify(s), new Date().toISOString())
    .run();
  invalidateMemo(MEMO_GUARD_SETTINGS);
  return s;
}

// 今止めているか。{ active, reason: "manual"|"usage"|null, ratio, settings, usage }
export async function getServiceGuardState(env, { waitUntil = null, freshUsage = false, settings = null } = {}) {
  const s = settings || (await getServiceGuardSettings(env.DB));
  if (s.manualPause) return { active: true, reason: "manual", ratio: null, settings: s, usage: null };
  if (!s.enabled || !env.CF_ANALYTICS_TOKEN) return { active: false, reason: null, ratio: null, settings: s, usage: null };
  let usage = null;
  try {
    usage = await getD1Usage(env.CF_ANALYTICS_TOKEN, { maxAgeMs: USAGE_MAX_AGE_MS, fresh: freshUsage, waitUntil });
  } catch {
    usage = null; // 使用量が取れないときは止めない
  }
  const ratio = d1UsageRatio(usage);
  const overridden = s.overrideUntil && Date.parse(s.overrideUntil) > Date.now();
  const active = ratio !== null && ratio * 100 >= s.thresholdPercent && !overridden;
  return { active, reason: active ? "usage" : null, ratio, settings: s, usage };
}

// _middleware.js から呼ぶ。止める対象の機能へのリクエストで、今止めているなら 503 の応答を返す(それ以外は null)。
export async function serviceGuardResponse(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let feature = null;
  for (const [key, f] of Object.entries(SERVICE_GUARD_FEATURES)) {
    if (f.match(request, url)) { feature = key; break; }
  }
  if (!feature) return null;
  const settings = await getServiceGuardSettings(env.DB);
  if (!settings.targets.includes(feature)) return null; // 手動停止も「止める機能」に選んだものだけ止める
  const state = await getServiceGuardState(env, { settings, waitUntil: context.waitUntil?.bind(context) });
  if (!state.active) return null;
  return new Response(
    JSON.stringify({ error: "ただいま混雑のため、この機能を一時的に停止しています。時間をおいてお試しください。", guard: true }),
    { status: 503, headers: { "Content-Type": "application/json", "X-Service-Guard": "1", "Retry-After": "600" } }
  );
}
