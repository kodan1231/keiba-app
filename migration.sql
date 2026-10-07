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
-- 実行方法: wrangler d1 execute --remote / --local で、新しく追記したブロックの
-- SQLだけを --command または --file= で実行し、成功したら
-- schema_migrations に INSERT で記録する(手順はREADME参照)。
--
-- 2026-10-07時点: 未適用のマイグレーションは無い。過去のステップ
-- (legacy_v13_multiuser, course_type_distance, race_results_and_conditions,
--  jockey_aliases, tickets_refunded, users_last_login, users_password_reset_pending)は
--  いずれも本番DB(keiba-yosou-db)へ適用済みで、最終結果は schema.sql に統合済みのため
-- 本ファイルからは削除してある。内容が必要な場合は git 履歴、または
-- archive/migrations/latest1_until_course_type_distance.sql
-- (race_results_and_conditions は archive/documents/BACKLOG_HISTORY.md「クラスタL」)を参照。
-- 2026-10-03: 続く14ステップ(horse_aliases, race_stats_cache, race_results_horse_key,
--  races_cache, races_cache_chunked, prediction_notes_key_race, races_post_time,
--  users_api_token, tickets_structure, race_stats_cache_chunked, graded_races,
--  races_base_name, horses_master, graded_races_schedule_md)も本番適用済み
--  (schema_migrations に記録済み)で、内容が schema.sql に反映済みであることを確認して
--  削除した。内容が必要な場合は git 履歴(c51b812 時点の migration.sql)を参照。
-- 2026-10-04: external_fetch_pause(netkeiba取得の一時停止)も本番適用済み・schema.sql 反映済みのため削除した。
-- 2026-10-06: umabashira_paste(trainer_aliases・horses.coat_color/affiliation)も本番適用済み・schema.sql 反映済みのため削除した。
-- 2026-10-07: race_lineup_cache(集計用の小さいキャッシュ+トリガー6つ)も本番適用済み・schema.sql 反映済みのため削除した。

PRAGMA foreign_keys=ON;

-- 各 @STEP ブロックの適用状況を記録するテーブル。
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- 今後スキーマ変更が必要になったら、この下に新しい "-- @STEP: 名前" ブロックを
-- 追記していく。DROP/RENAMEを伴う破壊的な変更は極力避け、ALTER TABLE ADD COLUMNや
-- CREATE TABLE/INDEX IF NOT EXISTSなど、再実行しても安全な変更を基本とすること。

