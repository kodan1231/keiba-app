-- v10: normalized imported purchase groups/items and multi-mark predictions
-- Existing imported_tickets is retained as the raw import source table.

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
CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_group_source_key ON imported_ticket_groups(source, group_key);

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
CREATE INDEX IF NOT EXISTS idx_imported_items_group ON imported_ticket_items(group_id);
CREATE INDEX IF NOT EXISTS idx_imported_items_race ON imported_ticket_items(race_id);

-- Allow multiple marks per horse. Existing unique(race_id,horse_number) constraint cannot be dropped in-place;
-- rebuild only when the table still has the old constraint.
CREATE TABLE IF NOT EXISTS prediction_marks_v10 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number, mark),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO prediction_marks_v10(race_id,horse_number,mark,created_at,updated_at) SELECT race_id,horse_number,mark,created_at,updated_at FROM prediction_marks;
DROP TABLE prediction_marks;
ALTER TABLE prediction_marks_v10 RENAME TO prediction_marks;
CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id ON prediction_marks(race_id);
