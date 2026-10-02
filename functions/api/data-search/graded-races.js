// データ検索画面「重賞検索」タブの重賞候補一覧(graded_races 全件)。
// 年間140件前後の小さいマスタのため全件SELECTで返す(絞り込みはクライアント側)。
// 全ユーザー共有データの閲覧のため requireAdmin しない(race-stats.js と同じ扱い)。
// 仕様は docs/design/graded-race-search.md。
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT id, name, name_key, grade, is_jump, track, course_type, distance, age_condition, schedule_md
       FROM graded_races
      ORDER BY schedule_md IS NULL, schedule_md ASC, name ASC`
  ).all();
  return Response.json({ items: results || [] });
}
