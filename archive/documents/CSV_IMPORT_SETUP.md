# CSVインポート設定

CSVインポート機能を利用する前に、DBを最新版(v10相当)へ更新してください。

## 既存のローカルD1

```bash
npx wrangler d1 execute keiba-yosou-db --local --file=./latest1.sql
```

## 既存のリモートD1

```bash
npx wrangler d1 execute keiba-yosou-db --remote --file=./latest1.sql
```

## 新規DB

新規DBは `schema.sql` を使用して構築します。

```bash
npx wrangler d1 execute keiba-yosou-db --remote --file=./schema.sql
```

## ローカル起動

```bash
npx wrangler pages dev public
```

CSVインポートAPI:

```text
POST /api/ticket-imports
```

`multipart/form-data` の `file` フィールドにCSVファイルを指定します。

> `migrate_v2.sql` ～ `migrate_v10.sql` は過去の変更履歴として `archive/migrations/` に保管しています。通常のCSVインポート設定では使用しません。
