// 総合推奨馬の比率(軸指数・相手指数)を、過去のレースの採点から選ぶ計算(2026-10-14)。ES モジュール。
// ブラウザ(管理者の「今すぐ計算」。prediction.js / admin.js から import())と、夜間の定時実行(scripts/pace-nightly.mjs。
// GitHub Actions の Node)の両方がこの1つのファイルを使う(計算の規則を1か所に保つため)。サーバーでは計算しない
// (無料枠のCPU上限〈10ミリ秒〉に収まらないため。サーバーは採点〈/api/admin/pace-backtest〉と保存だけ)。
// 仕様は docs/design/screens.md「軸指数・相手指数」「比率の計算(夜間・今すぐ計算)」。
//
// 入力 races: [{ race_id, race_date, pace_type, runners: [{ horse_number, place(1〜3。それ以外0), scores: [7要素の点], adj: [0/1 ×6] }] }]
//   scores の並びは FACTORS の順(サーバーの _lib/race-factors.js の FACTOR_KEYS と同じ)。評価点は掛けていない点。
//   adj は評価点の印(初距離・初競馬場・継続騎乗・前年掲示板・前年1着・間隔。ADJUST_KEYS の順。2026-10-14追加。古い採点で足りなければ0)。
//   間隔(2026-10-15)は総合点から直接引く(1/0)。同日に足した位置取りは、展開の点に脚質を入れたため同日に削除
// 規則:
//   - 軸指数の比率: その指数1位の馬(軸)が3着以内に入ったレースが一番多い比率(同じなら1着 → 2着以内 → 均等に近い方。1位の同点は按分)
//   - 相手指数の比率: ①の比率で各レースの軸を決め、軸を除いた上位3頭+軸に1着馬が入ったレースが一番多い比率
//     (同じなら1・2着馬とも → 1〜3着馬とも → 均等に近い方。境目の同点は按分)
//   - ペース予想ごと: コースの計算だけ、そのペースのレースが PACE_SPLIT_MIN 以上あれば作る(2026-10-18。以前は重賞も2レースから作っていた)
//   - 全コースの計算(評価点の既定値の自動計算。2026-10-28〜標準の比率としても保存)だけは 5%刻み・全要素5%以上・評価点5以上
//   - 探し方は総当たり(2026-10-18。10%刻み・合計100%の全19,448通り。選ぶレースのすべてで全馬が同じ点の要素は0%に決める)。
//     以前は山登り(各要素40%・残り10%の7通り+(20,20,20,10,10,10,10)から出発し、10%を別の要素へ移す〈最大42通り〉を最大6回)で、
//     よりよい比率を見落としていた(過去の重賞156レースの試算で、選ぶときに使わなかった年の軸の3着以内 29.5% → 41.0%)
//     2026-10-15 に8要素(週目)になり、出発点は各要素30%・残り10%の8通り+(20,20,10,…)、移し方は最大56通り
//   - 評価点(2026-10-14 ユーザー要望。docs/design/screens.md「評価点(初距離・初競馬場・継続騎乗)」): 初距離・初競馬場はタイムの点から引き、
//     継続騎乗は騎手の点、前年の同レース(掲示板・1着。重賞だけ)は同コースの点に足す(偏差値の点)。間隔(2026-10-15)は総合点から直接引く。
//     間隔は全レース共通(GLOBAL_ADJUST_KEYS)で、重賞・コースの計算では動かさず既定値のまま。「評価点の既定値」の自動計算(採点の kind="all")だけ選ぶ。全体の軸の比率(既定の評価点で選ぶ)を決めた後、
//     その比率のまま評価点を1つずつ 0〜30(5刻み)で動かして選ぶ(最大3周)。ものさし(2026-10-14 変更。ユーザー確認済み)は
//     「並びの一致」= 各レースで、3着以内の馬と3着外の馬の組のうち、3着以内の馬の指数が上だった割合(同じなら半分)の平均。
//     軸1頭の当たり外れだけでは評価点の効き目がほとんど表れず(600レースで2回差)、たまたまの差で値が揺れたため。
//     選んだ値が既定値より平均 ADJUST_MIN_GAIN 以上良くならなければ既定値のままにする(同じなら既定値に近い方)。
//     既定値は管理画面の「評価点の既定値」(採点の応答の adjust_default。無ければ DEFAULT_ADJUST)。
//     その評価点で全体の軸から選び直し、相手・ペースごとの比率もその評価点で選ぶ

export const FACTORS = ["pace", "number", "jockey", "time", "sexage", "weight", "course", "week"]; // week(週目)は2026-10-15追加
export const DEFAULT_WEIGHTS = { w_pace: 13, w_number: 13, w_jockey: 13, w_time: 13, w_sexage: 12, w_weight: 12, w_course: 12, w_week: 12 };
export const PACE_TYPES = ["high", "middle", "slow"];
// 補正タイム(その馬自身の能力を表す要素)の比率の下限(%。2026-10-25 ユーザー要望・仕様確認済み。docs/design/screens.md「補正タイムの比率の下限」)。
// 以前は 0% もありえ、東京芝1600のハイペースの比率が「騎手40・週目40・補正タイム0」になり、補正タイム24点の馬が◎になった(10/25 東京8R・16着)。
// 比率を選ぶのに使っていないレースの試算で、◎の補正タイムが40点未満のレースが 南関東 3.2% → 0.2%・重賞 4.7% → 0.4%、
// ◎の複勝圏が 南関東 47.3% → 49.4%(ペースごとは全体と半分ずつ混ぜたとき)・重賞 35.7% → 36.8%
export const TIME_MIN_WEIGHT = 30;
export const METHOD_VERSION = 17; // サーバー側 detail.version と同じ意味(17: 2026-10-25 補正タイムの比率は30%以上。16: 2026-10-18 総当たり・差がつかない要素を外す・重賞はペースごとを作らない。15: 2026-10-15 展開の点に脚質・位置取りを削除・間隔。14: 評価点に位置取り。11: 2026-10-14 計算をブラウザ・夜間へ移した。12: 評価点も選ぶ。13: 評価点のものさしを並びの一致に)
// 評価点(サーバーの _lib/race-factors.js の ADJUST_KEYS・DEFAULT_ADJUST と同じ)
export const ADJUST_KEYS = ["first_distance", "first_track", "same_jockey", "prev_board", "prev_win", "layoff"];
export const DEFAULT_ADJUST = { first_distance: 10, first_track: 5, same_jockey: 5, prev_board: 5, prev_win: 10, layoff: 5 };
export const GLOBAL_ADJUST_KEYS = ["layoff"];
const I_LAYOFF = ADJUST_KEYS.indexOf("layoff");
const NA = ADJUST_KEYS.length;
const ADJUST_VALUES = [0, 5, 10, 15, 20, 25, 30];
const ADJUST_ROUNDS = 3;
// 既定値から動かすのに要る良くなり幅(並びの一致の平均で0.5%。それ未満はたまたまの差とみなす)
export const ADJUST_MIN_GAIN = 0.005;
const I_JOCKEY = 2, I_TIME = 3, I_COURSE = 6; // FACTORS の中の位置
const PICK_N = 3;
export const PACE_SPLIT_MIN = 10; // コースのペースごとの比率を作る最少のレース数(2026-10-18。以前は2)

function compileRace(race) {
  const runners = [...race.runners].sort((a, b) => (Number(a.horse_number) || 99) - (Number(b.horse_number) || 99));
  const n = runners.length;
  const F = FACTORS.length;
  const S = new Float64Array(n * F);
  const place = new Uint8Array(n);
  const A = new Uint8Array(n * NA);
  runners.forEach((h, i) => {
    for (let k = 0; k < F; k++) S[i * F + k] = Number(h.scores[k]) || 0;
    place[i] = h.place >= 1 && h.place <= 3 ? h.place : 0;
    for (let k = 0; k < NA; k++) A[i * NA + k] = h.adj && Number(h.adj[k]) > 0 ? 1 : 0;
  });
  const placed = [];
  for (let i = 0; i < n; i++) if (place[i]) placed.push(i);
  // adj: 掛ける評価点(ADJUST_KEYS の順。null なら掛けない)。段ごとに入れ替える
  return { n, S, A, place, placed, totals: new Float64Array(n), adj: null };
}

function fillTotals(r, w) {
  const { n, S, A, totals, adj } = r;
  const F = w.length;
  let wSum = 0;
  for (let k = 0; k < F; k++) wSum += w[k];
  for (let h = 0; h < n; h++) {
    let t = 0;
    for (let k = 0; k < F; k++) t += w[k] * S[h * F + k];
    if (adj) {
      const a = h * NA;
      t += w[I_TIME] * -((adj[0] || 0) * A[a] + (adj[1] || 0) * A[a + 1]) + w[I_JOCKEY] * (adj[2] || 0) * A[a + 2]
        + w[I_COURSE] * ((adj[3] || 0) * A[a + 3] + (adj[4] || 0) * A[a + 4])
        - wSum * (adj[I_LAYOFF] || 0) * A[a + I_LAYOFF]; // 間隔: 総合点(Σ比率×点 ÷ Σ比率)から直接引くので Σ比率 を掛ける
    }
    totals[h] = Math.round(t * 1000);
  }
  return totals;
}

// 並びの一致(1レース): 3着以内の馬と3着外の馬の組のうち、3着以内の馬の指数が上だった割合(同じなら半分)。組が無ければ null
function orderAgreement(r, w) {
  const { n, place } = r;
  const totals = fillTotals(r, w);
  let good = 0, pairs = 0;
  for (let a = 0; a < n; a++) {
    if (!place[a]) continue;
    for (let b = 0; b < n; b++) {
      if (place[b]) continue;
      pairs++;
      if (totals[a] > totals[b]) good++;
      else if (totals[a] === totals[b]) good += 0.5;
    }
  }
  return pairs ? good / pairs : null;
}

// 評価点を選ぶ(全体の軸の比率 axisArr で、並びの一致の平均が一番高い値。1つずつ動かす)。def: 既定値(配列)
// fixed: 動かさない項目の位置(重賞・コースの計算では全レース共通の項目)
// adjustMin(2026-10-28): 選ぶ値の下限(評価点の既定値の自動計算は5。0を選ばない)。既定値が下限より小さければ下限にしてから選ぶ
function searchAdjust(rs, axisArr, def0, fixed = [], adjustMin = 0) {
  const def = def0.map((v, i) => (fixed.includes(i) ? v : Math.max(v, adjustMin)));
  const values = ADJUST_VALUES.filter((v) => v >= adjustMin);
  const r2 = (x) => Math.round(x * 100) / 100;
  const evalAdj = (adj) => {
    let agree = 0, cnt = 0, win = 0, quin = 0, show = 0;
    for (const r of rs) {
      r.adj = adj;
      const g = orderAgreement(r, axisArr);
      if (g != null) { agree += g; cnt++; }
      const x = evaluateAxis(r, axisArr);
      win += x.win; quin += x.quin; show += x.show;
    }
    return { adj, agree: cnt ? agree / cnt : 0, win: r2(win), quin: r2(quin), show: r2(show) };
  };
  const dist = (a) => a.reduce((s, v, i) => s + Math.abs(v - def[i]), 0);
  const better = (a, b) => (a.agree !== b.agree ? a.agree > b.agree : dist(a.adj) < dist(b.adj));
  const base = evalAdj(def);
  let best = base;
  for (let round = 0; round < ADJUST_ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < def.length; i++) {
      if (fixed.includes(i)) continue;
      for (const v of values) {
        if (v === best.adj[i]) continue;
        const a = [...best.adj];
        a[i] = v;
        const c = evalAdj(a);
        if (better(c, best)) { best = c; moved = true; }
      }
    }
    if (!moved) break;
  }
  // はっきり良くならなければ既定値のまま
  if (best.agree - base.agree < ADJUST_MIN_GAIN) best = base;
  const out = (x) => ({ adj: x.adj, agree: Math.round(x.agree * 10000) / 10000, win: x.win, quin: x.quin, show: x.show });
  return { best: out(best), base: out(base) };
}

function evaluateAxis(r, w) {
  const { n, place } = r;
  const totals = fillTotals(r, w);
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
  return cnt ? { show: s3 / cnt, win: s1 / cnt, quin: s2 / cnt } : { show: 0, win: 0, quin: 0 };
}

function axisPick(r, w) {
  const totals = fillTotals(r, w);
  let best = 0;
  for (let h = 1; h < r.n; h++) if (totals[h] > totals[best]) best = h;
  return best;
}

function evaluatePartner(r, w, axisIdx) {
  const { n, place, placed } = r;
  const totals = fillTotals(r, w);
  const cov = [1, 1, 1];
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
      c = Math.max(0, Math.min(above + same, PICK_N) - above) / same;
    }
    cov[p] = seen[p] ? Math.max(cov[p], c) : c;
    seen[p] = true;
  }
  return { win: cov[0], quin: cov[0] * cov[1], show: cov[0] * cov[1] * cov[2] };
}

// 比率の全通り(step% 刻み・合計100%。10%刻みは8要素で19,448通り)。初めて要るときに作る
// minWeight(2026-10-28): 各要素の下限(%)。標準の比率は5%刻み・各5%以上(補正タイムの30%以上は search で絞る。3,432通り)
const COMBOS = new Map();
function allCombos(step = 10, minWeight = 0) {
  const key = `${step}|${minWeight}`;
  if (COMBOS.has(key)) return COMBOS.get(key);
  const F = FACTORS.length, out = [];
  const units = Math.round(100 / step), minU = Math.ceil(minWeight / step);
  (function rec(k, left, arr) {
    if (k === F - 1) { if (left >= minU) out.push([...arr, left * step]); return; }
    for (let v = minU; v <= left - minU * (F - 1 - k); v++) rec(k + 1, left - v, [...arr, v * step]);
  })(0, units, []);
  COMBOS.set(key, out);
  return out;
}

// 選ぶレースのすべてで、全馬が同じ点だった要素の位置(順番に効かないので比率を割り振らない。2026-10-18)
function flatFactors(races) {
  const F = FACTORS.length, flat = [];
  for (let k = 0; k < F; k++) {
    let same = true;
    for (const r of races) {
      for (let h = 1; h < r.n && same; h++) if (r.S[h * F + k] !== r.S[k]) same = false;
      if (!same) break;
    }
    if (same) flat.push(k);
  }
  return flat;
}

// 比率を総当たりで選ぶ(2026-10-18。以前は山登り〈下の climbSearch〉で、よりよい比率を見落としていた。
// docs/design/screens.md「比率の選び方の見直し」)。keys の順に多いもの、同じなら DEFAULT_WEIGHTS に近いもの。
// 差がつかない要素(flatFactors)は 0% に決めた比率だけを試す
// 補正タイムは TIME_MIN_WEIGHT(30%)以上の比率だけを試す(2026-10-25。差がつかないときは上の規則で 0%)
// step・minWeight(2026-10-28。標準の比率は 5・5): 刻みと各要素の下限。下限があるときは差がつかない要素も0%にしない
function search(races, { evaluate, keys, step = 10, minWeight = 0 }) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const toW = (arr) => Object.fromEntries(FACTORS.map((f, i) => [`w_${f}`, arr[i]]));
  const dist = (arr) => FACTORS.reduce((a, f, i) => a + Math.abs(arr[i] - DEFAULT_WEIGHTS[`w_${f}`]), 0);
  const evalArr = (arr) => {
    let win = 0, quin = 0, show = 0;
    races.forEach((r, i) => {
      const x = evaluate(r, arr, i);
      win += x.win; quin += x.quin; show += x.show;
    });
    return { win: r2(win), quin: r2(quin), show: r2(show) };
  };
  const better = (a, b) => {
    for (const k of keys) if (a[k] !== b[k]) return a[k] > b[k];
    return dist(a.arr) < dist(b.arr);
  };
  const flat = minWeight > 0 ? [] : flatFactors(races);
  let best = null;
  const timeFlat = flat.includes(I_TIME);
  for (const arr of allCombos(step, minWeight)) {
    if (flat.length && flat.some((k) => arr[k] !== 0)) continue;
    if (!timeFlat && arr[I_TIME] < TIME_MIN_WEIGHT) continue;
    const r = { arr, ...evalArr(arr) };
    if (!best || better(r, best)) best = r;
  }
  const eqArr = FACTORS.map((f) => DEFAULT_WEIGHTS[`w_${f}`]);
  return { best: { w: toW(best.arr), arr: best.arr, win: best.win, quin: best.quin, show: best.show }, equal: evalArr(eqArr), flat: flat.map((k) => FACTORS[k]) };
}

// 同点の決め方(2026-10-18): 軸は3着以内 → 1着、相手は4頭に1着馬だけを比べ、同じなら均等に近い比率。以前は2着以内・1〜3着馬ともまで比べていたが、
// 細かい物差しで同点を割るとその年に合わせすぎた(過去の重賞156レースの試算で、使わなかった年の4頭に1着馬 46.7% → 51.1%)
const AXIS_KEYS = ["show", "win"];
const PARTNER_KEYS = ["win"];

const sum3 = (x) => ({ win: x.win, quin: x.quin, show: x.show });
const usableRaces = (races) => (races || []).filter((r) => r && r.runners && r.runners.length && r.runners.some((h) => h.place >= 1 && h.place <= 3));

// ---- 1段ずつ進める形(2026-10-14。当初は Cloudflare の定時起動〈workers/pace-cron。2026-10-18 削除〉から1段ずつ呼ぶため。
// 今は choosePaceWeights が全段を続けて呼ぶ〈ブラウザの「今すぐ計算」と GitHub Actions の Node〉) ----
// 段: 全体の軸(既定の評価点)→ 評価点 → 全体の軸(選んだ評価点。前の段から出発)→ 全体の相手 → (レース数の足りるペースごとに)軸 → 相手。
// 1段 = 総当たり1回(2026-10-18〜。1レース・1通り約1マイクロ秒。重賞10レースで約0.2秒、コース2年で数秒。夜間は GitHub Actions の Node で計算する)。
// 評価点の段より後は選んだ評価点で採点する。
// state は JSON にして保存できる: { stage, stages: [{ kind, pace }], out: { "axis0|" / "axis|" / "partner|" / "axis|high" …: { arr, win, quin, show, equal },
//   adjust: { vals, win, quin, show, base } } }
// opts.baseAdjust: 評価点の既定値 { first_distance, … }(管理画面の設定。無ければ DEFAULT_ADJUST)
// opts.adjustAll: 全レース共通の項目(間隔)も選ぶか(「評価点の既定値」の自動計算だけ true。2026-10-15)
// opts.paceSplitMin(2026-10-18): ペースごとの比率を作るのは、そのペースのレースがこの数以上のときだけ。0 なら作らない
//   (重賞は0〈年数が少なく合わせすぎる。重賞のレースはコースのペースの比率と混ぜて使う〉、コースは PACE_SPLIT_MIN)
// opts.chooseAdjust: 評価点も選ぶか(false なら既定値のまま。試算での比較用)
// opts.step・minWeight・adjustMin(2026-10-28。標準の比率〈評価点の既定値の自動計算〉は 5・5・5): 比率の刻み・各要素の下限(%)・評価点の下限
export function startPaceSearch(races, { baseAdjust = null, adjustAll = false, paceSplitMin = 0, chooseAdjust = false, step = 10, minWeight = 0, adjustMin = 0 } = {}) {
  const usable = usableRaces(races);
  if (!usable.length) return { error: "採点できる過去のレースがありません" };
  const base = ADJUST_KEYS.map((k) => (baseAdjust && Number.isFinite(Number(baseAdjust[k])) ? Number(baseAdjust[k]) : DEFAULT_ADJUST[k]));
  const stages = [{ kind: "axis0", pace: null }];
  if (chooseAdjust) stages.push({ kind: "adjust", pace: null });
  stages.push({ kind: "axis", pace: null }, { kind: "partner", pace: null });
  for (const p of PACE_TYPES) {
    if (paceSplitMin > 0 && usable.filter((r) => r.pace_type === p).length >= paceSplitMin) stages.push({ kind: "axis", pace: p }, { kind: "partner", pace: p });
  }
  return { stage: 0, stages, out: {}, base, adjustAll: Boolean(adjustAll), step, minWeight, adjustMin };
}

// 1段進める。戻り値: { done: false, state } か { done: true, result }(result は choosePaceWeights と同じ形)
export function stepPaceSearch(races, state) {
  const usable = usableRaces(races);
  if (!usable.length) return { done: true, result: { error: "採点できる過去のレースがありません" } };
  const st = state.stages[state.stage];
  if (st) {
    const idx = st.pace ? usable.map((r, i) => (r.pace_type === st.pace ? i : -1)).filter((i) => i >= 0) : usable.map((_, i) => i);
    const rs = idx.map((i) => compileRace(usable[i]));
    const key = (kind, pace) => `${kind}|${pace || ""}`;
    // 掛ける評価点: 評価点の段より前は既定値、後は選んだ値(評価点を選ばないときは既定値のまま)
    const fill = (v) => ADJUST_KEYS.map((k, i) => (v && v[i] != null ? v[i] : state.base ? state.base[i] : DEFAULT_ADJUST[k]));
    const adj = st.kind === "axis0" ? fill(null) : fill(state.out.adjust ? state.out.adjust.vals : null);
    for (const x of rs) x.adj = adj;
    if (st.kind === "adjust") {
      const fixed = state.adjustAll ? [] : GLOBAL_ADJUST_KEYS.map((k) => ADJUST_KEYS.indexOf(k));
      const a = searchAdjust(rs, state.out[key("axis0", null)].arr, fill(null), fixed, state.adjustMin || 0);
      const stat = (x) => ({ ...sum3(x), agree: x.agree });
      const next = { ...state, stage: state.stage + 1, out: { ...state.out, adjust: { vals: a.best.adj, ...stat(a.best), base: stat(a.base) } } };
      return next.stage < state.stages.length ? { done: false, state: next } : { done: true, result: assembleResult(usable, next.out, next) };
    }
    let r;
    const grid = { step: state.step || 10, minWeight: state.minWeight || 0 };
    const sameAdjust = !state.out.adjust || state.out.adjust.vals.every((v, i) => v === fill(null)[i]);
    if (st.kind === "axis" && !st.pace && sameAdjust && state.out[key("axis0", null)]) {
      // 評価点が既定値のままなら、全体の軸は「既定の評価点の軸」と同じ(総当たりをもう一度しない)
      const a0 = state.out[key("axis0", null)];
      r = { best: { arr: a0.arr, win: a0.win, quin: a0.quin, show: a0.show }, equal: a0.equal, flat: a0.flat };
    } else if (st.kind === "axis0" || st.kind === "axis") {
      r = search(rs, { evaluate: evaluateAxis, keys: AXIS_KEYS, ...grid });
    } else {
      // 相手: 同じ範囲の軸の比率で各レースの軸を決めてから
      const axisArr = state.out[key("axis", st.pace)].arr;
      const axisIdx = rs.map((x) => axisPick(x, axisArr));
      r = search(rs, { evaluate: (x, w, i) => evaluatePartner(x, w, axisIdx[i]), keys: PARTNER_KEYS, ...grid });
    }
    const out = { ...state.out, [key(st.kind, st.pace)]: { arr: r.best.arr, ...sum3(r.best), equal: sum3(r.equal), races: idx.length, flat: r.flat || [] } };
    const next = { ...state, stage: state.stage + 1, out };
    if (next.stage < state.stages.length) return { done: false, state: next };
    state = next;
  }
  return { done: true, result: assembleResult(usable, state.out, state) };
}

function assembleResult(usable, out, state = {}) {
  const toW = (arr) => Object.fromEntries(FACTORS.map((f, i) => [`w_${f}`, arr[i]]));
  const ax = out["axis|"], pt = out["partner|"];
  const byPace = {}, partnerByPace = {}, byPaceDetail = {}, partnerByPaceDetail = {};
  for (const p of PACE_TYPES) {
    const a = out[`axis|${p}`], b = out[`partner|${p}`];
    if (!a || !b) continue;
    byPace[p] = toW(a.arr);
    partnerByPace[p] = toW(b.arr);
    byPaceDetail[p] = { races: a.races, best: sum3(a), equal: a.equal };
    partnerByPaceDetail[p] = { races: b.races, best: sum3(b), equal: b.equal };
  }
  const adj = out.adjust ? Object.fromEntries(ADJUST_KEYS.map((k, i) => [k, out.adjust.vals[i] ?? DEFAULT_ADJUST[k]])) : null;
  return {
    weights: toW(ax.arr),
    byPace,
    partnerWeights: toW(pt.arr),
    partnerByPace,
    adjust: adj,
    detail: {
      // 評価点(2026-10-14): 選んだ値と、全体の軸の比率(既定の評価点で選んだもの)での軸の成績(選んだ値 / 既定値)
      adjust: adj ? { ...adj, best: { ...sum3(out.adjust), agree: out.adjust.agree }, base: out.adjust.base } : null,
      method: "backtest",
      version: METHOD_VERSION,
      computed_at: new Date().toISOString(),
      races: usable.length,
      race_ids: usable.map((r) => r.race_id),
      step: state.step || 10, // 比率の刻み・各要素の下限(2026-10-28。標準は 5・5)
      min_weight: state.minWeight || 0,
      best: sum3(ax),
      flat: ax.flat || [], // 差がつかず 0% に決めた要素(2026-10-18)
      equal: ax.equal,
      by_pace: byPaceDetail,
      partner: { races: usable.length, best: sum3(pt), equal: pt.equal, by_pace: partnerByPaceDetail },
    },
  };
}

// 比率を選ぶ(全段を続けて)。戻り値: { weights, byPace, partnerWeights, partnerByPace, adjust, detail } か { error }。opts は startPaceSearch と同じ
export function choosePaceWeights(races, opts = {}) {
  let state = startPaceSearch(races, opts);
  if (state.error) return { error: state.error };
  for (let guard = 0; guard < 20; guard++) {
    const r = stepPaceSearch(races, state);
    if (r.done) return r.result;
    state = r.state;
  }
  return { error: "計算が終わりませんでした" };
}

// 採点を数レースずつ取りに行き(fetchChunk(offset) → { total, races, missing_score, ... })、比率を選ぶ。
// onProgress(done, total) で進み具合を知らせる。戻り値: { result, info }(info は最初の応答の付帯情報)
export async function collectAndChoose(fetchChunk, onProgress = () => {}, chooseOpts = {}) {
  const races = [];
  const seen = new Set();
  let offset = 0, total = null, info = null;
  for (let guard = 0; guard < 200; guard++) {
    const chunk = await fetchChunk(offset);
    if (!info) info = chunk;
    total = chunk.total;
    for (const r of chunk.races || []) {
      if (seen.has(r.race_id)) continue; // 同じレースは1回だけ(2026-10-18)
      seen.add(r.race_id);
      races.push(r);
    }
    // 次の開始位置はサーバーの next_offset(対象にした件数で進める。2026-10-18)。採点できないレースがあっても手前にずれない。
    // 古いサーバーの応答(next_offset 無し)は従来どおり返した件数で進める
    const next = Number.isInteger(chunk.next_offset) ? chunk.next_offset : offset + (chunk.races || []).length;
    if (next <= offset) break;
    offset = next;
    onProgress(Math.min(offset, total), total);
    if (offset >= total) break;
  }
  // 評価点の既定値は採点の応答から(2026-10-14)。全コースの採点(kind="all")のときだけ全レース共通の項目も選ぶ(2026-10-15)
  // ペースごとの比率はコースと全コース(標準の比率。2026-10-28)の計算だけ(2026-10-18)
  const all = info?.kind === "all";
  const result = choosePaceWeights(races, { baseAdjust: info?.adjust_default || null, adjustAll: all, paceSplitMin: info?.kind === "course" || all ? PACE_SPLIT_MIN : 0,
    // 評価点を選ぶのは「評価点の既定値」の自動計算(kind="all")だけ。重賞・コースは既定値のまま(2026-10-18。選ぶと使わなかった年で当たりが下がった)
    chooseAdjust: all,
    // 全コースの計算は標準の比率にもする(2026-10-28 ユーザー要望): 5%刻み・全要素5%以上、評価点も5以上(0にしない)
    ...(all ? { step: 5, minWeight: 5, adjustMin: 5 } : {}), ...chooseOpts });
  if (!result.error && info) result.detail.missing_score = info.missing_score;
  return { result, info };
}
