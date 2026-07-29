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
