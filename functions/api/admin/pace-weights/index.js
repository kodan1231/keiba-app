import {
  requireAdmin, readJsonBody, jsonError, normalizePaceWeights, DEFAULT_PACE_WEIGHTS, PACE_TYPES, PACE_WEIGHT_COLUMNS,
  parseByPace, parsePartner, getPaceScoreSettings, parseCourseKey, parseAdjust, normalizeAdjust, ADJUST_KEYS, GLOBAL_ADJUST_KEYS,
} from "../../_shared.js";

const COLS = PACE_WEIGHT_COLUMNS; // w_pace … w_course(2026-10-14 に性齢・馬体重・同コースを追加)

// 管理者向け: 総合推奨馬の重視度の比率(2026-10-13追加)。仕様は docs/design/screens.md「総合推奨馬」。
//   GET    → { default: {...}|null, builtin, score_settings: { missing_score },
//              items: [{ graded_race_id, name, grade, is_jump, schedule_md, weights|null }],
//              courses: [{ course_key, track, course_type, distance, weights }](2026-10-14追加。コースの比率がある分だけ) }
//            weights: { w_*, source: "manual"|"auto"|"none", by_pace: { high|middle|slow: { w_*, source } }, partner, detail, updated_at }
//            (重賞マスタ全件〈年間140件前後〉+ 比率の表〈同程度〉+ コースの比率の表〈計算したコースの数〉を全件読む。管理画面を開いたときだけ)
//   PUT    { graded_race_id(0=標準) | course_key("競馬場|芝ダ障|距離"), pace_type?, kind?, w_*(7要素) } → 保存(source='manual')
//            pace_type("high"|"middle"|"slow")があればそのペースの比率、無ければ全ペース共通の比率
//   DELETE ?graded_race_id=N | ?course_key=K [&pace_type=P][&kind=partner] → 比率を消す。pace_type・kind が無ければ行ごと
// kind(2026-10-14追加): "axis"(既定。軸指数)/ "partner"(相手指数。列 partner の JSON)。
//   相手指数の共通の比率は DELETE ?kind=partner(pace_type なし)で消せる(軸指数に戻る)。
// 2026-10-14: 比率の自動算出は夜間の定時実行・管理者の「今すぐ計算」(ブラウザ)で行い、結果は ./auto-result.js で保存する。
// 評価点(2026-10-14追加。列 adjust の JSON { first_distance, first_track, same_jockey, source }。重賞・コースだけ。標準は設定の既定値〈./settings.js〉):
//   PUT { graded_race_id(1以上) | course_key, kind: "adjust", first_distance, first_track, same_jockey, prev_board, prev_win } → 手動で保存
//   DELETE ?graded_race_id=N | ?course_key=K &kind=adjust → 評価点だけ消す(次の計算で自動の値が入る)
//   GET の weights.adjust に入る(無ければ null)
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const [{ results: graded }, weightRows, courseRows, scoreSettings] = await Promise.all([
    db.prepare("SELECT id, name, grade, is_jump, schedule_md FROM graded_races ORDER BY schedule_md IS NULL, schedule_md, name").all(),
    db.prepare(`SELECT graded_race_id, ${COLS.join(", ")}, by_pace, partner, adjust, source, detail, updated_at FROM pace_weights`).all()
      .then((r) => r.results || [])
      .catch(() => []), // 表がまだ無い
    db.prepare(`SELECT track, course_type, distance, ${COLS.join(", ")}, by_pace, partner, adjust, source, detail, updated_at FROM course_pace_weights ORDER BY track, course_type, distance`).all()
      .then((r) => r.results || [])
      .catch(() => []),
    getPaceScoreSettings(db, { fresh: true }), // 点数の設定(2026-10-14。変更は ./settings.js)
  ]);
  const byId = new Map(weightRows.map((r) => [Number(r.graded_race_id), r]));
  const out = (r) => (r ? {
    ...Object.fromEntries(COLS.map((c) => [c, r[c] ?? 0])), source: r.source, updated_at: r.updated_at,
    by_pace: parseByPace(r.by_pace),
    partner: parsePartner(r.partner),
    adjust: parseAdjust(r.adjust),
    detail: r.detail ? safeJson(r.detail) : null,
  } : null);
  return Response.json({
    ok: true,
    builtin: DEFAULT_PACE_WEIGHTS,
    score_settings: scoreSettings,
    default: out(byId.get(0)),
    items: (graded || []).map((g) => ({ graded_race_id: g.id, name: g.name, grade: g.grade, is_jump: g.is_jump, schedule_md: g.schedule_md, weights: out(byId.get(Number(g.id))) })),
    courses: courseRows.map((r) => ({ course_key: `${r.track}|${r.course_type}|${r.distance}`, track: r.track, course_type: r.course_type, distance: r.distance, weights: out(r) })),
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// pace_type の値を検証する。{ pace } | { error }("" や未指定は共通 = null)
function paceTypeOf(raw) {
  if (raw === undefined || raw === null || raw === "") return { pace: null };
  return PACE_TYPES.includes(raw) ? { pace: raw } : { error: jsonError("pace_type が不正です", 400) };
}

// 保存先(重賞・標準 = pace_weights、コース = course_pace_weights)。{ table, keyCols, keyBinds, where, label } | { error }
async function targetOf(db, src) {
  if (src.course_key !== undefined && src.course_key !== null && src.course_key !== "") {
    const c = parseCourseKey(src.course_key);
    if (!c) return { error: jsonError("course_key が不正です", 400) };
    return { table: "course_pace_weights", keyCols: ["track", "course_type", "distance"], keyBinds: [c.track, c.course_type, c.distance] };
  }
  const id = Number(src.graded_race_id);
  if (!Number.isInteger(id) || id < 0) return { error: jsonError("graded_race_id が不正です", 400) };
  if (id > 0) {
    const g = await db.prepare("SELECT id FROM graded_races WHERE id = ?").bind(id).first();
    if (!g) return { error: jsonError("重賞が見つかりません", 404) };
  }
  return { table: "pace_weights", keyCols: ["graded_race_id"], keyBinds: [id] };
}

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const t = await targetOf(db, data || {});
  if (t.error) return t.error;
  if (data?.kind === "adjust") return putAdjust(db, t, data);
  const { pace, error: pErr } = paceTypeOf(data?.pace_type);
  if (pErr) return pErr;
  const w = normalizePaceWeights(data);
  if (!w) return jsonError("比率は0以上の数で、合計が0より大きくなるように入力してください", 400);
  const where = t.keyCols.map((c) => `${c} = ?`).join(" AND ");
  const keyList = t.keyCols.join(", ");
  const keyQ = t.keyCols.map(() => "?").join(", ");
  const d = DEFAULT_PACE_WEIGHTS;
  const now = new Date().toISOString();
  if (data?.kind === "partner") {
    // 相手指数(2026-10-14): 列 partner の共通かペースの1つだけ書き換える。行が無ければ「軸の共通は未設定(source='none')」の行を作る
    const row = await db.prepare(`SELECT partner FROM ${t.table} WHERE ${where}`).bind(...t.keyBinds).first();
    const partner = parsePartner(row?.partner);
    if (pace) partner.by_pace = { ...partner.by_pace, [pace]: { ...w, source: "manual" } };
    else partner.common = { ...w, source: "manual" };
    await db.prepare(
      `INSERT INTO ${t.table} (${keyList}, ${COLS.join(", ")}, partner, source, detail, updated_at)
       VALUES (${keyQ}, ${COLS.map(() => "?").join(", ")}, ?, 'none', NULL, ?)
       ON CONFLICT(${keyList}) DO UPDATE SET partner = excluded.partner, updated_at = excluded.updated_at`
    ).bind(...t.keyBinds, ...COLS.map((c) => d[c]), JSON.stringify(partner), now).run();
    return Response.json({ ok: true, kind: "partner", pace_type: pace, ...w, source: "manual", updated_at: now });
  }
  if (pace) {
    // ペースの比率: by_pace の1つだけ書き換える。行が無ければ「共通は未設定(source='none')」の行を作る
    const row = await db.prepare(`SELECT by_pace FROM ${t.table} WHERE ${where}`).bind(...t.keyBinds).first();
    const byPace = { ...parseByPace(row?.by_pace), [pace]: { ...w, source: "manual" } };
    await db.prepare(
      `INSERT INTO ${t.table} (${keyList}, ${COLS.join(", ")}, by_pace, source, detail, updated_at)
       VALUES (${keyQ}, ${COLS.map(() => "?").join(", ")}, ?, 'none', NULL, ?)
       ON CONFLICT(${keyList}) DO UPDATE SET by_pace = excluded.by_pace, updated_at = excluded.updated_at`
    ).bind(...t.keyBinds, ...COLS.map((c) => d[c]), JSON.stringify(byPace), now).run();
    return Response.json({ ok: true, pace_type: pace, ...w, source: "manual", updated_at: now });
  }
  // 共通(手動)。自動算出の根拠(detail)は残す(管理画面で過去の成績を見られるように)
  await db.prepare(
    `INSERT INTO ${t.table} (${keyList}, ${COLS.join(", ")}, source, detail, updated_at)
     VALUES (${keyQ}, ${COLS.map(() => "?").join(", ")}, 'manual', NULL, ?)
     ON CONFLICT(${keyList}) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(", ")},
       source = 'manual', updated_at = excluded.updated_at`
  ).bind(...t.keyBinds, ...COLS.map((c) => w[c]), now).run();
  return Response.json({ ok: true, ...w, source: "manual", updated_at: now });
}

export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const t = await targetOf(db, { course_key: url.searchParams.get("course_key"), graded_race_id: url.searchParams.get("graded_race_id") });
  if (t.error) return t.error;
  const { pace, error: pErr } = paceTypeOf(url.searchParams.get("pace_type"));
  if (pErr) return pErr;
  const where = t.keyCols.map((c) => `${c} = ?`).join(" AND ");
  const now = new Date().toISOString();
  if (url.searchParams.get("kind") === "adjust") {
    await db.prepare(`UPDATE ${t.table} SET adjust = NULL, updated_at = ? WHERE ${where}`).bind(now, ...t.keyBinds).run();
    return Response.json({ ok: true, kind: "adjust" });
  }
  if (url.searchParams.get("kind") === "partner") {
    // 相手指数(2026-10-14): ペースの1つ、または共通を消す(次の計算で自動の値が入る)
    const row = await db.prepare(`SELECT partner FROM ${t.table} WHERE ${where}`).bind(...t.keyBinds).first();
    if (!row) return Response.json({ ok: true, kind: "partner" });
    const partner = parsePartner(row.partner);
    if (pace) delete partner.by_pace[pace];
    else partner.common = null;
    await db.prepare(`UPDATE ${t.table} SET partner = ?, updated_at = ? WHERE ${where}`).bind(JSON.stringify(partner), now, ...t.keyBinds).run();
    return Response.json({ ok: true, kind: "partner", pace_type: pace });
  }
  if (!pace) {
    await db.prepare(`DELETE FROM ${t.table} WHERE ${where}`).bind(...t.keyBinds).run();
    return Response.json({ ok: true });
  }
  const row = await db.prepare(`SELECT by_pace, source, partner FROM ${t.table} WHERE ${where}`).bind(...t.keyBinds).first();
  if (!row) return Response.json({ ok: true, pace_type: pace });
  const byPace = parseByPace(row.by_pace);
  delete byPace[pace];
  const p = parsePartner(row.partner);
  if (row.source === "none" && !Object.keys(byPace).length && !p.common && !Object.keys(p.by_pace).length) {
    // 共通もペースも決めていない行は消す
    await db.prepare(`DELETE FROM ${t.table} WHERE ${where}`).bind(...t.keyBinds).run();
  } else {
    await db.prepare(`UPDATE ${t.table} SET by_pace = ?, updated_at = ? WHERE ${where}`).bind(JSON.stringify(byPace), now, ...t.keyBinds).run();
  }
  return Response.json({ ok: true, pace_type: pace });
}

// 評価点を手で保存する(2026-10-14)。行が無ければ「比率は未設定(source='none')」の行を作る
async function putAdjust(db, t, data) {
  if (t.table === "pace_weights" && Number(t.keyBinds[0]) === 0) return jsonError("標準の評価点は「評価点の既定値」で変更してください", 400);
  // 2026-10-15: 画面が送る全項目(前年の同レースも)を保存する。以前は3項目だけ読み、前年の同レースの入力が保存されていなかった
  const a = normalizeAdjust(Object.fromEntries(ADJUST_KEYS.map((k) => [k, data[k]])));
  if (!a) return jsonError("評価点は0〜50の数で入力してください", 400);
  for (const k of GLOBAL_ADJUST_KEYS) delete a[k]; // 間隔(2026-10-15)は全レース共通の既定値だけ
  const keyList = t.keyCols.join(", ");
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO ${t.table} (${keyList}, ${COLS.join(", ")}, adjust, source, detail, updated_at)
     VALUES (${t.keyCols.map(() => "?").join(", ")}, ${COLS.map(() => "?").join(", ")}, ?, 'none', NULL, ?)
     ON CONFLICT(${keyList}) DO UPDATE SET adjust = excluded.adjust, updated_at = excluded.updated_at`
  ).bind(...t.keyBinds, ...COLS.map((c) => DEFAULT_PACE_WEIGHTS[c]), JSON.stringify({ ...a, source: "manual" }), now).run();
  return Response.json({ ok: true, kind: "adjust", ...a, source: "manual", updated_at: now });
}
