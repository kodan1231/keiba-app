-- assign_existing_data_to_admin.sql
--
-- 複数ユーザー対応(latest1.sql の v13)を適用した直後、既存の購入履歴・インポート履歴・
-- 予想印/メモ・馬メモは user_id が NULL のままになっている(個別ログイン導入前のデータには
-- 「誰のものか」という情報がそもそも存在しないため)。
--
-- 管理者アカウント(schema.sql / latest1.sql で自動的に作成される username=admin)に
-- 一括で割り当てるためのスクリプト。管理者のユーザー名を admin から変更した場合は、
-- 下の 'admin' の部分を実際のユーザー名に書き換えてから実行すること。
--
-- 実行例:
--   npx wrangler d1 execute keiba-yosou-db --remote --file=./assign_existing_data_to_admin.sql
--
-- 何度実行しても安全(WHERE user_id IS NULL の行にしか影響しない)。

UPDATE tickets
  SET user_id = (SELECT id FROM users WHERE username = 'admin')
  WHERE user_id IS NULL;

UPDATE imported_tickets
  SET user_id = (SELECT id FROM users WHERE username = 'admin')
  WHERE user_id IS NULL;

UPDATE imported_ticket_groups
  SET user_id = (SELECT id FROM users WHERE username = 'admin')
  WHERE user_id IS NULL;

UPDATE prediction_notes
  SET user_id = (SELECT id FROM users WHERE username = 'admin')
  WHERE user_id IS NULL;

UPDATE prediction_marks
  SET user_id = (SELECT id FROM users WHERE username = 'admin')
  WHERE user_id IS NULL;

UPDATE horse_notes
  SET user_id = (SELECT id FROM users WHERE username = 'admin')
  WHERE user_id IS NULL;
