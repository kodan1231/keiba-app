> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# 馬名エイリアス管理(horse_aliases)

同一馬が、登録経路によって異なる表記で保存されてしまう問題への対応。`jockey_aliases`
(騎手名エイリアス)と同じ構図の、馬名版。

- JRAレース結果PDFインポート由来: `race_results.horse_name`(parser の生値。空白の入り方が
  まちまち、稀に半角カナ・異体字)
- 出走馬一覧PDFインポート/手動入力由来: `races.entries[].horse_name`

これらの表記が食い違うと、予想登録画面の「過去成績(出走履歴)」
(`docs/design/race-results.md`「予想登録画面での過去成績参照」)が、同じ馬なのに
`race_results` と `races.entries` を突き合わせられず、履歴が出ない。

### 突き合わせキー(alias_key)

`horseAliasKeyOf()`(`functions/api/_lib/horse-alias.js`):

```
NFKC 正規化 → 全角/半角スペース等をすべて除去
```

- **NFKC** で半角カナ→全角カナ・互換文字を畳む(`ﾖﾙｳﾞｨｯｸ` → `ヨルヴィック`)
- **空白除去** で全角/半角スペースの有無を吸収
- JRA の馬名は全国で一意に登録されるため、幅・空白を落としても別馬と衝突しない

**この正規化だけで吸収できるズレ(半角/全角・空白)は、エイリアス登録なしで自動的に
突き合わせが成立する。** それでも揃わない表記ゆれ(異体字・文字欠落・別表記)を、
管理画面から「表記ゆれ側 → 正しい馬名」として明示登録する。

### スキーマ

```sql
CREATE TABLE horse_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_key TEXT NOT NULL UNIQUE,   -- horseAliasKeyOf(表記ゆれ側)
  alias_display TEXT NOT NULL,      -- 表記ゆれ側の元の見た目(管理画面での参考表示用)
  canonical_name TEXT NOT NULL,     -- 正しい馬名
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 正規化を適用する経路

**(1) 今後登録されるデータ(登録・取込時に自動正規化)**

| 経路 | 実装箇所 | 対象 |
|---|---|---|
| レース新規登録(手動・netkeibaテキスト貼り付け) | `functions/api/races/index.js`(POST) | `entries[].horse_name` |
| レース編集 | `functions/api/races/[id].js`(PUT) | `entries` が含まれる場合のみ |
| 出走馬一覧PDFインポート | `functions/api/races/entries-import.js` | マージ前の `incomingEntries[].horse_name` |
| JRAレース結果PDFインポート | `functions/api/races/results-import.js` | `entries[].horse_name`・`race_results[].horse_name` |
| 馬メモ保存 | `functions/api/horse-notes/index.js`(POST) | `horse_notes.horse_name` |

いずれも、リクエストの先頭で `loadHorseAliasMap(db)` により全件を1回だけ Map として取得し、
以降は `applyHorseAliasMap(map, name)` でメモリ参照のみで正規化する(N+1 回避。
`jockey_aliases` と同じパターン)。マッチしない表記は変更しない(誤爆防止)。

**(1') 読み取り時の正規化**

`GET /api/races`(`functions/api/races/index.js`)は、保存済みの `entries[].horse_name` を
読み取り時にも `horse_aliases`(および `jockey_aliases`)で正規化して返す。全画面共通の
入口でここで揃えておくことで、予想画面の過去成績突き合わせ・集計等が一律に恩恵を受ける
(バックフィル前でも表示が揃う)。

`GET /api/horse-notes?race_id=` / `GET /api/races/:id/horse-history` も、突き合わせ時に
`horseAliasKeyOf` + `horse_aliases` を通す。`horse-history` は SQLite で NFKC ができない
ため、`race_results` を「今のレース以外」全件取得してメモリで突き合わせる
(1クエリ・サブリクエスト増なし)。

**(2) 既に登録されているデータ(一括補正・手動実行)**

管理画面の「既存データの馬名を一括補正する」ボタン →
`normalizeExistingHorseNames(db)`(`functions/api/_lib/horse-alias.js`)。
`horse_aliases` に登録済みのエイリアスとキーが一致する馬名だけを対象に書き換える。
対象テーブル・カラム:

- `races.entries`(JSON配列。各要素の `horse_name`)
- `race_results.horse_name`
- `horse_notes.horse_name`
- `tickets.selections`(JSON配列。各要素の `horse_name`)
- `imported_ticket_items.selections`(JSON配列。各要素の `horse_name`)

各テーブルとも「1回の SELECT で全件取得 → メモリ判定 → 変更行だけ `db.batch()`」方式で
サブリクエスト数上限を回避する。未登録の表記ゆれは対象外。**何度実行しても安全(冪等)。**

**`horse_notes` の衝突扱い**: `horse_notes` は `UNIQUE(horse_name, user_id)`。
「表記ゆれ名のメモ」と「正しい名の既存メモ」が同一ユーザーで両方あると衝突するため、
**集約先(正しい名の行)へ両方のメモを改行連結し、表記ゆれ名の行は削除する**
(データを失わない)。

### 管理画面(`admin.html`「馬名エイリアス管理」セクション)

- **登録馬一覧**: `GET /api/admin/horses`(管理者限定)。`races.entries` ∪ `race_results` ∪
  自分の `horse_notes` ∪ `horse_aliases` に現れる馬名を、`horseAliasKeyOf` + `horse_aliases`
  で1件に畳んで返す。3クエリ(races 全件 / race_results / 自分の horse_notes)をメモリ集計。
  - **50音行ボタン**(`ア カ サ タ ナ ハ マ ヤ ラ ワ その他`)+ **検索ボックス**(部分一致)。
    行 or 検索語が無ければ一覧は返さず、行ごとの件数(`rowCounts`)だけ返す(全件は重いため)
  - 濁点・小書き・半濁点は基本行へ寄せる(`ガ`→カ行、`パ`→ハ行、`ァ`→ア行)。
    カタカナ以外(漢字・英数等)は「その他」
  - 一覧の各行: `馬名 | 出走表(出現レース数) | 結果(出現レース数) | メモ有無 | 表記ゆれ | 操作`
  - **表記ゆれ**: 同一キーに複数の生表記があると `mismatch` フラグ + 行を色付け。
    生表記チップをクリックすると「表記ゆれ側」入力欄へプリフィル
  - 「エイリアス登録」ボタンでその馬名を「表記ゆれ側」へプリフィル
- **追加フォーム**(表記ゆれ側 / 正しい馬名)。`alias_key` が既存と重複すると 409
- **既存エイリアス表**(表記ゆれ側・正しい馬名・登録日時・削除)。並び順は
  `alias_display` の文字列昇順(`jockey_aliases` と同じ。厳密な五十音順ではない)
- **「既存データの馬名を一括補正する」ボタン**(上記(2))
- 編集(更新)機能は無い。訂正は削除して登録し直す
- API: `GET/POST /api/admin/horse-aliases`・`DELETE /api/admin/horse-aliases/:id`・
  `POST /api/admin/horse-aliases/normalize-existing`・`GET /api/admin/horses`。
  いずれも管理者限定(`requireAdmin()`)

### スコープ外(必要になったら別タスク)

- エイリアスの編集(更新)機能、CSV での一括インポート/エクスポート
- 異体字の是正を PDF parser 側で行うこと(`jockey_aliases` と同じく、本節は
  parser 側の是正が入った後も補完的に表記ゆれを吸収し続ける位置づけ)
- `race_results` を使い込んで巨大化したときの `horse-history` 全件スキャンの最適化
  (race_date 上限等でのバウンド)
