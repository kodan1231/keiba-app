# ドキュメント・ファイル索引(トークン節約用)

ルートの`CLAUDE.md`(Claude Codeが自動読み込みする)に要約版の対応表・不変条件・進め方がある。
このファイルはその詳細版で、`docs/design/` ・ `docs/testing/` の**ファイル索引**まで含む。
質問の種類に応じて、読む・渡すファイルを以下に絞ること。
`archive/`配下は「過去の経緯を明示的に聞かれた場合のみ」扱う(通常は不要)。

## 機能→ファイル対応表

| 触りたい機能 | 渡すべきファイル |
|---|---|
| 馬券購入画面(UI/組み合わせ生成) | public/buy.js, public/combos.js, public/bettypes.js, public/index.html |
| 購入履歴画面 | public/app.js, public/history.html |
| 予想登録画面(予想印・馬メモ) | public/prediction.js, public/prediction.html |
| 集計画面 | public/stats.js, public/stats.html |
| データ検索画面(レース成績集計) | public/data-search.js, public/data-search.html, functions/api/data-search/race-stats.js |
| レース管理画面(手動編集) | public/races.js, public/races.html |
| 出走馬一覧PDFインポート | public/jra-entries-pdf.js, functions/api/races/entries-import.js |
| JRAレース結果PDFインポート | public/jra-result-pdf.js, functions/api/races/results-import.js |
| CSVインポート | functions/api/ticket-imports/index.js |
| 払戻計算ロジック | public/payout.js, functions/api/_lib/ticket-payout.js |
| 認証・ユーザー管理 | functions/api/auth/*, functions/api/_lib/auth.js, public/auth.js |
| 騎手名エイリアス(管理画面API) | functions/api/admin/jockey-aliases/* |
| 騎手名エイリアス(正規化ロジック本体) | functions/api/_lib/jockey-alias.js |
| DBスキーマ変更 | schema.sql, migration.sql (archive/migrationsは不要) |
| 管理画面 | public/admin.js, public/admin.html, functions/api/admin/* |
| 出走馬entriesマージ・バックフィル | functions/api/_lib/entries-merge.js |
| race_results詳細記録 | functions/api/_lib/race-results.js |

## ドキュメント使い分け

| 知りたいこと | 参照先 | 備考 |
|---|---|---|
| 今の仕様(現状) | docs/DESIGN.md(索引)→ docs/design/<機能>.md | 下記「design/ ファイル索引」で対象1ファイルを特定。経緯説明は読み飛ばしてよい |
| 次に何をやるか(直近) | docs/BACKLOG.md | 冒頭の「🔰次のチャットで最初に読むこと」だけで足りることが多い |
| 大型・保留・将来構想 | docs/ROADMAP.md | 馬券かご機能・外部データ取得・大規模リファクタリング等。腰を据えるとき専用 |
| テスト観点 | docs/TESTING.md(索引)→ docs/testing/<機能>.md | 下記「testing/ ファイル索引」で対象1ファイルを特定 |
| 過去の経緯・完了履歴 | archive/documents/BACKLOG_HISTORY.md | 明示的に聞かれた時のみ |

## docs/design/ ファイル索引(2026-09-07に DESIGN.md を機能単位で分割)

DESIGN.md(索引)は各ファイルへのポインタのみ。経緯説明(「以前は〜だったが2026-08-XXに
修正」等)は各ファイル本文にロールバック防止の注記として残置しているため、要約・書き直しは
行わない。**対象の1ファイルだけを読むこと。** 節をまたぐ「〜」参照は見出し名なので
`grep -rn "見出し" docs/design/` で辿れる。

| ファイル | 主な見出し |
|---|---|
| data-model.md | データ構造(全テーブル) / コース種別・距離 / レース条件の詳細カラム / 出走馬(races.entries)の枠番・馬番 / 枠番は馬番から自動計算して保存する / 性齢・負担重量の追加 |
| import-flow.md | 想定フロー(木金土日) / タイミングごとの確定情報・再計算方針 / 出走馬情報(entries)のマージルールは共通 / 実装上の注意(サブリクエスト数対策) / 今回スコープに含めないもの |
| entries-import.md | 実装構成 / マージロジック / 予想情報の保護について / 既知の制約 |
| results-import.md | 解析ロジックの要点 / 全角文字正規化の方針 / サーバー側の反映 / 既知の制約・未解決の課題 / 関連ファイル |
| race-results.md | 目的・想定用途 / スキーマ / 更新ルール / 取消・除外・中止の扱い / races.entriesとの役割分担 / 画面での参照 |
| jockey-aliases.md | 対応方針の切り分け / スキーマ / 正規化を適用する2つの経路 / 管理画面でのエイリアス管理 / 今回のスコープに含めないもの |
| auth-multiuser.md | 認証・複数ユーザー対応(管理者判定 / セッション / 所有者user_id / 共有データraces) |
| data-flow.md | データフロー(通常購入 / CSV取込 / PDF取込 → 各テーブル) |
| csv-import.md | 着順・払戻レートの反映 / 確定扱いの統一 / 「馬／組番」列の解析 |
| screens.md | トップページ / モーダル共通挙動 / 購入履歴画面 / レース管理画面 / 集計画面 / 購入画面 / 馬券かご機能 / 予想登録画面 / 日時タイムゾーン / レスポンシブ対応 |
| data-search.md | データ検索画面(レース成績集計)/ フィルタ(競馬場・コース種別・距離)/ 平均単勝・馬連金額 / 単勝○円以下率 / 高勝率・高複勝率騎手トップ5 / 馬番別成績 / API仕様 |
| race-edit-lock.md | レース登録・編集 / ロック仕様 |
| payout-refund.md | 払戻確定時のticket反映(全ユーザー対応) / 払戻確定バッジ・的中率集計の判定 / 返還(refund)処理 |
| stats-rules.md | 集計ルール(収支・回収率・的中率の考え方) |
| ops.md | CSSのキャッシュ対策 / DBマイグレーションの運用 / DBファイルの役割 |

## docs/testing/ ファイル索引(2026-09-07に TESTING.md を機能単位で分割)

TESTING.md(索引)は各ファイルへのポインタのみ。**対象の1ファイルだけを読むこと。**
旧番号(1.7.2・4.5.0 等)は各ファイル内の見出しに残置。

| ファイル | テスト観点(旧番号) |
|---|---|
| testing/setup.md | 0 セットアップ |
| testing/csv-import.md | 1 CSVインポート / 1.6 馬名・騎手のバックフィル |
| testing/race-edit.md | 1.5 レース登録・編集 / 7・7.1 レース管理画面レイアウト・コース種別/距離表示 |
| testing/payout.md | 1.7〜1.7.2 払戻確定時のticket反映 / 4.5〜4.5.1 結果確定後の購入表示 |
| testing/entries-import.md | 1.8 出走馬一覧PDFインポート(基本・枠番未確定影響・木→金更新・予想保護・競合・異体字) |
| testing/race-results.md | 1.9 レース結果詳細(race_results)・レース条件詳細カラム |
| testing/prediction.md | 2 予想印・出走馬表示 / 2.0.1 馬メモの有無 / 2.1 購入馬券欄の開閉 / 2.5 予想登録画面レイアウト / 3 馬メモ |
| testing/buy.md | 4 馬券購入(組み合わせ生成) / 4.2 2頭軸UI / 4.4「購入済み」表示 / 4.6 レース選択画面UI改修 |
| testing/stats.md | 5 集計(stats) / 6 マイグレーション整合性 |
| testing/screens.md | 0.1 トップページ・「今日」ボタン / 0.2 カレンダーUI / 9・9.1 全画面共通・モバイルヘッダー / 8・8.1 購入履歴カレンダー・レースカード / 11 モーダル共通挙動 |
| testing/multiuser.md | 10 複数ユーザー対応 |
| testing/jockey-aliases.md | 12 騎手名エイリアス管理 |

## 運用ルール

1. Claude Codeは`CLAUDE.md`を自動で読む。対象機能が決まったら`docs/INDEX.md`の対応表でファイルを絞り、該当ファイルのみ読む(全文の一括読み込みはしない)
2. archive/配下は基本的に貼らない
3. BACKLOG.mdは全文ではなく該当クラスタの表だけ貼る運用も可
4. DESIGN.md / TESTING.md はいずれも索引のみ。上表で対象を特定し `docs/design/<機能>.md` ・ `docs/testing/<機能>.md` を1ファイルだけ読む(経緯記述は削らずそのまま維持する)
