> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# 騎手名エイリアス管理(jockey_aliases)

同一騎手が、登録経路によって異なる表記で保存されてしまう問題への対応。例(戸崎圭太騎手):

- JRAレース結果PDFインポート由来: 「戶崎 圭太」(JRA PDFフォント特有の異体字「戶」)
- レース情報のテキスト入力(netkeibaコピー貼り付け)由来: 「戸崎圭」(末尾の文字・区切り
  スペースが欠落。原因は`public/parse.js`側かnetkeiba側コピー元の時点かは未特定。
  `docs/BACKLOG.md`「調査中の不具合」参照)
- 手動修正: 「戸崎 圭太」(姓名間に全角スペース)

これらは表記としてすべて異なるため、`stats.html`の騎手別収支集計(完全一致でグルーピング)
が同一人物を複数行に分裂させてしまう。この問題への対応として`jockey_aliases`テーブルと
関連ロジックを新設した。

### 対応方針の切り分け

- **異体字(「戶崎」→「戸崎」等)の是正**: PDFインポート側(`jra-result-pdf.js`)の
  文字正規化ロジックで対応する(このドキュメントの「JRAレース結果PDFインポート」
  「全角文字正規化の方針」参照)。**本節(`jockey_aliases`)の対応範囲外。**
- **表記ゆれ全般(異体字以外)の吸収**: 本節の`jockey_aliases`テーブルおよび
  `applyJockeyAliasMap()`等のロジックで対応する。異体字修正が別途入った後も、
  本節の仕組みは他の表記ゆれ(文字欠落・スペース有無等)を補完的に吸収し続ける。

### スキーマ

```sql
CREATE TABLE jockey_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_key TEXT NOT NULL UNIQUE,   -- 突き合わせキー。見習い減量記号(☆▲△★◇)と
                                     -- 空白(全角/半角)を除去した文字列
  alias_display TEXT NOT NULL,      -- 表記ゆれ側の元の見た目(管理画面での参考表示用)
  canonical_name TEXT NOT NULL,     -- 正しい表記(見習い記号は含めない)
  created_at TEXT DEFAULT (datetime('now'))
);
```

- `alias_key`の生成ロジック(`jockeyAliasKeyOf()`、`functions/api/_lib/jockey-alias.js`): 先頭の見習い
  減量記号を除去した上で、残りの全角/半角スペースをすべて除去する。これにより「戸崎 圭太」
  「戸崎圭太」は同一キーになる(**要件: 姓名間のスペース有無は同一人物として扱う**)
- `canonical_name`には見習い記号を含めない。正規化適用時、取込側の表記に見習い記号が
  あれば、正規化後の名前の先頭に復元する(`applyJockeyAliasMap()`)

### 正規化を適用する2つの経路

**(1) 今後登録されるデータの救済(登録・取込時に自動正規化)**

以下の保存直前に、`jockey_aliases`と突き合わせて正規化する。マッチするエイリアスが
無い表記は変更しない(誤爆防止。エイリアス未登録の新種の表記ゆれは、後述(2)の
一括補正、または管理画面からのエイリアス追加で個別に対応する)。

| 経路 | 実装箇所 | 備考 |
|---|---|---|
| レース新規登録(手動入力・netkeibaテキスト貼り付けの一括入力を含む) | `functions/api/races/index.js`(POST) | `entries[].jockey`を正規化 |
| レース編集(同上) | `functions/api/races/[id].js`(PUT) | `entries`が含まれる場合のみ正規化 |
| 出走馬一覧PDFインポート | `functions/api/races/entries-import.js` | マージ前の`incomingEntries[].jockey`を正規化 |
| JRAレース結果PDFインポート | `functions/api/races/results-import.js` | `entries[].jockey`・`race_results[].jockey`の両方を正規化 |

いずれも、リクエスト内に含まれる騎手名の件数分DBへ問い合わせる(N+1)のを避けるため、
リクエストの先頭で`loadJockeyAliasMap(db)`によりエイリアス全件を1回だけMapとして取得し、
以降は`applyJockeyAliasMap(map, name)`でメモリ上のMap参照のみで正規化する
(`functions/api/ticket-imports/index.js`等、既存のN+1回避パターンを踏襲)。

購入時(`tickets.selections`)は`races.entries`から複写されるだけのため、上記の経路で
正規化されていれば自動的に揃う。

**(2) 既に登録されているデータの救済(一括補正・手動実行)**

上記(1)で救済しきれないもの(過去に登録済みのデータ、(1)導入前のデータ、想定外の
表記ゆれ)は、管理画面(`admin.html`)の「既存データの騎手名を一括補正する」ボタンから
明示的に実行する`normalizeExistingJockeyNames(db)`(`functions/api/_lib/jockey-alias.js`)で対応する。

対象テーブル・カラム:

- `races.entries`(JSON配列。各要素の`jockey`)
- `race_results.jockey`
- `tickets.selections`(JSON配列。各要素の`jockey`)
- `imported_ticket_items.selections`(JSON配列。各要素の`jockey`)

各テーブルとも「1回のSELECTで全件取得→メモリ上で`jockey_aliases`と突き合わせて判定→
変更が必要な行だけ`db.batch()`でまとめてUPDATE」という、本プロジェクトの他のバッチ処理
(CSVインポート等)と同じ方式でCloudflare Workersのサブリクエスト数上限を回避する。
`jockey_aliases`に登録されていない表記は対象外(誤爆防止)。ボタンを押した時だけ実行され、
自動実行はしない。エイリアスとの完全一致判定のみのため、**何度実行しても安全(冪等)。**

### 管理画面(`admin.html`)でのエイリアス管理

- 一覧表示(表記ゆれ側・正しい表記・登録日時・削除ボタン)。**一覧の並び順は
  「表記ゆれ側(`alias_display`)の文字列昇順」で表示する**。表記ゆれ側の文字列比較は、
  SQLiteの標準的なバイト順比較で行う(このアプリの他画面の名前列ソート(`stats.js`)と
  同じ方式に揃える。厳密な五十音順(濁点・拗音等の正規化)までは行わない)。同じ表記ゆれ側の
  値が複数ある場合は、登録日時の新しい順を副次キーとして使う
- 追加フォーム(表記ゆれ側・正しい表記の2つのテキスト入力)。`alias_key`が既存のものと
  重複する場合はエラーを返す(サーバー側`POST /api/admin/jockey-aliases`でUNIQUE制約違反を
  検知)
- 「既存データの騎手名を一括補正する」ボタン(上記(2))
- 編集(更新)機能は無い。表記を訂正したい場合は削除して登録し直す
- API: `GET/POST /api/admin/jockey-aliases`・`DELETE /api/admin/jockey-aliases/:id`・
  `POST /api/admin/jockey-aliases/normalize-existing`。いずれも管理者限定
  (`requireAdmin()`)

### 今回のスコープに含めないもの(BACKLOGへ引き継ぎ)

- netkeibaテキスト貼り付けで「戸崎圭」のように文字が欠落する根本原因の調査
  (`public/parse.js`側の解析処理か、netkeiba側のコピー元テキスト自体が省略表示だったのか
  の切り分けが必要。`docs/BACKLOG.md`「調査中の不具合」参照)
- JRA PDFの異体字(「戶崎」等)自体の是正(別タスクとして進行中。本節の対応範囲外)
- エイリアスの編集(更新)機能、CSVでの一括インポート/エクスポート
- 一覧の五十音順ソートを、濁点・半濁点・拗音・カタカナ/ひらがな差を吸収した厳密な
  読み仮名順にすること(今回はSQLiteの標準文字列比較による昇順にとどめる)
