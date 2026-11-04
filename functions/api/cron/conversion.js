import { readJsonBody, jsonError } from "../_shared.js";
import { saveConversionTables } from "../_lib/distance-ratios.js";

// 夜間の計算(GitHub Actions の scripts/pace-nightly.mjs)が Node で出した、距離の換算の比と換算の組み合わせごとの偏りを保存する(2026-11-04)。
// POST /api/cron/conversion(ヘッダー X-Cron-Secret: 秘密情報 PACE_CRON_SECRET。認証は functions/_middleware.js。管理者用アプリだけ)
//   { marker: 結果の最大 id, pairs: [[競馬場, 芝ダ, A, B, 組数, 比], ...], bias: { 今回の競馬場: [[元の競馬場, 芝ダ, 元の距離, 今回の距離, 組数, 偏り秒], ...] } }
//   → { ok, computed_at, ratios, bias_tracks, bias_pairs }
// 仕様は docs/design/screens.md「換算の組み合わせごとの直し」。_lib/distance-ratios.js 参照。
// D1: 書き込みは app_settings の 距離の比1行+競馬場ごとの偏りの行(約30行)+古い偏りの行の削除。読み取りは無し(1晩1回)
const MAX_PAIRS = 5000;
const MAX_BIAS = 20000;

export async function onRequestPost(context) {
  if (!context.data?.isCron) return Response.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const pairs = Array.isArray(data?.pairs) ? data.pairs : null;
  const bias = data?.bias && typeof data.bias === "object" && !Array.isArray(data.bias) ? data.bias : null;
  if (!pairs || !bias) return jsonError("pairs と bias が要ります", 400);
  if (pairs.length > MAX_PAIRS) return jsonError("pairs が多すぎます", 400);
  const okRow = (r, n) => Array.isArray(r) && r.length === n && r.slice(-2).every((v) => Number.isFinite(Number(v)));
  if (!pairs.every((r) => okRow(r, 6))) return jsonError("pairs の形が不正です", 400);
  let total = 0;
  for (const [track, list] of Object.entries(bias)) {
    if (!track || !Array.isArray(list) || !list.every((r) => okRow(r, 6))) return jsonError("bias の形が不正です", 400);
    total += list.length;
  }
  if (total > MAX_BIAS) return jsonError("bias が多すぎます", 400);
  try {
    return Response.json({ ok: true, ...(await saveConversionTables(context.env.DB, { marker: data.marker ?? null, pairs, bias })) });
  } catch (e) {
    console.error("conversion save failed", e);
    return jsonError(String(e?.message || e), 500);
  }
}
