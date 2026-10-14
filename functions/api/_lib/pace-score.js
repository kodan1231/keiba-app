// 総合推奨馬(2026-10-13追加。予想登録画面「展開・時計」タブ)の重視度の比率の読み書きと、過去のレースの採点。
// 仕様は docs/design/screens.md「総合推奨馬」「軸指数・相手指数」「比率の計算(夜間・今すぐ計算)」。
//
// 点数の付け方は _lib/race-factors.js に一本化した(2026-10-13)。
// 比率を「選ぶ」計算は public/pace-search.js(ブラウザの「今すぐ計算」と夜間の定時実行 scripts/pace-nightly.mjs が使う)。
// 2026-10-14: 以前はここ(サーバー)で重賞の比率を自動算出していた(予想登録画面で開いたときに裏で計算し直し)が、
//   軸・相手・ペース別・コース別で計算が増え、無料枠のCPU上限(10ミリ秒)に収まらないため、サーバーは
//   「過去のレースの採点を数レースずつ返す」(backtestChunk)と「選んだ結果を保存する」(saveAutoPaceResult)だけにした。
import { findRacesByGradedKey, jstYear } from "./graded-race-search.js";
import { gradedRaceNameKey } from "./race-classification.js";
import { getRaceIndex } from "./races-index-cache.js";
import { getRaceLineups } from "./race-lineup-cache.js";
import { loadJockeyAliasMapCached } from "./jockey-alias.js";
import { getRaceTimes } from "./race-time-cache.js";
import { FACTOR_KEYS, DEFAULT_MISSING_SCORE, ADJUST_KEYS, applyAdjust, createFactorContext, computeRaceFactors } from "./race-factors.js";
import { parseCourseKey } from "./pace-queue.js";

export const PACE_FACTORS = FACTOR_KEYS;
// 既定の比率(ほぼ均等)。2026-10-14 に7要素(性齢・馬体重・同コースを追加)にした。それまでは4要素とも25。public/pace-search.js と同じ
export const DEFAULT_PACE_WEIGHTS = { w_pace: 15, w_number: 15, w_jockey: 14, w_time: 14, w_sexage: 14, w_weight: 14, w_course: 14 };
// pace_weights / course_pace_weights の比率の列(SQL 用。PACE_FACTORS の順)
export const PACE_WEIGHT_COLUMNS = PACE_FACTORS.map((f) => `w_${f}`);
// ペース予想ごとの比率(2026-10-14追加。ユーザー要望)。列 by_pace に JSON { high|middle|slow: { w_*, source: "manual"|"auto" } } で持つ。
// 行の w_* は「全ペース共通」の比率。source='none' の行は共通の比率を決めていない(ペースの比率だけ手で入れた)。
export const PACE_TYPES = ["high", "middle", "slow"];
// 軸指数・相手指数(2026-10-14 ユーザー要望。仕様は docs/design/screens.md「軸指数・相手指数」):
//   - 行の w_* と by_pace は軸指数。列 partner に相手指数を JSON { common: { w_*, source }|null, by_pace: { high: { w_*, source } } }
//     (@STEP: pace_weights_partner)。相手指数の比率がどこにも無ければ、軸指数の比率を使う
export const PACE_PICK_N = 3; // 相手の頭数
export const PACE_KINDS = ["axis", "partner"];
const GRADED_PAST_YEARS = 10; // 重賞: 過去10年(+今年)
const COURSE_PAST_DAYS = 365; // コース: 直近1年(2026-10-14 ユーザー要望)
export const BACKTEST_CHUNK_MAX = 6; // 採点を1回で返すレース数の上限(CPU時間対策。1レースの採点は約0.5〜1ミリ秒)

// 比率の入力を検証して整数%(合計100)にする。不正なら null。
export function normalizePaceWeights(w) {
  const vals = PACE_FACTORS.map((f) => Number(w?.[`w_${f}`] ?? 0));
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return toPercents(vals);
}

// 0以上の値の並びを、合計100の整数%にする(端数は大きい順に配る)。
function toPercents(vals) {
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...DEFAULT_PACE_WEIGHTS };
  const raw = vals.map((v) => (v * 100) / sum);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return Object.fromEntries(PACE_FACTORS.map((f, i) => [`w_${f}`, out[i]]));
}

// 列 by_pace の JSON を読む(壊れていれば空)。
export function parseByPace(text) {
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" ? o : {};
  } catch { return {}; }
}

const weightsOf = (w) => Object.fromEntries(PACE_FACTORS.map((f) => [`w_${f}`, Number(w?.[`w_${f}`] ?? 0)]));

// 列 partner(相手指数の比率)の JSON を読む: { common: { w_*, source }|null, by_pace: {...} }
export function parsePartner(text) {
  const o = parseByPace(text);
  return { common: o.common && typeof o.common === "object" ? o.common : null, by_pace: o.by_pace && typeof o.by_pace === "object" ? o.by_pace : {} };
}

// 相手指数を、軸指数と同じ形の「行」として見る(resolvePaceWeights で同じ選ぶ順を使うため)
function partnerRowView(r) {
  if (!r) return null;
  const p = parsePartner(r.partner);
  if (!p.common && !Object.keys(p.by_pace).length) return null;
  return { ...weightsOf(p.common), source: p.common ? p.common.source || "manual" : "none", by_pace: JSON.stringify(p.by_pace), detail: r.detail, updated_at: r.updated_at };
}

const ROW_COLS = `${PACE_WEIGHT_COLUMNS.join(", ")}, by_pace, partner, adjust, source, detail, updated_at`;

// 比率を読む。gradedRaceId: その重賞(無ければ null)、course: { track, course_type, distance }(無ければ null。2026-10-14)。
// 読み取りは主キーで最大3行(標準・重賞・コース)。
// 戻り値: 全ペース共通の軸指数の比率 { w_*, source, updated_at, scope: "graded"|"course"|"default"|"builtin", pace_type, auto }
//   + paces: { high|middle|slow: 同じ形 } + partner: { 相手指数の同じ形, paces }
// 選ぶ順(2026-10-14 ユーザー確認済み。手で決めた比率を自動より優先):
//   重賞(そのペース手動 → 共通手動 → そのペース自動 → 共通自動)→ コース(同じ順)→ 標準(そのペース → 共通)→ 既定値
export async function getPaceWeights(db, gradedRaceId, course = null) {
  const ids = [0];
  if (gradedRaceId) ids.push(Number(gradedRaceId));
  let rows = [];
  let courseRow = null;
  try {
    const [r1, r2] = await Promise.all([
      db.prepare(`SELECT graded_race_id, ${ROW_COLS} FROM pace_weights WHERE graded_race_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all(),
      course && course.track && course.course_type && Number(course.distance) > 0
        ? db.prepare(`SELECT ${ROW_COLS} FROM course_pace_weights WHERE track = ? AND course_type = ? AND distance = ?`)
          .bind(course.track, course.course_type, Number(course.distance)).first().catch(() => null)
        : null,
    ]);
    rows = r1.results || [];
    courseRow = r2 || null;
  } catch (e) {
    console.error("pace_weights read failed (ignored)", e); // 表がまだ無い等。既定値で返す
  }
  const byId = new Map(rows.map((r) => [Number(r.graded_race_id), r]));
  const g = gradedRaceId ? byId.get(Number(gradedRaceId)) || null : null;
  const d = byId.get(0) || null;
  const specific = (view) => [[view(g), "graded"], [view(courseRow), "course"]];
  const axisOf = (p) => resolvePaceWeights(specific((r) => r), d, p, "axis");
  // 相手指数: 相手の比率の選ぶ順で探し、どこにも無ければ軸指数の比率(2026-10-14)
  const partnerOf = (p) => {
    const r = resolvePaceWeights(specific(partnerRowView), partnerRowView(d), p, "partner");
    return r.scope === "builtin" ? { ...axisOf(p), from_axis: true } : r;
  };
  return {
    ...axisOf(null),
    paces: Object.fromEntries(PACE_TYPES.map((p) => [p, axisOf(p)])),
    partner: { ...partnerOf(null), paces: Object.fromEntries(PACE_TYPES.map((p) => [p, partnerOf(p)])) },
    adjust: resolveAdjust([[g, "graded"], [courseRow, "course"]]),
  };
}

// 列 adjust(評価点。2026-10-14追加。@STEP: pace_weights_adjust)の JSON を読む: { first_distance, first_track, same_jockey, source }。無ければ null
export function parseAdjust(text) {
  const o = parseByPace(text);
  if (!ADJUST_KEYS.every((k) => Number.isFinite(Number(o[k])))) return null;
  return { ...Object.fromEntries(ADJUST_KEYS.map((k) => [k, Number(o[k])])), source: o.source === "auto" ? "auto" : "manual" };
}

// 評価点を選ぶ(比率と同じ考え方: 重賞の手動 → コースの手動 → 重賞の自動 → コースの自動)。無ければ null(呼び出し側が設定の既定値を使う)
function resolveAdjust(specifics) {
  const found = specifics.map(([r, scope]) => (r ? { a: parseAdjust(r.adjust), scope } : null)).filter((x) => x && x.a);
  const pick = found.find((x) => x.a.source === "manual") || found[0];
  return pick ? { ...pick.a, scope: pick.scope } : null;
}

// specifics: [[行, scope], ...](優先の高い順。重賞 → コース)、d: 標準の行、pace: "high"|"middle"|"slow"|null(共通)、kind: "axis"|"partner"
function resolvePaceWeights(specifics, d, pace, kind = "axis") {
  // auto: 自動算出の要約(重賞検索の検証・管理画面用)。相手指数は detail.partner
  const autoOf = (r, p) => {
    if (!r.detail) return null;
    try {
      const det0 = JSON.parse(r.detail);
      if (det0.method !== "backtest") return null;
      const det = kind === "partner" ? det0.partner : det0;
      if (!det) return null;
      if (p) return det.by_pace?.[p] || null;
      return { races: det.races, best: det.best, equal: det.equal };
    } catch { return null; }
  };
  const common = (r) => (r && r.source !== "none" ? { w: r, source: r.source, p: null } : null);
  const ofPace = (r) => {
    const e = r && pace ? parseByPace(r.by_pace)[pace] : null;
    return e ? { w: e, source: e.source === "auto" ? "auto" : "manual", p: pace } : null;
  };
  const make = (c, r, scope) => ({
    ...weightsOf(c.w), source: c.source, updated_at: r.updated_at, scope, pace_type: c.p, kind,
    auto: (scope === "graded" || scope === "course") && c.source === "auto" ? autoOf(r, c.p) : null,
  });
  for (const [r, scope] of specifics) {
    if (!r) continue;
    const rp = ofPace(r), rc = common(r);
    const order = [rp?.source === "manual" && rp, rc?.source === "manual" && rc, rp, rc].filter(Boolean);
    if (order.length) return make(order[0], r, scope);
  }
  if (d) {
    const c = ofPace(d) || common(d);
    if (c) return make(c, d, "default");
  }
  return { ...DEFAULT_PACE_WEIGHTS, source: "builtin", updated_at: null, scope: "builtin", pace_type: null, kind, auto: null };
}

// ---- 過去のレースの採点(重賞検索の検証・比率の計算の材料) ----

// 対象のレース(races_index_cache の行)を採点する。戻り値: [{ race, pace_type, top3Keys, runners: [{ key, horse_name, horse_number,
//   status, finish_position, factors: { f: { score, missing, value } } }] }](結果の無いレースは除く)
// D1の読み取り: キャッシュ(各約20行。使い回し)+ 対象レースの race_results(1レース約16行)+ その出走馬の全戦績
//   (race_results の horse_key インデックス。1頭あたり十数行)。horse_key の IN は90件ずつ。
// 評価点は掛けない(比率の計算で評価点も選ぶため)。各馬の flags(評価点の印)を一緒に返す。
async function scoreRaces(db, races, { missingScore = DEFAULT_MISSING_SCORE } = {}) {
  if (!races.length) return [];
  // 騎手名エイリアスは使い回し版(読み取り専用。同じ Map なら race-factors API と下ごしらえ〈createFactorContext〉も共有される)
  const [lineups, aliasMap, raceTimes] = await Promise.all([getRaceLineups(db), loadJockeyAliasMapCached(db), getRaceTimes(db)]);
  // 対象レースは呼び出し側で最大 BACKTEST_CHUNK_MAX(6)件または重賞の11件に絞る(100バインド上限に届かない)
  const ids = races.map((r) => Number(r.id));
  const { results: rrRows } = await db
    .prepare(
      `SELECT race_id, horse_key, horse_name, horse_number, jockey, sex_age, status, finish_position
         FROM race_results WHERE race_id IN (${ids.map(() => "?").join(",")})`
    )
    .bind(...ids)
    .all();
  const runnersByRace = new Map();
  for (const r of rrRows || []) {
    if (r.status !== "finished" && r.status !== "stopped") continue;
    if (!runnersByRace.has(r.race_id)) runnersByRace.set(r.race_id, []);
    runnersByRace.get(r.race_id).push(r);
  }
  // 出走馬の全戦績(horse_key は最大 11レース×18頭 ≒ 200件になりうるため90件ずつ)
  const horseKeys = [...new Set((rrRows || []).map((r) => r.horse_key).filter(Boolean))];
  const runsByHorse = new Map();
  for (let i = 0; i < horseKeys.length; i += 90) {
    const keys = horseKeys.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT rr.horse_key, rr.race_id, rr.status, rr.finish_position, rr.corner_positions, rr.time_text, rr.final_furlong_time,
                rr.body_weight, rr.jockey, r.race_date, r.race_number, r.track, r.course_type, r.distance, r.track_condition
           FROM race_results rr JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_key IN (${keys.map(() => "?").join(",")})`
      )
      .bind(...keys)
      .all();
    for (const row of results || []) {
      if (!runsByHorse.has(row.horse_key)) runsByHorse.set(row.horse_key, []);
      runsByHorse.get(row.horse_key).push(row);
    }
  }
  const ctx = createFactorContext(lineups, raceTimes, aliasMap);
  const out = [];
  for (const race of races) {
    const runnersAll = runnersByRace.get(Number(race.id)) || [];
    const top3 = runnersAll.filter((r) => r.status === "finished" && r.finish_position >= 1 && r.finish_position <= 3);
    if (!runnersAll.length || !top3.length) continue;
    const rf = computeRaceFactors(ctx, race, runnersAll.map((h) => ({ key: h.horse_key, horse_number: h.horse_number, jockey: h.jockey, sex_age: h.sex_age })), runsByHorse, { missingScore });
    out.push({
      race,
      pace_type: rf.pace_type,
      top3Keys: new Set(top3.map((r) => r.horse_key)),
      runners: runnersAll.map((h) => ({
        key: h.horse_key, horse_name: h.horse_name, horse_number: h.horse_number, status: h.status, finish_position: h.finish_position,
        factors: Object.fromEntries(PACE_FACTORS.map((f) => {
          const v = rf.factors[f].get(h.horse_key);
          return [f, { score: v.score, missing: v.missing, value: v.value }];
        })),
        flags: rf.flags.get(h.horse_key) || { fd: 0, ft: 0, cj: 0 },
      })),
    });
  }
  return out;
}

const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 重賞の過去(最大10年+今年。今日〈当日を含む〉までに行われた年。各年1レース)。戻り値: { error } | { master, targets: [races_index の行] }
async function gradedTargets(db, gradedRaceId) {
  const master = await db.prepare("SELECT id, name, name_key FROM graded_races WHERE id = ?").bind(gradedRaceId).first();
  if (!master) return { error: "重賞が見つかりません" };
  const allRaces = await getRaceIndex(db);
  const matches = findRacesByGradedKey(allRaces, new Set([master.name_key, gradedRaceNameKey(master.name)].filter(Boolean)));
  const today = todayJst();
  const currentYear = jstYear();
  const byYear = new Map();
  for (const r of matches) {
    const year = Number(String(r.race_date || "").slice(0, 4));
    if (!year || year < currentYear - GRADED_PAST_YEARS || String(r.race_date) > today) continue;
    const prev = byYear.get(year);
    if (!prev || String(r.race_date) > String(prev.race_date)) byYear.set(year, r);
  }
  const targets = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r);
  return { master, targets };
}

// コースの直近1年(今日より前。結果のあるレース。新しい順)。races_index_cache から絞る(D1はキャッシュ約20行)
async function courseTargets(db, course) {
  const allRaces = await getRaceIndex(db);
  const today = todayJst();
  const from = new Date(Date.now() + 9 * 3600 * 1000 - COURSE_PAST_DAYS * 86400000).toISOString().slice(0, 10);
  return allRaces
    .filter((r) => r.track === course.track && r.course_type === course.course_type && Number(r.distance) === Number(course.distance)
      && String(r.race_date) >= from && String(r.race_date) < today && r.has_finish_order)
    .sort((a, b) => String(b.race_date).localeCompare(String(a.race_date)) || Number(b.race_number) - Number(a.race_number));
}

// 重賞検索タブの「総合推奨馬の検証」用(2026-10-13)。戻り値: { error } か { master, targets, checkedRaceIds, years: [{ year, race, pace_type, runners, top3Keys }] }
export async function loadGradedBacktest(db, gradedRaceId, scoreOpts = {}) {
  const t = await gradedTargets(db, gradedRaceId);
  if (t.error) return t;
  if (!t.targets.length) return { error: "過去の結果が取り込まれていません" };
  const scored = await scoreRaces(db, t.targets, scoreOpts);
  const years = scored.map((x) => ({ ...x, year: Number(String(x.race.race_date).slice(0, 4)) }));
  const checkedRaceIds = t.targets.filter((r) => r.has_finish_order).map((r) => Number(r.id));
  return { master: t.master, targets: t.targets, checkedRaceIds, years };
}

// 比率の計算の材料を数レースずつ返す(2026-10-14。GET /api/admin/pace-backtest)。kind: "graded"(key=重賞ID)/ "course"(key="競馬場|芝ダ障|距離")
// 戻り値: { error } | { kind, key, label, total, offset, missing_score, races: [{ race_id, race_date, pace_type,
//   runners: [{ horse_number, place(1〜3。それ以外0), scores: [PACE_FACTORS の順。評価点は掛けない], adj: [初距離, 初競馬場, 継続騎乗](0/1) }] }] }
export async function backtestChunk(db, kind, key, offset, limit, scoreOpts) {
  let targets, label;
  if (kind === "graded") {
    const t = await gradedTargets(db, Number(key));
    if (t.error) return t;
    targets = t.targets;
    label = t.master.name;
  } else if (kind === "course") {
    const c = parseCourseKey(key);
    if (!c) return { error: "コースが不正です" };
    targets = await courseTargets(db, c);
    label = `${c.track} ${c.course_type}${c.distance}m`;
  } else {
    return { error: "kind が不正です" };
  }
  const slice = targets.slice(offset, offset + Math.min(limit, BACKTEST_CHUNK_MAX));
  const scored = await scoreRaces(db, slice, scoreOpts);
  return {
    kind, key: String(key), label, total: targets.length, offset, missing_score: scoreOpts.missingScore,
    races: scored.map((x) => ({
      race_id: Number(x.race.id), race_date: x.race.race_date, pace_type: x.pace_type,
      runners: x.runners.map((h) => ({
        horse_number: h.horse_number,
        place: h.status === "finished" && h.finish_position >= 1 && h.finish_position <= 3 ? h.finish_position : 0,
        scores: PACE_FACTORS.map((f) => Math.round(h.factors[f].score * 100) / 100),
        adj: [h.flags.fd, h.flags.ft, h.flags.cj], // 評価点の印(初距離・初競馬場・継続騎乗。public/pace-search.js が評価点を選ぶ)
      })),
    })),
  };
}

// ---- 選んだ結果の保存(2026-10-14。PUT /api/admin/pace-weights/auto-result) ----
// result: public/pace-search.js の choosePaceWeights の戻り値 { weights, byPace, partnerWeights, partnerByPace, adjust, detail }
// 評価点(adjust。2026-10-14)は、手で保存した評価点があれば残し、無ければ自動の値にする
// 共通の比率は自動の値で上書きする(手で保存した共通があれば、軸・相手それぞれ残す)。ペースの比率は手で決めたものを残し、
// それ以外を自動の値に置き換える(レース数が足りず作らなかったペースの古い自動の値は消す)。
export async function saveAutoPaceResult(db, kind, key, result) {
  const w = normalizePaceWeights(result?.weights);
  const pw = normalizePaceWeights(result?.partnerWeights);
  if (!w || !pw) return { error: "比率が不正です" };
  const clean = (obj) => Object.fromEntries(PACE_TYPES.filter((p) => obj?.[p]).map((p) => [p, normalizePaceWeights(obj[p])]).filter(([, v]) => v));
  const autoByPace = clean(result.byPace), autoPartnerByPace = clean(result.partnerByPace);
  const detail = JSON.stringify(result.detail || {}).slice(0, 200000);
  let table, where, binds, insertKeyCols, insertKeyBinds;
  if (kind === "graded") {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0) return { error: "重賞が不正です" };
    table = "pace_weights"; where = "graded_race_id = ?"; binds = [id]; insertKeyCols = ["graded_race_id"]; insertKeyBinds = [id];
  } else if (kind === "course") {
    const c = parseCourseKey(key);
    if (!c) return { error: "コースが不正です" };
    table = "course_pace_weights"; where = "track = ? AND course_type = ? AND distance = ?";
    binds = [c.track, c.course_type, c.distance]; insertKeyCols = ["track", "course_type", "distance"]; insertKeyBinds = binds;
  } else {
    return { error: "kind が不正です" };
  }
  const row = await db.prepare(`SELECT ${PACE_WEIGHT_COLUMNS.join(", ")}, by_pace, partner, adjust, source FROM ${table} WHERE ${where}`).bind(...binds).first();
  const mergePaces = (prev, auto) => {
    const out = {};
    for (const p of PACE_TYPES) {
      if (prev[p]?.source === "manual") out[p] = prev[p];
      else if (auto[p]) out[p] = { ...auto[p], source: "auto" };
    }
    return out;
  };
  const keepManualCommon = row?.source === "manual";
  const axisCommon = keepManualCommon ? weightsOf(row) : w;
  const byPace = mergePaces(parseByPace(row?.by_pace), autoByPace);
  const prevPartner = parsePartner(row?.partner);
  const partner = {
    common: prevPartner.common?.source === "manual" ? prevPartner.common : { ...pw, source: "auto" },
    by_pace: mergePaces(prevPartner.by_pace, autoPartnerByPace),
  };
  const prevAdjust = parseAdjust(row?.adjust);
  const autoAdjust = result.adjust && ADJUST_KEYS.every((k) => Number.isFinite(Number(result.adjust[k])))
    ? { ...Object.fromEntries(ADJUST_KEYS.map((k) => [k, Number(result.adjust[k])])), source: "auto" } : null;
  const adjust = prevAdjust?.source === "manual" ? prevAdjust : autoAdjust;
  const now = new Date().toISOString();
  const cols = PACE_WEIGHT_COLUMNS;
  await db.prepare(
    `INSERT INTO ${table} (${insertKeyCols.join(", ")}, ${cols.join(", ")}, by_pace, partner, adjust, source, detail, updated_at)
     VALUES (${insertKeyCols.map(() => "?").join(", ")}, ${cols.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(${insertKeyCols.join(", ")}) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")},
       by_pace = excluded.by_pace, partner = excluded.partner, adjust = excluded.adjust, source = excluded.source, detail = excluded.detail, updated_at = excluded.updated_at`
  ).bind(...insertKeyBinds, ...cols.map((c) => axisCommon[c]), JSON.stringify(byPace), JSON.stringify(partner),
    adjust ? JSON.stringify(adjust) : null, keepManualCommon ? "manual" : "auto", detail, now).run();
  return { ok: true, updated_at: now };
}

// ---- 軸・相手の選び方(画面 prediction.js の paceAxisPartner と同じ規則) ----

// 指数 = Σ 比率 × 点 ÷ 比率の合計(画面と同じ)。factors: { f: { score } }
export function paceIndexOf(factors, w) {
  const wOf = (f) => Number(w[`w_${f}`] ?? 0);
  const wSum = PACE_FACTORS.reduce((a, f) => a + wOf(f), 0) || 1;
  return PACE_FACTORS.reduce((a, f) => a + wOf(f) * factors[f].score, 0) / wSum;
}

// 軸1頭・相手3頭を選ぶ。horses: [{ horse_number, axis, partner }] → { axis: 要素|null, partners: [要素] }
// 軸 = 軸指数の1位(同じなら相手指数の高い方 → 馬番の小さい方)。相手 = 軸を除いた相手指数の上位3頭(同じなら軸指数 → 馬番)
export function pickAxisPartners(horses) {
  const num = (h) => (h.horse_number == null ? 999 : Number(h.horse_number));
  const axis = [...horses].sort((a, b) => b.axis - a.axis || b.partner - a.partner || num(a) - num(b))[0] || null;
  const partners = horses.filter((h) => h !== axis)
    .sort((a, b) => b.partner - a.partner || b.axis - a.axis || num(a) - num(b))
    .slice(0, PACE_PICK_N);
  return { axis, partners };
}

// 重賞検索タブの「総合推奨馬の検証」(2026-10-13追加。2026-10-14 軸・相手に変更): 過去の各年を、指定の比率で採点した
// 軸1頭・相手3頭と実際の着順。weights は getPaceWeights の戻り値。各年はその年のペース予想の比率で採点する。
// adjust: 評価点(weights.adjust。無ければ設定の既定値を呼び出し側で渡す。2026-10-14)
export function gradedPicksOf(bt, weights, adjust = null) {
  return bt.years.map((y0) => {
    const y = adjust ? { ...y0, runners: y0.runners.map((h) => ({ ...h, factors: applyAdjust(h.factors, h.flags, adjust) })) } : y0;
    const wa = (y.pace_type && weights.paces?.[y.pace_type]) || weights;
    const pw = weights.partner || weights;
    const wp = (y.pace_type && pw.paces?.[y.pace_type]) || pw;
    const horses = y.runners.map((h) => ({ h, horse_number: h.horse_number, axis: paceIndexOf(h.factors, wa), partner: paceIndexOf(h.factors, wp) }));
    const { axis, partners } = pickAxisPartners(horses);
    const finished = (x) => (x && x.h.status === "finished" && x.h.finish_position >= 1 ? x.h.finish_position : null);
    const axisPos = finished(axis);
    const set = [axis, ...partners].filter(Boolean);
    const inSet = (pos) => set.some((x) => finished(x) === pos);
    const r1 = (v) => Math.round(v * 10) / 10;
    const row = (x, role) => ({
      role, horse_name: x.h.horse_name, horse_number: x.h.horse_number, status: x.h.status, finish_position: x.h.finish_position,
      axis: r1(x.axis), partner: r1(x.partner),
      factors: Object.fromEntries(PACE_FACTORS.map((f) => [f, { score: Math.round(x.h.factors[f].score), missing: x.h.factors[f].missing, value: x.h.factors[f].value }])),
    });
    const top3 = y.runners
      .filter((h) => y.top3Keys.has(h.key))
      .sort((a, b) => a.finish_position - b.finish_position)
      .map((h) => ({ finish_position: h.finish_position, horse_name: h.horse_name, horse_number: h.horse_number }));
    return {
      year: y.year, race_id: y.race.id, race_date: y.race.race_date, track: y.race.track, course_type: y.race.course_type, distance: y.race.distance,
      field_size: y.runners.length, pace_type: y.pace_type, top3,
      picks: [...(axis ? [row(axis, "axis")] : []), ...partners.map((x) => row(x, "partner"))],
      // 軸: 3着以内 / 1着。相手: 軸+相手3頭に 1着馬 / 1・2着馬 / 1〜3着馬
      axis_show: axisPos != null && axisPos <= 3, axis_win: axisPos === 1,
      partner_win: inSet(1), partner_quin: inSet(1) && inSet(2), partner_show: inSet(1) && inSet(2) && inSet(3),
      weights: { ...weightsOf(wa), pace_type: wa.pace_type ?? null }, // この年の採点に使った軸指数の比率
      partner_weights: { ...weightsOf(wp), pace_type: wp.pace_type ?? null },
    };
  });
}
