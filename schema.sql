-- 疑似馬券購入シミュレーター データベース スキーマ (FIX ver1.0)
--
-- 新規DBを構築する際に、このファイルを1回実行すれば最新版のテーブル一式が
-- 出来上がる。既存DBを更新する場合はこのファイルではなく migration.sql を使う
-- (README.md「DBマイグレーション方針」参照)。
--
-- セクション構成:
--   1. 認証(users)
--   2. レース(races) ... 全ユーザー共有
--   3. 通常購入(tickets)
--   4. 予想(prediction_notes / prediction_marks)
--   5. 馬メモ(horse_notes)
--   6. CSV取込 原本(imported_tickets)
--   7. CSV取込 正規化データ(imported_ticket_groups / imported_ticket_items)
--   8. 騎手名エイリアス(jockey_aliases)

-- ============================================================
-- 1. 認証
-- ============================================================

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
-- (パスワードハッシュは pbkdf2$100000$<salt>$<hash> 形式)
-- 管理者として扱われるには、Cloudflare Pagesの環境変数 ADMIN_USERNAMES に
-- "admin" を追加する必要がある(README参照)。ログイン後、必要であればパスワードを
-- 変更する(現状アプリ内に変更機能は無いため、変更する場合はDBを直接更新する)。
INSERT OR IGNORE INTO users (username, password_hash) VALUES (
  'admin',
  'pbkdf2$100000$MStroT20U7oSgAlutNgvkw==$gkB+N7Q6VHmvVWx94Bs7oBqlHUk9DnWJRr9YnMasMS8='
);

-- ============================================================
-- 2. レース(全ユーザー共有)
-- ============================================================

-- レースマスター: 出走馬表(枠・馬番・馬名・騎手)と、確定後のレース結果(着順)を保持する。
-- 実世界の共通データのため全ユーザー共有。登録・編集・削除は管理者のみが行える
-- (APIハンドラ側でチェックする)。
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date TEXT NOT NULL,        -- 開催日 (YYYY-MM-DD)
  track TEXT NOT NULL,            -- 競馬場
  race_number INTEGER NOT NULL,   -- レース番号 (1-12)
  race_name TEXT,                 -- レース名(任意)
  course_type TEXT,               -- コース種別: 芝/ダート/障害(任意入力)
  distance INTEGER,               -- 距離(メートル・任意入力)
  weight_type TEXT,               -- 斤量区分: 馬齢/定量/別定/ハンデ(任意入力)
  class_flags TEXT,               -- 条件フラグ等の生テキスト(指定/特指/混合/牝馬限定等。任意入力)
  course_direction TEXT,          -- コースの回り: 左/右(該当なしはNULL)
  weather TEXT,                   -- 天候(JRAレース結果PDFのみに出現)
  track_condition TEXT,           -- 馬場状態(JRAレース結果PDFのみに出現。天候とは別カラム)
  entries TEXT NOT NULL,          -- JSON配列 [{horse_number, waku_number, horse_name, jockey, mark, sex_age, weight_carried}]
                                   -- waku_number/horse_numberはnullを許容する(出走馬一覧PDF
                                   -- インポート対応。docs/DESIGN.md「出走馬(races.entries)の
                                   -- 枠番・馬番はnullを許容する」参照)
  finish_order TEXT,              -- JSON配列 [horse_number, ...] 着順順(1着から)。未確定はNULL
  payouts TEXT,                   -- JSON { 馬券式: [{combo:[馬番...], rate:100円あたり払戻}, ...] }
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_date, track, race_number)
);

CREATE INDEX IF NOT EXISTS idx_races_date ON races(race_date);

-- レース結果の詳細記録: 馬単位の確定結果を1頭1行で記録する(全ユーザー共有)。
-- races.finish_order/payouts(払戻判定用・上位3着のみ)とは独立した「記録・将来の
-- 集計参照用」の追加データ。docs/DESIGN.md「レース結果の詳細記録(race_results)」参照。
CREATE TABLE IF NOT EXISTS race_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  horse_number INTEGER,
  waku_number INTEGER,         -- 常にnull想定。PDFからは取得できないため手動入力用の列としてのみ保持
  horse_name TEXT,
  sex_age TEXT,                 -- 性齢 例:"牡3"
  weight_carried REAL,          -- 負担重量 例:57.0
  jockey TEXT,                  -- 見習い減量記号を含む表記のまま保持
  status TEXT NOT NULL DEFAULT 'finished', -- finished/scratched(取消)/excluded(除外)/stopped(中止)
  finish_position INTEGER,      -- 着順(全馬)。取消・除外はNULL
  time_text TEXT,                -- タイム 例:"1:25.0"(生テキストのまま)
  margin TEXT,                   -- 着差 例:"クビ" "１ 1/4" "大差"(表記ゆれが大きいためTEXT)
  corner_positions TEXT,         -- 個別コーナー通過順位(生テキストのまま)
  final_furlong_time REAL,       -- 推定上り 例:37.2
  body_weight INTEGER,           -- 馬体重
  body_weight_change TEXT,       -- 増減 例:"+2" "-2" "初出走" "計不"(数値以外もあるためTEXT)
  win_popularity INTEGER,        -- 単勝人気
  incident_note TEXT,            -- 競走中の出来事(該当時に自動転記)。管理者が編集可
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number)
);

CREATE INDEX IF NOT EXISTS idx_race_results_race_id ON race_results(race_id);
CREATE INDEX IF NOT EXISTS idx_race_results_horse_name ON race_results(horse_name);

-- ============================================================
-- 3. 通常購入
-- ============================================================

-- 購入履歴: ボックス/流し/フォーメーションで生成された組み合わせ1点ごとに1行。
-- user_id: 購入したユーザー。複数ユーザー対応より前のデータはNULL(管理者アカウント
-- 作成後、archive/migrations/assign_existing_data_to_admin.sql で一括割り当てする)。
-- ロック仕様(着順・払戻確定後の編集・削除禁止)は撤廃済み。確定後も自由に編集・削除できる
-- (docs/DESIGN.md「ロック仕様」参照)。
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
  payout INTEGER,                 -- この1点の払戻金額(円)。未確定はNULL。返還時は購入金額(amount)と同額
  refunded INTEGER NOT NULL DEFAULT 0, -- 返還(取消・除外馬が絡む買い目)によりpayoutが確定した場合は1。
                                        -- 2026-08-20追加。的中による払戻(refunded=0)と区別するためのフラグ。
                                        -- docs/DESIGN.md「返還(refund)処理」参照
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_group ON tickets(group_id);
CREATE INDEX IF NOT EXISTS idx_tickets_race_date ON tickets(race_date);
CREATE INDEX IF NOT EXISTS idx_tickets_race_id ON tickets(race_id);
CREATE INDEX IF NOT EXISTS idx_tickets_track ON tickets(track);
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);

-- ============================================================
-- 4. 予想(予想印・予想メモ)
-- ============================================================

-- 予想メモ: レース単位の自由記述メモ。ユーザーごとに複数持てる(1レース1ユーザーにつき1件)。
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

CREATE INDEX IF NOT EXISTS idx_prediction_notes_race_id ON prediction_notes(race_id);

-- 予想印: 1頭につき1つまで(◎○▲△☆消)。ユーザーごとに独立して持てる。
CREATE TABLE IF NOT EXISTS prediction_marks (
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

CREATE INDEX IF NOT EXISTS idx_prediction_marks_race_id ON prediction_marks(race_id);

-- ============================================================
-- 5. 馬メモ
-- ============================================================

-- 馬単位の継続メモ。馬名をキーに管理する(馬名はtrim/空白正規化して保存)。
-- ユーザーごとに独立して持てる(horse_name, user_idの組み合わせで一意)。
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

-- ============================================================
-- 6. CSV取込 原本
-- ============================================================

-- Club JRA-Net等の外部購入履歴CSVを保持するテーブル(原本保持用)。
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

-- ============================================================
-- 7. CSV取込 正規化データ
-- ============================================================

-- CSV購入グループ: CSVの1行=1購入グループ。組み合わせを個別買い目(imported_ticket_items)へ
-- 分解する前の、購入操作単位のまとまり。
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

-- (source, group_key)の一意制約にはuser_idを含めない。本アプリは同じJRA-Netアカウントを
-- 複数のアプリユーザーが共有する想定をしていないため(docs/DESIGN.md「CSV取込の仕様」参照)。
CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_group_source_key ON imported_ticket_groups(source, group_key);
CREATE INDEX IF NOT EXISTS idx_imported_groups_user_id ON imported_ticket_groups(user_id);

-- CSV個別買い目: imported_ticket_groups の組み合わせを個別買い目へ分解したもの。
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

-- ============================================================
-- 8. 騎手名エイリアス(2026-08-16追加)
-- ============================================================

-- 同一騎手がPDFインポート・手動入力・netkeibaテキスト貼り付け等の経路によって
-- 異なる表記(異体字・空白有無・文字欠落等)で登録されてしまい、集計画面の
-- 騎手別収支が同一人物なのに複数行へ分裂してしまう問題への対応。
-- 管理画面(admin.html)から編集する。詳細はdocs/DESIGN.md「騎手名エイリアス管理」参照。
CREATE TABLE IF NOT EXISTS jockey_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_key TEXT NOT NULL UNIQUE,   -- 表記ゆれ側の突き合わせキー。見習い減量記号(☆▲△★◇)と
                                     -- 空白(全角/半角)を除去した文字列。空白有無だけの違いは
                                     -- 同一人物として扱うため、キー生成時に空白を除去している
  alias_display TEXT NOT NULL,      -- 表記ゆれ側の元の見た目(管理画面での参考表示用)
  canonical_name TEXT NOT NULL,     -- 正しい表記(見習い記号は含めない。適用時に元の記号を復元する)
  created_at TEXT DEFAULT (datetime('now'))
);
