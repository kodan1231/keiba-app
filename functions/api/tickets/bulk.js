const VALID_BET_TYPES = [
  "tan", "fuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan",
];
const VALID_METHODS = ["normal", "box", "nagashi", "formation"];

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  const { race_id, race_date, track, race_number, race_name, bet_type, method, memo, combos } = data;

  if (!race_id || !race_date || !track || !race_number || !bet_type || !Array.isArray(combos) || combos.length === 0) {
    return new Response(
      JSON.stringify({ error: "必須項目が不足しているか、組み合わせが生成されていません" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!VALID_BET_TYPES.includes(bet_type)) {
    return new Response(JSON.stringify({ error: "馬券種類が不正です" }), { status: 400 });
  }
  if (method && !VALID_METHODS.includes(method)) {
    return new Response(JSON.stringify({ error: "購入方式が不正です" }), { status: 400 });
  }
  if (combos.some((c) => !c.amount || !Array.isArray(c.selections))) {
    return new Response(JSON.stringify({ error: "組み合わせごとの金額が不正です" }), { status: 400 });
  }

  const groupId = crypto.randomUUID();

  const stmts = combos.map((c) =>
    env.DB.prepare(
      `INSERT INTO tickets
        (group_id, race_id, race_date, track, race_number, race_name, bet_type, method, selections, amount, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      groupId,
      race_id,
      race_date,
      track,
      race_number,
      race_name || null,
      bet_type,
      method || "normal",
      JSON.stringify(c.selections),
      c.amount,
      memo || null
    )
  );

  await env.DB.batch(stmts);

  return Response.json({ ok: true, group_id: groupId, count: combos.length });
}
