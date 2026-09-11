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
-- 2026-09-10時点: 未適用のマイグレーションは無い。過去のステップ
-- (legacy_v13_multiuser, course_type_distance, race_results_and_conditions,
--  jockey_aliases, tickets_refunded, users_last_login, users_password_reset_pending)は
--  いずれも本番DB(keiba-yosou-db)へ適用済みで、最終結果は schema.sql に統合済みのため
-- 本ファイルからは削除してある。内容が必要な場合は git 履歴、または
-- archive/migrations/latest1_until_course_type_distance.sql
-- (race_results_and_conditions は archive/documents/BACKLOG_HISTORY.md「クラスタL」)を参照。

PRAGMA foreign_keys=ON;

-- 各 @STEP ブロックの適用状況を記録するテーブル。
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- 今後スキーマ変更が必要になったら、この下に新しい "-- @STEP: 名前" ブロックを
-- 追記していく。DROP/RENAMEを伴う破壊的な変更は極力避け、ALTER TABLE ADD COLUMNや
-- CREATE TABLE/INDEX IF NOT EXISTSなど、再実行しても安全な変更を基本とすること。

-- @STEP: horse_aliases
-- 馬名エイリアス(表記ゆれ→正しい馬名)。jockey_aliases と同じ構図。
-- 詳細は docs/design/horse-aliases.md 参照。
CREATE TABLE IF NOT EXISTS horse_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_key TEXT NOT NULL UNIQUE,   -- 突き合わせキー: NFKC正規化 + 全空白除去
  alias_display TEXT NOT NULL,      -- 表記ゆれ側の元の見た目(管理画面での参考表示用)
  canonical_name TEXT NOT NULL,     -- 正しい馬名
  created_at TEXT DEFAULT (datetime('now'))
);

-- @STEP: race_results_horse_key
-- GET /api/races/:id/horse-history が race_results を毎回全件スキャンしていたことで
-- D1の日次行読み取り上限(500万行)を超過する障害が発生(2026-09-11)。
-- race_results.horse_name の突き合わせキー(horseAliasKeyOf(horse_name))を列として
-- 保持し、インデックスを張ることで「対象馬だけをSQL側で直接引く」ようにする。
-- 詳細は docs/design/horse-aliases.md 参照。
-- 列追加後、既存行への値の埋め込み(バックフィル)は admin画面「既存データの馬名を
-- 一括補正する」ボタン(normalizeExistingHorseNames)の実行で行う(NFKC正規化は
-- SQLiteでは出来ないため、アプリ側=JSで計算してUPDATEする必要がある)。
ALTER TABLE race_results ADD COLUMN horse_key TEXT;
CREATE INDEX IF NOT EXISTS idx_race_results_horse_key ON race_results(horse_key);
