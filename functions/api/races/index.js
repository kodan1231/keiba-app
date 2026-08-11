import { backfillHorseNamesForRace, linkUnregisteredImportsToRace, requireAdmin } from "../_shared.js";

// GET: レース情報は全ユーザー共有の閲覧データなので、ログインしていれば誰でも見られる。
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT * FROM races ORDER BY race_date DESC, track ASC, race_number ASC`
  ).all();

  const items = results.map((row) => ({
    ...row,
    entries: JSON.parse(row.entries),
    finish_order: row.finish_order ? JSON.parse(row.finish_order) : null,
    payouts: row.payouts ? JSON.parse(row.payouts) : null,
  }));

  return Response.json(items);
}

// POST(新規登録): 管理者のみ実行可能。
export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  const { race_date, track, race_number, race_name, course_type, distance, entries, finish_order, payouts } = data;

  if (!race_date || !track || !race_number || !Array.isArray(entries)) {
    return new Response(
      JSON.stringify({ error: "開催日・競馬場・レース番号は必須です" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // 新規登録時も、出走馬表と同時に着順・払戻が入力されているケースがあるため
    // (例: 結果が既に出ているレースを後から一括登録する場合)、finish_order/payouts も保存する。
    const result = await env.DB.prepare(
      `INSERT INTO races (race_date, track, race_number, race_name, course_type, distance, entries, finish_order, payouts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        race_date,
        track,
        race_number,
        race_name || null,
        course_type || null,
        distance || null,
        JSON.stringify(entries),
        finish_order ? JSON.stringify(finish_order) : null,
        payouts && Object.keys(payouts).length ? JSON.stringify(payouts) : null
      )
      .run();

    const raceId = result.meta.last_row_id;

    // このレースが未登録の間に取り込まれたCSVデータ(race_id未紐付け)があれば、ここで紐付ける。
    await linkUnregisteredImportsToRace(env.DB, raceId, race_date, track, race_number);
    // 出走馬表(馬名・騎手)が分かったので、紐付いた購入履歴のselectionsへ反映する。
    await backfillHorseNamesForRace(env.DB, raceId, entries);

    return Response.json({ ok: true, id: raceId });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return new Response(
        JSON.stringify({ error: "同じ開催日・競馬場・レース番号のレースが既に登録されています" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "登録に失敗しました" }), { status: 500 });
  }
}
