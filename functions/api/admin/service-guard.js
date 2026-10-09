import {
  requireAdmin,
  readJsonBody,
  jsonError,
  getServiceGuardSettings,
  saveServiceGuardSettings,
  getServiceGuardState,
  SERVICE_GUARD_FEATURES,
} from "../_shared.js";

// 管理者向け: 重い機能の自動一時停止の設定と状態(2026-10-08追加。_lib/service-guard.js、docs/design/ops.md「重い機能の自動一時停止」)。
//   GET … { settings, features: [{ key, label }], state: { active, reason, ratio }, tokenConfigured }
//   PUT { enabled, thresholdPercent, targets, manualPause } … 設定を保存
//   PUT { action: "override" }       … 一時停止を解除(次のリセット〈日本時間9時〉まで自動停止しない)
//   PUT { action: "clear_override" } … 解除をやめる(自動停止を有効に戻す)

async function respond(context, settings) {
  const state = await getServiceGuardState(context.env, { settings, waitUntil: context.waitUntil?.bind(context) });
  return Response.json({
    settings,
    features: Object.entries(SERVICE_GUARD_FEATURES).map(([key, f]) => ({ key, label: f.label })),
    state: { active: state.active, reason: state.reason, ratio: state.ratio },
    tokenConfigured: Boolean(context.env.CF_ANALYTICS_TOKEN),
  });
}

export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  return respond(context, await getServiceGuardSettings(context.env.DB, { fresh: true }));
}

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const current = await getServiceGuardSettings(db, { fresh: true });
  let next;
  if (data?.action === "override") {
    const until = new Date();
    until.setUTCHours(24, 0, 0, 0); // 次のリセット(UTC 0時 = 日本時間9時)
    next = { ...current, overrideUntil: until.toISOString() };
  } else if (data?.action === "clear_override") {
    next = { ...current, overrideUntil: null };
  } else if (!data?.action) {
    next = {
      ...current,
      enabled: data.enabled ?? current.enabled,
      thresholdPercent: data.thresholdPercent ?? current.thresholdPercent,
      targets: Array.isArray(data.targets) ? data.targets : current.targets,
      manualPause: data.manualPause ?? current.manualPause,
    };
  } else {
    return jsonError("action が不正です", 400);
  }
  try {
    const saved = await saveServiceGuardSettings(db, next);
    return respond(context, saved);
  } catch (e) {
    return jsonError("保存に失敗しました(マイグレーション service_guard が未適用の可能性があります)", 500);
  }
}
