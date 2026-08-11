import { requireAdmin } from "../_shared.js";

// 開催日程の一括登録も管理者のみ実行可能。
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

  const { races } = data;
  if (!Array.isArray(races) || races.length === 0) {
    return new Response(JSON.stringify({ error: "登録するレースがありません" }), { status: 400 });
  }

  const stmts = races.map((r) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO races (race_date, track, race_number, race_name, entries)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(r.race_date, r.track, r.race_number, r.race_name || null, JSON.stringify(r.entries || []))
  );

  await env.DB.batch(stmts);

  return Response.json({ ok: true, count: races.length });
}
