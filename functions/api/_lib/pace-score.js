// 総合推奨馬(2026-10-13追加。予想登録画面「展開・時計」タブ)の重視度の比率と、重賞の過去の結果からの自動算出。
// 仕様は docs/design/screens.md「総合推奨馬」。
//
// 点数の付け方は _lib/race-factors.js に一本化した(2026-10-13。以前は画面〈prediction.js〉とここに二重に持っていた)。
import { findRacesByGradedKey, jstYear } from "./graded-race-search.js";
import { gradedRaceNameKey } from "./race-classification.js";
import { getRaceIndex } from "./races-index-cache.js";
import { getRaceLineups } from "./race-lineup-cache.js";
import { loadJockeyAliasMapCached } from "./jockey-alias.js";
import { getRaceTimes } from "./race-time-cache.js";
import { FACTOR_KEYS, DEFAULT_MISSING_SCORE, createFactorContext, computeRaceFactors } from "./race-factors.js";
import { getPaceScoreSettings } from "./pace-settings.js";

export const PACE_FACTORS = FACTOR_KEYS;
// 既定の比率(ほぼ均等)。2026-10-14 に7要素(性齢・馬体重・同コースを追加)にした。それまでは4要素とも25
export const DEFAULT_PACE_WEIGHTS = { w_pace: 15, w_number: 15, w_jockey: 14, w_time: 14, w_sexage: 14, w_weight: 14, w_course: 14 };
// pace_weights の比率の列(SQL 用。PACE_FACTORS の順)
export const PACE_WEIGHT_COLUMNS = PACE_FACTORS.map((f) => `w_${f}`);
// ペース予想ごとの比率(2026-10-14追加。ユーザー要望)。列 by_pace に JSON { high|middle|slow: { w_*, source: "manual"|"auto" } } で持つ。
// 行の w_* は「全ペース共通」の比率。source='none' の行は共通の比率を決めていない(ペースの比率だけ手で入れた)。
export const PACE_TYPES = ["high", "middle", "slow"];
// 自動算出でペースごとの比率を作るのに要る年数(これ未満のペースは作らず、共通の比率を使う)
const PACE_SPLIT_MIN_YEARS = 2;
// 自動算出の方式の版。変えたら上げる(古い版で保存した自動の比率は、次に開かれたときに計算し直す)
const AUTO_METHOD_VERSION = 10; // 3: 2026-10-13 データの無い馬を25点・近い条件で補う(race-factors.js) / 4: 同日 評価を総合上位3頭に変更 /
// 5: 同日 上位3頭の1着数→2着以内の数→3着以内の数の優先順で比べる / 6: 2026-10-14 ペース予想ごとの比率も選ぶ /
// 7: 同日 馬番の点を3頭ずつの馬番帯で数える(race-factors.js) / 8: 同日 性齢・馬体重・同コースを追加し、探し方を山登りに変更 /
// 9: 同日 点を偏差値に変更(データ無しの点は設定。変えたら detail.missing_score と違うので計算し直す) /
// 10: 同日 軸指数・相手指数の2組の比率に分けた(下記)
//
// 軸指数・相手指数(2026-10-14 ユーザー要望。仕様は docs/design/screens.md「軸指数・相手指数」):
//   - 軸指数の比率: その指数の1位の馬(軸)が3着以内に入る年が一番多い比率(同じなら1着の年数 → 2着以内の年数 → 均等に近い方)
//   - 相手指数の比率: 軸を除いた相手指数の上位3頭(相手)と軸の4頭に、1着馬が入る年が一番多い比率
//     (同じなら2着馬も入る年数 → 3着馬も入る年数 → 均等に近い方)。軸は先に選んだ軸指数の比率で決める
//   - 保存: 行の w_* と by_pace は軸指数。列 partner に相手指数を JSON { common: { w_*, source }|null, by_pace: { high: { w_*, source } } }
//     (@STEP: pace_weights_partner)。相手指数の比率がどこにも無ければ、軸指数の比率を使う
export const PACE_TOP_N = 5; // (旧)重賞検索の検証で年ごとに表示していた頭数
export const PACE_PICK_N = 3; // 相手の頭数
export const PACE_KINDS = ["axis", "partner"];
const AUTO_PAST_YEARS = 10;

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

// 標準(graded_race_id=0)と、その重賞の比率を読む。読み取りは主キーで最大2行。
// 戻り値: 全ペース共通の比率 { w_*, source, updated_at, scope, pace_type: null, auto } に、
//   paces: { high|middle|slow: 同じ形(pace_type はペースの比率を使ったときだけそのペース) } を付けたもの。
// 選ぶ順(2026-10-14 ユーザー確認済み。手で決めた比率を自動より優先):
//   その重賞のそのペース(手動)→ その重賞の共通(手動)→ その重賞のそのペース(自動)→ その重賞の共通(自動)
//   → 標準のそのペース → 標準の共通 → 既定値(各25)
export async function getPaceWeights(db, gradedRaceId) {
  const ids = [0];
  if (gradedRaceId) ids.push(Number(gradedRaceId));
  let rows = [];
  try {
    const { results } = await db
      .prepare(`SELECT graded_race_id, ${PACE_WEIGHT_COLUMNS.join(", ")}, by_pace, partner, source, detail, updated_at FROM pace_weights WHERE graded_race_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    rows = results || [];
  } catch (e) {
    console.error("pace_weights read failed (ignored)", e); // 表がまだ無い等。既定値で返す
  }
  const byId = new Map(rows.map((r) => [Number(r.graded_race_id), r]));
  const g = gradedRaceId ? byId.get(Number(gradedRaceId)) || null : null;
  const d = byId.get(0) || null;
  const axisOf = (p) => resolvePaceWeights(g, d, p, "axis");
  // 相手指数: 相手の比率の選ぶ順で探し、どこにも無ければ軸指数の比率(2026-10-14)
  const partnerOf = (p) => {
    const r = resolvePaceWeights(partnerRowView(g), partnerRowView(d), p, "partner");
    return r.scope === "builtin" ? { ...axisOf(p), from_axis: true } : r;
  };
  return {
    ...axisOf(null),
    paces: Object.fromEntries(PACE_TYPES.map((p) => [p, axisOf(p)])),
    partner: { ...partnerOf(null), paces: Object.fromEntries(PACE_TYPES.map((p) => [p, partnerOf(p)])) },
  };
}

// g: その重賞の行、d: 標準の行(どちらも無ければ null)、pace: "high"|"middle"|"slow"|null(共通)、kind: "axis"|"partner"
function resolvePaceWeights(g, d, pace, kind = "axis") {
  // auto: 自動算出の要約(画面に「過去の的中」を出す用。年ごとの根拠は管理画面の一覧で見る)。相手指数は detail.partner
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
    auto: scope === "graded" && c.source === "auto" ? autoOf(r, c.p) : null,
  });
  if (g) {
    const gp = ofPace(g), gc = common(g);
    const order = [gp?.source === "manual" && gp, gc?.source === "manual" && gc, gp, gc].filter(Boolean);
    if (order.length) return make(order[0], g, "graded");
  }
  if (d) {
    const c = ofPace(d) || common(d);
    if (c) return make(c, d, "default");
  }
  return { ...DEFAULT_PACE_WEIGHTS, source: "builtin", updated_at: null, scope: "builtin", pace_type: null, kind, auto: null };
}

// 1年分を、ある比率で採点したときの { hits(総合上位3頭〈PACE_PICK_N〉のうち3着以内に入った頭数), posSum(3着以内の馬の総合の位置の合計) }。
// 総合点 = Σ 比率 × 点(データ無しは50点)÷ 100。
// 同点の馬が上位3頭の境目をまたぐときは、残りの枠を同点の馬で按分して数える(例: 3位以下に4頭が同点で残り1枠なら1頭あたり1/4)。
// 2026-10-13: 当初は同点を同順位にして全員をベスト5に数えており、ある要素のデータが全頭に無い(全頭50点で同点)と
// 全頭がベスト5扱いになって当たりが多く数えられ、その要素の比率が不当に高く選ばれた。位置も同点の中の平均にする。
// CPU時間対策(2026-10-13): 候補(2026-10-14〜 山登りで最大約260通り)×最大11年を採点するため、年ごとの点を先に数値の配列にしておき(compileYear)、
// 採点ではオブジェクトを作らない。Map を引く素朴な書き方だと手元で約46ミリ秒かかり、無料枠のCPU上限(10ミリ秒)を超えた。
// placeOf: Map(key -> 着順 1/2/3。それ以外は無し)
function compileYear(keys, placeOf, scores) {
  const n = keys.length;
  const F = PACE_FACTORS.length;
  const S = new Float64Array(n * F);
  const place = new Uint8Array(n); // 1/2/3 着(それ以外は0)
  keys.forEach((key, h) => {
    PACE_FACTORS.forEach((f, k) => {
      const s = scores[f].get(key);
      S[h * F + k] = s == null ? DEFAULT_MISSING_SCORE : s; // 点は race-factors で必ず入っている(念のため)
    });
    place[h] = placeOf.get(key) || 0;
  });
  const placed = [];
  for (let h = 0; h < n; h++) if (place[h]) placed.push(h);
  return { n, S, place, placed, totals: new Float64Array(n) };
}

// w: 比率の配列(PACE_FACTORS の順)。totals に各馬の点(整数化。浮動小数の誤差で同点が崩れないよう)を入れる
function fillTotals(year, w) {
  const { n, S, totals } = year;
  const F = w.length;
  for (let h = 0; h < n; h++) {
    let t = 0;
    for (let k = 0; k < F; k++) t += w[k] * S[h * F + k];
    totals[h] = Math.round(t * 1000);
  }
  return totals;
}

// 軸指数の採点(2026-10-14): 1位の馬(軸)が 3着以内 / 1着 / 2着以内 か。1位が同点で複数いるときは按分。
// 戻り値: { show, win, quin }(0〜1)
function evaluateAxis(year, w) {
  const { n, place } = year;
  const totals = fillTotals(year, w);
  let max = -Infinity, cnt = 0, s3 = 0, s1 = 0, s2 = 0;
  for (let h = 0; h < n; h++) {
    const t = totals[h];
    if (t > max) { max = t; cnt = 0; s3 = s1 = s2 = 0; }
    if (t === max) {
      cnt++;
      const p = place[h];
      if (p) s3++;
      if (p === 1) s1++;
      if (p && p <= 2) s2++;
    }
  }
  return { show: s3 / cnt, win: s1 / cnt, quin: s2 / cnt };
}

// 軸の馬(その比率で点が一番高い馬。同点は並びの先〈馬番の小さい方〉)
function axisPick(year, w) {
  const totals = fillTotals(year, w);
  let best = 0;
  for (let h = 1; h < year.n; h++) if (totals[h] > totals[best]) best = h;
  return best;
}

// 相手指数の採点(2026-10-14): 軸(axisIdx)を除いた上位3頭+軸に、1着馬・2着馬・3着馬が入っているか。
// 境目の同点は残りの枠を按分(以前の上位3頭の数え方と同じ)。戻り値: { win(1着馬が入る), quin(1・2着馬とも), show(1〜3着馬すべて) }
// CPU時間対策: 全頭を並べ替えず、着順の馬ごとに「点が上の馬の数」と「同点の馬の数」を数える(軸の馬は数えない)
function evaluatePartner(year, w, axisIdx) {
  const { n, place, placed } = year;
  const totals = fillTotals(year, w);
  const cov = [1, 1, 1]; // 1・2・3着の馬が入っている割合(その着順の馬がいなければ1のまま)
  const seen = [false, false, false];
  for (const h of placed) {
    const p = place[h] - 1;
    let c;
    if (h === axisIdx) c = 1;
    else {
      const t = totals[h];
      let above = 0, same = 0;
      for (let x = 0; x < n; x++) {
        if (x === axisIdx) continue;
        if (totals[x] > t) above++;
        else if (totals[x] === t) same++;
      }
      c = Math.max(0, Math.min(above + same, PACE_PICK_N) - above) / same;
    }
    // 同着で同じ着順が2頭いれば、入っている方を採る
    cov[p] = seen[p] ? Math.max(cov[p], c) : c;
    seen[p] = true;
  }
  return { win: cov[0], quin: cov[0] * cov[1], show: cov[0] * cov[1] * cov[2] };
}

const AXIS_KEYS = ["show", "win", "quin"]; // 軸: 3着以内 → 1着 → 2着以内
const PARTNER_KEYS = ["win", "quin", "show"]; // 相手: 1着馬 → 2着馬も → 3着馬も

// 重賞の過去(最大10年。今日〈当日を含む〉までに行われ着順のある年)の各年について、そのレースより前のデータだけで
// 4要素の点を付け直す(_lib/race-factors.js。画面と同じ規則)。比率の自動算出と、重賞検索タブの「過去の上位5頭」で共用する
// (2026-10-13 に autoPaceWeights から切り出し)。
// 戻り値: { error } か { master, targets, checkedRaceIds, years: [{ year, race, pace_type, runners: [{ key, horse_name, horse_number,
//   status, finish_position, factors: { f: { score, missing, value } } }], top3Keys }] }(新しい年から)
// D1の読み取り: 一覧用キャッシュ・集計用キャッシュ・勝ちタイムのキャッシュ(各約20行)+ 対象レースの race_results(約200行)+
//   その出走馬の全戦績(race_results の horse_key インデックス。毎日王冠で約800行)。
// missingScore: データの無い馬の点(偏差値。設定の missing_score。2026-10-14)
export async function loadGradedBacktest(db, gradedRaceId, { missingScore = DEFAULT_MISSING_SCORE } = {}) {
  const master = await db.prepare("SELECT id, name, name_key FROM graded_races WHERE id = ?").bind(gradedRaceId).first();
  if (!master) return { error: "重賞が見つかりません" };

  // 騎手名エイリアスは使い回し版(2026-10-14。読み取り専用のため。同じ Map なら race-factors API と下ごしらえ〈createFactorContext〉も共有される)
  const [allRaces, lineups, aliasMap, raceTimes] = await Promise.all([getRaceIndex(db), getRaceLineups(db), loadJockeyAliasMapCached(db), getRaceTimes(db)]);
  const matches = findRacesByGradedKey(allRaces, new Set([master.name_key, gradedRaceNameKey(master.name)].filter(Boolean)));
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const currentYear = jstYear();
  const byYear = new Map();
  for (const r of matches) {
    const year = Number(String(r.race_date || "").slice(0, 4));
    if (!year || year < currentYear - AUTO_PAST_YEARS || String(r.race_date) > today) continue;
    const prev = byYear.get(year);
    if (!prev || String(r.race_date) > String(prev.race_date)) byYear.set(year, r);
  }
  const targets = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, r]) => ({ year, race: r }));
  if (!targets.length) return { error: "過去の結果が取り込まれていません" };

  // 対象レース(最大11件。100バインド上限に届かない)の出走馬と着順
  const targetIds = targets.map((t) => Number(t.race.id));
  const { results: rrRows } = await db
    .prepare(
      `SELECT race_id, horse_key, horse_name, horse_number, jockey, sex_age, status, finish_position
         FROM race_results WHERE race_id IN (${targetIds.map(() => "?").join(",")})`
    )
    .bind(...targetIds)
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
                rr.body_weight, r.race_date, r.race_number, r.track, r.course_type, r.distance, r.track_condition
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

  const years = [];
  for (const { year, race } of targets) {
    const runnersAll = runnersByRace.get(Number(race.id)) || [];
    const top3 = runnersAll.filter((r) => r.status === "finished" && r.finish_position >= 1 && r.finish_position <= 3);
    if (!runnersAll.length || !top3.length) continue;
    const rf = computeRaceFactors(ctx, race, runnersAll.map((h) => ({ key: h.horse_key, horse_number: h.horse_number, jockey: h.jockey, sex_age: h.sex_age })), runsByHorse, { missingScore });
    years.push({
      year,
      race,
      pace_type: rf.pace_type,
      top3Keys: new Set(top3.map((r) => r.horse_key)),
      runners: runnersAll.map((h) => ({
        key: h.horse_key, horse_name: h.horse_name, horse_number: h.horse_number, status: h.status, finish_position: h.finish_position,
        factors: Object.fromEntries(PACE_FACTORS.map((f) => {
          const v = rf.factors[f].get(h.horse_key);
          return [f, { score: v.score, missing: v.missing, value: v.value }];
        })),
      })),
    });
  }
  const checkedRaceIds = targets.filter((t) => t.race.has_finish_order || runnersByRace.has(Number(t.race.id))).map((t) => Number(t.race.id));
  return { master, targets, checkedRaceIds, years };
}

// 重賞の過去(最大10年)の結果から比率を自動算出する(2026-10-13 に方式を変更)。
// 各年の4要素の点(loadGradedBacktest)をもとに、比率の候補ごとに総合点の上位3頭のうち何頭が3着以内に入ったかを数え
// (2026-10-13 ユーザー要望で上位5頭→上位3頭に変更)、
// 過去の全年で一番多く当たった比率を採用する。同じ当たり数なら3着以内の馬の総合の位置の合計が小さい方、それも同じなら均等に近い方。
// 2026-10-13 以前は「各要素のベスト5の的中率 − 偶然の割合」に比例させていたが、偶然以下の要素が0%に切り捨てられ、
// 富士S・秋華賞が騎手100%になった(展開のデータが少なく、馬番が偶然をわずかに下回ったため)。要素ごとの的中率は参考として detail に残す。
// opts.targetRace(画面で開いたレース)があれば、その年を detail.target_year に記録する。
export async function autoPaceWeights(db, gradedRaceId, opts = {}) {
  const { missing_score: missingScore } = await getPaceScoreSettings(db);
  const bt = await loadGradedBacktest(db, gradedRaceId, { missingScore });
  if (bt.error) return { error: bt.error };

  const factorTotal = { top3: 0 };
  for (const f of PACE_FACTORS) factorTotal[f] = { hits: 0, expected: 0 };
  const years = []; // 年ごとの採点結果(比率の候補の評価に使う)
  const yearsOut = []; // detail に残す根拠
  for (const y of bt.years) {
    const n = y.runners.length;
    // 馬番の順に並べる(軸の同点は馬番の小さい方〈axisPick〉)
    const ordered = [...y.runners].sort((a, b) => (Number(a.horse_number) || 99) - (Number(b.horse_number) || 99));
    years.push(compileYear(
      ordered.map((h) => h.key),
      new Map(y.runners.filter((h) => h.status === "finished" && h.finish_position >= 1 && h.finish_position <= 3).map((h) => [h.key, h.finish_position])),
      Object.fromEntries(PACE_FACTORS.map((f) => [f, new Map(y.runners.map((h) => [h.key, h.factors[f].score]))]))
    ));
    const yearOut = { year: y.year, race_id: y.race.id, field_size: n, pace_type: y.pace_type, top3: y.top3Keys.size };
    factorTotal.top3 += y.top3Keys.size;
    for (const f of PACE_FACTORS) {
      // 要素ごとの上位3頭(データのある馬を点の高い順)
      const best = y.runners.filter((h) => !h.factors[f].missing).sort((a, b) => b.factors[f].score - a.factors[f].score).slice(0, PACE_PICK_N);
      const hits = best.filter((h) => y.top3Keys.has(h.key)).length;
      factorTotal[f].hits += hits;
      factorTotal[f].expected += (y.top3Keys.size * best.length) / n;
      yearOut[f] = { hits, picked: best.length };
    }
    yearsOut.push(yearOut);
  }
  if (!factorTotal.top3) return { error: "過去の着順が取り込まれていません" };

  // 軸指数 → (その比率で決めた各年の軸)→ 相手指数 の順に選ぶ(2026-10-14)。
  // pick(ys, startAxis, startPartner): 年の並び ys について { axis, partner }(各 { best, equal })
  const pick = (ys, startAxis = null, startPartner = null) => {
    const axis = searchBestWeights(ys, { evaluate: evaluateAxis, keys: AXIS_KEYS, start: startAxis });
    const axisIdx = ys.map((y) => axisPick(y, axis.best.arr));
    const partner = searchBestWeights(ys, {
      evaluate: (y, w, i) => evaluatePartner(y, w, axisIdx[i]), keys: PARTNER_KEYS, start: startPartner,
    });
    return { axis, partner };
  };
  const all = pick(years);
  const sum3 = (r) => ({ win: r.win, quin: r.quin, show: r.show });
  yearsOut.forEach((y, i) => {
    y.axis = all.axis.best.perYear[i]; // 選んだ比率での軸の { show, win, quin }
    y.partner = all.partner.best.perYear[i]; // 選んだ比率での相手(軸含む4頭)の { win, quin, show }
  });

  // ペース予想ごと(2026-10-14追加): 各年のペース予想で分け、PACE_SPLIT_MIN_YEARS 年以上あるペースだけ選ぶ(全年で選んだ比率から探す)
  const byPace = {}, partnerByPace = {};
  const byPaceDetail = {}, partnerByPaceDetail = {};
  for (const p of PACE_TYPES) {
    const idx = bt.years.map((y, i) => (y.pace_type === p ? i : -1)).filter((i) => i >= 0);
    if (idx.length < PACE_SPLIT_MIN_YEARS) continue;
    const r = pick(idx.map((i) => years[i]), all.axis.best.arr, all.partner.best.arr);
    byPace[p] = { ...r.axis.best.w };
    partnerByPace[p] = { ...r.partner.best.w };
    byPaceDetail[p] = { races: idx.length, best: sum3(r.axis.best), equal: sum3(r.axis.equal) };
    partnerByPaceDetail[p] = { races: idx.length, best: sum3(r.partner.best), equal: sum3(r.partner.equal) };
  }
  const best = all.axis.best, equal = all.axis.equal;

  const summary = {};
  for (const f of PACE_FACTORS) {
    summary[f] = {
      hits: factorTotal[f].hits,
      hit_rate: Math.round((factorTotal[f].hits / factorTotal.top3) * 1000) / 1000,
      chance_rate: Math.round((factorTotal[f].expected / factorTotal.top3) * 1000) / 1000,
    };
  }
  const targetYear = opts.targetRace ? Number(String(opts.targetRace.race_date || "").slice(0, 4)) || null : opts.targetYear || null;
  return {
    weights: { ...best.w },
    byPace,
    partnerWeights: { ...all.partner.best.w },
    partnerByPace,
    detail: {
      method: "backtest",
      version: AUTO_METHOD_VERSION,
      missing_score: missingScore, // この点で採点した(設定が変わったら計算し直す。isAutoWeightsStale)
      computed_at: new Date().toISOString(),
      target_year: targetYear,
      race_ids: yearsOut.map((y) => y.race_id),
      // 着順のあったレース(全頭の結果がそろわず採点に使えなかった年も含む)。古いかどうかの判定に使う
      // (着順の無かった今年のレースは入れない。結果が入ったら計算し直すため)
      checked_race_ids: bt.checkedRaceIds,
      races: yearsOut.length,
      top3: factorTotal.top3,
      // 軸指数: 軸が 3着以内 / 1着 / 2着以内 に入った年数(分母は年数)
      best: sum3(best),
      equal: sum3(equal),
      // ペースごとの { races, best, equal }(年数が足りず作らなかったペースは無し)
      by_pace: byPaceDetail,
      // 相手指数: 軸+相手3頭に 1着馬 / 1・2着馬 / 1〜3着馬 が入った年数
      partner: { races: yearsOut.length, best: sum3(all.partner.best), equal: sum3(all.partner.equal), by_pace: partnerByPaceDetail },
      summary,
      years: yearsOut,
    },
  };
}

// 年ごとの採点(compileYear)の並びから、一番当たった比率を選ぶ。戻り値: { best: { w, arr, win, quin, show, perYear }, equal }
// evaluate(year, wArr, i) → { win, quin, show }(その年の当たり。0〜1)、keys: 比べる順(例 ["show", "win", "quin"])
// start(比率の配列)があれば、そこだけを出発点にする(ペースごとの探索は全年で選んだ比率から始める。CPU時間対策)
function searchBestWeights(years, { evaluate, keys, start = null }) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const evalWeights = (w) => {
    const wArr = PACE_FACTORS.map((f) => w[`w_${f}`]);
    let win = 0, quin = 0, show = 0;
    const perYear = years.map((y, i) => {
      const r = evaluate(y, wArr, i);
      win += r.win; quin += r.quin; show += r.show;
      return { win: r2(r.win), quin: r2(r.quin), show: r2(r.show) };
    });
    return { win: r2(win), quin: r2(quin), show: r2(show), perYear };
  };
  const distFromEqual = (w) => PACE_FACTORS.reduce((a, f) => a + Math.abs(w[`w_${f}`] - DEFAULT_PACE_WEIGHTS[`w_${f}`]), 0);
  // 比べ方(2026-10-14 ユーザー確認済み): keys の順に多い方。それも同じなら均等に近い方
  const better = (r, b) => {
    for (const k of keys) if (r[k] !== b[k]) return r[k] > b[k];
    return distFromEqual(r.w) < distFromEqual(b.w);
  };
  // 山登りで探す(2026-10-14。要素が7つになり、10%刻みの全通り〈8,008通り〉は試せないため。それまでは4要素の全通りを2段階で探していた):
  //   出発点 = 各要素を40%・残りを10%ずつにした7通り+(20,20,20,10,10,10,10)のうち一番当たったもの。
  //   そこから「ある要素の10%を別の要素へ移す」(最大42通り)のうち一番良いものへ動き、良くならなくなるか CLIMB_MAX_STEPS 回で止める。
  //   試すのは最大 8 + 42×CLIMB_MAX_STEPS 通り。必ず一番当たる比率が見つかるとは限らない(近くで一番良い比率)
  const CLIMB_MAX_STEPS = 6;
  const tried = new Map();
  const consider = (wArr) => {
    const key = wArr.join(",");
    let r = tried.get(key);
    if (!r) {
      const w = Object.fromEntries(PACE_FACTORS.map((f, i) => [`w_${f}`, wArr[i]]));
      tried.set(key, (r = { w, arr: wArr, ...evalWeights(w) }));
    }
    return r;
  };
  const F = PACE_FACTORS.length;
  const seeds = start ? [start] : PACE_FACTORS.map((_, i) => PACE_FACTORS.map((__, k) => (k === i ? 100 - 10 * (F - 1) : 10)));
  if (!start) seeds.push(PACE_FACTORS.map((_, k) => (k < 100 / 10 - F ? 20 : 10))); // 合計100になるよう先頭から20
  let best = null;
  for (const s of seeds) {
    const r = consider(s);
    if (!best || better(r, best)) best = r;
  }
  for (let step = 0; step < CLIMB_MAX_STEPS; step++) {
    let next = null;
    for (let i = 0; i < F; i++) {
      if (best.arr[i] < 10) continue;
      for (let j = 0; j < F; j++) {
        if (i === j) continue;
        const a = [...best.arr];
        a[i] -= 10;
        a[j] += 10;
        const r = consider(a);
        if (!next || better(r, next)) next = r;
      }
    }
    if (!next || !better(next, best)) break;
    best = next;
  }
  return { best, equal: evalWeights(DEFAULT_PACE_WEIGHTS) };
}

// 指数 = Σ 比率 × 点 ÷ 比率の合計(画面と同じ)。factors: { f: { score } }
export function paceIndexOf(factors, w) {
  const wOf = (f) => Number(w[`w_${f}`] ?? 0);
  const wSum = PACE_FACTORS.reduce((a, f) => a + wOf(f), 0) || 1;
  return PACE_FACTORS.reduce((a, f) => a + wOf(f) * factors[f].score, 0) / wSum;
}

// 軸1頭・相手3頭を選ぶ(画面〈prediction.js の paceAxisPartner〉と同じ規則)。
// horses: [{ horse_number, axis, partner }] → { axis: 要素|null, partners: [要素] }
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
export function gradedPicksOf(bt, weights) {
  return bt.years.map((y) => {
    const wa = (y.pace_type && weights.paces?.[y.pace_type]) || weights;
    const pw = weights.partner || weights;
    const wp = (y.pace_type && pw.paces?.[y.pace_type]) || pw;
    const horses = y.runners.map((h) => ({ h, horse_number: h.horse_number, axis: paceIndexOf(h.factors, wa), partner: paceIndexOf(h.factors, wp) }));
    const { axis, partners } = pickAxisPartners(horses);
    const finished = (x) => x && x.h.status === "finished" && x.h.finish_position >= 1 ? x.h.finish_position : null;
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

// 自動の比率が古くなっていないか(画面で開いたレース race で判定)。
//   - そのレースの結果が入っているのに、計算に含まれていない → 古い(結果を含めて計算し直し、翌年に活かす)
//   - そのレースの年より前の年のために計算したもの → 古い(今年の出走馬が登録されたら、過去10年で計算し直す)
// 管理者が手で保存した共通の比率(source='manual')があれば自動で計算し直さない(手動が自動より優先されるため使われない)。
// ペースの比率だけ手で入れた行(source='none')は、共通と残りのペースを自動で埋める。
// missingScore: 今の設定のデータ無しの点(2026-10-14)。計算したときの点と違えば古い。
export function isAutoWeightsStale(row, race, missingScore = DEFAULT_MISSING_SCORE) {
  if (!row) return true;
  if (row.source === "manual") return false;
  let detail = null;
  try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { /* 壊れていれば計算し直す */ }
  if (!detail || detail.method !== "backtest" || detail.version !== AUTO_METHOD_VERSION) return true;
  if (Number(detail.missing_score) !== Number(missingScore)) return true;
  const year = Number(String(race.race_date || "").slice(0, 4));
  // 計算の対象(過去10年)より前のレースを開いたときは、計算し直さない(含められないため、毎回古いと判定されてしまう)
  if (!year || year < jstYear() - AUTO_PAST_YEARS) return false;
  const checked = (detail.checked_race_ids || detail.race_ids || []).map(Number);
  if (race.has_result && !checked.includes(Number(race.id))) return true;
  return !detail.target_year || detail.target_year < year;
}

// races の行(id, race_date, finish_order)を isAutoWeightsStale に渡す形にする(結果が入っているか)。
export function raceForStaleCheck(race) {
  return { ...race, has_result: Boolean(race.finish_order && race.finish_order !== "[]" && race.finish_order !== "null") };
}

// 自動算出して保存する(画面から呼ばれたとき・管理者のボタン)。戻り値は autoPaceWeights と同じ(保存したら saved: true)。
// 共通の比率は自動の値で上書きする。ペースの比率は、手で決めたもの(source='manual')を残し、それ以外を自動の値に置き換える
// (年数が足りず作らなかったペースの古い自動の値は消す)。
export async function computeAndSaveAutoPaceWeights(db, gradedRaceId, opts = {}) {
  const result = await autoPaceWeights(db, gradedRaceId, opts);
  if (result.error) return result;
  const row = await db.prepare("SELECT by_pace, partner FROM pace_weights WHERE graded_race_id = ?").bind(gradedRaceId).first();
  // ペースの比率: 手で決めたものは残し、それ以外を自動の値に置き換える
  const mergePaces = (prev, auto) => {
    const out = {};
    for (const p of PACE_TYPES) {
      if (prev[p]?.source === "manual") out[p] = prev[p];
      else if (auto[p]) out[p] = { ...auto[p], source: "auto" };
    }
    return out;
  };
  const byPace = mergePaces(parseByPace(row?.by_pace), result.byPace);
  // 相手指数(2026-10-14): 共通も手で決めたものは残す
  const prevPartner = parsePartner(row?.partner);
  const partner = {
    common: prevPartner.common?.source === "manual" ? prevPartner.common : { ...result.partnerWeights, source: "auto" },
    by_pace: mergePaces(prevPartner.by_pace, result.partnerByPace),
  };
  const now = new Date().toISOString();
  const cols = PACE_WEIGHT_COLUMNS;
  await db.prepare(
    `INSERT INTO pace_weights (graded_race_id, ${cols.join(", ")}, by_pace, partner, source, detail, updated_at)
     VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?, 'auto', ?, ?)
     ON CONFLICT(graded_race_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")},
       by_pace = excluded.by_pace, partner = excluded.partner, source = 'auto', detail = excluded.detail, updated_at = excluded.updated_at`
  ).bind(gradedRaceId, ...cols.map((c) => result.weights[c]), JSON.stringify(byPace), JSON.stringify(partner), JSON.stringify(result.detail), now).run();
  return { ...result, byPace, partner, saved: true, updated_at: now };
}
