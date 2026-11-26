// 全部の JS の構文チェック(node --check)。push のたびに .github/workflows/ci.yml が動かす。手元でも `node scripts/check-syntax.mjs`(2026-11-27)
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const DIRS = ["functions", "public", "scripts", "tests"];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(name)) files.push(p);
  }
};
DIRS.forEach(walk);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    failed++;
    console.error(`✖ ${f}\n${String(e.stderr || e.message).trim()}\n`);
  }
}
console.log(`構文チェック: ${files.length} ファイル中 ${failed} 件の誤り`);
process.exit(failed ? 1 : 0);
