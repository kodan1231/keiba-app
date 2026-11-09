import { jsonError } from "../_shared.js";
import { loadPickStats, PICK_STATS_VERSION } from "../_lib/pick-stats.js";
import { memoized } from "../_lib/memo-cache.js";

// データ検索画面「推奨馬比較」タブ(2026-11-10)。
// GET /api/data-search/pick-stats → { computed_at, races, recorded, marks: ["◎","〇","▲","☆"],
//   cells: { "年|競馬場|芝ダ|r or c": [レース数, 印ごとに(買えた数, 単勝的中, 複勝的中, 単勝払戻, 複勝払戻)] } }
//   (まだ計算していない・古い形なら { stats: null })。r = 結果登録の直前に記録した印、c = 記録の無いレースを今の印で採点し直したもの。
//   払戻は100円あたりの合計。年・芝ダ・出どころの絞り込みと競馬場ごとの合計は画面で行う。
// 夜間の計算が保存した app_settings の1行を読むだけ(主キーで1行。同じ実行環境で2分使い回す)。
// 仕様は docs/design/data-search.md「推奨馬比較タブ」。全ユーザー共有データのため requireAdmin しない(horse-ranking と同じ)
export async function onRequestGet(context) {
  try {
    const v = await memoized("pick_stats", () => loadPickStats(context.env.DB));
    if (!v || v.v !== PICK_STATS_VERSION || !v.cells) return Response.json({ stats: null });
    return Response.json({ computed_at: v.computed_at || null, races: v.races || 0, recorded: v.recorded || 0, marks: ["◎", "〇", "▲", "☆"], cells: v.cells });
  } catch (e) {
    console.error("pick stats load failed", e);
    return jsonError("読み込みに失敗しました", 500);
  }
}
