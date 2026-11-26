// 総合推奨馬の指数と印(public/recommend-marks.js)。規則は docs/design/screens.md「推奨馬の印(◎〇▲☆)」
import { test } from "node:test";
import assert from "node:assert/strict";
import { PACE_FACTOR_KEYS, paceIndexOf, indexedHorse, pickRecommended, STAR_TIME_MIN } from "../public/recommend-marks.js";

const factorsOf = (scores, extra = {}) =>
  Object.fromEntries(PACE_FACTOR_KEYS.map((k) => [k, { score: scores[k] ?? 50, ...(extra[k] || {}) }]));

test("指数 = Σ比率×点 ÷ 比率の合計(比率が無い要素は0)", () => {
  const f = factorsOf({ pace: 80, time: 40 });
  assert.equal(paceIndexOf(f, { w_pace: 3, w_time: 1 }), (3 * 80 + 1 * 40) / 4);
  // 比率が全部0なら0で割らない
  assert.equal(paceIndexOf(f, {}), 0);
});

test("indexedHorse: 評価点を軸・相手の両方に足し、補正タイムのデータ無しを返す", () => {
  const f = factorsOf({ pace: 60, time: 70 }, { time: { missing: true } });
  const h = indexedHorse(f, "5", { w_pace: 1 }, { w_time: 1 });
  assert.deepEqual(h, { axis: 65, partner: 75, pace: 60, time: 70, timeMissing: true });
});

const horse = (horse_number, axis, partner, time, pace, timeMissing = false) => ({ horse_number, axis, partner, time, pace, timeMissing });
const marksOf = (horses) => Object.fromEntries(pickRecommended(horses).map(({ mark, x }) => [mark, x.horse_number]));

test("印: ◎合計1位 → 〇残りの軸1位 → ▲残りの補正タイム+軸1位 → ☆残りの(タイム40以上)展開1位", () => {
  const horses = [
    horse(1, 70, 70, 50, 50), // 合計140 → ◎
    horse(2, 68, 50, 30, 50), // 軸68 → 〇
    horse(3, 55, 69, 40, 50), // 相手は高いが タイム+軸 = 95
    horse(4, 50, 50, 60, 50), // タイム+軸 = 110 → ▲
    horse(5, 40, 40, 30, 90), // 展開は最高だがタイム30(40未満)
    horse(6, 40, 40, 45, 70), // タイム40以上の展開1位 → ☆
  ];
  assert.deepEqual(marksOf(horses), { "◎": 1, "〇": 2, "▲": 4, "☆": 6 });
});

test("☆: 補正タイムのデータが無い馬も候補。候補がいなければ残りの展開1位", () => {
  const base = [horse(1, 90, 90, 90, 0), horse(2, 80, 0, 90, 0), horse(3, 0, 0, 99, 0)];
  assert.equal(marksOf([...base, horse(4, 0, 0, 0, 80, true), horse(5, 0, 0, 10, 99)])["☆"], 4);
  assert.equal(marksOf([...base, horse(4, 0, 0, 10, 80), horse(5, 0, 0, STAR_TIME_MIN - 1, 99)])["☆"], 5);
});

test("同点は決まった順(◎は軸の高い方、最後は馬番の小さい方)", () => {
  assert.equal(marksOf([horse(2, 50, 60, 0, 0), horse(1, 60, 50, 0, 0)])["◎"], 1);
  assert.equal(marksOf([horse(3, 50, 50, 0, 0), horse(1, 50, 50, 0, 0)])["◎"], 1);
});

test("頭数が4頭未満なら印も少ない", () => {
  assert.equal(pickRecommended([horse(1, 1, 1, 1, 1), horse(2, 1, 1, 1, 1)]).length, 2);
  assert.equal(pickRecommended([]).length, 0);
});
