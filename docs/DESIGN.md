# 設計方針(索引)

**FIX ver1.0**

このドキュメントは現状の設計を常に表す「生きたドキュメント」です。日付単位の不具合修正記録・
調査の経緯・実機検証ログといった過去の作業履歴は持たず、**現時点で正しい仕様のみ**を記載します。
過去の経緯を確認したい場合は`archive/documents/BACKLOG_HISTORY.md`を参照してください。
未解決の不具合・未着手のタスクは`docs/BACKLOG.md`を参照してください。

## この索引の使い方(トークン節約)

2026-09-07に、肥大化した本ファイル(約1400行)を`docs/design/`配下へ**機能単位で分割**しました。
本ファイルは各ファイルへのポインタ(索引)だけを持ちます。

- **全文を読み込まない**。下表で対象ファイルを1つ特定し、そのファイルだけを読む。
- 節をまたぐ参照(「〜」参照)は`docs/design/`内の**見出し名**。
  `grep -rn "見出し" docs/design/` で該当ファイルを辿れる。
- 経緯記述(「以前は〜だったが2026-08-XXに変更」)は各ファイル本文に残置(ロールバック防止)。
  仕様把握には読み飛ばしてよい。

## ファイル索引

| ファイル | 内容(主な見出し) |
|---|---|
| `docs/design/data-model.md` | データ構造(全テーブル)・コース種別/距離・レース条件詳細カラム・`races.entries`の枠番/馬番・**枠番の自動計算**・性齢/負担重量 |
| `docs/design/import-flow.md` | 出走馬一覧PDF/結果PDFインポートの運用フロー・想定フロー(木金土日)・タイミングごとの確定情報・**`entries`共通マージルール**・サブリクエスト数対策 |
| `docs/design/entries-import.md` | 出走馬一覧PDFインポート・実装構成・マージロジック・予想情報の保護・既知の制約 |
| `docs/design/results-import.md` | JRAレース結果PDFインポート・解析ロジック・**全角文字正規化の方針**・サーバー側の反映・既知の制約・関連ファイル |
| `docs/design/race-results.md` | `race_results`テーブル・目的/用途・スキーマ・更新ルール・取消/除外/中止の扱い・`races.entries`との役割分担 |
| `docs/design/jockey-aliases.md` | 騎手名エイリアス(`jockey_aliases`)・対応方針の切り分け・スキーマ・正規化を適用する2経路・管理画面 |
| `docs/design/auth-multiuser.md` | 認証・複数ユーザー対応(管理者判定・セッション・所有者user_id・共有データ`races`) |
| `docs/design/data-flow.md` | データフロー(通常購入/CSV取込/PDF取込 → 各テーブル) |
| `docs/design/csv-import.md` | CSV取込の仕様・着順/払戻レートの反映・確定扱いの統一・「馬／組番」列の解析 |
| `docs/design/screens.md` | 画面仕様(トップ/モーダル共通/購入履歴/レース管理/集計/購入/**馬券かご**/予想登録)・日時タイムゾーン・レスポンシブ対応 |
| `docs/design/race-edit-lock.md` | レース登録・編集・ロック仕様 |
| `docs/design/payout-refund.md` | 払戻確定時のticket反映(全ユーザー)・払戻確定バッジ/的中率判定・**返還(refund)処理** |
| `docs/design/stats-rules.md` | 集計ルール(収支・回収率・的中率の考え方) |
| `docs/design/data-search.md` | データ検索画面(レース成績集計)・`race_results`/`payouts` 横断集計・検索ハブ構成・API仕様 |
| `docs/design/ops.md` | CSSキャッシュ対策・DBマイグレーションの運用・DBファイルの役割 |

機能→コードの対応、共有ヘルパー(`functions/api/_lib/`)の構成、絶対不変条件は
ルートの`CLAUDE.md`、より詳しい索引は`docs/INDEX.md`を参照。
