-- latest1.sql
-- 現行DBを最新版（v10相当）へ更新するための統合マイグレーション。
--
-- 方針:
--   * migrate_v2.sql ～ migrate_v10.sql を順番に適用した最終状態を再現する。
--   * 番号付きmigrationは履歴（archive/migrations/）として保存し、通常運用では使用しない。
--   * 本ファイルは、v3相当の races / tickets が存在する既存DBから最新版へ更新する用途。
--   * 既にv5～v10相当のテーブルが存在するDBにも可能な限り安全に再実行できるようIF NOT EXISTSを使用する。
--
-- 新規DBは schema.sql を使用する。

PRAGMA foreign_keys=ON;

-- v4: races に払戻情報を追加。
-- latest1.sql は v3相当の既存DBをv10相当へ更新するため、ここで追加する。
-- ALTER TABLE races ADD COLUMN payouts TEXT;

-- v5/v7: 予想メモ
CREATE TABLE IF NOT EXISTS prediction_notes (
  race_id INTEGER PRIMARY KEY,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

-- prediction_marks は v5/v7 の UNIQUE(race_id, horse_number) から
-- v10 の UNIQUE(race_id, horse_number, mark) へ変更する必要がある。
-- 旧テーブルが存在しない場合も処理できるよう、旧形式の空テーブルを先に用意する。
CREATE TABLE IF NOT EXISTS prediction_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

DROP TABLE IF EXISTS prediction_marks_latest1;
CREATE TABLE prediction_marks_latest1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number, mark),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO prediction_marks_latest1
  (race_id, horse_number, mark, created_at, updated_at)
SELECT race_id, horse_number, mark, created_at, updated_at
FROM prediction_marks;

DROP TABLE prediction_marks;
ALTER TABLE prediction_marks_latest1 RENAME TO prediction_marks;

CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id
  ON prediction_marks(race_id);

-- v12(2026-07-30): 予想印を再び1頭1印に制限する。
-- v10でUNIQUE(race_id,horse_number,mark)に広げて複数印を許容したが、
-- 予想印UIをドロップダウン化し「1頭1印」の仕様に変更したため、
-- UNIQUE(race_id,horse_number)に戻す。既に複数印が登録済みの場合は、
-- 同じ(race_id,horse_number)の中でidが最大(=最後に登録された)ものを残す。
DROP TABLE IF EXISTS prediction_marks_v12;
CREATE TABLE prediction_marks_v12 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO prediction_marks_v12
  (id, race_id, horse_number, mark, created_at, updated_at)
SELECT id, race_id, horse_number, mark, created_at, updated_at
FROM prediction_marks
GROUP BY race_id, horse_number
HAVING id = MAX(id);

DROP TABLE prediction_marks;
ALTER TABLE prediction_marks_v12 RENAME TO prediction_marks;

CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id
  ON prediction_marks(race_id);

-- v6/v7: 馬単位の継続メモ
CREATE TABLE IF NOT EXISTS horse_notes (
  horse_name TEXT PRIMARY KEY,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- v8/v9: Club JRA-Net等の外部購入履歴CSV原本
CREATE TABLE IF NOT EXISTS imported_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'club_jra_net',
  race_date TEXT,
  receipt_number TEXT,
  sequence_number TEXT,
  venue TEXT,
  race_number TEXT,
  bet_type TEXT,
  combination TEXT,
  purchase_amount INTEGER DEFAULT 0,
  hit_refund TEXT,
  refund_unit INTEGER DEFAULT 0,
  refund_amount INTEGER DEFAULT 0,
  return_amount INTEGER DEFAULT 0,
  raw_csv TEXT
);

CREATE INDEX IF NOT EXISTS idx_imported_tickets_race_date
  ON imported_tickets(race_date);

CREATE INDEX IF NOT EXISTS idx_imported_tickets_receipt_number
  ON imported_tickets(receipt_number);

CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_tickets_club_jra
  ON imported_tickets(source, receipt_number, sequence_number)
  WHERE receipt_number IS NOT NULL AND receipt_number <> ''
    AND sequence_number IS NOT NULL AND sequence_number <> '';

-- v11: 受付番号は開催日ごとに採番がリセットされることがあるため、日付を含めずに
-- 受付番号+通番だけで一意性を判定すると、別日の正当なデータが重複扱いされ
-- CSV再取込時に誤ってスキップされてしまうバグがあった。race_date を含めて再定義する。
-- (IF NOT EXISTSでは既存インデックスの定義は更新されないため、明示的に作り直す)
DROP INDEX IF EXISTS uq_imported_tickets_club_jra;
CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_tickets_club_jra
  ON imported_tickets(source, race_date, receipt_number, sequence_number)
  WHERE receipt_number IS NOT NULL AND receipt_number <> ''
    AND sequence_number IS NOT NULL AND sequence_number <> '';

-- v10: CSV購入グループ
CREATE TABLE IF NOT EXISTS imported_ticket_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'club_jra_net',
  source_row_id INTEGER,
  race_id INTEGER,
  group_key TEXT NOT NULL,
  race_date TEXT,
  track TEXT,
  race_number INTEGER,
  race_name TEXT,
  bet_type TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'import',
  total_amount INTEGER NOT NULL DEFAULT 0,
  total_payout INTEGER,
  status TEXT NOT NULL DEFAULT 'unsettled',
  raw_json TEXT,
  imported_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (race_id) REFERENCES races(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_group_source_key
  ON imported_ticket_groups(source, group_key);

-- v10: CSV個別買い目
CREATE TABLE IF NOT EXISTS imported_ticket_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  race_id INTEGER,
  bet_type TEXT NOT NULL,
  selections TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  payout INTEGER,
  is_hit INTEGER NOT NULL DEFAULT 0,
  result_inferred INTEGER NOT NULL DEFAULT 0,
  source_key TEXT,
  FOREIGN KEY (group_id) REFERENCES imported_ticket_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (race_id) REFERENCES races(id)
);

CREATE INDEX IF NOT EXISTS idx_imported_items_group
  ON imported_ticket_items(group_id);

CREATE INDEX IF NOT EXISTS idx_imported_items_race
  ON imported_ticket_items(race_id);

-- v13(2026-08-01): 複数ユーザー対応
-- ログイン画面から自己登録できるユーザーアカウントを追加し、購入履歴・
-- インポート履歴・予想印/メモ・馬メモをユーザー単位で分離する。
-- レース情報(races)は引き続き全ユーザー共有。管理者判定は環境変数
-- ADMIN_USERNAMES(カンマ区切り)で行うため、usersテーブルに管理者フラグは持たせない。

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 初期管理者アカウント: username=admin, password=password
-- ログイン後、Cloudflare Pagesの環境変数 ADMIN_USERNAMES に "admin" を追加すると
-- 管理者として扱われる(README参照)。
INSERT OR IGNORE INTO users (username, password_hash) VALUES (
  'admin',
  'pbkdf2$100000$MStroT20U7oSgAlutNgvkw==$gkB+N7Q6VHmvVWx94Bs7oBqlHUk9DnWJRr9YnMasMS8='
);

-- tickets / imported_tickets / imported_ticket_groups に user_id を追加。
-- 追加直後は既存行のuser_idはすべてNULL。管理者アカウント作成後、
-- assign_existing_data_to_admin.sql を1回実行して割り当てる(README参照)。
-- 注意: このALTER文は非冪等(再実行するとエラーになる)。既にv13を適用済みのDBに対して
-- latest1.sqlを再実行する場合は、このv13セクションだけ手動で除外すること。
ALTER TABLE tickets ADD COLUMN user_id INTEGER;
ALTER TABLE imported_tickets ADD COLUMN user_id INTEGER;
ALTER TABLE imported_ticket_groups ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_imported_tickets_user_id ON imported_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_imported_groups_user_id ON imported_ticket_groups(user_id);

-- uq_imported_tickets_club_jra にuser_idを含めて再定義する
-- (ユーザーが異なれば別々のCSV=別々のJRA会員である可能性が高いため)。
DROP INDEX IF EXISTS uq_imported_tickets_club_jra;
CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_tickets_club_jra
  ON imported_tickets(source, user_id, race_date, receipt_number, sequence_number)
  WHERE receipt_number IS NOT NULL AND receipt_number <> ''
    AND sequence_number IS NOT NULL AND sequence_number <> '';

-- prediction_notes: 1レースにつき1件(全ユーザー共通)だったメモを、ユーザーごとに
-- 複数持てるように主キーをrace_idからid連番+UNIQUE(race_id,user_id)へ変更する。
-- 既存行のuser_idはNULLのまま移行する(後で管理者に割り当てる)。
DROP TABLE IF EXISTS prediction_notes_v13;
CREATE TABLE prediction_notes_v13 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  user_id INTEGER,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, user_id),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);
INSERT INTO prediction_notes_v13 (race_id, user_id, memo, created_at, updated_at)
SELECT race_id, NULL, memo, created_at, updated_at FROM prediction_notes;
DROP TABLE prediction_notes;
ALTER TABLE prediction_notes_v13 RENAME TO prediction_notes;
CREATE INDEX IF NOT EXISTS idx_prediction_notes_race_id ON prediction_notes(race_id);

-- prediction_marks: UNIQUE(race_id,horse_number)にuser_idを加える。
DROP TABLE IF EXISTS prediction_marks_v13;
CREATE TABLE prediction_marks_v13 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  user_id INTEGER,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number, user_id),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);
INSERT INTO prediction_marks_v13 (id, race_id, user_id, horse_number, mark, created_at, updated_at)
SELECT id, race_id, NULL, horse_number, mark, created_at, updated_at FROM prediction_marks;
DROP TABLE prediction_marks;
ALTER TABLE prediction_marks_v13 RENAME TO prediction_marks;
CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id ON prediction_marks(race_id);

-- horse_notes: horse_name単一PKから、(horse_name, user_id)の組み合わせへ変更する。
DROP TABLE IF EXISTS horse_notes_v13;
CREATE TABLE horse_notes_v13 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horse_name TEXT NOT NULL,
  user_id INTEGER,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(horse_name, user_id)
);
INSERT INTO horse_notes_v13 (horse_name, user_id, memo, created_at, updated_at)
SELECT horse_name, NULL, memo, created_at, updated_at FROM horse_notes;
DROP TABLE horse_notes;
ALTER TABLE horse_notes_v13 RENAME TO horse_notes;
CREATE INDEX IF NOT EXISTS idx_horse_notes_horse_name ON horse_notes(horse_name);
