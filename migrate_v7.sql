-- Phase 2 UI/予想保存の安全マイグレーション
-- 既存環境でも予想印・馬単位メモの保存先が存在するようにする。
CREATE TABLE IF NOT EXISTS prediction_notes (
  race_id INTEGER PRIMARY KEY,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prediction_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number)
);

CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id
  ON prediction_marks(race_id);

CREATE TABLE IF NOT EXISTS horse_notes (
  horse_name TEXT PRIMARY KEY,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
