# ドキュメント・ファイル索引(トークン節約用)

質問の種類に応じて、渡すファイルを以下に絞ってください。
`archive/`配下は「過去の経緯を明示的に聞かれた場合のみ」渡す(通常は不要)。

## 機能→ファイル対応表

| 触りたい機能 | 渡すべきファイル |
|---|---|
| 馬券購入画面(UI/組み合わせ生成) | public/buy.js, public/combos.js, public/bettypes.js, public/index.html |
| 購入履歴画面 | public/app.js, public/history.html |
| 予想登録画面(予想印・馬メモ) | public/prediction.js, public/prediction.html |
| 集計画面 | public/stats.js, public/stats.html |
| レース管理画面(手動編集) | public/races.js, public/races.html |
| 出走馬一覧PDFインポート | public/jra-entries-pdf.js, functions/api/races/entries-import.js |
| JRAレース結果PDFインポート | public/jra-result-pdf.js, functions/api/races/results-import.js |
| 払戻計算ロジック | public/payout.js, functions/api/_shared.js(recomputeTicketPayoutsForRace系) |
| CSVインポート | functions/api/ticket-imports/index.js |
| 認証・ユーザー管理 | functions/api/auth/*, functions/api/_shared.js(セッション部分), public/auth.js |
| 騎手名エイリアス | functions/api/admin/jockey-aliases/*, functions/api/_shared.js(jockey系) |
| DBスキーマ変更 | schema.sql, migration.sql (archive/migrationsは不要) |
| 管理画面 | public/admin.js, public/admin.html, functions/api/admin/* |

## ドキュメント使い分け

| 知りたいこと | 参照先 | 備考 |
|---|---|---|
| 今の仕様(現状) | docs/DESIGN.md | 経緯説明は読み飛ばしてよい |
| 次に何をやるか(直近) | docs/BACKLOG.md | 冒頭の「🔰次のチャットで最初に読むこと」だけで足りることが多い |
| 大型・保留・将来構想 | docs/ROADMAP.md | 馬券かご機能・外部データ取得・大規模リファクタリング等。腰を据えるとき専用 |
| テスト観点 | docs/TESTING.md | 該当機能のセクションのみ抜粋依頼推奨 |
| 過去の経緯・完了履歴 | archive/documents/BACKLOG_HISTORY.md | 明示的に聞かれた時のみ |

## 運用ルール

1. 新しいチャットではまずこのINDEX.mdだけを渡し、「〇〇を直したい」で対象ファイルを絞ってから該当ファイルのみ追加で貼る
2. archive/配下は基本的に貼らない
3. BACKLOG.mdは全文ではなく該当クラスタの表だけ貼る運用も可
