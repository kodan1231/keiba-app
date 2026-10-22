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

-- @STEP: prediction_notes_key_index
-- 勝負レースの一覧(馬券購入画面を開くたび)用のインデックス(2026-10-16)。以前は prediction_notes を全件読んでいた。
-- 作成で prediction_notes の全行を1回読む(予想を付けたレースの数×利用者。数千行程度)。コードの反映の前後どちらでもよい。
CREATE INDEX IF NOT EXISTS idx_prediction_notes_user_key ON prediction_notes(user_id) WHERE is_key_race = 1;
INSERT INTO schema_migrations (name) VALUES ('prediction_notes_key_index');

-- @STEP: user_data_versions
-- 購入履歴の「変更なし(304)」の版数を利用者ごとにする(2026-10-16。_lib/ticket-view-version.js)。
-- **コードの反映の後に適用すること**(前に適用すると、古いコードは全員共通の版数しか見ず、購入しても購入履歴が更新されなくなる)。
-- 全員共通の版数を上げていたトリガーのうち重賞一覧以外を消し、利用者ごとのトリガーに置き換える。
-- imported_ticket_groups(race_id) のインデックスを作る(レースのトリガーが使う。作成でその表の全行〈数千行〉を1回読む)。
-- 適用直後は全員の ETag の形が変わるので、各利用者が次に開いたときに1回だけ全件を読み直す。
DROP TRIGGER IF EXISTS trg_ticket_views_tickets_ins;
DROP TRIGGER IF EXISTS trg_ticket_views_tickets_upd;
DROP TRIGGER IF EXISTS trg_ticket_views_tickets_del;
DROP TRIGGER IF EXISTS trg_ticket_views_igroups_ins;
DROP TRIGGER IF EXISTS trg_ticket_views_igroups_upd;
DROP TRIGGER IF EXISTS trg_ticket_views_igroups_del;
DROP TRIGGER IF EXISTS trg_ticket_views_iitems_ins;
DROP TRIGGER IF EXISTS trg_ticket_views_iitems_upd;
DROP TRIGGER IF EXISTS trg_ticket_views_iitems_del;
DROP TRIGGER IF EXISTS trg_ticket_views_itickets_ins;
DROP TRIGGER IF EXISTS trg_ticket_views_itickets_upd;
DROP TRIGGER IF EXISTS trg_ticket_views_itickets_del;
DROP TRIGGER IF EXISTS trg_ticket_views_races_ins;
DROP TRIGGER IF EXISTS trg_ticket_views_races_upd;
DROP TRIGGER IF EXISTS trg_ticket_views_races_del;
CREATE TABLE IF NOT EXISTS user_data_versions (
  user_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imported_groups_race ON imported_ticket_groups(race_id);
CREATE TRIGGER IF NOT EXISTS trg_uv_tickets_ins AFTER INSERT ON tickets BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT NEW.user_id, 1 WHERE NEW.user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_tickets_upd AFTER UPDATE ON tickets BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT u, 1 FROM (SELECT NEW.user_id AS u UNION SELECT OLD.user_id) WHERE u IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_tickets_del AFTER DELETE ON tickets BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT OLD.user_id, 1 WHERE OLD.user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_igroups_ins AFTER INSERT ON imported_ticket_groups BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT NEW.user_id, 1 WHERE NEW.user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_igroups_upd AFTER UPDATE ON imported_ticket_groups BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT u, 1 FROM (SELECT NEW.user_id AS u UNION SELECT OLD.user_id) WHERE u IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_igroups_del AFTER DELETE ON imported_ticket_groups BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT OLD.user_id, 1 WHERE OLD.user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_iitems_ins AFTER INSERT ON imported_ticket_items BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT user_id, 1 FROM imported_ticket_groups WHERE id = NEW.group_id AND user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_iitems_upd AFTER UPDATE ON imported_ticket_items BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT DISTINCT user_id, 1 FROM imported_ticket_groups WHERE id IN (NEW.group_id, OLD.group_id) AND user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_iitems_del AFTER DELETE ON imported_ticket_items BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT user_id, 1 FROM imported_ticket_groups WHERE id = OLD.group_id AND user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_itickets_ins AFTER INSERT ON imported_tickets BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT NEW.user_id, 1 WHERE NEW.user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_itickets_upd AFTER UPDATE ON imported_tickets BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT u, 1 FROM (SELECT NEW.user_id AS u UNION SELECT OLD.user_id) WHERE u IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_itickets_del AFTER DELETE ON imported_tickets BEGIN
  INSERT INTO user_data_versions (user_id, version) SELECT OLD.user_id, 1 WHERE OLD.user_id IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_races_upd AFTER UPDATE OF finish_order, payouts, course_type, distance, race_name, class_flags, race_base_name ON races
WHEN OLD.finish_order IS NOT NEW.finish_order OR OLD.payouts IS NOT NEW.payouts OR OLD.course_type IS NOT NEW.course_type
  OR OLD.distance IS NOT NEW.distance OR OLD.race_name IS NOT NEW.race_name OR OLD.class_flags IS NOT NEW.class_flags
  OR OLD.race_base_name IS NOT NEW.race_base_name
BEGIN
  INSERT INTO user_data_versions (user_id, version)
    SELECT u, 1 FROM (SELECT user_id AS u FROM tickets WHERE race_id = NEW.id UNION SELECT user_id FROM imported_ticket_groups WHERE race_id = NEW.id)
     WHERE u IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_uv_races_del AFTER DELETE ON races BEGIN
  INSERT INTO user_data_versions (user_id, version)
    SELECT u, 1 FROM (SELECT user_id AS u FROM tickets WHERE race_id = OLD.id UNION SELECT user_id FROM imported_ticket_groups WHERE race_id = OLD.id)
     WHERE u IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1;
END;
INSERT INTO schema_migrations (name) VALUES ('user_data_versions');

-- @STEP: cache_dirty
-- 範囲ごとのキャッシュ4つを「変わったレースだけ差し替える」方式にする(2026-10-16。_lib/range-chunk-cache.js)。
-- **コードの反映の後に適用すること**(前に適用すると、古いコードは控えを見ないため、キャッシュが更新されなくなる)。
-- 範囲の行を消していたトリガー21個を消し、控え(cache_dirty)に書くトリガー6つに置き換える。表を作るだけでデータは読まない。
DROP TRIGGER IF EXISTS trg_races_index_cache_ins;
DROP TRIGGER IF EXISTS trg_races_index_cache_upd;
DROP TRIGGER IF EXISTS trg_races_index_cache_del;
DROP TRIGGER IF EXISTS trg_race_lineup_cache_races_ins;
DROP TRIGGER IF EXISTS trg_race_lineup_cache_races_upd;
DROP TRIGGER IF EXISTS trg_race_lineup_cache_races_del;
DROP TRIGGER IF EXISTS trg_race_lineup_cache_rr_ins;
DROP TRIGGER IF EXISTS trg_race_lineup_cache_rr_del;
DROP TRIGGER IF EXISTS trg_race_lineup_cache_rr_upd;
DROP TRIGGER IF EXISTS trg_race_time_cache_races_ins;
DROP TRIGGER IF EXISTS trg_race_time_cache_races_upd;
DROP TRIGGER IF EXISTS trg_race_time_cache_races_del;
DROP TRIGGER IF EXISTS trg_race_time_cache_rr_ins;
DROP TRIGGER IF EXISTS trg_race_time_cache_rr_del;
DROP TRIGGER IF EXISTS trg_race_time_cache_rr_upd;
DROP TRIGGER IF EXISTS trg_horse_names_cache_races_ins;
DROP TRIGGER IF EXISTS trg_horse_names_cache_races_upd;
DROP TRIGGER IF EXISTS trg_horse_names_cache_races_del;
DROP TRIGGER IF EXISTS trg_horse_names_cache_rr_ins;
DROP TRIGGER IF EXISTS trg_horse_names_cache_rr_del;
DROP TRIGGER IF EXISTS trg_horse_names_cache_rr_upd;
CREATE TABLE IF NOT EXISTS cache_dirty (
  tbl TEXT NOT NULL,
  race_id INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tbl, race_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS trg_cache_dirty_races_ins AFTER INSERT ON races
BEGIN
  INSERT INTO cache_dirty (tbl, race_id)
    VALUES ('races_index_cache', NEW.id), ('race_lineup_cache', NEW.id), ('race_time_cache', NEW.id), ('horse_names_cache', NEW.id)
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_cache_dirty_races_del AFTER DELETE ON races
BEGIN
  INSERT INTO cache_dirty (tbl, race_id)
    VALUES ('races_index_cache', OLD.id), ('race_lineup_cache', OLD.id), ('race_time_cache', OLD.id), ('horse_names_cache', OLD.id)
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_cache_dirty_races_upd AFTER UPDATE ON races
BEGIN
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'races_index_cache', NEW.id
     WHERE OLD.race_date IS NOT NEW.race_date OR OLD.track IS NOT NEW.track OR OLD.race_number IS NOT NEW.race_number
        OR OLD.race_name IS NOT NEW.race_name OR OLD.race_base_name IS NOT NEW.race_base_name
        OR OLD.course_type IS NOT NEW.course_type OR OLD.distance IS NOT NEW.distance OR OLD.class_flags IS NOT NEW.class_flags
        OR OLD.weight_type IS NOT NEW.weight_type OR OLD.weather IS NOT NEW.weather OR OLD.track_condition IS NOT NEW.track_condition
        OR OLD.post_time IS NOT NEW.post_time OR OLD.finish_order IS NOT NEW.finish_order OR OLD.payouts IS NOT NEW.payouts
        OR OLD.entries IS NOT NEW.entries
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'race_lineup_cache', NEW.id
     WHERE OLD.race_date IS NOT NEW.race_date OR OLD.track IS NOT NEW.track OR OLD.course_type IS NOT NEW.course_type
        OR OLD.distance IS NOT NEW.distance OR OLD.finish_order IS NOT NEW.finish_order OR OLD.track_condition IS NOT NEW.track_condition
        OR OLD.class_flags IS NOT NEW.class_flags OR OLD.race_name IS NOT NEW.race_name OR OLD.payouts IS NOT NEW.payouts
        OR OLD.entries IS NOT NEW.entries
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'race_time_cache', NEW.id
     WHERE OLD.track IS NOT NEW.track OR OLD.course_type IS NOT NEW.course_type OR OLD.distance IS NOT NEW.distance
        OR OLD.track_condition IS NOT NEW.track_condition OR OLD.class_flags IS NOT NEW.class_flags OR OLD.race_name IS NOT NEW.race_name
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'horse_names_cache', NEW.id WHERE OLD.entries IS NOT NEW.entries
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_cache_dirty_rr_ins AFTER INSERT ON race_results
BEGIN
  INSERT INTO cache_dirty (tbl, race_id)
    VALUES ('race_lineup_cache', NEW.race_id), ('race_time_cache', NEW.race_id), ('horse_names_cache', NEW.race_id)
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_cache_dirty_rr_del AFTER DELETE ON race_results
BEGIN
  INSERT INTO cache_dirty (tbl, race_id)
    VALUES ('race_lineup_cache', OLD.race_id), ('race_time_cache', OLD.race_id), ('horse_names_cache', OLD.race_id)
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_cache_dirty_rr_upd AFTER UPDATE ON race_results
BEGIN
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'race_lineup_cache', r FROM (SELECT NEW.race_id AS r UNION SELECT OLD.race_id)
     WHERE OLD.race_id IS NOT NEW.race_id OR OLD.horse_number IS NOT NEW.horse_number OR OLD.jockey IS NOT NEW.jockey
        OR OLD.status IS NOT NEW.status OR OLD.finish_position IS NOT NEW.finish_position OR OLD.time_text IS NOT NEW.time_text
        OR OLD.sex_age IS NOT NEW.sex_age OR OLD.body_weight IS NOT NEW.body_weight OR OLD.corner_positions IS NOT NEW.corner_positions
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'race_time_cache', r FROM (SELECT NEW.race_id AS r UNION SELECT OLD.race_id)
     WHERE OLD.race_id IS NOT NEW.race_id OR OLD.status IS NOT NEW.status OR OLD.finish_position IS NOT NEW.finish_position
        OR OLD.time_text IS NOT NEW.time_text
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
  INSERT INTO cache_dirty (tbl, race_id)
    SELECT 'horse_names_cache', r FROM (SELECT NEW.race_id AS r UNION SELECT OLD.race_id)
     WHERE OLD.race_id IS NOT NEW.race_id OR OLD.horse_name IS NOT NEW.horse_name
    ON CONFLICT(tbl, race_id) DO UPDATE SET claimed = 0 WHERE claimed = 1;
END;
INSERT INTO schema_migrations (name) VALUES ('cache_dirty');

-- @STEP: drop_redundant_indexes
-- 一意制約・他のインデックスと重複する、または使う問い合わせが無いインデックスを消す(2026-10-16)。D1 はインデックス1つにつき
-- 書き込みが1行増える(race_results は1頭の結果を書くたびに5行 → 3行)。
-- 本番の D1 は手元と違う計画を選ぶことがあるため、**空いている日に適用し、翌日に管理画面「D1の使用量」の重い問い合わせで、
-- 購入履歴・過去成績・予想印の読み取り行数が増えていないことを確かめる**。増えていたらそのインデックスだけ作り直す
-- (作り直しの文は schema.sql の git 履歴にある)。
DROP INDEX IF EXISTS idx_race_results_race_id;
DROP INDEX IF EXISTS idx_race_results_horse_name;
DROP INDEX IF EXISTS idx_tickets_group;
DROP INDEX IF EXISTS idx_tickets_race_date;
DROP INDEX IF EXISTS idx_tickets_track;
DROP INDEX IF EXISTS idx_tickets_user_id;
DROP INDEX IF EXISTS idx_prediction_notes_race_id;
DROP INDEX IF EXISTS idx_prediction_marks_race_id;
DROP INDEX IF EXISTS idx_horse_notes_horse_name;
DROP INDEX IF EXISTS idx_imported_groups_user_id;
DROP INDEX IF EXISTS idx_horses_horse_name;
INSERT INTO schema_migrations (name) VALUES ('drop_redundant_indexes');

-- @STEP: table_snapshots
-- 設定表(騎手名エイリアス・重賞一覧)の全件の写し(2026-10-18。_lib/table-snapshot.js)。画面表示の読み取りAPIは、使い回しが切れたときに
-- 表の全件(騎手エイリアス約360行・重賞一覧約140行)ではなく写しの1〜2行を読む。表が変わるとトリガーが data_versions の版数を上げ、
-- 古い写しは使われなくなる(次に読んだ人が作り直す)。表を作るだけでデータは読まない(版数の行を2つ書く)。
CREATE TABLE IF NOT EXISTS table_snapshots (
  name TEXT NOT NULL,
  part INTEGER NOT NULL,
  total INTEGER NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (name, part)
) WITHOUT ROWID;
INSERT OR IGNORE INTO data_versions (name, version) VALUES ('snap:jockey_aliases', 1), ('snap:graded_races', 1);
CREATE TRIGGER IF NOT EXISTS trg_snap_jockey_aliases_ins AFTER INSERT ON jockey_aliases BEGIN UPDATE data_versions SET version = version + 1 WHERE name = 'snap:jockey_aliases'; END;
CREATE TRIGGER IF NOT EXISTS trg_snap_jockey_aliases_upd AFTER UPDATE ON jockey_aliases BEGIN UPDATE data_versions SET version = version + 1 WHERE name = 'snap:jockey_aliases'; END;
CREATE TRIGGER IF NOT EXISTS trg_snap_jockey_aliases_del AFTER DELETE ON jockey_aliases BEGIN UPDATE data_versions SET version = version + 1 WHERE name = 'snap:jockey_aliases'; END;
CREATE TRIGGER IF NOT EXISTS trg_snap_graded_races_ins AFTER INSERT ON graded_races BEGIN UPDATE data_versions SET version = version + 1 WHERE name = 'snap:graded_races'; END;
CREATE TRIGGER IF NOT EXISTS trg_snap_graded_races_upd AFTER UPDATE ON graded_races BEGIN UPDATE data_versions SET version = version + 1 WHERE name = 'snap:graded_races'; END;
CREATE TRIGGER IF NOT EXISTS trg_snap_graded_races_del AFTER DELETE ON graded_races BEGIN UPDATE data_versions SET version = version + 1 WHERE name = 'snap:graded_races'; END;
INSERT INTO schema_migrations (name) VALUES ('table_snapshots');

-- @STEP: jump_course_type
-- 障害レースの芝ダ障を「障害」に直す(2026-10-22)。JRA公式の結果・出走馬一覧のページは障害のコースを「3,000メートル(芝)」と書き、
-- netkeiba は「障芝3000m」と書くため、読み取りが「芝」にして、障害レース197件が芝として保存されていた(「障害」は2件だけ)。
-- 芝3000m の勝ちタイムの平均が障害(3:16〜3:26)で遅くなり、補正タイム・競馬場傾向がずれていた。取り込みは _lib/race-classification.js の
-- raceCourseTypeOf で今後は障害になる。条件(class_flags)かレース名に「障害」がある行が対象(平地の条件・レース名には「障害」は無い)。
-- races は約8千行を読む(条件の列にインデックスが無い。1回だけ)。書き込みは197行+キャッシュの差し替えの控え(トリガー。3表×197行)。
-- 比率の表に障害のコースが芝として2行入っていた(京都芝2910・東京芝3110)ので消す。
UPDATE races SET course_type = '障害'
 WHERE (course_type IS NULL OR course_type <> '障害')
   AND (class_flags LIKE '%障害%' OR race_name LIKE '%障害%');
DELETE FROM course_pace_weights WHERE course_type = '芝' AND ((track = '京都' AND distance = 2910) OR (track = '東京' AND distance = 3110));
INSERT INTO schema_migrations (name) VALUES ('jump_course_type');
