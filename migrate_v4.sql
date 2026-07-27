-- v3 -> v4: racesテーブルに払戻率保存用のpayouts列と、entries内の予想印(mark)対応を追加。
-- entries/finish_orderは既存のJSON列のままなので、追加のデータ移行は不要。
ALTER TABLE races ADD COLUMN payouts TEXT;
