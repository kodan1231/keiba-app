// 馬券購入画面の買い目の生成(public/combos.js)。点数がずれると購入金額がずれる
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClassic } from "./helpers/load-classic.mjs";

const { generateCombinations, slotsForNagashiUnordered, slotsForNagashiOrdered, generateAxis1Multi, generateAxis2Multi } = loadClassic(
  ["public/combos.js"],
  ["generateCombinations", "slotsForNagashiUnordered", "slotsForNagashiOrdered", "generateAxis1Multi", "generateAxis2Multi"],
);

const keys = (list) => list.map((c) => c.join("-"));
const box = (horses, n) => Array.from({ length: n }, () => horses);

test("ボックス: 点数は組み合わせ・順列の数", () => {
  const h = [1, 2, 3, 4, 5];
  assert.equal(generateCombinations(box(h, 2), false).length, 10); // 馬連 5C2
  assert.equal(generateCombinations(box(h, 2), true).length, 20); // 馬単 5P2
  assert.equal(generateCombinations(box(h, 3), false).length, 10); // 3連複 5C3
  assert.equal(generateCombinations(box(h, 3), true).length, 60); // 3連単 5P3
});

test("順不同の組は小さい順に並べ、重複を除く", () => {
  assert.deepEqual(keys(generateCombinations([[3, 1], [1, 3]], false)), ["1-3"]);
});

test("同じ馬を2回使わない・空の列があれば0点", () => {
  assert.deepEqual(generateCombinations([[1], [1]], true), []);
  assert.deepEqual(generateCombinations([[1], []], true), []);
  assert.deepEqual(generateCombinations([], true), []);
});

test("フォーメーション(3連単 1着1,2 / 2着1,2,3 / 3着3,4)", () => {
  assert.deepEqual(keys(generateCombinations([[1, 2], [1, 2, 3], [3, 4]], true)), [
    "1-2-3", "1-2-4", "1-3-4", "2-1-3", "2-1-4", "2-3-4",
  ]);
});

test("流し(順不同): 3連複 軸1頭・相手4頭は 4C2 = 6点", () => {
  const combos = generateCombinations(slotsForNagashiUnordered(3, [1], [2, 3, 4, 5]), false);
  assert.equal(combos.length, 6);
  assert.ok(combos.every((c) => c.includes(1)));
});

test("流し(着順): 3連単 2着固定は軸が必ず2着", () => {
  const combos = generateCombinations(slotsForNagashiOrdered(3, 7, 1, [1, 2, 3]), true);
  assert.equal(combos.length, 6); // 3P2
  assert.ok(combos.every((c) => c[1] === 7));
});

test("マルチ: 3連単1頭軸 相手3頭は 3C2×6 = 18点、2頭軸 相手3頭は 3×6 = 18点", () => {
  assert.equal(generateAxis1Multi(1, [2, 3, 4]).length, 18);
  assert.equal(generateAxis2Multi([1, 2], [3, 4, 5]).length, 18);
  assert.deepEqual(generateAxis1Multi(1, [2]), []); // 相手が足りない
  assert.deepEqual(generateAxis2Multi([1], [3]), []); // 軸が2頭でない
});
