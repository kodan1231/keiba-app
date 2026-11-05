import { readJsonBody, jsonError } from "../_shared.js";
import { saveHorseRanking } from "../_lib/horse-ranking.js";

// 夜間の計算(scripts/pace-nightly.mjs の 2a)が Node で数えた、馬情報検索タブの出走回数・勝利回数のトップ10を保存する(2026-11-05)。
// POST /api/cron/horse-ranking(ヘッダー X-Cron-Secret: 秘密情報 PACE_CRON_SECRET。認証は functions/_middleware.js。管理者用アプリだけ)
//   { marker: 結果の最大 id, ranking: { jra: { starts: [[馬名, 出走, 勝利], ...], wins: [...] }, local: { ... } } } → { ok, computed_at }
// 仕様は docs/design/data-search.md「出走回数・勝利回数のトップ10」。_lib/horse-ranking.js 参照。
// D1: 書き込みは app_settings の1行。読み取りは無し(1晩1回)
const MAX_ROWS = 50; // _lib/horse-ranking.js の RANKING_MAX

export async function onRequestPost(context) {
  if (!context.data?.isCron) return Response.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const src = data?.ranking;
  const okList = (l) => Array.isArray(l) && l.length <= MAX_ROWS
    && l.every((r) => Array.isArray(r) && r.length === 3 && typeof r[0] === "string" && r[0].length <= 60 && Number.isFinite(r[1]) && Number.isFinite(r[2]));
  const ranking = {};
  for (const kind of ["jra", "local"]) {
    const g = src?.[kind];
    if (!g || !okList(g.starts) || !okList(g.wins)) return jsonError(`ranking.${kind} の形が不正です`, 400);
    ranking[kind] = { starts: g.starts, wins: g.wins };
  }
  try {
    return Response.json({ ok: true, ...(await saveHorseRanking(context.env.DB, { marker: data.marker ?? null, ranking })) });
  } catch (e) {
    console.error("horse ranking save failed", e);
    return jsonError(String(e?.message || e), 500);
  }
}
