import { requireAdmin, readJsonBody, jsonError, normalizePaceWeights, DEFAULT_PACE_WEIGHTS } from "../../_shared.js";

// 管理者向け: 総合推奨馬の重視度の比率(pace_weights。2026-10-13追加)。仕様は docs/design/screens.md「総合推奨馬」。
//   GET    → { default: {...}|null, builtin, items: [{ graded_race_id, name, grade, is_jump, schedule_md, weights|null }] }
//            (重賞マスタ全件〈年間140件前後〉+ 比率の表〈同程度〉を全件読む。管理画面を開いたときだけ)
//   PUT    { graded_race_id(0=標準), w_pace, w_number, w_jockey, w_time } → 保存(source='manual'。合計100の%にそろえる)
//   DELETE ?graded_race_id=N → その重賞の比率を消す(標準の比率を使うようになる)。0(標準)は消すと既定値に戻る
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const [{ results: graded }, weightRows] = await Promise.all([
    db.prepare("SELECT id, name, grade, is_jump, schedule_md FROM graded_races ORDER BY schedule_md IS NULL, schedule_md, name").all(),
    db.prepare("SELECT graded_race_id, w_pace, w_number, w_jockey, w_time, source, detail, updated_at FROM pace_weights").all()
      .then((r) => r.results || [])
      .catch(() => []), // 表がまだ無い
  ]);
  const byId = new Map(weightRows.map((r) => [Number(r.graded_race_id), r]));
  const out = (r) => (r ? {
    w_pace: r.w_pace, w_number: r.w_number, w_jockey: r.w_jockey, w_time: r.w_time ?? 0, source: r.source, updated_at: r.updated_at,
    detail: r.detail ? safeJson(r.detail) : null,
  } : null);
  return Response.json({
    ok: true,
    builtin: DEFAULT_PACE_WEIGHTS,
    default: out(byId.get(0)),
    items: (graded || []).map((g) => ({ graded_race_id: g.id, name: g.name, grade: g.grade, is_jump: g.is_jump, schedule_md: g.schedule_md, weights: out(byId.get(Number(g.id))) })),
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const id = Number(data?.graded_race_id);
  if (!Number.isInteger(id) || id < 0) return jsonError("graded_race_id が不正です", 400);
  const w = normalizePaceWeights(data);
  if (!w) return jsonError("比率は0以上の数で、合計が0より大きくなるように入力してください", 400);
  if (id > 0) {
    const g = await db.prepare("SELECT id FROM graded_races WHERE id = ?").bind(id).first();
    if (!g) return jsonError("重賞が見つかりません", 404);
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO pace_weights (graded_race_id, w_pace, w_number, w_jockey, w_time, source, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manual', NULL, ?)
     ON CONFLICT(graded_race_id) DO UPDATE SET w_pace = excluded.w_pace, w_number = excluded.w_number,
       w_jockey = excluded.w_jockey, w_time = excluded.w_time, source = 'manual', detail = NULL, updated_at = excluded.updated_at`
  ).bind(id, w.w_pace, w.w_number, w.w_jockey, w.w_time, now).run();
  return Response.json({ ok: true, graded_race_id: id, ...w, source: "manual", updated_at: now });
}

export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const url = new URL(context.request.url);
  const id = Number(url.searchParams.get("graded_race_id"));
  if (!Number.isInteger(id) || id < 0) return jsonError("graded_race_id が不正です", 400);
  await context.env.DB.prepare("DELETE FROM pace_weights WHERE graded_race_id = ?").bind(id).run();
  return Response.json({ ok: true, graded_race_id: id });
}
