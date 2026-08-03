#!/usr/bin/env node
/**
 * latest1.sql を「常に安全に実行できる」形で適用するラッパースクリプト。
 *
 * 仕組み:
 *   latest1.sql は "-- @STEP: 名前" というマーカーで区切られたブロックの集まり。
 *   各ブロックが適用済みかどうかは、DB内の schema_migrations テーブルに記録する。
 *   このスクリプトは、まだ記録されていないブロックだけを上から順に実行し、
 *   成功したブロックの名前を schema_migrations に記録する。
 *
 *   これにより「DBの状態にかかわらず、何度でも node scripts/migrate.js を
 *   実行してよい」という前提を、DB自身の記録だけで担保する。SQLの実行結果や
 *   エラーメッセージの文面から状態を推測する、といったことはしない。
 *
 * 初回移行(bootstrap):
 *   schema_migrations テーブルがまだ存在しないDB、つまり本スクリプト導入以前に
 *   latest1.sqlを手動やまるごとの再実行で更新してきた既存DBに対して初めて実行
 *   した場合に限り、実データを見て「どのブロックが適用済みか」を1回だけ推定する
 *   (BOOTSTRAP_CHECKS参照)。一度 schema_migrations に記録されたあとは、
 *   この推定ロジックは二度と使われない(常に schema_migrations の記録のみを見る)。
 *
 * 使い方:
 *   node scripts/migrate.js --local   … ローカルDBに適用
 *   node scripts/migrate.js --remote  … 本番(リモート)DBに適用
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DB_NAME = "keiba-yosou-db";
const STEP_MARKER_RE = /^-- @STEP:\s*(\S+)\s*$/;

const args = process.argv.slice(2);
const mode = args.includes("--remote") ? "--remote" : "--local";
if (!args.includes("--remote") && !args.includes("--local")) {
  console.log("(--remote も --local も指定が無いため --local として実行します)");
}

// --- wrangler d1 execute の薄いラッパー ---

function runSql(sql) {
  const tmpFile = path.join(
    os.tmpdir(),
    `keiba_migrate_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`
  );
  fs.writeFileSync(tmpFile, sql, "utf8");
  try {
    return execFileSync(
      "npx",
      ["wrangler", "d1", "execute", DB_NAME, mode, `--file=${tmpFile}`, "--json"],
      { encoding: "utf8", shell: process.platform === "win32" }
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// SELECT/PRAGMAの結果をJSONで取得する。
// wranglerは--remote実行時に進捗メッセージをJSONより前にstdoutへ出力することが
// あるため、最初の "[" 以降だけを取り出してからパースする。
function queryJson(sql) {
  const out = runSql(sql);
  const jsonStart = out.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`結果からJSONを検出できませんでした。出力:\n${out}`);
  }
  const parsed = JSON.parse(out.slice(jsonStart));
  return (parsed[0] && parsed[0].results) || [];
}

function columnExists(table, column) {
  try {
    const rows = queryJson(`PRAGMA table_info(${table});`);
    return rows.some((r) => r.name === column);
  } catch (err) {
    const output = String(err.stderr || err.stdout || err.message || err);
    if (/no such table/i.test(output)) return false;
    throw err;
  }
}

// --- latest1.sql を "-- @STEP: 名前" ブロックに分割する ---

function splitIntoSteps(fullSql) {
  const lines = fullSql.split("\n");
  const preambleLines = [];
  const steps = []; // { name, lines: [] }
  let current = null;

  for (const line of lines) {
    const m = line.match(STEP_MARKER_RE);
    if (m) {
      current = { name: m[1], lines: [] };
      steps.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  return {
    preambleSql: preambleLines.join("\n"),
    steps: steps.map((s) => ({ name: s.name, sql: s.lines.join("\n") })),
  };
}

// 本スクリプト導入以前(schema_migrationsが無い状態)からの既存DBに対して、
// 初回のみ「このブロックはもう実データに反映済みか」を判定するための対応表。
// 新しいSTEPを追記しても、この表への追加は不要(schema_migrationsが
// 既に存在する状態で追記していく分には、常に「未適用」として素直に実行される)。
const BOOTSTRAP_CHECKS = {
  legacy_v13_multiuser: () => columnExists("prediction_marks", "user_id"),
  course_type_distance: () => columnExists("races", "course_type"),
};

// --- 実行本体 ---

const sqlPath = path.join(__dirname, "..", "latest1.sql");
const fullSql = fs.readFileSync(sqlPath, "utf8");
const { preambleSql, steps } = splitIntoSteps(fullSql);

if (steps.length === 0) {
  console.error("latest1.sql 内に '-- @STEP: 名前' 形式のブロックが見つかりません。処理を中断します。");
  process.exit(1);
}

console.log(`latest1.sql を ${mode} に適用します`);
console.log("");
console.log("--- 前提セットアップ(schema_migrationsテーブル等)を実行 ---");
runSql(preambleSql);

let appliedNames = new Set(
  queryJson("SELECT name FROM schema_migrations;").map((r) => r.name)
);

if (appliedNames.size === 0) {
  console.log("");
  console.log("--- 初回移行判定(bootstrap): 既存データから適用済みブロックを推定 ---");
  let foundAny = false;
  for (const step of steps) {
    const check = BOOTSTRAP_CHECKS[step.name];
    if (check && check()) {
      foundAny = true;
      console.log(`  [推定] ${step.name} は適用済みとみなします(実行はスキップ)`);
      runSql(`INSERT OR IGNORE INTO schema_migrations (name) VALUES ('${step.name}');`);
      appliedNames.add(step.name);
    }
  }
  if (!foundAny) {
    console.log("  適用済みと判定できるブロックはありませんでした(新規DBとして扱います)。");
  }
}

console.log("");
console.log("--- 未適用のブロックを適用 ---");

let appliedCount = 0;
let skippedCount = 0;

for (const step of steps) {
  if (appliedNames.has(step.name)) {
    skippedCount++;
    console.log(`  [済み] ${step.name}`);
    continue;
  }
  console.log(`  [適用中] ${step.name} ...`);
  try {
    runSql(step.sql);
    runSql(`INSERT INTO schema_migrations (name) VALUES ('${step.name}');`);
    appliedCount++;
    console.log(`  [適用] ${step.name}`);
  } catch (err) {
    console.error("");
    console.error(`ブロック "${step.name}" の実行中にエラーが発生したため処理を中断しました。`);
    console.error("このブロックはschema_migrationsに記録されていないため、原因を解消した後");
    console.error("再度 migrate.js を実行すれば、このブロックからやり直されます。");
    console.error(String(err.stderr || err.stdout || err.message || err));
    process.exit(1);
  }
}

console.log("");
console.log(`完了: 新規適用 ${appliedCount}件 / スキップ(適用済み) ${skippedCount}件`);
