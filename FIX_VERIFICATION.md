# 修正後の確認手順

1. D1 migration
   npx wrangler d1 execute keiba-yosou-db --local --file=./migrate_v9.sql

2. Start local
   npx wrangler pages dev public

3. CSV import
   - 購入履歴 → CSVインポート
   - 同じCSVを2回実行
   - 1回目: imported > 0
   - 2回目: skipped > 0
   - 購入履歴に表示されること

4. API
   GET /api/ticket-imports
   レスポンスは { ok: true, items: [...] } であること

5. 予想印
   - 印を変更
   - ページ再読込
   - 同じ印が表示されること

6. 馬メモ
   - メモ変更
   - ページ再読込
   - メモが残ること

7. 馬券購入
   - 馬単流し 1着固定 / 2着固定
   - 三連複2頭軸
   - 三連単2頭軸
   - 三連単マルチ
   の買い目生成数を確認

注意:
- 本修正版ではCSV履歴のAPI/画面不整合と重複取込を修正。
- 集計へのCSV履歴統合と管理者権限は、既存のstats.js / auth設計を確認した上で別途統合する必要があります。
