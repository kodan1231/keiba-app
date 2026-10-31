import { jsonError, RACE_FACTOR_COLUMNS, canScoreRace, raceSignalStale, todayJst } from "../_shared.js";

// 馬券購入画面のレース一覧の目印「複」「ワ」の、その日の保存済みの分(2026-11-01。docs/design/screens.md「レース一覧の目印(複・ワ)」)。
// GET /api/data-search/race-signals?date=YYYY-MM-DD
//   → { signals: { レースID: "複"|"ワ"|"複ワ" }(目印の無いレースは入れない), pending: [計算し直しが要るレースID] }
// pending は、今日以降の点数を出せる(出走馬・コースがある)レースのうち、まだ計算していない・出走馬表が変わった・今日まだ
// 計算していないもの(_lib/race-signals.js の raceSignalStale)。画面はこれを1件ずつ race-signal で計算する。
// 過去の日は保存済みの目印をそのまま出す(出走馬表が後から変わっていても出す。計算し直さない)。
// 表 race_signals がまだ無い(マイグレーション前)ときは、何も出さず計算もさせない(unavailable)。
//
// D1の読み取り: races のその日の行(idx_races_date。1日約90行)+ race_signals のその日の行(idx_race_signals_date。約90行)。
//   日付を選ぶたびに1回(同じ日は画面が覚える)。1日に数十回で約1〜2万行/日。
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError("date が不正です", 400);

  let saved;
  try {
    const { results } = await db.prepare("SELECT race_id, fp, signals, computed_on FROM race_signals WHERE race_date = ?").bind(date).all();
    saved = new Map((results || []).map((r) => [Number(r.race_id), r]));
  } catch (e) {
    console.error("race_signals read failed", e);
    return Response.json({ signals: {}, pending: [], unavailable: true });
  }
  const { results: races } = await db.prepare(`SELECT ${RACE_FACTOR_COLUMNS} FROM races WHERE race_date = ?`).bind(date).all();
  const today = todayJst();
  const signals = {};
  const pending = [];
  for (const race of races || []) {
    const id = Number(race.id);
    const s = saved.get(id);
    if (!canScoreRace(race)) continue;
    // 過去の日は新しく計算しない(過去の日を見て回るたびに1日約5万行を読まないため)。その日までに計算して保存した目印だけ出す
    if (race.race_date < today) { if (s?.signals) signals[id] = s.signals; continue; }
    if (raceSignalStale(race, s, today)) pending.push(id);
    else if (s.signals) signals[id] = s.signals;
  }
  return Response.json({ signals, pending });
}
