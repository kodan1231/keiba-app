import { requireAdmin, readJsonBody, jsonError, normalizePaceWeights, DEFAULT_PACE_WEIGHTS, PACE_TYPES, PACE_WEIGHT_COLUMNS, parseByPace, parsePartner, getPaceScoreSettings } from "../../_shared.js";

const COLS = PACE_WEIGHT_COLUMNS; // w_pace … w_course(2026-10-14 に性齢・馬体重・同コースを追加)

// 管理者向け: 総合推奨馬の重視度の比率(pace_weights。2026-10-13追加)。仕様は docs/design/screens.md「総合推奨馬」。
//   GET    → { default: {...}|null, builtin, score_settings: { missing_score }, items:[{ graded_race_id, name, grade, is_jump, schedule_md, weights|null }] }
//            weights: { w_*, source: "manual"|"auto"|"none", by_pace: { high|middle|slow: { w_*, source } }, detail, updated_at }
//            (重賞マスタ全件〈年間140件前後〉+ 比率の表〈同程度〉を全件読む。管理画面を開いたときだけ)
//   PUT    { graded_race_id(0=標準), pace_type?, w_*(7要素) } → 保存(source='manual'。合計100の%にそろえる)
//            pace_type("high"|"middle"|"slow"。2026-10-14追加)があればそのペースの比率、無ければ全ペース共通の比率
//   DELETE ?graded_race_id=N[&pace_type=P] → その重賞の比率を消す(標準の比率を使うようになる)。0(標準)は消すと既定値に戻る。
//            pace_type があればそのペースの比率だけ消す
// kind(2026-10-14追加): "axis"(既定。軸指数)/ "partner"(相手指数。列 partner の JSON)。PUT の本文・DELETE の ?kind= で指定。
//   相手指数の共通の比率は DELETE ?kind=partner(pace_type なし)で消せる(軸指数〈または自動〉に戻る)。行ごと消すのは kind なし
//   GET の weights.partner: { common: { w_*, source }|null, by_pace: {...} }
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const [{ results: graded }, weightRows, scoreSettings] = await Promise.all([
    db.prepare("SELECT id, name, grade, is_jump, schedule_md FROM graded_races ORDER BY schedule_md IS NULL, schedule_md, name").all(),
    db.prepare(`SELECT graded_race_id, ${COLS.join(", ")}, by_pace, partner, source, detail, updated_at FROM pace_weights`).all()
      .then((r) => r.results || [])
      .catch(() => []), // 表がまだ無い
    getPaceScoreSettings(db, { fresh: true }), // 点数の設定(2026-10-14。変更は ./settings.js)
  ]);
  const byId = new Map(weightRows.map((r) => [Number(r.graded_race_id), r]));
  const out = (r) => (r ? {
    ...Object.fromEntries(COLS.map((c) => [c, r[c] ?? 0])), source: r.source, updated_at: r.updated_at,
    by_pace: parseByPace(r.by_pace),
    partner: parsePartner(r.partner),
    detail: r.detail ? safeJson(r.detail) : null,
  } : null);
  return Response.json({
    ok: true,
    builtin: DEFAULT_PACE_WEIGHTS,
    score_settings: scoreSettings,
    default: out(byId.get(0)),
    items: (graded || []).map((g) => ({ graded_race_id: g.id, name: g.name, grade: g.grade, is_jump: g.is_jump, schedule_md: g.schedule_md, weights: out(byId.get(Number(g.id))) })),
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

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const id = Number(data?.graded_race_id);
  if (!Number.isInteger(id) || id < 0) return jsonError("graded_race_id が不正です", 400);
  const { pace, error: pErr } = paceTypeOf(data?.pace_type);
  if (pErr) return pErr;
  const w = normalizePaceWeights(data);
  if (!w) return jsonError("比率は0以上の数で、合計が0より大きくなるように入力してください", 400);
  if (id > 0) {
    const g = await db.prepare("SELECT id FROM graded_races WHERE id = ?").bind(id).first();
    if (!g) return jsonError("重賞が見つかりません", 404);
  }
  const now = new Date().toISOString();
  if (data?.kind === "partner") {
    // 相手指数(2026-10-14): 列 partner の共通かペースの1つだけ書き換える。行が無ければ「軸の共通は未設定(source='none')」の行を作る
    const row = await db.prepare("SELECT partner FROM pace_weights WHERE graded_race_id = ?").bind(id).first();
    const partner = parsePartner(row?.partner);
    if (pace) partner.by_pace = { ...partner.by_pace, [pace]: { ...w, source: "manual" } };
    else partner.common = { ...w, source: "manual" };
    const d = DEFAULT_PACE_WEIGHTS;
    await db.prepare(
      `INSERT INTO pace_weights (graded_race_id, ${COLS.join(", ")}, partner, source, detail, updated_at)
       VALUES (?, ${COLS.map(() => "?").join(", ")}, ?, 'none', NULL, ?)
       ON CONFLICT(graded_race_id) DO UPDATE SET partner = excluded.partner, updated_at = excluded.updated_at`
    ).bind(id, ...COLS.map((c) => d[c]), JSON.stringify(partner), now).run();
    return Response.json({ ok: true, graded_race_id: id, kind: "partner", pace_type: pace, ...w, source: "manual", updated_at: now });
  }
  if (pace) {
    // ペースの比率: by_pace の1つだけ書き換える。行が無ければ「共通は未設定(source='none')」の行を作る
    const row = await db.prepare("SELECT by_pace FROM pace_weights WHERE graded_race_id = ?").bind(id).first();
    const byPace = { ...parseByPace(row?.by_pace), [pace]: { ...w, source: "manual" } };
    const d = DEFAULT_PACE_WEIGHTS;
    await db.prepare(
      `INSERT INTO pace_weights (graded_race_id, ${COLS.join(", ")}, by_pace, source, detail, updated_at)
       VALUES (?, ${COLS.map(() => "?").join(", ")}, ?, 'none', NULL, ?)
       ON CONFLICT(graded_race_id) DO UPDATE SET by_pace = excluded.by_pace, updated_at = excluded.updated_at`
    ).bind(id, ...COLS.map((c) => d[c]), JSON.stringify(byPace), now).run();
    return Response.json({ ok: true, graded_race_id: id, pace_type: pace, ...w, source: "manual", updated_at: now });
  }
  await db.prepare(
    `INSERT INTO pace_weights (graded_race_id, ${COLS.join(", ")}, source, detail, updated_at)
     VALUES (?, ${COLS.map(() => "?").join(", ")}, 'manual', NULL, ?)
     ON CONFLICT(graded_race_id) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(", ")},
       source = 'manual', detail = NULL, updated_at = excluded.updated_at`
  ).bind(id, ...COLS.map((c) => w[c]), now).run();
  return Response.json({ ok: true, graded_race_id: id, ...w, source: "manual", updated_at: now });
}

export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const id = Number(url.searchParams.get("graded_race_id"));
  if (!Number.isInteger(id) || id < 0) return jsonError("graded_race_id が不正です", 400);
  const { pace, error: pErr } = paceTypeOf(url.searchParams.get("pace_type"));
  if (pErr) return pErr;
  if (url.searchParams.get("kind") === "partner") {
    // 相手指数(2026-10-14): ペースの1つ、または共通を消す。重賞の自動の比率は根拠を消して次に開いたときに選び直させる
    const row = await db.prepare("SELECT partner FROM pace_weights WHERE graded_race_id = ?").bind(id).first();
    if (!row) return Response.json({ ok: true, graded_race_id: id, kind: "partner" });
    const partner = parsePartner(row.partner);
    if (pace) delete partner.by_pace[pace];
    else partner.common = null;
    await db.prepare(
      `UPDATE pace_weights SET partner = ?, detail = CASE WHEN graded_race_id > 0 AND source <> 'manual' THEN NULL ELSE detail END,
         updated_at = ? WHERE graded_race_id = ?`
    ).bind(JSON.stringify(partner), new Date().toISOString(), id).run();
    return Response.json({ ok: true, graded_race_id: id, kind: "partner", pace_type: pace });
  }
  if (!pace) {
    await db.prepare("DELETE FROM pace_weights WHERE graded_race_id = ?").bind(id).run();
    return Response.json({ ok: true, graded_race_id: id });
  }
  const row = await db.prepare("SELECT by_pace, source FROM pace_weights WHERE graded_race_id = ?").bind(id).first();
  if (!row) return Response.json({ ok: true, graded_race_id: id, pace_type: pace });
  const byPace = parseByPace(row.by_pace);
  delete byPace[pace];
  if (row.source === "none" && !Object.keys(byPace).length) {
    // 共通もペースも決めていない行は消す
    await db.prepare("DELETE FROM pace_weights WHERE graded_race_id = ?").bind(id).run();
  } else {
    // 重賞の自動の比率は根拠を消して、次に開いたときにそのペースを自動で選び直させる(標準〈0〉は自動算出しない)
    await db.prepare(
      `UPDATE pace_weights SET by_pace = ?, detail = CASE WHEN graded_race_id > 0 AND source <> 'manual' THEN NULL ELSE detail END,
         updated_at = ? WHERE graded_race_id = ?`
    ).bind(JSON.stringify(byPace), new Date().toISOString(), id).run();
  }
  return Response.json({ ok: true, graded_race_id: id, pace_type: pace });
}
