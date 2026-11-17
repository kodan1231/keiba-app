import { requireAdmin, getRaceIndex, gradedRaceNameKey, resolveGradedKeyOfRace, jstYear, readJsonBody, jsonError } from "../../_shared.js";

// 管理者向け: 重賞ごとの過去10年の登録状況(2026-11-13追加。docs/design/graded-races.md「登録状況」)。
// 「登録済み」= その年に、その重賞に当たるレースがあり、着順(finish_order)まで入っていること。
// 重賞に当たるかの判定は重賞検索タブ(data-search/graded-race.js)と同じ(name_key と名前から計算し直したキー、
// 冠付きのレース名は resolveGradedKey、開催日での付け替えは resolveGradedKeyOfRace)。
// 読み取り: graded_races 全件(年間約140件)+ レース一覧の軽いキャッシュ races_index_cache(範囲ごとの行。
// 約80行)+ 対象外の年の設定1行で 1回あたり約250行。管理画面で表を開いたとき・対象外を切り替えたときだけ呼ぶ。IN句は使わない。
//
// 対象外の年(2026-11-17): 新設の重賞の新設前の年や、未開催の年(例: みやこS の2018年)を「登録完了」に数えるため、
// 重賞ごとに年を除外できる。app_settings の1行(key = graded_excluded_years、値は {"<graded_races.id>": [年, ...]})に持つ。
// graded_races の列にしないのは、graded_races の更新は購入履歴の版数(ticket_views)・設定表の写しを動かすトリガーがあるため。
// その年に結果があれば、対象外にしていても登録済み(●)として数える。
const PAST_YEARS = 10;
const EXCLUDED_KEY = "graded_excluded_years";

async function loadExcluded(db) {
  try {
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(EXCLUDED_KEY).first();
    const v = row ? JSON.parse(row.value) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;

  const { results } = await db.prepare(
    `SELECT id, name, name_key, grade, is_jump, schedule_md FROM graded_races`
  ).all();
  const masters = results || [];
  const excluded = await loadExcluded(db);

  // キー → その重賞(同じキーの重賞が複数あっても全部に数える)
  const mastersByKey = new Map();
  for (const g of masters) {
    for (const k of new Set([g.name_key, gradedRaceNameKey(g.name)].filter(Boolean))) {
      if (!mastersByKey.has(k)) mastersByKey.set(k, []);
      mastersByKey.get(k).push(g.id);
    }
  }
  const hasKey = (k) => mastersByKey.has(k);

  const currentYear = jstYear();
  const firstYear = currentYear - PAST_YEARS;
  // 重賞id → Map(年 → "result" | "entries")。結果ありを優先する
  const statusById = new Map(masters.map((g) => [g.id, new Map()]));
  for (const r of await getRaceIndex(db)) {
    if (!r.race_name) continue;
    const year = Number(String(r.race_date || "").slice(0, 4));
    if (!year || year < firstYear || year > currentYear) continue;
    const key = resolveGradedKeyOfRace(r, hasKey);
    if (!key) continue;
    const st = r.has_finish_order ? "result" : "entries";
    for (const id of mastersByKey.get(key)) {
      const m = statusById.get(id);
      if (m.get(year) !== "result") m.set(year, st);
    }
  }

  const years = [];
  for (let y = currentYear; y >= firstYear; y--) years.push(y);
  const items = masters.map((g) => {
    const m = statusById.get(g.id);
    const ex = new Set((excluded[g.id] || []).map(Number));
    const byYear = {};
    for (const y of years) byYear[y] = m.get(y) || (ex.has(y) ? "excluded" : null);
    // 数えるのは今年を除く過去10年のうち、対象外でない年(結果のある年は対象外でも数える)
    let registered = 0, target = 0;
    for (let y = currentYear - 1; y >= firstYear; y--) {
      if (byYear[y] === "excluded") continue;
      target++;
      if (byYear[y] === "result") registered++;
    }
    return {
      id: g.id, name: g.name, grade: g.grade, is_jump: !!g.is_jump, schedule_md: g.schedule_md || null,
      years: byYear, registered, target, missing: target - registered,
    };
  });
  return Response.json({ ok: true, current_year: currentYear, past_years: PAST_YEARS, years, items });
}

// PUT { id, years: [年, ...] }: その重賞の対象外の年を置き換える(空配列で解除)
export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const id = Number(data?.id);
  if (!Number.isInteger(id) || id <= 0) return jsonError("重賞の指定が不正です", 400);
  const rawYears = Array.isArray(data?.years) ? data.years : null;
  if (!rawYears || rawYears.length > 30) return jsonError("年の指定が不正です", 400);
  const years = [...new Set(rawYears.map(Number))].filter((y) => Number.isInteger(y) && y >= 1990 && y <= 2100).sort((a, b) => a - b);
  if (years.length !== new Set(rawYears.map(Number)).size) return jsonError("年の指定が不正です", 400);

  const excluded = await loadExcluded(db);
  if (years.length) excluded[id] = years;
  else delete excluded[id];
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(EXCLUDED_KEY, JSON.stringify(excluded)).run();
  return Response.json({ ok: true, id, years });
}
