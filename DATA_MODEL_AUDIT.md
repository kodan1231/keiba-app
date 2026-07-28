# データモデル統一方針

今回の修正で、以下のデータフローを統一します。

- 通常購入: tickets
- Club JRA-Net取込: imported_tickets
- 購入履歴画面: tickets + imported_tickets
- CSV APIレスポンス: { ok, items, imported, skipped }

注意:
- imported_tickets は外部履歴の原本保持用。
- 通常購入と外部履歴は現時点では別テーブルだが、履歴画面では同一リストとして扱う。
- 集計側で imported_tickets を含める場合は、stats.js の集計処理に imported_tickets を加算する必要がある。
- schema.sql と既存migrationの定義差は、次回のDB整理フェーズで一本化する。
