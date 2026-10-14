import { requireAdmin, jsonError, parseCourseKey } from "../_shared.js";

// 管理者向け(APIトークンでも可): 総合推奨馬の比率の「計算待ち」(2026-10-14追加。_lib/pace-queue.js)。
// 夜間の定時実行(scripts/pace-nightly.mjs)が使う。
//   GET    → { items: [{ kind, key, race_id, created_at, last_computed_at|null }] }(計算待ちは1晩で数十件まで。表は小さい)
//   DELETE ?kind=&key= → 計算待ちから取り除く
// 仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { results } = await db.prepare("SELECT kind, key, race_id, created_at FROM pace_recompute_queue ORDER BY created_at").all();
  const items = results || [];
  // 前に計算した日時(重賞は pace_weights、コースは course_pace_weights。主キーで1件ずつ。計算待ちの件数分だけ)
  const out = [];
  for (const it of items) {
    let row = null;
    if (it.kind === "graded") {
      row = await db.prepare("SELECT updated_at, source FROM pace_weights WHERE graded_race_id = ?").bind(Number(it.key)).first();
    } else if (it.kind === "course") {
      const c = parseCourseKey(it.key);
      if (c) row = await db.prepare("SELECT updated_at, source FROM course_pace_weights WHERE track = ? AND course_type = ? AND distance = ?")
        .bind(c.track, c.course_type, c.distance).first();
    }
    out.push({ ...it, last_computed_at: row && row.source === "auto" ? row.updated_at : null, manual: row?.source === "manual" });
  }
  return Response.json({ ok: true, items: out });
}

export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const url = new URL(context.request.url);
  const kind = url.searchParams.get("kind");
  const key = url.searchParams.get("key");
  if (!kind || !key) return jsonError("kind・key を指定してください", 400);
  await context.env.DB.prepare("DELETE FROM pace_recompute_queue WHERE kind = ? AND key = ?").bind(kind, key).run();
  return Response.json({ ok: true });
}
