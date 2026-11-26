// バックアップ(scripts/backup.mjs の表ごとの JSON)を、D1 に流せる INSERT 文にする(2026-11-27。戻すとき用)。
// 使い方: node scripts/backup-restore-sql.mjs <復号したフォルダ>/tickets.json [--where "user_id=2"] > restore.sql
//   --where は JavaScript の式ではなく「列=値」1つだけ(例: user_id=2)。その行だけを出す
// 出すのは INSERT OR REPLACE(同じ主キーの行は置き換え)。流す前に中身と件数を必ず確かめ、
// 書き込み行数(1日の上限10万行)に注意して `npx wrangler d1 execute keiba-yosou-db --remote --file restore.sql` で流す。
// races を作り直す・消す使い方はしない(CLAUDE.md「絶対に破ってはいけない不変条件」)。
import { readFileSync } from "node:fs";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("使い方: node scripts/backup-restore-sql.mjs <表>.json [--where 列=値]");
  process.exit(1);
}
const { table, columns, rows } = JSON.parse(readFileSync(file, "utf8"));
let filter = null;
const wi = rest.indexOf("--where");
if (wi >= 0) {
  const m = String(rest[wi + 1] || "").match(/^(\w+)=(.*)$/);
  if (!m || !columns.includes(m[1])) throw new Error(`--where の列が見つかりません: ${rest[wi + 1]}`);
  const idx = columns.indexOf(m[1]);
  filter = (r) => String(r[idx]) === m[2];
}
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const picked = filter ? rows.filter(filter) : rows;
for (const r of picked) {
  console.log(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${r.map(lit).join(", ")});`);
}
console.error(`${table}: ${picked.length} 行`);
