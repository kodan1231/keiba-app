# 修正後の確認手順

## 1. DBを最新版へ更新

既存のローカルD1を使用する場合:

```bash
npx wrangler d1 execute keiba-yosou-db --local --file=./latest1.sql
```

新規ローカルDBを構築する場合は、先に `schema.sql` を実行します。

## 2. Start local

```bash
npx wrangler pages dev public
```

## 3. CSV import

- 購入履歴 → CSVインポート
- 同じCSVを2回実行
- 1回目: `imported > 0`
- 2回目: `skipped > 0`
- 購入履歴に表示されること

## 4. API

```text
GET /api/ticket-imports
```

レスポンスが `{ ok: true, items: [...] }` の形式であること。

## 5. 予想印

- 印を変更
- ページ再読込
- 同じ印が表示されること
- 1頭に複数の印を登録できること

## 6. 馬メモ

- メモ変更
- ページ再読込
- メモが残ること

## 7. 馬券購入

- 馬単流し 1着固定 / 2着固定
- 三連複2頭軸
- 三連単2頭軸
- 三連単マルチ

の買い目生成数を確認。

## 8. マイグレーション整合性

- 新規DBは `schema.sql` の1回実行で最新版(v10相当)になること
- 既存DBは `latest1.sql` の1回実行で最新版(v10相当)になること
- 番号付きmigrationは通常のセットアップ・更新で使用しないこと

> `migrate_v2.sql` ～ `migrate_v10.sql` は `archive/migrations/` に履歴として保管しています。
