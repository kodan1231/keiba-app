# 未着手タスク・調査中の不具合 引継ぎメモ

**これから対応すること**を記録する場所(現状仕様は `docs/design/`、完了経緯は
`archive/documents/BACKLOG_HISTORY.md`)。着手したら該当項目を本ファイルから削除し、
仕様は `docs/design/<機能>.md` へ、経緯は BACKLOG_HISTORY へ反映する。
大型・保留・将来構想は `docs/ROADMAP.md`(クラスタH・M)。

- **進め方**: ①仕様確認→承認 → ②`docs/design/<機能>.md` 更新 → ③実装 →
  ④`node --check` → ⑤本ファイル更新(完了分は BACKLOG_HISTORY へ要約移動)。詳細は `CLAUDE.md`。
- **実機確認はユーザー側**。Claude は `node --check` と静的レビュー・シミュレーションのみ。
  着手・完了報告時に検証状況を明示する。

## 🔰 次のチャットで最初に読むこと(最終更新 2026-09-08)

- **読む順**: `CLAUDE.md`(自動)→ 本セクション → `docs/INDEX.md` で対象ファイルを特定 →
  `docs/design/<機能>.md` を対象1ファイルだけ。過去の完了経緯は
  `archive/documents/BACKLOG_HISTORY.md`(明示的に聞かれた時のみ)。
- **未適用のマイグレーションあり(2026-09-12)**: `migration.sql` の `@STEP: races_cache`
  (`races_cache`テーブル+`races`書き込み時の自動無効化トリガー追加)が本番DB
  `keiba-yosou-db` へ未適用。適用後はボタン操作等不要(初回アクセス時に自動計算される)。
  `race_results_horse_key`・`race_stats_cache` は適用済み・`schema_migrations` 記録済み
  (`horse_key` の既存行バックフィルも完了。`race_results` 14768件更新)。
  実ブラウザでの数値確認は未実施(下記「🔵 実機検証未完了」参照)。
- **直近の状況**: トークン効率化リファクタリング完了(2026-09-07〜08。BACKLOG_HISTORY 期間9)。
  その後 予想画面の過去成績表示(2026-09-10)・管理者パスワードリセット(2026-09-10)・
  データ検索画面「レース成績」タブ(2026-09-10。ROADMAP クラスタM の騎手名ベース集計)・
  結果PDF/出走馬一覧PDFの複数ファイルインポート(2026-09-10)・
  馬名エイリアス `horse_aliases` + 登録馬一覧(2026-09-11)・
  **D1日次行読み取り上限超過障害への対応**(2026-09-11〜12。`horse-history`/`race-stats` の
  全件スキャン解消+`race-stats`のrace_results事前計算キャッシュ化。ユーザー数増加を
  見据えた対応)・**購入馬券グループのIPAT風コンパクト表示**(2026-09-12。JRA公式IPATに
  見た目を寄せ、box/フォーメーション/ながし等の全組み合わせ展開をやめ入力した形で
  見せる)・**`GET /api/ticket-imports`のD1読み取り上限逼迫の修正**(2026-09-12。
  `imported_ticket_items`を全ユーザー分全件SELECTしていたのが原因で日次上限の75%を
  1エンドポイントだけで消費していた障害。`group_id IN (...)`絞り込みに変更)・
  **`races_cache`の先回り導入**(2026-09-12。`races`も同じ「テーブルが小さい前提」の
  全件SELECTが`GET /api/races`〈全画面共通の入口〉・データ検索画面・CSV取込一覧の
  複数箇所にあり、ユーザー数増加時に同じ障害が再発するリスクがあったため、
  `race_stats_cache`と同じ発想の事前計算キャッシュを先回りで導入。要マイグレーション
  適用)を追加。
  下記「⚠️ 調査中の不具合」の 🔵 実機検証未完了に、ユーザー確認待ちの項目がある。
- **次に着手するタスク**: 下記「優先順位」の A 段(CSV返還行 payout〈CSVサンプル待ち〉)。
  片付いたら B 段へ。

## ⚠️ 調査中の不具合(未解決・修正未承認)

| 状態 | 内容 | 詳細 |
|---|---|---|
| 🟡 未修正(要サンプルCSV確認) | CSVインポートで「的中／返還」列が「的中」を含まない行(出走取消等による返還を想定)は、`payout`が一律0円(全損)として計算されている可能性がある。返還の場合は本来ほぼ全額が払い戻される(収支への影響は±0に近いはず)ため、実データでの表記を確認したうえで対応要否を判断する必要がある | `docs/design/csv-import.md`「CSV取込の仕様」要確認 |
| 🟡 未対応(今回対象外) | 降着・失格など、取消・除外・中止以外の着順未確定ケースは`race_results.status`で扱えない。将来`demoted`/`disqualified`等のstatus値を追加する拡張が必要 | `docs/design/race-results.md`「レース結果の詳細記録(race_results)」取消・除外・中止の扱い |
| 🔵 実機検証未完了 | 返還(refund)処理(`tickets.refunded`列・`recomputeTicketPayoutsForRace`/`computeTicketPayout`の返還判定・`stats.js`の的中率集計除外)の実ブラウザでの挙動確認が未実施(コードレビューのみ)。`tickets.refunded`列は本番DBに適用済み | `docs/design/payout-refund.md`「返還(refund)処理」 |
| 🔵 実機検証未完了 | JRA結果PDF / 出走馬一覧PDF インポートの複数ファイル選択対応(`multiple`・`jraPdfParseFiles()`・ファイル単位の順次POST)は `node --check` のみ。**実ブラウザで**: 複数PDF選択→解析でファイルごとの折りたたみ診断が出ること、重複レースの除外表示、登録が「(3/10) ファイル名」進捗で1ファイルずつ実行され最後にサマリが出ること、1ファイル解析失敗時に他が継続すること、単一ファイル時に従来どおり動くこと、を確認する | `docs/design/results-import.md`「複数ファイルの一括選択」 |
| 🔵 実機検証未完了 | データ検索画面「レース成績」タブ(新規。`data-search.html`/`.js`・`GET /api/data-search/race-stats`・NAV「データ検索」)は `node --check` とローカルDBでの馬番別集計シミュレーションのみ。**実DB(本番)で**: 競馬場・コース種別・距離の各フィルタ、距離セレクトが競馬場/コース種別選択で絞られること、平均単勝/馬連金額・○円以下率・騎手トップ5(足切り `max(5,⌈対象レース数×5%⌉)`)・馬番別成績の数値が妥当か、③④⑤の着順ソース使い分け(`race_results` 全頭ぶんあり→それ / 不足→`finish_order`+`entries`)が効いているかを確認する | `docs/design/data-search.md` |
| 🔵 実機検証未完了 | JRAレース結果PDFパーサの関数分割(2026-09-08。`jraResultParseExtractedPages` 527行 → `detectRaceHeaders()` + `parseRaceBlock()` に抽出)は`node --check`と原本との行集合突き合わせのみ。**実PDF(できれば複数レース入り)を1件インポートし、分割前と比較**: レース数・レース名・コース/距離・1〜3着・払戻レート(全式別)・`race_results`詳細・取消/除外/中止行・`incident_note`・診断パネルの各カウンタ(`raceHeaders`/`resultRows`/`payoutItems`等)が一致すること。診断パネルのバージョンに`-split`が付いていれば新コード | `docs/design/results-import.md`「解析ロジックの要点」 |
| 🔵 実機検証未完了 | 枠番自動計算の不具合修正(2026-09-08。7頭以下で枠番が後ろへずれる問題。`computeWakuNumberFromHorseNumber()` / `defaultWakuNumber()` に `horseCount<=8` の早期リターン + `mergeEntriesByHorseName()` に「馬番1〜N連番の8頭以下」限定の既存値補正)は`node --check`と頭数3〜18でのアルゴリズム出力確認のみ。**7頭以下のレースを実際にPDFインポートまたは再インポートし、枠番が馬番と一致すること**を確認する必要がある | `docs/design/data-model.md`「枠番は馬番から自動計算して保存する」 |
| 🔵 実機検証未完了(要マイグレーション適用) | `races_cache`の先回り導入(2026-09-12。`races`を無条件に全件SELECTする箇所〈`GET /api/races`本体・`GET /api/data-search/race-stats`・`GET /api/ticket-imports`のコース情報付与〉が複数あり、`imported_ticket_items`と同じ「テーブルが育つ前提の無い全件SELECT」構造だったため、`race_stats_cache`と同じ発想で先回りキャッシュ化した。`_lib/races-cache.js`の`getAllRacesRaw()`。`races`へのINSERT/UPDATE/DELETEでDBトリガーが自動無効化)は`node --check`のみ。**本番適用手順**: `migration.sql`の`@STEP: races_cache`を`wrangler d1 execute --remote`で適用(バックフィル等のボタン操作は不要)。**実ブラウザで**: 馬券購入画面のレース一覧・購入履歴画面・データ検索画面・CSV取込一覧が従来通り表示されること、レースの新規登録/編集/PDFインポート直後に一覧へ即座に反映されること(トリガーによる自動無効化の確認)を確認する | `docs/design/data-model.md`「races全件取得の事前計算キャッシュ(races_cache)」 |
| 🔵 実機検証未完了 | `GET /api/ticket-imports`のD1読み取り上限逼迫の修正(2026-09-12。`wrangler d1 insights`で判明: `imported_ticket_items`を全ユーザー分全件SELECTする設計〈テーブルが小さい前提〉が、テーブルが5,600行超まで育ったことで破綻し、このGET1エンドポイントだけで1日137回・768,707行〈日次上限500万行の約15%〉を消費していた。自分の`imported_ticket_groups.id`集合で`WHERE group_id IN (...)`〈90件チャンク・既存の`idx_imported_items_group`使用〉に絞り込む方式へ変更)は`node --check`のみ。**実ブラウザで**: 購入履歴画面のCSV取込グループ一覧が従来通り表示されること(自分の取込分の内容が欠けていないこと)、集計画面「コース別収支」への影響が無いことを確認する。修正後の読み取り量が実際に減っているかは`wrangler d1 insights`で後日確認するとよい | `functions/api/ticket-imports/index.js` |
| 🔵 実機検証未完了 | 購入馬券グループのIPAT風コンパクト表示(2026-09-12。JRA公式IPAT「照会結果詳細」に見た目を寄せ、box/フォーメーション/ながし等で生成された全組み合わせを展開せず「入力した形」〈馬番一覧・着順ごとの馬番・軸馬/相手〉を数行で見せる新設。`ticket-view.js`の`describeGroupSelections()`/`groupCompactSummaryHtml()`。method文字列不問でCSV取込グループにも適用)は`node --check`とNode上でのbox(60点)/フォーメーション/2頭軸ながし/単勝まとめ買いパターンの出力確認のみ。**実ブラウザで**: 購入履歴画面・予想登録画面の両方で、通常購入・box・フォーメーション・ながし(1頭軸/2頭軸)・CSV取込の各グループを展開し、コンパクト表示の内容が実際の買い目と一致すること、「内訳を見る」トグルで1点ごとの明細(当落・個別金額編集・削除)が問題なく開閉・動作すること、を確認する。着順なし券種の複雑なフォーメーション(各着順が完全に別集合)は「馬番:全馬番の一覧」に丸められる既知の制約があるため、該当パターンがあれば見え方を確認する | `docs/design/screens.md`「購入馬券グループの表示(IPAT風コンパクト表示)」 |
| 🔵 実機検証未完了 | D1日次行読み取り上限(500万行)超過障害(2026-09-11)への対応。①`GET /api/races/:id/horse-history`:`race_results.horse_key`列+インデックスを追加し、全件スキャン→`WHERE horse_key IN (...)`の直接絞り込みに変更(あわせて馬ごと直近5走まで・`field_size`の相関サブクエリ解消)。②`GET /api/data-search/race-stats`:`race_results`とのJOIN全件スキャン→フィルタ該当`race_id`のみ`IN`(90件チャンク)取得 →(2026-09-12。ユーザー数増加を見据え)`race_stats_cache`テーブルへの事前計算キャッシュ化(`race_results`書き込み時にDBトリガーで自動無効化・次回読み取り時に自動再計算)に変更。マイグレーション適用・`horse_key`バックフィル(`race_results` 14768件)は2026-09-12に本番完了済み。`node --check`と設計上のシミュレーションのみで、**実ブラウザでの数値確認が未実施**: 予想登録画面で過去成績が(旧仕様と同じ内容で・直近5走に絞られた形で)表示されること、データ検索画面「レース成績」タブが従来と同じ数値を返すこと、結果PDFを再取込した際にレース成績タブの数値が更新されること(トリガーによる自動再計算の確認)を確認する | `docs/design/horse-aliases.md`「`race_results.horse_key`」・`docs/design/race-results.md`「予想登録画面での過去成績参照」・`docs/design/data-search.md`「サーバー処理」 |

## 優先順位(2026-09-08。ユーザー方針を反映)

### A. 早め(次に着手・コスト小〜中)

| タスク | コスト | 内容 |
|---|---|---|
| **CSV返還行の payout 見直し** | 小〜中 | **早め対応。CSVサンプルをユーザーからもらうのが前提**。「的中/返還」列が「的中」を含まない返還行(出走取消等)の payout が全損計算になっている可能性。PDFインポート側の返還処理と設計を揃える |

> 完了済み(2026-09-08 = このセッション): N-3 ログアウト401 / 払戻の矢印区切り(結果PDFは
> 全式別 `-` で問題なしと実PDF確認。`→` 対応は保険として追加)/ payout マージを常に上書きに
> (結果PDFは `mode:"overwrite"`)/ **CSV取込後の再計算**(`recomputeTicketPayoutsForRace(s)` が
> `imported_ticket_items` も再計算)/ **N-4 第1段階**(予想画面の馬一覧に性齢・負担重量・騎手を
> 「・」区切り表示。race一覧カード/払戻モーダルの `weight_type` 等は第2段階として据え置き)/
> **CSSキャッシュ一元化**(`public/_headers` で `/*.css` `/*.js` を `Cache-Control: no-cache`。
> 全HTMLから `?v=` を除去。`docs/design/ops.md` 参照)/ **旧クラスタA 履歴の一括削除**
> (通常購入のみ。CSV取込分は対象外。`POST /api/tickets/bulk-delete` 新設。
> `docs/design/screens.md`「履歴の一括削除(選択モード)」)/ **旧クラスタC コース別収支**
> (集計画面の「競馬場別」タブを「コース別」= 競馬場×芝/ダ/障×距離 に置換)。
> 詳細は BACKLOG_HISTORY 期間9。
>
> 完了済み(2026-09-11): **JRAレース結果PDFインポートで性齢・負担重量が `races.entries`
> に反映されない不具合を修正**。`public/jra-result-pdf.js` は性齢・負担重量を
> `race_results` 用の行(`jraResultParseFullResultRow`/`ScratchRow`/`StopRow`)からは
> 抽出していたが、同時に構築する `entries`(予想登録画面の馬名行が参照)には渡していな
> かった。新規 `jraResultApplySexAgeWeightToEntries()` で entries 側にも反映するよう
> 修正。既存データは `race_results`→`races.entries` への一括バックフィルを本番DBへ直接
> 実行済み(2026-09-11。`wrangler d1 execute --remote`。horse_number未確定・重複馬番は
> 対象外・空欄のみ埋める・既存値は上書きしない)。**全1197レース中917レースを更新、
> 出走馬15,862頭中15,383頭(97%)に性齢・負担重量が入った状態に**。適用前後で
> レース数・出走馬数・JSON妥当性が一致することを確認済み。残り約480頭は
> `race_results` 自体にその馬の行が無い(結果PDF未取込)ケース。
> `docs/design/data-model.md`「races.entriesへの性齢・負担重量の追加」更新済み。
> `node --check` 済み・パーサー単体の疑似データ確認済み・実PDFでの確認は未実施。
>
> 完了済み(2026-09-11): **馬名エイリアス(`horse_aliases`)機能を新設**(騎手名エイリアスの
> 馬名版)。同じ馬が `race_results` と `races.entries` で表記ゆれ(半角/全角カナ・空白・異体字)
> を起こし予想画面の過去成績が紐付かない問題への対応。突き合わせキーは `horseAliasKeyOf`
> (NFKC + 全空白除去)+ 明示エイリアス。**半角/全角・空白のズレはエイリアス登録なしで
> 自動吸収**。新規: `functions/api/_lib/horse-alias.js` / `functions/api/admin/horse-aliases/*` /
> `functions/api/admin/horses/index.js`(登録馬一覧。50音行 + 検索)。変更: `races/index.js`
> (GET で読み取り時も正規化・POST)/ `races/[id].js`(PUT)/ `entries-import.js` /
> `results-import.js` / `horse-notes/index.js` / `races/[id]/horse-history.js`(突き合わせを
> エイリアスキーへ・`race_results` 全件スキャン方式へ変更)/ `public/admin.{html,js}` /
> `public/style.css` / `schema.sql` / `migration.sql`(`@STEP: horse_aliases`)。
> `docs/design/horse-aliases.md` 新規・索引3ファイル・`data-model.md`・`screens.md`・
> `race-results.md`・`CLAUDE.md` 更新。`node --check` 済み + `wrangler pages dev` +
> ローカルD1 で「NFKC自動突き合わせ / エイリアス登録 / 一括補正 / 登録馬一覧」を実機確認。
> **本番DBへ `horse_aliases` マイグレーション適用が必要**(上の 🔰 参照)。
>
> 完了済み(2026-09-11): **過去成績の巻き添え不具合修正**。`horse-history` の取得を
> `selectRace()` の `Promise.all` から外し独立関数 `loadHorseHistory()` へ。応答が非JSONだと
> `await res.json()` が throw して `applyHorseNotes` まで止まり馬メモが消えていた。
>
> 完了済み(2026-09-10): **予想登録画面に「過去成績(出走履歴)」表示を追加**。馬の行を
> 開くと馬メモの下に、その馬の `race_results` 由来の過去出走(表示中レースを除く・馬名
> 突き合わせ・`race_date` 降順で全件)を表で出す。新規 `GET /api/races/:id/horse-history`
> (`functions/api/races/[id]/horse-history.js`。JOIN + 相関サブクエリでクエリ1本、
> バインドは出走頭数バウンド)。列=日付/場R/コース/着順(N着/M頭)/人気/騎手/斤量/
> 馬体重(増減)/タイム/着差、横スクロール。あわせて **馬行の開閉「＋/−」記号を廃止**
> (行クリックでの開閉は維持)。変更: `public/prediction.js` / `public/style.css`
> (`.horse-history*`)。`docs/design/screens.md`「予想登録画面」・
> `docs/design/race-results.md`「予想登録画面での過去成績参照」更新済み。
> `node --check` 済み・実機確認は未実施。
>
> 完了済み(2026-09-10): **管理者によるパスワードリセット機能**。管理画面の登録ユーザー
> 一覧に「パスワードリセット」ボタン(自分の行を除く)。管理者が入力した新パスワードで
> `password_hash` を上書きし `users.password_reset_pending=1`。対象ユーザーには全画面
> 冒頭のバナー(`GET /api/auth/check` が返す)で変更を促し、本人がパスワード変更すると
> `0` に戻る。新規: `functions/api/admin/reset-user-password.js`。変更: `functions/api/auth/
> {check,change-password}.js` / `functions/api/admin/users.js` / `public/{auth,admin}.js` /
> `public/admin.html` は変更不要(モーダルはJS生成) / `public/style.css` `.password-reset-banner` /
> `schema.sql`。マイグレーション `users_password_reset_pending` は本番DBへ適用・
> `schema_migrations` 記録済み(2026-09-10)。
> `docs/design/auth-multiuser.md` 更新済み。`node --check` 済み・実機確認は未実施。
>
> 完了済み(2026-09-09): **集計画面「総合成績」タブに購入比率の棒グラフ3種を追加**
> (馬券種別別 / 競馬場別 / 騎手別。金額ベース、分母は全購入合計。騎手別は各騎手へ
> 全額計上・上位10名+その他)。`public/stats.js` `renderRatioBreakdowns()` /
> `public/stats.html` / `public/style.css` `.ratio-*`。`docs/design/screens.md`
> 「集計画面」・`docs/design/stats-rules.md` 更新済み。実機確認は未実施。
>
> 完了済み(2026-09-09): **予想登録画面の競馬場セレクト変更時に現在のR番号を維持**
> (以前は常にその開催の先頭レースへ切り替わっていた。同じRが無い競馬場のみ先頭へ
> フォールバック)。`public/prediction.js` `renderRaceHeader()` の track-select change
> ハンドラ。`docs/design/screens.md`「予想登録画面」更新済み。実機確認は未実施。
>
> 完了済み(2026-09-09): **予想登録画面から開いた購入モーダルを×/ESCで閉じたら
> 予想登録画面へ戻る**(以前は購入画面に留まっていた)。予想の購入ボタンURLに
> `?from=prediction` を付与し、`closePurchaseModal()` がそれを見て `prediction.html`
> へ戻す。`public/prediction.js` / `public/buy-purchase-modal.js`。
> `docs/design/screens.md`「購入画面」「予想登録画面」更新済み。実機確認は未実施。
>
> 完了済み(2026-09-09): 上記の続き。**×で閉じた直後に購入画面が一瞬見える問題を解消**。
> (1) `?race=` 直リンク時は `body.deep-link-purchase` で `.buy-main` を隠す
> (モーダルが開くまで/閉じるまで)。(2) `from=prediction` で戻るときはモーダルを
> `hidden` にせずオーバーレイを不透明化してから遷移。`public/buy.js` /
> `public/buy-purchase-modal.js` / `public/style.css`。
>
> 修正(2026-09-09): 上記(1)の隠し対象が広すぎ、`.buy-main` 内にある
> `#purchase-modal` まで `visibility:hidden` になって予想画面から購入モーダルが
> 開かなくなっていた。隠し対象を `.buy-step`(レース選択UIのみ。モーダルは兄弟要素で
> 対象外)に変更。
>
> 完了済み(2026-09-09): **予想登録画面ヘッダーに開催日セレクトを追加**。競馬場・R に
> 加え日付も切り替え可能に。日付/競馬場変更時は現在のRを維持(`switchToRaceKeeping()`。
> 日付+競馬場+R → 日付+競馬場先頭R → その日付先頭)。`public/prediction.js` /
> `public/style.css` `#prediction-date-select`。`docs/design/screens.md`
> 「予想登録画面」更新済み。実機確認は未実施。
>
> 完了済み(2026-09-09): 上記の続き。**iPhone SE3(375px)でヘッダーの日付/競馬場/R
> 3セレクトが1行に収まるよう `@media(max-width:430px)` でサイズ調整**(gap・font・
> padding・min-width を圧縮)。`public/style.css` のみ。
>
> 完了済み(2026-09-09): さらに続き。**予想登録画面ヘッダーを2行構成に**。
> 1行目=日付/競馬場/R/購入ボタン、2行目=レース名/頭数/条件バッジ(牝馬限定「牝」・
> ハンデ戦「H」。`class_flags`・`weight_type` の部分一致で判定)。日付表示は
> `formatDateMdW`(M/D(曜))へ変更。`public/prediction.js` `renderRaceHeader()` /
> `public/style.css`(`.prediction-race-meta` `.race-cond-badge`)。
> `docs/design/screens.md`「予想登録画面」・`docs/design/data-model.md`
> 「レース条件の詳細カラム」(N-4 の一部進捗)更新済み。実機確認は未実施。
>
> 完了済み(2026-09-10): **データ検索画面「レース成績」タブを新設**(ROADMAP クラスタM
> 「騎手名ベースの集計」)。NAV に「データ検索」(全ログインユーザー)。競馬場・コース種別
> (芝/ダート)・距離(完全一致・データ内のみ)で絞り、①平均単勝金額・単勝300/500/1000円
> 以下率(`races.payouts.tan`)②平均馬連金額(`payouts.umaren`)③高勝率騎手トップ5
> ④高複勝率騎手トップ5(一律3着以内率。足切り `max(5,⌈対象レース数×5%⌉)` 上限50。
> 見習い記号除去で名寄せ)⑤馬番別成績(着別度数+勝率/連対率/複勝率)を表示。
> サーバーはサブリクエスト2本(`races` 全件 / `race_results` を `races` と JOIN)。
> 新規: `public/data-search.html` `public/data-search.js`
> `functions/api/data-search/race-stats.js`。変更: `public/shell.js`(NAV_ITEMS)
> `public/style.css`(`.ds-*`)。`docs/design/data-search.md` 新規・索引3ファイル更新済み。
> `node --check` 済み・実機確認は未実施。
>
> 完了済み(2026-09-10): **JRAレース結果PDF / 出走馬一覧PDF インポートを複数ファイル
> 選択対応に**。過去の結果PDFを詳細記録(`race_results`)込みで取り込み直す用途。
> `races.html` の両ファイル入力を `multiple` に。共通ヘルパー `jraPdfParseFiles()` /
> `jraPdfRaceKey()`(`public/jra-pdf-common.js`)で全ファイルを順に解析(1件失敗しても
> 継続)、プレビューはファイルごとの折りたたみ診断+レースキーで重複排除したレース一覧。
> **登録はファイル単位で順次 POST**(1リクエスト≒12レースに抑え、D1バインド上限・
> batchサイズ・サブリクエスト上限を回避。サーバー側 `results-import.js` /
> `entries-import.js` は無変更)。進捗表示・失敗ファイルのサマリあり。変更:
> `public/jra-pdf-common.js` `public/jra-result-pdf.js` `public/jra-entries-pdf.js`
> `public/races.html`。`docs/design/results-import.md` /
> `docs/design/entries-import.md` 更新済み。`node --check` 済み・実機確認は未実施。

### B. 中期(feasible なら / 仕様を検討して)

| タスク | メモ |
|---|---|
| クラスタC レース別4階層化 | 「年月→日付→競馬場→レース」のアコーディオン。出来そうなら進める |
| クラスタC 名前クリックでドリルダウン ×2 | クリック時に出す内容の精査が先。後で |

### C. そのうち

- 降着・失格の `race_results.status` 対応方針の検討
- ROADMAP クラスタM 残タスク: `races(track, course_type, distance)` 複合インデックス
  (「データ検索」が重くなったら)/ 馬名・騎手個別検索タブの要否検討。主要2機能
  (馬名ベース=予想画面の過去成績 / 騎手名ベース=データ検索画面)は実装済み

### 後回し

- N-1 馬番重複防止(手入力時のみ・インポート運用が主のため)
- クラスタD 未登録レース登録のモーダル化(admin のみ・インポートがベース)

### クローズ / 対象外

- 騎手名連結の不具合 → 「とりあえず解決」判定(騎手エイリアス運用でカバー)。⚠️ から削除
- ROADMAP クラスタH 外部データ自動取得 → 不要
- ROADMAP クラスタI CSSキャッシュ → 完了(2026-09-08。`public/_headers` 方式。`shell.js` 生成案は不採用)

---

## 未着手タスクの詳細(クラスタ単位)

同じファイル/画面を触るタスクをまとめたもの。上記「優先順位」が着手順の判断材料。

### クラスタN: コードレビューで発見した不具合の修正(2026-08-12仕様確定)

実行環境を用いない静的コードレビューにより発見。修正方針は確定済み。

#### N-1: 出走馬表モーダルで馬番が重複入力できてしまう

**症状**: 出走馬表モーダル(`public/races-entries-modal.js`。2026-09-01 の分割で `races.js` から
分離。行は `.entry-form-row`、馬番セレクトは `.e-horse-number`)は、各行の馬番セレクトが
互いに独立しており、同じ馬番を複数行に設定できてしまう。馬番が重複すると、購入時の
組み合わせ紐付けや`computeWinningCombos`による的中判定が意図しない挙動になる可能性がある。

**発生源の切り分け(確認済み)**:
- 手入力(レース管理画面): 対応要
- PDFインポート系(`jra-entries-pdf.js`/`jra-result-pdf.js`経由): **対応不要**。
  重複が起きるとすればパーサー側の解析バグであり、今回のスコープには含めない
  (再現・報告があれば別タスクとして起票する)

**確定した修正方針(クライアント側のみ・スワップ方式)**:

`public/races-entries-modal.js`の出走馬表フォームで、ある行の馬番セレクト(`.e-horse-number`)の
値を変更した際、**送信前の時点で**重複が起きないよう、UIの操作性で防ぐ。

- 各行の馬番セレクトに、現在選択されている値を`dataset.horseNumber`として保持しておく
  (`renderEntryRows()`描画時に初期値をセットし、以後の変更のたびに更新する)
- ある行(行X)の馬番セレクトが新しい値`V`に変更されたとき:
  1. 他の行(行Y)の中で、現在の馬番が`V`である行を探す
  2. 見つかった場合、行Yの馬番セレクトの値を「行Xの変更前の値」に**入れ替える**
     (単純なブロック/警告ではなく、2行の値をスワップすることで「常に1〜出走頭数の
     数値が重複なく1つずつ使われている」状態を維持する)
  3. スワップ後、両方の行の`dataset.horseNumber`を更新する
- 出走頭数変更時(`horseCountSelect`のchangeイベント)の再描画(`renderEntryRows`)でも、
  同様に初期値の`dataset.horseNumber`をセットし直す

**対象外とする範囲(確認済み)**:
- 枠番(`waku_number`)は9頭以上のレースで複数馬が同じ枠を共有するのが正常な状態のため、
  重複チェック・スワップ処理の対象**外**
- サーバー側への重複チェック追加は今回は追加しない(必要になった時点で別途検討)
- PDFインポート経由(`entries-import.js`のマージ結果)での重複チェックは対象外

**実装対象ファイル**: `public/races-entries-modal.js`(`renderEntryRows()`・馬番セレクトの
`change` イベントハンドラ)のみ。

#### N-4: レース条件詳細カラムの画面表示対応

**背景**: `weight_type`(斤量区分)・`class_flags`(条件フラグ)・`course_direction`(回り)・
`weather`(天候)・`track_condition`(馬場状態)は、スキーマ追加とPDFインポート時の取込・
保存までを優先して先行実装したもので、意図的にどの画面表示にも反映していない。

**第1段階(2026-09-08 完了)**: `entries[].sex_age`(性齢)・`weight_carried`(負担重量)を
予想登録画面(`prediction.js` `renderHorses()`)の馬名行に「性齢 ・ 負担重量 ・ 騎手」の
「・」区切りで表示。値の無い項目は出さない。`docs/design/screens.md`「予想登録画面」参照。

**対応内容(第2段階・未着手)**:
- レース一覧カード(`renderRaceRow()`)・払戻モーダルの読み取り専用情報
  (`openPayoutModal()`)に、`weight_type`/`class_flags`/`course_direction`を追記するか検討する
  (例: 「3歳 未勝利（混合）［指定］・馬齢・右回り」のような表示)
- `weather`/`track_condition`は結果確定後にのみ値が入るため、表示するなら払戻モーダルまたは
  `race_results`詳細セクション側が適切と考えられる
- 出走馬表モーダル側で、これらの項目を手動編集できるようにするかは別途検討
- どこまでを表示対象にするか(一覧カードへの追記は情報過多にならないか等)は着手前に
  UI案を提示して承認を得ること

**規模目安**: 中(表示ロジックの追加のみで、データ取得・保存経路は既存のまま使える)

### クラスタB: 馬券購入画面(buy.js)の改善

出走馬に枠番・馬番が未確定の馬を含むレースは購入不可にするガード(`hasUnconfirmedEntries()`)が
既に実装済みのため、本クラスタの改修時はこのガードと競合しないか確認すること。

| 優先度 | 内容 | 規模目安 |
|---|---|---|
| 低 | レース選択グリッド(競馬場×R一覧)のUI微調整。「レース番号とレース名の間隔を詰める」が残タスクとされているが、**実装済みかどうか未確認**。着手前に実画面で現状を見て、既に十分なら本項目を削除する | 小 |

### クラスタC: 集計画面(stats.js)

コース別収支は 2026-09-08 に実装済み(「競馬場別」タブを「コース別」に置換。BACKLOG_HISTORY 期間9)。
残りのドリルダウン2件は、クリック時に出す内容の精査が先。
**`docs/ROADMAP.md`のクラスタMの成果(騎手名ベースの単勝率等)と重複する可能性があるため、
着手時にクラスタMとの役割分担を確認すること。**

| 優先度 | 内容 | 規模目安 |
|---|---|---|
| 中 | レース別収支を「年月→日付→競馬場→レース」の4階層アコーディオン表示にする | 中〜大 |
| 中 | 騎手別収支画面で騎手名をクリックすると、その騎手が関わる購入履歴の詳細一覧を別ウィンドウ(モーダル等)で表示する | 中 |
| 中 | レース別収支画面でレース名をクリックすると、そのレースの購入履歴の詳細一覧を別ウィンドウ(モーダル等)で表示する | 中 |

### クラスタD: 管理画面・権限表示(admin.js/admin.html)

| 優先度 | 内容 | 規模目安 |
|---|---|---|
| 中 | 「未登録レース一覧」からレース情報登録まで画面遷移せず完結できるようにする(モーダル共通化 or admin.html側に個別実装。設計方針は着手時に要相談) | 大 |

### クラスタE: CSVインポート仕様変更

| 優先度 | 内容 | 規模目安 |
|---|---|---|
| 中 | 返還(出走取消等)行の`payout`計算を、実際のCSV表記を確認したうえで見直す(上記「調査中の不具合」表の🟡「CSV『的中』なし返還行」と同一課題)。サンプルCSV入手が前提。**PDFインポート側の返還処理と設計方針を揃えることが望ましい** | 小〜中 |

> 「取り込んだ結果は外れ馬券も含めすべて確定扱いにする(`hitText===''` も payout=0)」は
> 2026-08-14 に実装済み(`functions/api/ticket-imports/index.js`。docs/design/csv-import.md 参照)。

(仕様矛盾の解消方針一覧は`archive/documents/BACKLOG_HISTORY.md`参照)
