-- v2(tickets単体構成)からv3(races + tickets構成)への移行スクリプト。
-- 旧購入履歴は新しいデータ構造と互換性がないため削除されます。ご了承のうえ実行してください。

DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS predictions; -- さらに古いバージョンが残っている場合の後片付け

CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  race_name TEXT,
  entries TEXT NOT NULL,
  finish_order TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_date, track, race_number)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  race_id INTEGER NOT NULL,
  race_date TEXT NOT NULL,
  track TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  race_name TEXT,
  bet_type TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'normal',
  selections TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payout INTEGER,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_races_date ON races(race_date);
CREATE INDEX IF NOT EXISTS idx_tickets_group ON tickets(group_id);
CREATE INDEX IF NOT EXISTS idx_tickets_race_date ON tickets(race_date);
CREATE INDEX IF NOT EXISTS idx_tickets_race_id ON tickets(race_id);
CREATE INDEX IF NOT EXISTS idx_tickets_track ON tickets(track);
