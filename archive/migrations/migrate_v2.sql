-- 既に predictions テーブルで運用していた環境を
-- 疑似馬券購入シミュレーター(tickets テーブル)に切り替えるための移行スクリプト。
-- 旧データ(登録済みの予想)は引き継がれず削除されます。ご了承のうえ実行してください。

DROP TABLE IF EXISTS predictions;

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,
  track TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  race_name TEXT,
  bet_type TEXT NOT NULL,
  selections TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payout INTEGER,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_race_date ON tickets(race_date);
CREATE INDEX IF NOT EXISTS idx_tickets_race ON tickets(race_date, track, race_number);
CREATE INDEX IF NOT EXISTS idx_tickets_track ON tickets(track);
