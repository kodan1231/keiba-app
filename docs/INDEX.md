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

## docs/DESIGN.md 見出し索引(セクション指定で部分参照するため)

DESIGN.mdは経緯説明(「以前は〜だったが2026-08-XXに修正」等)がロールバック防止の注記として
本文に意図的に残っているため、本文の要約・書き直しは行わない。かわりに、次回以降は
以下の見出し名を指定して「このセクションだけ見せて」と依頼することで、全文を貼らずに
済ませられる。

- データ構造
  - レース情報のコース種別・距離
  - レース条件の詳細カラム
  - 出走馬(races.entries)の枠番・馬番
  - 枠番は馬番から自動計算して保存する
  - races.entriesへの性齢・負担重量の追加
- 出走馬インポート・レース結果インポートの運用フロー
  - 想定フロー / タイミングごとの確定情報・再計算方針
  - 出走馬情報(entries)のマージルールは共通
  - 実装上の注意(サブリクエスト数対策)
  - 今回スコープに含めないもの(BACKLOGへ引き継ぎ)
- 出走馬一覧PDFインポート
  - 実装構成 / マージロジック / 予想情報の保護について / 既知の制約
- JRAレース結果PDFインポート
  - 解析ロジックの要点 / 全角文字正規化の方針 / サーバー側の反映 / 既知の制約・未解決の課題 / 関連ファイル
- レース結果の詳細記録(race_results)
  - 目的・想定用途 / スキーマ / 更新ルール / 取消・除外・中止の扱い / races.entriesとの役割分担 / 画面での参照
- 騎手名エイリアス管理(jockey_aliases)
  - 対応方針の切り分け / スキーマ / 正規化を適用する2つの経路 / 管理画面でのエイリアス管理 / 今回のスコープに含めないもの
- 認証・複数ユーザー対応
- データフロー
- CSV取込の仕様
  - 「馬／組番」列の解析
- 画面仕様
  - トップページ(/)の表示について / モーダル/ダイアログ共通挙動
  - 購入履歴画面(history.html)(レースカードの表示)
  - レース管理画面(races.html)
  - 集計画面(stats.html)
  - 購入画面(index.html)(レース選択グリッド / GET /api/horse-notes)
  - 予想登録画面(prediction.html)
- 日時表示のタイムゾーン(「今日」ボタンの日付判定)
- レスポンシブ対応
- レース登録・編集
- 払戻確定時のticket反映(全ユーザー対応)(払戻確定バッジ・的中率集計の判定)
- 返還(refund)処理
  - 対応範囲 / スキーマ / 返還対象の判定ルール / 実装方針 / 画面表示
- ロック仕様
- 集計ルール
- CSSのキャッシュ対策
- DBマイグレーションの運用 / DBファイルの役割

## 運用ルール

1. 新しいチャットではまずこのINDEX.mdだけを渡し、「〇〇を直したい」で対象ファイルを絞ってから該当ファイルのみ追加で貼る
2. archive/配下は基本的に貼らない
3. BACKLOG.mdは全文ではなく該当クラスタの表だけ貼る運用も可
4. DESIGN.mdは全文を貼らず、上記の見出し索引を使って該当セクションのみ貼ってもらう(経緯記述は削らずそのまま維持する)
