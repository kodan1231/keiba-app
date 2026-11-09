import { readJsonBody, jsonError } from "../_shared.js";
import { savePickStats, PICK_STATS_COURSE_TYPES, PICK_STATS_SOURCES, PICK_STATS_VERSION, PICK_CELL_LEN } from "../_lib/pick-stats.js";

// 夜間の計算(scripts/pace-nightly.mjs の 2a)が Node で数えた、推奨馬の印ごとの単勝・複勝の的中と払戻を保存する(2026-11-10)。
// POST /api/cron/pick-stats(ヘッダー X-Cron-Secret: 秘密情報 PACE_CRON_SECRET。認証は functions/_middleware.js。管理者用アプリだけ)
//   { marker: 結果の最大 id, stats: { v: 2, races, recorded, cells: { "年|競馬場|芝ダ|r or c": [数21個] } } } → { ok, computed_at }
// 仕様は docs/design/data-search.md「推奨馬比較タブ」。_lib/pick-stats.js 参照。
// D1: 書き込みは app_settings の1行。読み取りは無し(1晩1回)
const MAX_BYTES = 1_500_000; // D1 の1行の上限(200万バイト)より小さく

export async function onRequestPost(context) {
  if (!context.data?.isCron) return Response.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const s = data?.stats;
  if (!s || s.v !== PICK_STATS_VERSION || !s.cells || typeof s.cells !== "object" || Array.isArray(s.cells)) return jsonError("stats の形が不正です", 400);
  const cells = {};
  for (const [k, c] of Object.entries(s.cells)) {
    const [year, track, ct, src] = String(k).split("|");
    if (!/^\d{4}$/.test(year || "") || !track || !PICK_STATS_COURSE_TYPES.includes(ct) || !PICK_STATS_SOURCES.includes(src)) return jsonError(`組が不正です: ${k}`, 400);
    if (!Array.isArray(c) || c.length !== PICK_CELL_LEN || !c.every((v) => Number.isFinite(v) && v >= 0)) return jsonError(`数が不正です: ${k}`, 400);
    cells[k] = c;
  }
  const stats = { v: PICK_STATS_VERSION, races: Number(s.races) || 0, recorded: Number(s.recorded) || 0, cells };
  if (JSON.stringify(stats).length > MAX_BYTES) return jsonError("stats が大きすぎます", 400);
  try {
    return Response.json({ ok: true, ...(await savePickStats(context.env.DB, { marker: data.marker ?? null, stats })) });
  } catch (e) {
    console.error("pick stats save failed", e);
    return jsonError(String(e?.message || e), 500);
  }
}
