import { requireAdmin, readJsonBody, jsonError, getPaceScoreSettings, savePaceScoreSettings } from "../../_shared.js";

// 管理者向け: 総合推奨馬の点数の設定(2026-10-14追加)。仕様は docs/design/screens.md「総合推奨馬」の「点数を偏差値に変更」。
//   GET → { missing_score }(データの無い馬の点〈偏差値〉)
//   PUT { missing_score }(0〜100) → 保存。保存済みの自動の比率は計算し直さない(次の夜間の計算・「今すぐ計算」から、この点で採点する。2026-10-14)
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  return Response.json({ ok: true, ...(await getPaceScoreSettings(context.env.DB, { fresh: true })) });
}

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const s = await savePaceScoreSettings(context.env.DB, data);
  if (!s) return jsonError("データ無しの点は0〜100の数で入力してください", 400);
  return Response.json({ ok: true, ...s });
}
