import { loadGradedRaceMap, classifyRace } from "../_shared.js";

export async function onRequestGet(context) {
  const { env } = context;
  const userId = context.data.userId;
  // race_finish_order / race_payouts: 集計画面で「着順または払戻のいずれかが確定していれば
  // 判定対象に含める」ためにレース側の確定情報も一緒に返す(購入履歴自身のpayoutだけでは
  // 着順は確定しているが払戻レート未入力のレースを判定対象にできないため)。
  // race_course_type / race_distance: 集計画面の「コース別収支」でレースのコース種別
  // (芝/ダート/障害)・距離ごとに集計するために付与する(購入履歴自身は持たないため
  // レースをJOINして返す)。未入力のレースは NULL のまま返る。
  // race_category: 集計画面「総合成績」「レース別」タブの「すべて/重賞のみ/条件戦のみ」
  // フィルタ用("graded"/"condition"/"other")。race_name・class_flagsをgraded_races
  // マスタ(小テーブル。全件1回読み)と突き合わせて判定する(2026-09-19追加。
  // docs/design/graded-races.md参照)。
  const { results } = await env.DB.prepare(
    `SELECT t.*, r.finish_order AS race_finish_order, r.payouts AS race_payouts,
            r.course_type AS race_course_type, r.distance AS race_distance,
            r.race_name AS race_race_name, r.class_flags AS race_class_flags
     FROM tickets t
     LEFT JOIN races r ON r.id = t.race_id
     WHERE t.user_id = ?
     ORDER BY t.race_date DESC, t.track ASC, t.race_number ASC, t.created_at ASC`
  ).bind(userId).all();

  const gradedMap = await loadGradedRaceMap(env.DB);

  const items = results.map((row) => {
    const { race_race_name, race_class_flags, ...rest } = row;
    const { category } = classifyRace(gradedMap, { race_name: race_race_name, class_flags: race_class_flags });
    return {
      ...rest,
      selections: JSON.parse(row.selections),
      structure: row.structure ? JSON.parse(row.structure) : null,
      race_category: category,
    };
  });

  return Response.json(items);
}
