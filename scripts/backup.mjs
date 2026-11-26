// 週1回のバックアップ(2026-11-27。.github/workflows/backup.yml が動かす)。作り直せない表だけを D1 から読み、表ごとの JSON に書き出す。
// 暗号化と保存はワークフロー側(openssl で合言葉 BACKUP_PASSPHRASE を使って暗号化し、Actions の保存ファイルに90日)。
// リポジトリは公開なので、暗号化しないものは絶対に置かない(このスクリプトは手元のフォルダに書くだけ)。
//
// 読み取り行数: 対象の表の行数の合計だけ(2026-11-27 時点で約4.4万行 = 1日の上限 500万行の約0.9%)。rowid の順に区切って読む
// (OFFSET は飛ばした行も読み取りに数えられるので使わない)。
// 環境変数: CF_D1_TOKEN(D1 を読める Cloudflare の API トークン)、BACKUP_DIR(書き出し先。既定 backup-out)、
//           CF_ACCOUNT_ID・CF_D1_DATABASE_ID(省略時は本番の値)
// 戻すとき: docs/design/ops.md「バックアップ」(scripts/backup-restore-sql.mjs で INSERT 文にする)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createD1Rest } from "./lib/d1-rest.mjs";

// 作り直せない表(手入力・取り込みの控え・管理の設定)。レース・結果・各種キャッシュは取り込み直し・作り直しができるので入れない。
// 表を足したら docs/design/ops.md「バックアップ」も直す。値は1回に読む行数(app_settings は1行が大きいので少なく)
export const BACKUP_TABLES = {
  users: 2000,
  tickets: 2000,
  imported_tickets: 2000,
  imported_ticket_groups: 2000,
  imported_ticket_items: 2000,
  prediction_marks: 2000,
  prediction_notes: 2000,
  horse_notes: 2000,
  graded_race_notes: 2000,
  race_pick_records: 2000, // 結果登録の直前の推奨馬の印(後から作り直せない)
  jockey_aliases: 2000,
  horse_aliases: 2000,
  trainer_aliases: 2000,
  graded_races: 2000,
  horses: 2000, // 馬柱の取り込みで入れた血統・調教師(取り込み直しは手間がかかる)
  pace_weights: 2000,
  course_pace_weights: 2000,
  guest_ip_blocks: 2000,
  app_settings: 3,
};

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "c3dc56a1eaad703f636e2a990aaa7d1c";
const DATABASE_ID = process.env.CF_D1_DATABASE_ID || "82cd3353-2185-4c83-bcde-4cf8db2b905b";
const TOKEN = process.env.CF_D1_TOKEN || "";
const OUT = process.env.BACKUP_DIR || "backup-out";

async function main() {
  if (!TOKEN) throw new Error("CF_D1_TOKEN が要ります");
  const db = createD1Rest({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, token: TOKEN });
  mkdirSync(OUT, { recursive: true });
  const summary = {};
  for (const [table, pageSize] of Object.entries(BACKUP_TABLES)) {
    let columns = null;
    const rows = [];
    let last = -1;
    for (;;) {
      const { results } = await db
        .prepare(`SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(last, pageSize)
        .all();
      for (const r of results) {
        last = r.__rowid;
        delete r.__rowid;
        if (!columns) columns = Object.keys(r);
        rows.push(columns.map((c) => r[c]));
      }
      if (results.length < pageSize) break;
    }
    writeFileSync(join(OUT, `${table}.json`), JSON.stringify({ table, columns: columns || [], rows }));
    summary[table] = rows.length;
  }
  const stats = db.stats();
  writeFileSync(join(OUT, "_summary.json"), JSON.stringify({ at: new Date().toISOString(), tables: summary, rowsRead: stats.rowsRead }, null, 1));
  console.log(summary);
  console.log(`問い合わせ ${stats.queries} 回・読み取り ${stats.rowsRead} 行`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
