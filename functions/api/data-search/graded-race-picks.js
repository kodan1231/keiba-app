import { jsonError, parsePositiveIntId, getPaceWeights, loadGradedBacktest, gradedPicksOf, memoized } from "../_shared.js";

// データ検索「重賞検索」タブの「総合推奨馬の比率と過去の上位5頭」(2026-10-13追加)。
// GET /api/data-search/graded-race-picks?id=<graded_races.id>
//   → { weights: { w_*(7要素), source, scope, auto, paces }, years: [{ year, race_id, race_date, field_size, pace_type,
//        hits, weights(その年のペース予想の比率。2026-10-14), top3: [{ finish_position, horse_name, horse_number, total_rank }],
//        picks: [{ rank, total, horse_name, horse_number, status, finish_position, factors }] }] }
// 過去の各年を、その年より前のデータだけで採点し(_lib/pace-score.js の loadGradedBacktest。比率の自動算出と同じ)、
// この重賞の比率(無ければ標準・既定値)で総合点の上位5頭を出す。仕様は docs/design/graded-race-search.md「総合推奨馬の検証」。
// /api/data-search/ の下なので、使用量が多い日の自動一時停止(データ検索)の対象。
//
// D1の読み取り: 比率の表(主キーで最大2行)+ 過去の各年の採点(キャッシュ各約20行+対象レースの結果約200行+出走馬の全戦績 数百〜千行)。
// 採点の結果は同じ実行環境で10分使い回す(重賞検索で同じ重賞を開き直したとき・比率を変えたときに読み直さない)。
// CPU時間: 採点は1年あたり約2〜3ミリ秒(最大11年)+キャッシュの読み込み。
const BT_MEMO_MS = 10 * 60 * 1000;

export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const { id, error } = parsePositiveIntId(url.searchParams.get("id"), "id");
  if (error) return error;

  const [weights, bt] = await Promise.all([
    getPaceWeights(db, id),
    memoized(`graded_backtest_${id}`, () => loadGradedBacktest(db, id), BT_MEMO_MS),
  ]);
  if (bt.error === "重賞が見つかりません") return jsonError(bt.error, 404);
  if (bt.error) return Response.json({ weights, years: [], message: bt.error });
  return Response.json({ weights, years: gradedPicksOf(bt, weights) });
}
