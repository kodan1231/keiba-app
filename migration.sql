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
-- 過去に適用済みのステップ(legacy_v13_multiuser, course_type_distance)は
-- 本番DB(keiba-yosou-db)への適用・schema_migrationsへの記録が完了し、
-- その最終結果は schema.sql に統合済みのため、本ファイルからは削除してある。
-- 内容が必要な場合は archive/migrations/latest1_until_course_type_distance.sql
-- を参照(git履歴にも残っている)。
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

-- 今後スキーマ変更が必要になったら、この下に新しい "-- @STEP: 名前" ブロックを
-- 追記していく。DROP/RENAMEを伴う破壊的な変更は極力避け、ALTER TABLE ADD COLUMNや
-- CREATE TABLE/INDEX IF NOT EXISTSなど、再実行しても安全な変更を基本とすること。
--
-- 2026-08-12: race_results_and_conditions ステップ(races へのレース条件詳細カラム
-- 追加・race_results テーブル新設)は本番DB(keiba-yosou-db)への適用・
-- schema_migrationsへの記録が完了し、その最終結果は schema.sql に統合済みのため、
-- 本ファイルからは削除した(docs/BACKLOG.md「クラスタL」完了参照)。
