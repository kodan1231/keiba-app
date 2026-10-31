import { parsePositiveIntId, jsonError, getRaceFactorsBody, RACE_FACTOR_COLUMNS } from "../_shared.js";

// 予想登録画面「展開・時計」タブの総合推奨馬・推奨馬(2026-10-13追加)。
// GET /api/data-search/race-factors?race_id=N
//   → { pace_type, counts: { nige, senko, unknown, n }, horses: [{ horse_name, horse_number, waku_number, jockey,
//        factors: { pace|number|jockey|time|sexage|weight|course: { score, rank, value, missing } } }] }(後ろ3つは2026-10-14追加)
// 点数の規則は _lib/race-factors.js(重賞の比率の自動算出と同じ1か所)。仕様は docs/design/screens.md「総合推奨馬」。
// 応答を作る処理は _lib/race-signals.js の getRaceFactorsBody(2026-11-01 にレース一覧の目印と共用にするため移した)。
// /api/data-search/ の下なので、使用量が多い日の自動一時停止(データ検索)の対象。
//
// D1の読み取り: races 1行 + 出走馬の全戦績(race_results の horse_key インデックス。18頭×数十走で数百行)+
//   集計用キャッシュ・勝ちタイムのキャッシュ(各約20行。同じ実行環境で60秒使い回す)+ 評価点を選ぶための比率の行(主キーで最大3行。2026-10-14)
//   + 重賞一覧(2分使い回し)+(重賞のときだけ)前年の同レースを探す重賞1行+レース一覧のキャッシュ約20行。展開・時計タブを開いたときにレースごとに1回。
// 評価点(初距離・初競馬場・継続騎乗。2026-10-14)は、このレースの重賞・コースの評価点(_lib/pace-score.js の getPaceWeights の adjust)、
//   無ければ設定の既定値を掛ける。value に「初距離−10」等を足し、タイム・騎手の順位は掛けた後の点で付け直す。
// バインド数: 出走馬の名寄せキー(最大18頭 ×〈1+その馬のエイリアス数〉)+ 1。horse-best と同じく100バインド上限内。
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
  if (error) return error;

  const race = await db.prepare(`SELECT ${RACE_FACTOR_COLUMNS} FROM races WHERE id = ?`).bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);
  return Response.json(await getRaceFactorsBody(db, race));
}
