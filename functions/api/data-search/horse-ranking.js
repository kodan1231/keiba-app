import { jsonError } from "../_shared.js";
import { loadHorseRanking } from "../_lib/horse-ranking.js";
import { memoized } from "../_lib/memo-cache.js";

// データ検索画面「馬情報検索」タブの出走回数・勝利回数のトップ10(2026-11-05)。
// GET /api/data-search/horse-ranking → { computed_at, jra: { starts, wins }, local: { starts, wins } }(まだ計算していなければ { ranking: null })
//   各一覧: [[馬名, 出走, 勝利], ...](10位と同数の馬も含む)
// 夜間の計算が保存した app_settings の1行を読むだけ(主キーで1行。同じ実行環境で2分使い回す)。
// 仕様は docs/design/data-search.md「出走回数・勝利回数のトップ10」。全ユーザー共有データのため requireAdmin しない(horse-search と同じ)
export async function onRequestGet(context) {
  try {
    const v = await memoized("horse_ranking", () => loadHorseRanking(context.env.DB));
    if (!v) return Response.json({ ranking: null });
    return Response.json({ computed_at: v.computed_at || null, jra: v.jra || null, local: v.local || null });
  } catch (e) {
    console.error("horse ranking load failed", e);
    return jsonError("読み込みに失敗しました", 500);
  }
}
