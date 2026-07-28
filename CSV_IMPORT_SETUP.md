# CSVインポート設定

1. ローカルD1へ migration_v8.sql を適用
   npx wrangler d1 execute keiba-yosou-db --local --file=./migrate_v8.sql

2. リモートD1へ反映する場合
   npx wrangler d1 execute keiba-yosou-db --remote --file=./migrate_v8.sql

3. ローカル起動
   npx wrangler pages dev public

CSVインポートAPI:
POST /api/ticket-imports
multipart/form-data の `file` にCSVを指定します。
