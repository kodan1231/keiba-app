# 馬券帳 - 開発ガイド(Claude用)

Cloudflare Pages + Pages Functions + D1 で動く、疑似馬券購入・収支管理アプリ。
アプリ概要は `README.md`、詳細仕様は `docs/design/<機能>.md`(索引は `docs/DESIGN.md`)、
テスト観点は `docs/testing/<機能>.md`(索引は `docs/TESTING.md`)。

## トークンを無駄にしないための読み方

- **ドキュメントは全文を読まない**。まずこのファイルと `docs/INDEX.md` の索引で当たりをつける。
- 仕様は `docs/DESIGN.md`(索引)→ `docs/design/<機能>.md` の**対象1ファイルだけ** Read する。
  機能↔ファイルの対応は `docs/DESIGN.md` / `docs/INDEX.md` の「design/ ファイル索引」。
  節をまたぐ「〜」参照は見出し名 → `grep -rn "見出し" docs/design/`。
- テスト観点は `docs/TESTING.md`(索引)→ `docs/testing/<機能>.md` の**対象1ファイルだけ** Read する。
- design ファイルには「以前は〜だったが2026-08-XXに変更」という経緯記述が
  ロールバック防止のため本文に残っている。仕様の把握には読み飛ばしてよい。
- `archive/` 配下は「過去の経緯を明示的に聞かれた場合のみ」読む。通常は不要。
- 次にやるタスクは `docs/BACKLOG.md` 冒頭の「🔰次のチャットで最初に読むこと」だけで足りることが多い。
- 広い探索が必要なときは Explore サブエージェント(抜粋読み)を使う。

## 機能 → 触るファイル

| 機能 | ファイル |
|---|---|
| 馬券購入画面(UI/組み合わせ生成) | `public/buy.js`, `public/combos.js`, `public/bettypes.js`, `public/index.html` |
| 馬券かご(カート) | `public/cart.js`, `public/buy-purchase-modal.js` |
| 購入履歴画面 | `public/app.js`, `public/history.html` |
| 予想登録画面(予想印・馬メモ・過去成績) | `public/prediction.js`, `public/prediction.html`, `functions/api/races/[id]/horse-history.js` |
| 購入馬券グループ表示の共通部品(履歴・予想の両画面) | `public/ticket-view.js`(`groupTicketsByGroupId` `ticketMoneyText` `ticketGroupStatus` `selectionCellHtml` 等。history/prediction のみ読込) |
| 集計画面 | `public/stats.js`, `public/stats.html` |
| データ検索画面(レース成績集計) | `public/data-search.js`, `public/data-search.html`, `functions/api/data-search/race-stats.js` |
| レース管理画面(手動編集) | `public/races.js`, `public/races.html`, `public/races-entries-modal.js`, `public/races-payout-modal.js` |
| 出走馬一覧PDFインポート | `public/jra-entries-pdf.js`, `functions/api/races/entries-import.js` |
| JRAレース結果PDFインポート | `public/jra-result-pdf.js`, `functions/api/races/results-import.js` |
| PDF解析の共通処理 | `public/jra-pdf-common.js` |
| CSVインポート | `functions/api/ticket-imports/index.js` |
| 払戻計算ロジック | `public/payout.js`, `functions/api/_lib/ticket-payout.js` |
| 認証・ユーザー管理 | `functions/api/auth/*`, `functions/api/_lib/auth.js`, `public/auth.js` |
| 全画面共通のヘッダー/ナビ/ログイン画面 | `public/shell.js`(6HTMLへ実行時注入。ナビ項目は `NAV_ITEMS`、ページ固有ヘッダーボタンは `PAGE_ACTIONS`) |
| 騎手名エイリアス(管理API) | `functions/api/admin/jockey-aliases/*` |
| 騎手名エイリアス(正規化本体) | `functions/api/_lib/jockey-alias.js` |
| 馬名エイリアス(管理API・登録馬一覧) | `functions/api/admin/horse-aliases/*`, `functions/api/admin/horses/index.js` |
| 馬名エイリアス(正規化本体) | `functions/api/_lib/horse-alias.js` |
| 出走馬entriesマージ・バックフィル・枠番自動計算 | `functions/api/_lib/entries-merge.js` |
| race_results 詳細記録 | `functions/api/_lib/race-results.js` |
| 管理画面 | `public/admin.js`, `public/admin.html`, `functions/api/admin/*` |
| DBスキーマ変更 | `schema.sql`, `migration.sql`(`archive/migrations` は不要) |

## 共有ヘルパーの構成(重要)

サーバー側の横断ヘルパーは `functions/api/_lib/` 配下に機能別に分割されている。
`functions/api/_shared.js` は**それらを re-export するだけの薄い窓口**(全文でも22行)。
既存の `import { X } from "../_shared.js"` はそのまま動く。**新しい関数は `_lib/` の該当ファイルに追記する。**

| ファイル | 主な関数 |
|---|---|
| `_lib/http.js` | `jsonError(msg,status,extra?)` `readJsonBody(request)`→`{data}`\|`{error}` `parsePositiveIntId(raw,label?)`→`{id}`\|`{error}`。ハンドラは `const {data,error}=await readJsonBody(request); if(error) return error;` の形で使う |
| `_lib/auth.js` | `hashPassword` `verifyPassword` `isAdminUsername` `requireAdmin` `createSessionToken` `verifySessionToken` |
| `_lib/entries-merge.js` | `mergeEntriesByHorseName` `backfillHorseNamesForRace` `linkUnregisteredImportsToRace` `computeWakuNumberFromHorseNumber`(非export・内部) |
| `_lib/jockey-alias.js` | `jockeyAliasKeyOf` `loadJockeyAliasMap` `applyJockeyAliasMap` `applyJockeyAliasesToEntries` `normalizeExistingJockeyNames` |
| `_lib/horse-alias.js` | `horseAliasKeyOf`(NFKC+空白除去) `loadHorseAliasMap` `applyHorseAliasMap` `applyHorseAliasesToEntries` `normalizeExistingHorseNames` |
| `_lib/race-results.js` | `upsertRaceResults` `upsertRaceResultsBulk` |
| `_lib/ticket-payout.js` | `recomputeTicketPayoutsForRace` `recomputeTicketPayoutsForRaces` `findStoredRateServer`(非export・内部) |

## 絶対に破ってはいけない不変条件

- **`races` 行(`races.id`)を削除して作り直さない**。必ず「あればUPDATE、なければINSERT」。
  `prediction_marks` / `prediction_notes` が `ON DELETE CASCADE` で消える。
- **着順(`finish_order`)や払戻(`payouts`)を書き換えるコードパスでは、必ず
  `recomputeTicketPayoutsForRace` / `recomputeTicketPayoutsForRaces` を呼ぶ**
  (そのレースを購入した全ユーザーの `tickets.payout` 再計算)。
- **レース単位のループで1件ずつ DB へ問い合わせない**。Cloudflare Pages Functions の
  サブリクエスト数上限に抵触する。「まとめてSELECT → メモリ上で判定 → `db.batch()` でまとめて書き込む」方式にする。
- **`WHERE ... IN (?,?,…)` に渡す `?` の数は D1 の「1クエリ100バインドパラメータ」上限に注意**。
  件数が「1レースの出走馬」「1回の取込PDFのレース」等で自然にバウンドされるなら可。
  ユーザーの全履歴・全レース等、使い込むと増える集合を渡す場合は、対象テーブルが小さければ
  全件SELECTしてメモリ照合、大きければ90件ずつチャンク分割する
  (2026-09-08にこの上限超過で `GET /api/ticket-imports` が落ちる障害があった)。
- **馬の同一性は `horse_number` ではなく `horse_name`(馬名)をキーに判定する**。
  比較前に必ず空白正規化(全角スペース等を半角1つへ畳み込み・trim)を通す。
  レース横断で突き合わせる場合(予想画面の過去成績等)は `horseAliasKeyOf`
  (NFKC+全空白除去)+ `horse_aliases` を通す(`docs/design/horse-aliases.md`)。
- `prediction_marks` は `horse_number NOT NULL` かつ `UNIQUE(race_id, horse_number, user_id)`。
  馬番未確定の馬には予想印を付けられない(馬メモは馬名キーなので常に可)。
- `races` / `race_results` は全ユーザー共有(user_idなし)。`tickets` 等はユーザーごとに分離。
  またがる処理では「管理者に見えているデータ」と「更新すべき対象データ」が一致するとは限らない。
- **D1は無料枠(Workers Free)を維持する。有料プランへの切り替えは選択肢に入れない。**
  日次上限は `rows_read 500万/日` `rows_written 10万/日`(毎日UTC 0時=日本時間朝9時にリセット)。
  **どちらか一方でも超えると、読み取りを含むD1への全クエリが失敗する**(公式FAQ: "When your
  account hits the daily read and/or write limits, you will not be able to run queries
  against D1.")。「書き込みが90%」のような偏った警告でも、実際に全画面が真っ白になる
  (2026-09-12に実際に発生。原因は`races_cache`の保存失敗時に例外を投げていたため
  「保存できない→次アクセスでまた全件再計算→また保存失敗」のループに陥り、
  本来1回で済むはずの`races`全件読み取りを繰り返し発生させ、rows_read上限を先に
  使い切ったこと。詳細は`docs/BACKLOG.md`「D1無料枠の日次上限に関する注意」参照)。
  そのため **読み取り高速化のためのキャッシュ書き込み(`*_cache`系テーブルへの保存)は
  必ずbest-effort(try/catchで握りつぶし、失敗しても呼び出し元には読み取り結果を返す)**
  にする。保存の失敗が読み取り自体の失敗に波及してはならない。
- **大きな一括処理(複数ファイルのCSV/PDFインポート、管理画面の「一括補正」
  `normalizeExistingHorseNames`/`normalizeExistingJockeyNames`等)は、対象行数分の
  rows_written/rows_readを一度に消費する**(例: `race_results`全件へのNFKC一括補正で
  約4.2万行書き込み、18ファイル分のCSV結果一括インポートで約2.4万行書き込み、
  これらが同日に重なり10万行の大半を消費した実績あり)。**同じUTC日に複数の大きな
  一括処理を重ねない**。直前に日次上限の警告メールが来ている場合や、大きな一括処理を
  行う前に不安がある場合は、事前に `wrangler d1 insights <db名> --time-period 1d
  --sort-by writes` `--sort-by reads` で当日の消費状況を確認してから実行する。
- `migration.sql` の `@STEP` を手動で `wrangler d1 execute` 適用する前に、
  `SELECT name FROM schema_migrations WHERE name='...'` で未適用であることを確認する。
  (適用済みのステップを誤って再実行すると、`CREATE INDEX IF NOT EXISTS` のような
  本来無害なはずの文でも対象テーブルの全行数分のrows_written/readを消費することが
  観測されている。)

## 進め方

1. 要望の仕様矛盾・不足を確認 → 承認を得る
2. `docs/design/<機能>.md`(該当ファイル)を新仕様に合わせて更新(経緯記述は削らない)
3. 実装
4. 構文チェック(`node --check <file>`)
5. `docs/BACKLOG.md` のタスク表を更新(完了分は `archive/documents/BACKLOG_HISTORY.md` へ要約移動)

実機(wrangler dev / 本番)での動作確認は基本ユーザー側が行う。検証状況は報告時に明示する。
