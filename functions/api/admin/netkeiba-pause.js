import {
  requireAdmin,
  readJsonBody,
  jsonError,
  getNetkeibaPauseSettings,
  setNetkeibaPauseHours,
  NETKEIBA_PAUSE_HOURS_MIN,
  NETKEIBA_PAUSE_HOURS_MAX,
} from "../_shared.js";

// 管理者向け: netkeiba への取得の一時停止の設定(2026-10-04追加)。
// netkeiba から取得を拒否されたら、ここで設定した時間は netkeiba へ問い合わせない
// (_lib/horse-master.js「netkeiba への取得の一時停止」。docs/design/data-search.md「netkeiba連携」)。

// GET: { pauseHours, pauseHoursIsDefault, pausedUntil, lastReason, min, max, tableMissing }
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const settings = await getNetkeibaPauseSettings(context.env.DB);
  return Response.json({ ok: true, ...settings, min: NETKEIBA_PAUSE_HOURS_MIN, max: NETKEIBA_PAUSE_HOURS_MAX });
}

// PUT: { pauseHours } 止める時間(時間単位の整数)を保存する。今の停止期限は変えない
// (次に拒否されたときから新しい時間が使われる)。
export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { data: body, error } = await readJsonBody(context.request);
  if (error) return error;
  const hours = Number(body?.pauseHours);
  if (!Number.isInteger(hours) || hours < NETKEIBA_PAUSE_HOURS_MIN || hours > NETKEIBA_PAUSE_HOURS_MAX) {
    return jsonError(`中断時間は${NETKEIBA_PAUSE_HOURS_MIN}〜${NETKEIBA_PAUSE_HOURS_MAX}時間の整数で指定してください`, 400);
  }
  try {
    await setNetkeibaPauseHours(context.env.DB, hours);
  } catch (e) {
    return jsonError("保存に失敗しました(external_fetch_pause テーブルが未作成の可能性があります)", 500);
  }
  const settings = await getNetkeibaPauseSettings(context.env.DB);
  return Response.json({ ok: true, ...settings, min: NETKEIBA_PAUSE_HOURS_MIN, max: NETKEIBA_PAUSE_HOURS_MAX });
}
