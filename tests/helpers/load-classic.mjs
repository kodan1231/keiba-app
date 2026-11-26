// 画面の普通のスクリプト(public/*.js。import/export を使わずグローバルに関数を置くもの)を、
// ブラウザと同じく1つの場所で順に読み込み、その中の関数を取り出す(テスト用。2026-11-27)。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../../", import.meta.url);

// files: ["public/bettypes.js", ...](読み込む順)、names: 取り出す関数・定数の名前
export function loadClassic(files, names) {
  const ctx = vm.createContext({ console });
  for (const f of files) vm.runInContext(readFileSync(new URL(f, ROOT), "utf8"), ctx, { filename: f });
  // const・function はグローバルのプロパティにならないことがあるので、名前を評価して取り出す
  // 別の場所の配列・オブジェクトはこちらの Array と別物で、assert の厳密な比較が通らないため、戻り値は写してから返す
  const wrap = (v) => (typeof v === "function" ? (...args) => structuredClone(v(...args)) : v);
  return Object.fromEntries(names.map((n) => [n, wrap(vm.runInContext(n, ctx))]));
}
