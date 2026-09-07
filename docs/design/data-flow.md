> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# データフロー

- 通常購入 → `tickets`
- Club JRA-Net等のCSV取込 → `imported_tickets`(原本)→ `imported_ticket_groups`(購入グループ)
  → `imported_ticket_items`(個別買い目)
- 出走馬一覧PDF取込 → `races.entries`(馬名をキーにマージ。上記「出走馬一覧PDFインポート」参照)
- JRAレース結果PDF取込 → `races.entries`/`races.finish_order`/`races.payouts`/
  `races`のレース条件詳細カラム/`race_results`(`results-import.js`。`entries`は出走馬一覧
  PDFインポートと共通のマージルールを使う。着順・払戻を更新した場合、このレースを購入した
  全ユーザーの`tickets.payout`も併せて再計算する。下記「払戻確定時のticket反映」参照)
- 購入履歴画面では、通常購入とCSV取込履歴を統合して表示する(データの出所は保持したまま扱い、
  自動統合はしない)
- CSV APIレスポンス形式: `{ ok, items, imported, skipped }`

