import { readJsonBody, jsonError } from "../_shared.js";
import { saveCourseHistory } from "../_lib/course-history.js";

// 夜間の計算(scripts/pace-nightly.mjs の 2a)が Node で数えた、総合推奨馬の「同コース」「展開」の物差しを保存する(2026-11-07)。
// POST /api/cron/course-history(ヘッダー X-Cron-Secret: 秘密情報 PACE_CRON_SECRET。認証は functions/_middleware.js。管理者用アプリだけ)
//   { marker: 結果の最大 id, history: { v: 1, courses, tracks, all } } → { ok, computed_at }
// 仕様は docs/design/screens.md「全要素の点を過去の結果の物差しで出す」。_lib/course-history.js 参照。
// D1: 書き込みは app_settings の1行。読み取りは無し(1晩1回)
const MAX_BYTES = 1_500_000; // D1 の1行の上限(200万バイト)より小さく

export async function onRequestPost(context) {
  if (!context.data?.isCron) return Response.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const h = data?.history;
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (!isObj(h) || h.v !== 1 || !isObj(h.courses) || !isObj(h.tracks) || !isObj(h.all)) return jsonError("history の形が不正です", 400);
  const history = { v: 1, courses: h.courses, tracks: h.tracks, all: h.all };
  if (JSON.stringify(history).length > MAX_BYTES) return jsonError("history が大きすぎます", 400);
  try {
    return Response.json({ ok: true, ...(await saveCourseHistory(context.env.DB, { marker: data.marker ?? null, history })) });
  } catch (e) {
    console.error("course history save failed", e);
    return jsonError(String(e?.message || e), 500);
  }
}
