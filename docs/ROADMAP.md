# 大型・保留・将来構想タスク(ROADMAP)

`docs/BACKLOG.md` から分離した大型タスク置き場。**直近着手すべきタスクは `docs/BACKLOG.md`
の「優先順位」を参照。** 本ファイルで現在も生きているのは**クラスタM のみ**
(F=実装済み / H=対象外 / I=完了。いずれも下に経緯だけ残す)。

## クラスタF: 馬券かご機能 — 実装済み(2026-09-06〜07)

`public/cart.js` + `functions/api/tickets/bulk.js` として実装完了。都度保存フローは廃止し
「かごに追加 → まとめて購入」に一本化。現行仕様は `docs/design/screens.md`「馬券かご機能」。

## クラスタH: 外部データ自動取得 — 対象外(2026-09-08)

外部サイト/APIからの自動取得は手段自体が存在しないため対象外とする。現実解は現状の
「ユーザーが手動保存した PDF/CSV をインポート」で、その延長でUXを磨く方向。

- **JRA-VAN Data Lab.**: 唯一のインターフェース「JV-Link」が Windows専用 ActiveX COM。
  Cloudflare Pages Functions からは技術的に呼べない
- **JRA公式サイト(jra.go.jp)**: bot対策で即ブロック(規約以前に技術的に不可)
- **netkeiba**: 利用規約でスクレイピング明示禁止

方針転換する場合の選択肢(A: 貼り付け/PDF方式を磨く=現状 / B: 有料スクレイピング代行API /
C: Windows常時稼働機で JV-Link 中継サーバー)は git 履歴を参照。

## クラスタI: リファクタリング候補 — 完了(2026-09-08)

トークン効率化リファクタリングは 2026-09-07〜08 に完了(フォーマッタ集約・サーバハンドラ
定型コード集約・HTML共通シェル・デッドコード削除・トラックリスト重複整理・`buy.js`/`races.js`
分割・`jra-result-pdf.js` パーサ分割・購入馬券グループ描画の部品共通化)。
**経緯の詳細は `archive/documents/BACKLOG_HISTORY.md` 期間9。**

CSS/JS キャッシュ制御も完了(2026-09-08)。`public/_headers` の `Cache-Control: no-cache` へ
移行し、全HTMLから `?v=` を除去した(`docs/design/ops.md`「CSS / JS のキャッシュ対策」)。

## クラスタM: race_resultsを使った集計・参照画面

`race_results`を参照・集計する画面を追加するタスク。**主要な2機能は実装済み**:

### 馬名ベースの集計 — 実装済み(2026-09-10)

予想登録画面の馬行に「過去成績(出走履歴)」を表示。`GET /api/races/:id/horse-history`
(馬名キー・`race_date`降順・全件)。詳細は `docs/design/screens.md`「予想登録画面」と
BACKLOG「完了済み(2026-09-10)」。専用の馬名検索画面は今のところ未着手(必要になったら)。

### 騎手名ベースの集計 — 実装済み(2026-09-10)

「データ検索」画面(`data-search.html`)の「レース成績」タブとして実装。競馬場・コース種別・
距離で絞り、平均単勝/馬連金額・単勝○円以下率・高勝率/高複勝率騎手トップ5・馬番別成績を
表示する。全ログインユーザー閲覧可。仕様は `docs/design/data-search.md`。

### 残タスク(優先度低)

- `races(track, course_type, distance)` の複合インデックス追加(`race_results` の行数が
  増えて「データ検索」が重くなったら。`migration.sql` に `@STEP` ブロックを追記)
- 「データ検索」を検索ハブとして、馬名検索・騎手個別検索タブを追加するか検討
- 降着・失格馬の `race_results.status` 対応(現状 `finished` 扱い)
