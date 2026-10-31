import { parsePositiveIntId, jsonError, RACE_FACTOR_COLUMNS, canScoreRace, computeAndSaveRaceSignal } from "../_shared.js";

// 馬券購入画面のレース一覧の目印「複」「ワ」を1レース分計算して保存する(2026-11-01。docs/design/screens.md「レース一覧の目印(複・ワ)」)。
// GET /api/data-search/race-signal?race_id=N → { race_id, signals: "" | "複" | "ワ" | "複ワ" }
// 画面は race-signals(その日の保存済み)で「計算し直しが要る」と返ったレースだけ、1件ずつこれを呼ぶ。
// 点数は race-factors と同じ計算・同じ使い回し(_lib/race-signals.js の getRaceFactorsBody)。
// /api/data-search/ の下なので、使用量が多い日の自動一時停止(データ検索)の対象。
//
// D1の読み取り: race-factors と同じ(races 1行+出走馬の全戦績で数百行+キャッシュ類)+ 比率の行(主キーで最大3行)。
//   1日あたり: その日以降のレース(1日約90レース。中央+地方)× 1日1回+出走馬表が変わったとき。約90×500行 ≒ 5万行/日。
// D1の書き込み: race_signals 1行(UPSERT)。約90行/日。
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
  if (error) return error;

  const race = await db.prepare(`SELECT ${RACE_FACTOR_COLUMNS} FROM races WHERE id = ?`).bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);
  if (!canScoreRace(race)) return Response.json({ race_id: raceId, signals: "" });
  return Response.json({ race_id: raceId, signals: await computeAndSaveRaceSignal(db, race) });
}
