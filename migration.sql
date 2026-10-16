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
-- 2026-10-07: races_index_cache(レース一覧用の軽いキャッシュ+トリガー3つ)も本番適用済み・schema.sql 反映済みのため削除した。
-- 2026-10-07: perf_indexes_ticket_views(組み合わせインデックス6つ・data_versions+トリガー18個・race_stats_cache の削除)も
--  本番適用済み・schema.sql 反映済みのため削除した(インデックス作成の書き込みは計約1.9万行だった)。
-- 2026-10-09: range_chunk_caches(キャッシュ3つの範囲ごとのトリガー・horse_names_cache)・cleanup_unused_tables(races_cache・
--  external_fetch_pause の削除)・service_guard(app_settings)も本番適用済み・schema.sql 反映済みのため削除した。
--  未適用のマイグレーションは無い。
-- 2026-10-12: graded_race_notes(重賞メモ)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-13: pace_weights(総合推奨馬の比率)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-13: race_time_cache(勝ちタイムの小さいキャッシュ+トリガー6つ)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-13: pace_weights_time(比率の表に補正タイムの列)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-14: pace_weights_by_pace(比率の表にペース予想ごとの比率の列)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-14: pace_weights_more_factors(比率の表に性齢・馬体重・同コースの列)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-14: guest_access(ゲスト閲覧の端末・IPブロックの表)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-14: pace_weights_partner(比率の表に相手指数の列)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-14: course_pace_weights(コースごとの比率・比率の計算待ちの表)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-14: pace_jobs(比率の計算の途中の状態)・pace_weights_adjust(評価点の列)を追加。同日本番適用済み
--  (schema_migrations に記録済み。2026-10-15 に確認)。未適用のマイグレーションは無い。
-- 2026-10-15: pace_weights_week(比率の表に週目の列)を追加。同日本番適用済み(schema_migrations に記録済み)。
-- 2026-10-16: guest_nickname(ゲストの端末の表にニックネームの列と UNIQUE インデックス)を追加。同日本番適用済み(schema_migrations に記録済み)。

PRAGMA foreign_keys=ON;

-- 各 @STEP ブロックの適用状況を記録するテーブル。
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- 今後スキーマ変更が必要になったら、この下に新しい "-- @STEP: 名前" ブロックを
-- 追記していく。DROP/RENAMEを伴う破壊的な変更は極力避け、ALTER TABLE ADD COLUMNや
-- CREATE TABLE/INDEX IF NOT EXISTSなど、再実行しても安全な変更を基本とすること。

-- @STEP: graded_race_notes
-- 重賞メモ(2026-10-12)。新しい空の表を作るだけなので、書き込みは数行。
CREATE TABLE IF NOT EXISTS graded_race_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  graded_race_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  memo TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, graded_race_id, year)
);
INSERT INTO schema_migrations (name) VALUES ('graded_race_notes');

-- @STEP: pace_weights
-- 総合推奨馬の重視度の比率(2026-10-13)。新しい空の表を作るだけなので、書き込みは数行。
CREATE TABLE IF NOT EXISTS pace_weights (
  graded_race_id INTEGER PRIMARY KEY,
  w_pace INTEGER NOT NULL,
  w_number INTEGER NOT NULL,
  w_jockey INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  detail TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO schema_migrations (name) VALUES ('pace_weights');

-- @STEP: race_time_cache
-- 勝ちタイムの小さいキャッシュ(2026-10-13)。空の表とトリガー6つを作るだけ(中身は最初に読まれたときに作る。
-- その1回で races 約4千行+race_results 約5万行を読む)。
CREATE TABLE IF NOT EXISTS race_time_cache (
  chunk_index INTEGER PRIMARY KEY,
  payload TEXT,
  updated_at TEXT
);
CREATE TRIGGER IF NOT EXISTS trg_race_time_cache_races_ins AFTER INSERT ON races
BEGIN
  DELETE FROM race_time_cache WHERE chunk_index = NEW.id / 200;
END;
CREATE TRIGGER IF NOT EXISTS trg_race_time_cache_races_upd AFTER UPDATE OF id, track, course_type, distance, track_condition, class_flags, race_name ON races
BEGIN
  DELETE FROM race_time_cache WHERE chunk_index IN (OLD.id / 200, NEW.id / 200);
END;
CREATE TRIGGER IF NOT EXISTS trg_race_time_cache_races_del AFTER DELETE ON races
BEGIN
  DELETE FROM race_time_cache WHERE chunk_index = OLD.id / 200;
END;
CREATE TRIGGER IF NOT EXISTS trg_race_time_cache_rr_ins AFTER INSERT ON race_results
BEGIN
  DELETE FROM race_time_cache WHERE chunk_index = NEW.race_id / 200;
END;
CREATE TRIGGER IF NOT EXISTS trg_race_time_cache_rr_del AFTER DELETE ON race_results
BEGIN
  DELETE FROM race_time_cache WHERE chunk_index = OLD.race_id / 200;
END;
CREATE TRIGGER IF NOT EXISTS trg_race_time_cache_rr_upd AFTER UPDATE OF race_id, status, finish_position, time_text ON race_results
BEGIN
  DELETE FROM race_time_cache WHERE chunk_index IN (OLD.race_id / 200, NEW.race_id / 200);
END;
INSERT INTO schema_migrations (name) VALUES ('race_time_cache');

-- @STEP: pace_weights_time
-- 総合推奨馬の4つ目の要素「補正タイム」の比率の列(2026-10-13)。列を足すだけ(既存の行は0になる。自動の比率は次に開かれたときに計算し直す)。
ALTER TABLE pace_weights ADD COLUMN w_time INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_migrations (name) VALUES ('pace_weights_time');

-- @STEP: pace_weights_by_pace
-- 総合推奨馬のペース予想ごとの比率の列(2026-10-14)。列を足すだけ(表は重賞の数程度の行。自動の比率は方式の版が上がったので
-- 次に開かれたときに計算し直す)。
ALTER TABLE pace_weights ADD COLUMN by_pace TEXT;
INSERT INTO schema_migrations (name) VALUES ('pace_weights_by_pace');

-- @STEP: pace_weights_more_factors
-- 総合推奨馬の要素「性齢」「馬体重」「同コース」の比率の列(2026-10-14)。列を足すだけ(既存の行は0。自動の比率は方式の版が
-- 上がったので次に開かれたときに計算し直す)。
ALTER TABLE pace_weights ADD COLUMN w_sexage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pace_weights ADD COLUMN w_weight INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pace_weights ADD COLUMN w_course INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_migrations (name) VALUES ('pace_weights_more_factors');

-- @STEP: guest_access
-- ゲスト閲覧(2026-10-14)。空の表を2つ作るだけ。docs/design/guest.md
CREATE TABLE IF NOT EXISTS guest_devices (
  device_id TEXT PRIMARY KEY,
  first_seen TEXT,
  last_seen TEXT,
  ip TEXT,
  user_agent TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS guest_ip_blocks (
  ip TEXT PRIMARY KEY,
  created_at TEXT,
  note TEXT
);
INSERT INTO schema_migrations (name) VALUES ('guest_access');

-- @STEP: pace_weights_partner
-- 総合推奨馬の相手指数の比率の列(2026-10-14)。列を足すだけ(自動の比率は方式の版が上がったので次に開かれたときに計算し直す)。
ALTER TABLE pace_weights ADD COLUMN partner TEXT;
INSERT INTO schema_migrations (name) VALUES ('pace_weights_partner');

-- @STEP: course_pace_weights
-- コースごとの総合推奨馬の比率と、比率の計算待ち(2026-10-14)。空の表を2つ作るだけ。
CREATE TABLE IF NOT EXISTS course_pace_weights (
  track TEXT NOT NULL,
  course_type TEXT NOT NULL,
  distance INTEGER NOT NULL,
  w_pace INTEGER NOT NULL DEFAULT 0,
  w_number INTEGER NOT NULL DEFAULT 0,
  w_jockey INTEGER NOT NULL DEFAULT 0,
  w_time INTEGER NOT NULL DEFAULT 0,
  w_sexage INTEGER NOT NULL DEFAULT 0,
  w_weight INTEGER NOT NULL DEFAULT 0,
  w_course INTEGER NOT NULL DEFAULT 0,
  by_pace TEXT,
  partner TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  detail TEXT,
  updated_at TEXT,
  PRIMARY KEY (track, course_type, distance)
);
CREATE TABLE IF NOT EXISTS pace_recompute_queue (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  race_id INTEGER,
  created_at TEXT,
  PRIMARY KEY (kind, key)
);
INSERT INTO schema_migrations (name) VALUES ('course_pace_weights');

-- @STEP: pace_jobs
-- 比率の計算の作業(定時起動が1歩ずつ進める途中の状態。2026-10-14)。空の表を作るだけ。
CREATE TABLE IF NOT EXISTS pace_jobs (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  phase TEXT NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  races TEXT,
  state TEXT,
  missing_score REAL,
  updated_at TEXT,
  PRIMARY KEY (kind, key)
);
INSERT INTO schema_migrations (name) VALUES ('pace_jobs');

-- @STEP: pace_weights_adjust
-- 評価点(初距離・初競馬場の減点、継続騎乗の加点。2026-10-14)を重賞・コースの比率の行に持つ列。JSON { first_distance, first_track, same_jockey, source }。
-- 列を足すだけ(既存の行は NULL = 評価点なし → 設定の既定値を使う)。
ALTER TABLE pace_weights ADD COLUMN adjust TEXT;
ALTER TABLE course_pace_weights ADD COLUMN adjust TEXT;
INSERT INTO schema_migrations (name) VALUES ('pace_weights_adjust');

-- @STEP: pace_weights_week
-- 総合推奨馬の8つ目の要素「週目」の比率の列(2026-10-15)。列を足すだけ(既存の行は0 = 次に計算し直すまで週目は使わない)。
-- **コードの反映より前に適用すること**(2026-10-15 に本番適用済み)(比率の読み取りが w_week を SELECT するため、列が無いと総合推奨馬が出なくなる)。
ALTER TABLE pace_weights ADD COLUMN w_week INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_pace_weights ADD COLUMN w_week INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_migrations (name) VALUES ('pace_weights_week');

-- @STEP: guest_nickname
-- ゲストのニックネーム(2026-10-16)。端末の表に名前と重複を比べるキーの列、キーの UNIQUE インデックス(NULL は重複してよい)。
-- **コードの反映より前に適用すること**(2026-10-16 に本番適用済み)(登録の API が nickname 列に書くため、列が無いとゲストが登録できず見られなくなる)。
-- guest_devices は端末の数だけの小さな表(2026-10-16 時点で26行)なので、インデックスの作成は軽い。
ALTER TABLE guest_devices ADD COLUMN nickname TEXT;
ALTER TABLE guest_devices ADD COLUMN nickname_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_devices_nickname_key ON guest_devices(nickname_key);
INSERT INTO schema_migrations (name) VALUES ('guest_nickname');
