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

-- @STEP: race_results_and_conditions
--
-- 2026-08-11(2)追加。docs/DESIGN.md「レース結果の詳細記録(race_results)」
-- 「レース条件の詳細カラム」「races.entriesへの性齢・負担重量の追加」参照。
--
-- 【重要】このステップは、対応する取込処理(jra-entries-pdf.js / jra-result-pdf.js /
-- entries-import.js / results-import.js の変更)の実装が完了してから適用すること。
-- スキーマだけ先行適用すると、race_results が空のまま・races の新規カラムが常にNULLの
-- まま残るだけになる(docs/BACKLOG.md「クラスタL」参照)。
--
-- races.entries (JSON列) 内の各要素へ sex_age(性齢)・weight_carried(負担重量) を
-- 追加する。entries 自体はスキーマレスなJSON列のため、このステップにDDLは不要
-- (アプリケーション側の読み書きロジック変更のみで対応する)。

-- races: レース条件詳細カラムを追加(すべて任意入力・既存行はNULLのまま)。
ALTER TABLE races ADD COLUMN weight_type TEXT;      -- 斤量区分: 馬齢/定量/別定/ハンデ
ALTER TABLE races ADD COLUMN class_flags TEXT;      -- 条件フラグ等の生テキスト(指定/特指/混合/牝馬限定等)
ALTER TABLE races ADD COLUMN course_direction TEXT; -- コースの回り: 左/右(該当なしはNULL)
ALTER TABLE races ADD COLUMN weather TEXT;          -- 天候(結果PDFのみに出現)
ALTER TABLE races ADD COLUMN track_condition TEXT;  -- 馬場状態(結果PDFのみに出現。天候とは別カラム)

-- race_results: 馬単位の確定結果を1頭1行で記録する新テーブル。
-- 全ユーザー共有(races と同様、user_idを持たない)。races.finish_order/payouts
-- (払戻判定用・上位3着のみ)とは独立した「記録・将来の集計参照用」の追加データ。
CREATE TABLE IF NOT EXISTS race_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  horse_number INTEGER,
  waku_number INTEGER,         -- 常にnull想定。PDFからは取得できないため手動入力用の列としてのみ保持
  horse_name TEXT,
  sex_age TEXT,                 -- 性齢 例:"牡3"
  weight_carried REAL,          -- 負担重量 例:57.0
  jockey TEXT,                  -- 見習い減量記号を含む表記のまま保持
  status TEXT NOT NULL DEFAULT 'finished', -- finished/scratched(取消)/excluded(除外)
  finish_position INTEGER,      -- 着順(全馬)。取消・除外はNULL
  time_text TEXT,               -- タイム 例:"1:25.0"(生テキストのまま)
  margin TEXT,                  -- 着差 例:"クビ" "１ 1/4" "大差"(表記ゆれが大きいためTEXT)
  corner_positions TEXT,        -- 個別コーナー通過順位(生テキストのまま)
  final_furlong_time REAL,      -- 推定上り 例:37.2
  body_weight INTEGER,          -- 馬体重
  body_weight_change TEXT,      -- 増減 例:"+2" "-2" "初出走" "計不"(数値以外もあるためTEXT)
  win_popularity INTEGER,       -- 単勝人気
  incident_note TEXT,           -- 競走中の出来事(該当時に自動転記)。管理者が編集可
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number)
);

CREATE INDEX IF NOT EXISTS idx_race_results_race_id ON race_results(race_id);
CREATE INDEX IF NOT EXISTS idx_race_results_horse_name ON race_results(horse_name);
