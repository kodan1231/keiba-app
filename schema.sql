-- 疑似馬券購入シミュレーター データベース スキーマ (v3)

-- レースマスター: 出走馬表(枠・馬番・馬名・騎手)と、確定後のレース結果(着順)を保持
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,        -- 開催日 (YYYY-MM-DD)
  track TEXT NOT NULL,            -- 競馬場
  race_number INTEGER NOT NULL,   -- レース番号 (1-12)
  race_name TEXT,                 -- レース名(任意)
  entries TEXT NOT NULL,          -- JSON配列 [{horse_number, waku_number, horse_name, jockey, mark}]
  finish_order TEXT,              -- JSON配列 [horse_number, ...] 着順順(1着から)。未確定はNULL
  payouts TEXT,                   -- JSON { 馬券式: [{combo:[馬番...], rate:100円あたり払戻}, ...] }
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_date, track, race_number)
);

-- 購入履歴: ボックス/流し/フォーメーションで生成された組み合わせ1点ごとに1行
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,         -- 同じ購入操作で生成された組み合わせをまとめるID
  race_id INTEGER NOT NULL,       -- races.id への参照
  race_date TEXT NOT NULL,        -- 表示用に非正規化
  track TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  race_name TEXT,
  bet_type TEXT NOT NULL,         -- tan/fuku/wakuren/umaren/wide/umatan/sanrenpuku/sanrentan
  method TEXT NOT NULL DEFAULT 'normal', -- normal/box/nagashi/formation (表示用)
  selections TEXT NOT NULL,       -- JSON配列 [{horse_number, waku_number, horse_name, jockey}] (購入時点のスナップショット)
  amount INTEGER NOT NULL,        -- この1点の購入金額(円)
  payout INTEGER,                 -- この1点の払戻金額(円)。未確定はNULL
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_races_date ON races(race_date);
CREATE INDEX IF NOT EXISTS idx_tickets_group ON tickets(group_id);
CREATE INDEX IF NOT EXISTS idx_tickets_race_date ON tickets(race_date);
CREATE INDEX IF NOT EXISTS idx_tickets_race_id ON tickets(race_id);
CREATE INDEX IF NOT EXISTS idx_tickets_track ON tickets(track);
