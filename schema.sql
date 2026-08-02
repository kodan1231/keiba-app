-- 疑似馬券購入シミュレーター データベース スキーマ (latest / v13相当・複数ユーザー対応)

-- ユーザーアカウント。ログイン画面から自己登録できる(招待コード等の制限なし)。
-- 管理者かどうかはこのテーブルではなく、Cloudflare Pagesの環境変数ADMIN_USERNAMES
-- (カンマ区切りのユーザー名リスト)で判定する。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 初期管理者アカウント: username=admin, password=password
-- (パスワードハッシュは pbkdf2$100000$<salt>$<hash> 形式。ログイン後、必要であれば
--  パスワード変更機能は現状無いため、DBを直接更新するか運用で管理する)
-- 管理者として扱われるには、Cloudflare Pagesの環境変数 ADMIN_USERNAMES に
-- "admin" を追加する必要がある(README参照)。
INSERT OR IGNORE INTO users (username, password_hash) VALUES (
  'admin',
  'pbkdf2$100000$MStroT20U7oSgAlutNgvkw==$gkB+N7Q6VHmvVWx94Bs7oBqlHUk9DnWJRr9YnMasMS8='
);

-- レースマスター: 出走馬表(枠・馬番・馬名・騎手)と、確定後のレース結果(着順)を保持
-- 全ユーザー共有のデータ(実世界の共通データのため、ユーザーごとに分けない)。
-- 登録・編集・削除は管理者のみが行える(APIハンドラ側でチェックする)。
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,        -- 開催日 (YYYY-MM-DD)
  track TEXT NOT NULL,            -- 競馬場
  race_number INTEGER NOT NULL,   -- レース番号 (1-12)
  race_name TEXT,                 -- レース名(任意)
  course_type TEXT,               -- コース種別: 芝/ダート/障害(任意入力・2026-08-02追加)
  distance INTEGER,               -- 距離(メートル・任意入力・2026-08-02追加)
  entries TEXT NOT NULL,          -- JSON配列 [{horse_number, waku_number, horse_name, jockey, mark}]
  finish_order TEXT,              -- JSON配列 [horse_number, ...] 着順順(1着から)。未確定はNULL
  created_at TEXT DEFAULT (datetime('now')),
  payouts TEXT,                   -- JSON { 馬券式: [{combo:[馬番...], rate:100円あたり払戻}, ...] }
  UNIQUE(race_date, track, race_number)
);

-- 購入履歴: ボックス/流し/フォーメーションで生成された組み合わせ1点ごとに1行
-- user_id: 購入したユーザー。複数ユーザー対応より前のデータはNULL(管理者アカウント
-- 作成後に一括で割り当てる運用。README参照)。
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  group_id TEXT NOT NULL,         -- 同じ購入操作で生成された組み合わせをまとめるID
  race_id INTEGER NOT NULL,       -- races.id への参照
  race_date TEXT NOT NULL,        -- 表示用に非正規化
  track TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  race_name TEXT,
  bet_type TEXT NOT NULL,         -- tan/fuku/wakuren/umaren/wide/umatan/sanrenpuku/sanrentan
  method TEXT NOT NULL DEFAULT 'normal', -- normal/box/nagashi/axis1/axis2/multi/axis2_multi/formation (表示用)
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
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);


-- Phase 1: 予想
-- Phase 1: 予想機能の追加
-- 既存の races / tickets データは変更しません。
-- 2026-08-01: 複数ユーザー対応により、予想メモ・予想印はユーザーごとに持てるようにする
-- (以前は1レースにつき1件・全ユーザー共通だった)。

CREATE TABLE IF NOT EXISTS prediction_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  user_id INTEGER,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, user_id),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prediction_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL,
  user_id INTEGER,
  horse_number INTEGER NOT NULL,
  mark TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  -- 1頭につき予想印は1つまで(2026-07-30〜)。ユーザーごとに独立して持てる。
  UNIQUE(race_id, horse_number, user_id),
  FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id
  ON prediction_marks(race_id);
CREATE INDEX IF NOT EXISTS idx_prediction_notes_race_id
  ON prediction_notes(race_id);


-- Phase 2: 馬単位の継続メモ
-- 2026-08-01: 複数ユーザー対応により、馬メモもユーザーごとに持てるようにする
-- (以前はhorse_nameのみがPKで、全ユーザー共通の1件だった)。
CREATE TABLE IF NOT EXISTS horse_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horse_name TEXT NOT NULL,
  user_id INTEGER,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(horse_name, user_id)
);
CREATE INDEX IF NOT EXISTS idx_horse_notes_horse_name ON horse_notes(horse_name);


-- Club JRA-Net等の外部購入履歴CSVを保持するテーブル
-- user_id: 取り込んだユーザー。重複判定(uq_imported_tickets_club_jra)もユーザー単位で行う。
CREATE TABLE IF NOT EXISTS imported_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_imported_tickets_race_date ON imported_tickets(race_date);
CREATE INDEX IF NOT EXISTS idx_imported_tickets_receipt_number ON imported_tickets(receipt_number);
CREATE INDEX IF NOT EXISTS idx_imported_tickets_user_id ON imported_tickets(user_id);

-- 受付番号は開催日ごとに採番がリセットされることがあるため、日付を含めずに
-- 受付番号+通番だけで一意性を判定すると、別日の正当なデータが重複扱いされてしまう。
-- そのため race_date も含めて一意性を判定する。ユーザーが異なれば別々のCSV(別々の
-- JRA会員)である可能性が高いため、user_id も一意性の判定に含める。
CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_tickets_club_jra
  ON imported_tickets(source, user_id, race_date, receipt_number, sequence_number)
  WHERE receipt_number IS NOT NULL AND receipt_number <> ''
    AND sequence_number IS NOT NULL AND sequence_number <> '';


-- 最新版: Import normalized purchase groups / individual ticket items
-- user_id: 取り込んだユーザー(imported_ticket_itemsは持たず、group_id経由で辿る)。
CREATE TABLE IF NOT EXISTS imported_ticket_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_imported_groups_user_id ON imported_ticket_groups(user_id);

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
