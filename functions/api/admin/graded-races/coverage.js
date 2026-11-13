import { requireAdmin, getRaceIndex, gradedRaceNameKey, resolveGradedKey, jstYear } from "../../_shared.js";

// 管理者向け: 重賞ごとの過去10年の登録状況(2026-11-13追加。docs/design/graded-races.md「登録状況」)。
// 「登録済み」= その年に、その重賞に当たるレースがあり、着順(finish_order)まで入っていること。
// 重賞に当たるかの判定は重賞検索タブ(data-search/graded-race.js)と同じ(name_key と名前から計算し直したキー、
// 冠付きのレース名は resolveGradedKey で解決)。
// 読み取り: graded_races 全件(年間約140件)+ レース一覧の軽いキャッシュ races_index_cache(範囲ごとの行。
// 約80行)で 1回あたり約250行。管理画面で表を開いたときだけ呼ぶ。IN句は使わない。
const PAST_YEARS = 10;

export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const db = context.env.DB;

  const { results } = await db.prepare(
    `SELECT id, name, name_key, grade, is_jump, schedule_md FROM graded_races`
  ).all();
  const masters = results || [];

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
    const key = resolveGradedKey(gradedRaceNameKey(r.race_name), hasKey);
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
    const byYear = {};
    for (const y of years) byYear[y] = m.get(y) || null;
    // 足りない年は過去10年(今年を除く)で数える
    let registered = 0;
    for (let y = currentYear - 1; y >= firstYear; y--) if (byYear[y] === "result") registered++;
    return {
      id: g.id, name: g.name, grade: g.grade, is_jump: !!g.is_jump, schedule_md: g.schedule_md || null,
      years: byYear, registered, missing: PAST_YEARS - registered,
    };
  });
  return Response.json({ ok: true, current_year: currentYear, past_years: PAST_YEARS, years, items });
}
