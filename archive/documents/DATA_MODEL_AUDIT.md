# データモデル統一方針

今回のDB整理後は、最新版のDBスキーマを `schema.sql` と `latest1.sql` の2ファイルで管理します。

## データフロー

- 通常購入: `tickets`
- Club JRA-Net取込原本: `imported_tickets`
- CSV購入グループ: `imported_ticket_groups`
- CSV個別買い目: `imported_ticket_items`
- 購入履歴画面: 通常購入とCSV取込履歴を統合表示
- CSV APIレスポンス: `{ ok, items, imported, skipped }`

## DBファイルの役割

- `schema.sql`: 新規DBを最新版(v10相当)で構築するための最終スキーマ
- `latest1.sql`: 既存DBを最新版(v10相当)へ更新するための統合マイグレーション
- `archive/migrations/migrate_v2.sql` ～ `migrate_v10.sql`: 過去の変更履歴。通常のセットアップ・更新では使用しない

`latest1.sql` は、番号付きmigrationを順番に適用した結果の最終DB状態を基準として、既存DBを最新版へ更新するために整理したものです。

## CSV原本と正規化データ

- `imported_tickets` は外部履歴CSVの原本保持用。
- `imported_ticket_groups` はCSVの購入グループ。
- `imported_ticket_items` は解析・分解した個別買い目。
- 通常購入とCSV取込履歴はデータの出所を保持したまま扱い、自動統合しない。
