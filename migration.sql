-- migration.sql
-- 現行DBを最新版へ更新するための統合マイグレーション。
-- (旧ファイル名 latest1.sql。FIX ver1.0整理にあわせて改名した。
--  内容自体は同じ運用ルールを引き継いでいる)
--
-- 方針:
--   * 本ファイルは、既存DBを最新版へ更新する用途。新規DBは schema.sql を使用する。
--   * 内容を "-- @STEP: 名前" で区切ったブロックに分割してある。各ブロックが
--     適用済みかどうかは、このDBの中の schema_migrations テーブルに記録する
--     (名前をキーに1行1件)。一度記録されたブロックは、この仕組みの上では
--     二度と再実行しない。
--   * 新しいマイグレーションを追加する場合は、このファイルの末尾に
--     新しい "-- @STEP: 名前" ブロックを追記するだけでよい。名前は一度使ったら
--     固定すること(schema_migrations内のキーになるため)。
--
-- 過去に適用済みのステップ(legacy_v13_multiuser, course_type_distance,
-- race_results_and_conditions)は本番DB(keiba-yosou-db)への適用・
-- schema_migrationsへの記録が完了し、その最終結果は schema.sql に統合済みのため、
-- 本ファイルからは削除してある。内容が必要な場合は
-- archive/migrations/latest1_until_course_type_distance.sql を参照
-- (race_results_and_conditionsについてはarchive/documents/BACKLOG_HISTORY.md
-- 「クラスタL」参照。git履歴にも残っている)。
--
-- 実行方法: wrangler d1 execute --remote / --local で、新しく追記したブロックの
-- SQLだけを --command または --file= で実行し、成功したら
-- schema_migrations に INSERT で記録する(手順はREADME参照)。

PRAGMA foreign_keys=ON;

-- 各 @STEP ブロックの適用状況を記録するテーブル。
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- @STEP: jockey_aliases
-- 2026-08-16: 騎手別収支で同一騎手が表記ゆれ(異体字・空白有無・文字欠落等)により
-- 複数行に分裂してしまう問題への対応。表記ゆれ→正しい表記の対応表を持つ
-- jockey_aliases テーブルを追加する(CREATE TABLE IF NOT EXISTSのみの非破壊的変更)。
-- 詳細はdocs/DESIGN.md「騎手名エイリアス管理(jockey_aliases)」参照。
CREATE TABLE IF NOT EXISTS jockey_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_key TEXT NOT NULL UNIQUE,
  alias_display TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- @STEP: tickets_refunded
-- 2026-08-20: 返還(refund)処理対応。取消・除外馬が絡む買い目の払戻を「不的中(0円)」では
-- なく「返還(購入金額と同額)」として区別できるよう、tickets に refunded 列を追加する
-- (ALTER TABLE ADD COLUMNのみの非破壊的変更)。詳細はdocs/DESIGN.md「返還(refund)処理」参照。
ALTER TABLE tickets ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0;

-- @STEP: users_last_login
-- 2026-08-30: 管理画面の登録ユーザー一覧に「最終ログイン日時」を表示するため、
-- users に last_login_at 列を追加する(ALTER TABLE ADD COLUMNのみの非破壊的変更)。
-- ログイン成功時(functions/api/auth/login.js)に更新し、新規登録時
-- (functions/api/auth/register.js)は登録日時を初期値として設定する。
-- 詳細はdocs/DESIGN.md「認証・複数ユーザー対応」参照。
ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- 今後スキーマ変更が必要になったら、この下に新しい "-- @STEP: 名前" ブロックを
-- 追記していく。DROP/RENAMEを伴う破壊的な変更は極力避け、ALTER TABLE ADD COLUMNや
-- CREATE TABLE/INDEX IF NOT EXISTSなど、再実行しても安全な変更を基本とすること。
--
-- 2026-08-12: race_results_and_conditions ステップ(races へのレース条件詳細カラム
-- 追加・race_results テーブル新設)は本番DB(keiba-yosou-db)への適用・
-- schema_migrationsへの記録が完了し、その最終結果は schema.sql に統合済みのため、
-- 本ファイルからは削除した(docs/BACKLOG.md「クラスタL」完了参照)。