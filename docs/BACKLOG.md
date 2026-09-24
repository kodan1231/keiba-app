# 未着手タスク・調査中の不具合 引継ぎメモ

**これから対応すること**を記録する場所(現状仕様は `docs/design/`、完了経緯は
`archive/documents/BACKLOG_HISTORY.md`)。着手したら該当項目を本ファイルから削除し、
仕様は `docs/design/<機能>.md` へ、経緯は BACKLOG_HISTORY へ反映する。
大型・保留・将来構想は `docs/ROADMAP.md`(クラスタH・M)。

- **進め方**: ①仕様確認→承認 → ②`docs/design/<機能>.md` 更新 → ③実装 →
  ④`node --check` → ⑤本ファイル更新(完了分は BACKLOG_HISTORY へ要約移動)。詳細は `CLAUDE.md`。
- **実機確認はユーザー側**。Claude は `node --check` と静的レビュー・シミュレーションのみ。
  着手・完了報告時に検証状況を明示する。

## 🔰 次のチャットで最初に読むこと(最終更新 2026-09-24)

- **🔴 未適用のマイグレーションあり・要デプロイ前適用(2026-09-24)**: `migration.sql` の
  `@STEP: races_base_name`(`races.race_base_name`列追加)が本番DB `keiba-yosou-db`
  へ未適用。**このマイグレーションを適用する前にコードをデプロイすると、
  `functions/api/races/index.js`(POST)・`functions/api/races/[id].js`(PUT)・
  `functions/api/races/entries-import.js`・`functions/api/races/results-import.js`
  のINSERT/UPDATE文がいずれも`race_base_name`列を明示的に指定するため、
  「no such column: race_base_name」でレース新規登録・編集・出走馬一覧PDF/結果PDFの
  インポートが全滅する**。デプロイ手順は①`wrangler d1 execute keiba-yosou-db
  --command "ALTER TABLE races ADD COLUMN race_base_name TEXT;"`(または
  `schema_migrations`未適用確認の上で`@STEP: races_base_name`を適用)→ ②コードを
  デプロイ、の順を厳守すること。適用後、管理画面「重賞管理」の「レースのベース名を
  再計算する」ボタンを1回押して既存行をバックフィルする(押さなくてもエラーには
  ならないが、押すまで集計画面「レース別」の表示名が`race_name`のフォールバックの
  ままになる)。詳細は`docs/design/data-model.md`「races.race_base_name」参照。
- **🔴 本番DBが2026-09-12中、D1無料枠の日次rows_read上限(500万行/日)を使い切って
  全画面で情報が見れない状態になっている**。原因・詳細・恒久対策は下記
  「D1無料枠の日次上限に関する注意(2026-09-12発生)」参照。**UTC 0時(日本時間
  朝9時)に自動でリセットされるのを待つ以外の対処法は無い**(無料枠を維持する方針の
  ため有料プランへの切り替えは選択肢に入れない)。コード側の再発防止(`races_cache`の
  保存失敗をbest-effort化)は実装済み・要デプロイ確認。リセット後、実ブラウザで
  各画面が正常に表示されることを確認すること。
- **読む順**: `CLAUDE.md`(自動)→ 本セクション → `docs/INDEX.md` で対象ファイルを特定 →
  `docs/design/<機能>.md` を対象1ファイルだけ。過去の完了経緯は
  `archive/documents/BACKLOG_HISTORY.md`(明示的に聞かれた時のみ)。
- **未適用のマイグレーションあり(2026-09-12)**: `migration.sql` の
  `@STEP: prediction_notes_key_race`(`prediction_notes.is_key_race`列追加。勝負レース
  フラグ)が本番DB `keiba-yosou-db` へ未適用。適用後はボタン操作等不要。
- **未適用のマイグレーションあり(2026-09-13)**: `migration.sql` の
  `@STEP: races_post_time`(`races.post_time`列追加)・`@STEP: users_api_token`
  (`users.api_token_hash`/`api_token_created_at`列追加+ユニークインデックス)が
  本番DB `keiba-yosou-db` へ未適用。JRAレース結果ユーザースクリプト取込み・
  管理画面「APIトークン」を使う前に適用が必要。
- **🔴 未適用のマイグレーションあり・要デプロイ前適用(2026-09-17)**: `migration.sql` の
  `@STEP: tickets_structure`(`tickets.structure`列追加)が本番DB `keiba-yosou-db`
  へ未適用。**`ALTER TABLE`自体は軽量だが、`functions/api/tickets/bulk.js`の
  INSERT文が`structure`列を明示的に指定するようコード変更済みのため、
  このマイグレーションを適用する前に今回の変更をデプロイすると、
  `structure`列が存在せず`POST /api/tickets/bulk`(購入確定・カゴの「購入」ボタン)が
  全件エラーになり新規購入ができなくなる**。デプロイ手順は
  ①`wrangler d1 execute keiba-yosou-db --command "ALTER TABLE tickets ADD COLUMN structure TEXT;"`
  (または`schema_migrations`未適用確認の上で`@STEP: tickets_structure`を適用)
  → ②コードをデプロイ、の順を厳守すること。詳細は
  `docs/design/data-model.md`「購入方式の入力構造(tickets.structure)」参照。
  `race_results_horse_key`・`race_stats_cache`・`races_cache`(チャンク分割版。
  `@STEP: races_cache_chunked`)は適用済み・`schema_migrations` 記録済み(`horse_key`
  の既存行バックフィルも完了。`race_results` 14768件更新)。実ブラウザでの数値確認は
  未実施(下記「🔵 実機検証未完了」参照)。
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
  `race_stats_cache`と同じ発想の事前計算キャッシュを先回りで導入。本番適用済み)・
  **D1 2MB行サイズ上限超過障害への対応**(2026-09-12。上記`races_cache`導入直後、
  結果CSV18ファイルの一括インポートで`races`全件を1行のJSONにまとめた累積サイズが
  D1の「1行〈1カラム値〉あたり2,000,000バイト」の上限を超え、`GET /api/races`に
  依存する馬券購入画面・データ検索画面・レース管理画面が軒並み500になる障害が
  発生。`races_cache`を複数行〈チャンク〉に分割して保持する方式に変更し、
  件数ではなくバイト数〈UTF-8実測〉で区切ることで根本対応。要マイグレーション適用
  〈`@STEP: races_cache_chunked`〉)・
  **勝負レースフラグ**(2026-09-12。予想登録画面にレース×ユーザー単位の個人設定
  トグルを新設。ONのレースは馬券購入画面のレース一覧にも★表示。`prediction_notes.
  is_key_race`+専用API `PUT /api/predictions/key-race`。要マイグレーション適用)を追加。
  **買い目画面・履歴画面のページ遷移レイテンシ改善**(2026-09-13。ページ遷移後に
  データが表示されるまでの体感速度低下の相談を受けて調査。`races_cache`等の
  D1上限対策は有効だが、`races`が育つほど`GET /api/races`のレスポンス自体
  〈JSON直列化・エイリアス適用ループ・転送量〉が重くなる問題は未対策だったため、
  `GET /api/races?since=`〈直近1ヶ月+未来レース全部に絞る。範囲指定時は`races_cache`
  を経由せず`idx_races_date`で直接SELECT〉と`GET /api/races/:id`〈単一レース取得。
  新設〉を追加し、買い目画面(`buy.js`)・履歴画面(`app.js`)の初期表示をこれに
  切り替えた。深リンク(`?race=`)・古い購入履歴の金額再計算は範囲外時に
  `/api/races/:id`で個別取得するフォールバックを実装した。レース管理画面
  (`races.js`)・予想登録画面(`prediction.js`。日付/競馬場/R切替ナビに全件の
  `races`が必要なため対象外と判明)・データ検索画面・CSV取込一覧の内部呼び出しは
  無変更)を実施。
  **購入履歴画面の馬券ダイアログ(実物のJRA馬券風デザイン)の新規実装**
  (2026-09-16〜17。式別行タップ時のインライン展開をやめ、実物の馬券写真を
  参照した専用デザインのダイアログ表示に変更。詳細は`docs/design/screens.md`
  「購入方式グループのダイアログ」参照)、および**購入方式(box/nagashi/formation)の
  入力構造をDBに保存する`tickets.structure`列の追加**(2026-09-17。着順なし券種
  〈三連複等〉のフォーメーションは保存済みの組み合わせ結果から入力時のゾーン分けを
  復元できない制約があったため、過去データ・CSV取込は現状の推測ロジックのまま
  許容し、今後の画面購入分のみ購入時点の構造情報をそのまま保存して正しく
  表示できるようにした。要マイグレーション適用。上記🔴参照)を実施。
  **馬券ダイアログの軸ながし表記修正**(2026-09-18。実物の馬券写真で確認し、
  三連単等の軸1頭ながしの和文ラベルを「軸1頭流し」→「軸1頭ながし」に修正。
  マルチも表記自体は変えず〈方式ボックスの「軸○頭ながし」表記はマルチの
  有無で変化しない〉、「組合せ数」「各組」の表と同じ高さに黒背景の「マルチ」
  バッジ〈`.ticket-multi-badge`〉を並べて表示する形に変更。以前は方式ボックスの
  ラベルを「マルチ」「軸2頭マルチ」に置き換えていたが実物と異なっており、
  さらにその後バッジを軸/相手の番号ボックスの左に置く形を試したところ
  番号の並びが崩れたため、この位置に落ち着いた)、および**左情報列の高さ調整に
  伴う単勝・複勝表示崩れの修正**(2026-09-18。左列下側ブロック〈レース名・
  JRA◯◯・月日〉を合計欄の下端に揃えるため`.ticket-info-col`の`grid-row`を
  合計欄の行までまたがせていたが、これにより合計欄の行の必要高さが増えて
  1行目〈買い目列を含む〉が圧迫され、単勝・複勝で馬名が表示されない・
  金額が馬名から離れて表示される不具合が発生。グリッドの行サイズ計算に
  影響しない`position:absolute`方式に変更し、金額行も`.ticket-selection-area`
  の外の別要素から同じ要素の中へ移して隣接表示に修正)、**単勝・複勝金額の右揃えへの
  変更**(2026-09-18。`.ticket-single-amount`を左揃え→右揃えに変更)、および
  **CSV取込直後の馬名バックフィル**(2026-09-18。取込先レースが既に出走馬表
  〈`races.entries`〉を持っている場合、全行の取込処理後にそのレースぶんだけ
  `backfillHorseNamesForRace()`を呼びその場で馬名・騎手を反映するよう変更。
  以前はレース管理画面で出走馬表を保存し直すまで、CSV取込直後の単勝・複勝等で
  馬名が表示されなかった。`functions/api/ticket-imports/index.js`。
  `docs/design/csv-import.md`参照)、および**縦帯の位置・幅調整と単勝・複勝
  馬名表示幅の拡大**(2026-09-18。縦帯を左へ寄せるため左情報列を33%→28%へ、
  縦帯自体も56px→52pxへ縮小。幅を詰めた分`.ticket-strip-label`の
  `font-size`(8.5px→8px)・`letter-spacing`(0.1px→0)・左右`padding`
  (1px→0px)も比例して詰め、最長の英字表記(QUINELLA/TRIFECTAの8文字)が
  1行に収まる余裕を維持した。左情報列・縦帯が縮小した分だけ買い目列(3列目)が
  広がり、単勝・複勝の馬名の表示可能文字数が伸びる〈目安7文字前後→9文字前後〉)
  を実施。
  下記「⚠️ 調査中の不具合」の 🔵 実機検証未完了に、ユーザー確認待ちの項目がある。
- **次に着手するタスク**: 下記「優先順位」の A 段(CSV返還行 payout〈CSVサンプル待ち〉)。
  片付いたら B 段へ。

## ⚠️ 調査中の不具合(未解決・修正未承認)

| 状態 | 内容 | 詳細 |
|---|---|---|
| 🟡 未修正(要サンプルCSV確認) | CSVインポートで「的中／返還」列が「的中」を含まない行(出走取消等による返還を想定)は、`payout`が一律0円(全損)として計算されている可能性がある。返還の場合は本来ほぼ全額が払い戻される(収支への影響は±0に近いはず)ため、実データでの表記を確認したうえで対応要否を判断する必要がある | `docs/design/csv-import.md`「CSV取込の仕様」要確認 |
| 🟡 未対応(今回対象外) | 降着・失格など、取消・除外・中止以外の着順未確定ケースは`race_results.status`で扱えない。将来`demoted`/`disqualified`等のstatus値を追加する拡張が必要 | `docs/design/race-results.md`「レース結果の詳細記録(race_results)」取消・除外・中止の扱い |
| 🔵 実機検証未完了 | 返還(refund)処理(`tickets.refunded`列・`recomputeTicketPayoutsForRace`/`computeTicketPayout`の返還判定・`stats.js`の的中率集計除外)の実ブラウザでの挙動確認が未実施(コードレビューのみ)。`tickets.refunded`列は本番DBに適用済み | `docs/design/payout-refund.md`「返還(refund)処理」 |
| 🔵 実機検証未完了(要マイグレーション適用) | `races.race_base_name`列追加(2026-09-24。race_nameから「第N回」等の回次・混入グレードバッジを除いたベース名を、race_name書き込みの全経路〈レース新規登録・編集・出走馬一覧PDF/結果PDFインポート〉で同時保存。集計画面「レース別」の表示名はこちらを優先〈`GET /api/tickets`・`GET /api/ticket-imports`がJOINして返す〉。既存行バックフィルは管理画面「重賞管理」の「レースのベース名を再計算する」ボタン`POST /api/admin/races/recompute-base-names`)は`node --check`とNode上での`raceBaseNameOf()`/`gradedRaceNameKey()`の入出力確認(回次のみ・バッジのみ・両方・順序違い等)のみ。**本番適用手順**: `migration.sql`の`@STEP: races_base_name`を適用→バックフィルボタンを押す(上記🔰参照)。**実ブラウザで**: レース新規登録・編集・出走馬一覧PDF/結果PDFインポート後にrace_base_nameが正しく保存されること、集計画面「レース別」で重賞のレース名が回次なしで正しく表示されること(グレードバッジ混入済みの既存データでも直ること)、バックフィルボタンを押すと既存レース全件の表示が直ること、`gradedRaceNameKey()`のリファクタリング後も「重賞のみ」フィルタの判定結果が従来と変わらないことを確認する | `docs/design/data-model.md`「races.race_base_name」 |
| 🔵 実機検証未完了 | 集計画面に「競馬場別」タブを追加(2026-09-24。`track`のみでまとめる〈コース種別・距離では分けない〉収支表。既存の「コース別」より粗い粒度。`public/stats.js`の`renderTrackTable()`。レース区分フィルタ〈重賞のみ/条件戦のみ〉は既存のコース別・騎手別と同じく無し)は`node --check`のみ。**実ブラウザで**: 「競馬場別」タブに競馬場ごとの購入/払戻/収支/回収率/的中率が表示されること、列見出しクリックでソートできること、競馬場未登録の購入が「競馬場不明」にまとまること、総合成績タブの「競馬場別 購入比率」棒グラフの金額と整合していることを確認する | `docs/design/stats-rules.md`「競馬場別収支」 |
| 🔵 実機検証未完了 | 払戻モーダルでの出走取消馬の手動設定(2026-09-24。`races-payout-modal.js`に馬番チェックボックス欄〈`renderScratchedSection()`〉を追加し、`races.payouts.refunds`を手動編集できるようにした。除外は出走馬表確定前に取り除く運用のため対象外、取消のみ扱う。枠連の返還同枠〈`waku_numbers`〉は出走馬表の枠番情報からクライアント側で自動算出〈`computeRefundWakuNumbers()`〉。バックエンド〈`PUT /api/races/:id`・`recomputeTicketPayoutsForRace`〉は無変更で既存の返還判定ロジックがそのまま処理する)は`node --check`のみ。**実ブラウザで**: 払戻モーダルで馬番をチェックし保存すると該当馬が絡む馬券(単勝・複勝・馬連等)の`tickets.payout`が購入金額と同額(`refunded=1`)になること、枠連は該当枠の全頭をチェックした場合のみ返還になること、出走馬表未登録のレースでもチェックのみで馬番ベースの返還が反映されること、PDFインポート済みレースを開いた際に既存の返還内容がチェック済みで表示されること、を確認する | `docs/design/payout-refund.md`「払戻モーダルでの手動入力(出走取消馬)」 |
| 🔵 実機検証未完了 | 買い目画面・履歴画面のページ遷移レイテンシ改善(2026-09-13。`GET /api/races?since=`〈直近1ヶ月+未来レース全部。範囲指定時は`races_cache`を経由せず`idx_races_date`で直接SELECT〉・`GET /api/races/:id`〈単一レース取得。新設〉を追加し、買い目画面(`buy.js`)・履歴画面(`app.js`)の初期表示をこれに切り替え、深リンク・古い購入履歴の金額再計算は範囲外時に`/api/races/:id`で個別取得するフォールバックを実装)は`node --check`のみ。**実ブラウザで**: 買い目画面・履歴画面が従来通り表示されること(直近1ヶ月より前の購入履歴・レースが欠けないこと)、買い目画面へ古いレースの`?race=`深リンクで遷移した際に購入モーダルが正しく開くこと、履歴画面で1ヶ月より前の購入履歴の金額を編集した際に払戻金額が正しく再計算されること、実際にページ遷移が速くなったと感じられるかを確認する | `docs/design/data-model.md`「GET /api/races の範囲限定・単一レース取得API」 |
| 🔵 実機検証未完了 | JRA結果PDF / 出走馬一覧PDF インポートの複数ファイル選択対応(`multiple`・`jraPdfParseFiles()`・ファイル単位の順次POST)は `node --check` のみ。**実ブラウザで**: 複数PDF選択→解析でファイルごとの折りたたみ診断が出ること、重複レースの除外表示、登録が「(3/10) ファイル名」進捗で1ファイルずつ実行され最後にサマリが出ること、1ファイル解析失敗時に他が継続すること、単一ファイル時に従来どおり動くこと、を確認する | `docs/design/results-import.md`「複数ファイルの一括選択」 |
| 🔵 実機検証未完了 | データ検索画面「レース成績」タブ(新規。`data-search.html`/`.js`・`GET /api/data-search/race-stats`・NAV「データ検索」)は `node --check` とローカルDBでの馬番別集計シミュレーションのみ。**実DB(本番)で**: 競馬場・コース種別・距離の各フィルタ、距離セレクトが競馬場/コース種別選択で絞られること、平均単勝/馬連金額・○円以下率・騎手トップ5(足切り `max(5,⌈対象レース数×5%⌉)`)・馬番別成績の数値が妥当か、③④⑤の着順ソース使い分け(`race_results` 全頭ぶんあり→それ / 不足→`finish_order`+`entries`)が効いているかを確認する | `docs/design/data-search.md` |
| 🔵 実機検証未完了 | JRAレース結果PDFパーサの関数分割(2026-09-08。`jraResultParseExtractedPages` 527行 → `detectRaceHeaders()` + `parseRaceBlock()` に抽出)は`node --check`と原本との行集合突き合わせのみ。**実PDF(できれば複数レース入り)を1件インポートし、分割前と比較**: レース数・レース名・コース/距離・1〜3着・払戻レート(全式別)・`race_results`詳細・取消/除外/中止行・`incident_note`・診断パネルの各カウンタ(`raceHeaders`/`resultRows`/`payoutItems`等)が一致すること。診断パネルのバージョンに`-split`が付いていれば新コード | `docs/design/results-import.md`「解析ロジックの要点」 |
| 🔵 実機検証未完了 | 枠番自動計算の不具合修正(2026-09-08。7頭以下で枠番が後ろへずれる問題。`computeWakuNumberFromHorseNumber()` / `defaultWakuNumber()` に `horseCount<=8` の早期リターン + `mergeEntriesByHorseName()` に「馬番1〜N連番の8頭以下」限定の既存値補正)は`node --check`と頭数3〜18でのアルゴリズム出力確認のみ。**7頭以下のレースを実際にPDFインポートまたは再インポートし、枠番が馬番と一致すること**を確認する必要がある | `docs/design/data-model.md`「枠番は馬番から自動計算して保存する」 |
| 🔵 実機検証未完了(マイグレーション適用済み) | `races_cache`のチャンク分割化+保存失敗のbest-effort化(2026-09-12。先回り導入した`races_cache`〈1行固定〉が、同日中の結果CSV18ファイル一括インポートで`races`累積JSONがD1の1行2,000,000バイト上限を超えUPDATE失敗→`GET /api/races`依存の馬券購入画面・データ検索画面・レース管理画面が500になる障害を起こしたため、複数行〈チャンク〉に分割し件数でなくバイト数〈UTF-8実測〉で区切る方式に変更。さらにチャンク化直後、`recomputeRacesCache()`の保存〈`db.batch`〉に例外処理が無かったため、D1のrows_written上限に迫った際に保存失敗→次回また再計算→また保存失敗のループに陥り、`races`全件読み直しを繰り返してrows_read上限〈500万行/日〉まで使い切り全画面で読み取り不能になる二次障害が発生。保存処理をtry/catchで囲み、保存に失敗しても読み取れた`rows`は返すよう修正。`_lib/races-cache.js`の`getAllRacesRaw()`/`recomputeRacesCache()`。`migration.sql`の`@STEP: races_cache_chunked`は本番`keiba-yosou-db`へ適用済み)は`node --check`のみ。D1日次上限リセット後、**実ブラウザで**: 馬券購入画面のレース一覧・購入履歴画面・データ検索画面・CSV取込一覧が従来通り表示されること、レースの新規登録/編集/PDFインポート直後に一覧へ即座に反映されること、大量のレースをまとめてインポートしても500にならないことを確認する | `docs/design/data-model.md`「races全件取得の事前計算キャッシュ(races_cache)」チャンク分割・保存失敗時のbest-effort化 |
| 🔵 実機検証未完了(要マイグレーション適用) | 勝負レースフラグ(2026-09-12。予想登録画面のヘッダーにレース名の直後「☆/★ 勝負レース」トグルボタンを新設。`prediction_notes.is_key_race`〈レース×ユーザー単位の個人設定〉+`PUT /api/predictions/key-race`。ONのレースは馬券購入画面のレース選択グリッドのレース名の後ろに★を表示〈`GET /api/predictions`のrace_id省略時一覧取得モード+`myKeyRaceIds`〉)は`node --check`のみ。**本番適用手順**: `migration.sql`の`@STEP: prediction_notes_key_race`を`wrangler d1 execute --remote`で適用。**実ブラウザで**: トグルON/OFFが即座に反映されること、レース切り替え後も状態が正しく再取得されること、馬券購入画面のレース一覧に★が正しく表示されること(自分がONにしたレースのみ)、予想印・予想メモの保存でこのフラグが意図せず変化しないことを確認する | `docs/design/screens.md`「予想登録画面」 |
| 🔵 実機検証未完了 | `GET /api/ticket-imports`のD1読み取り上限逼迫の修正(2026-09-12。`wrangler d1 insights`で判明: `imported_ticket_items`を全ユーザー分全件SELECTする設計〈テーブルが小さい前提〉が、テーブルが5,600行超まで育ったことで破綻し、このGET1エンドポイントだけで1日137回・768,707行〈日次上限500万行の約15%〉を消費していた。自分の`imported_ticket_groups.id`集合で`WHERE group_id IN (...)`〈90件チャンク・既存の`idx_imported_items_group`使用〉に絞り込む方式へ変更)は`node --check`のみ。**実ブラウザで**: 購入履歴画面のCSV取込グループ一覧が従来通り表示されること(自分の取込分の内容が欠けていないこと)、集計画面「コース別収支」への影響が無いことを確認する。修正後の読み取り量が実際に減っているかは`wrangler d1 insights`で後日確認するとよい | `functions/api/ticket-imports/index.js` |
| 🔵 実機検証未完了 | 購入馬券グループのIPAT風コンパクト表示(2026-09-12。JRA公式IPAT「照会結果詳細」に見た目を寄せ、box/フォーメーション/ながし等で生成された全組み合わせを展開せず「入力した形」〈馬番一覧・着順ごとの馬番・軸馬/相手〉を数行で見せる新設。`ticket-view.js`の`describeGroupSelections()`/`groupCompactSummaryHtml()`。method文字列不問でCSV取込グループにも適用)は`node --check`とNode上でのbox(60点)/フォーメーション/2頭軸ながし/単勝まとめ買いパターンの出力確認のみ。**実ブラウザで**: 購入履歴画面・予想登録画面の両方で、通常購入・box・フォーメーション・ながし(1頭軸/2頭軸)・CSV取込の各グループを展開し、コンパクト表示の内容が実際の買い目と一致すること、「内訳を見る」トグルで1点ごとの明細(当落・個別金額編集・削除)が問題なく開閉・動作すること、を確認する。着順なし券種の複雑なフォーメーション(各着順が完全に別集合)は「馬番:全馬番の一覧」に丸められる既知の制約があるため、該当パターンがあれば見え方を確認する | `docs/design/screens.md`「購入馬券グループの表示(IPAT風コンパクト表示)」 |
| 🔵 実機検証未完了 | 馬券ダイアログの軸ながし表記修正(2026-09-18。三連単等の軸1頭ながしの和文ラベルを実物の馬券写真に合わせ「軸1頭流し」→「軸1頭ながし」に修正〈`TICKET_METHOD_LABELS.axis1`〉。マルチは方式ボックスの表記自体を変えず、`ticketMethodBoxLabel()`が返す`multi`フラグを使って「組合せ数」「各組」の表〈`.ticket-combo-table`〉と同じ高さに黒背景の「マルチ」バッジ〈`.ticket-multi-badge`。`.ticket-combo-table-row`〉を並べて表示する形に変更。当初は軸/相手の番号ボックス〈`.ticket-axis-multi-row`〉の左に置いていたが、番号の並びが崩れるとの指摘を受けこの位置に移動した)は`node --check`のみ。**実ブラウザで**: 三連単・三連複の軸1頭ながし〈マルチ無し〉で方式ボックスが「軸1頭ながし」と表示されること、軸1頭/軸2頭それぞれのマルチ購入で方式ボックスの表記が変わらず「組合せ数」「各組」の表の左にマルチバッジが出て馬番ボックスの並びが崩れないこと、`tickets.structure`が無い過去データ・CSV取込のながしグループでマルチバッジが出ない(判定できないため)ことを確認する | `docs/design/screens.md`「購入方式グループのダイアログ」 |
| 🔵 実機検証未完了 | 縦帯の位置・幅調整と単勝・複勝馬名表示幅の拡大(2026-09-18。左情報列33%→28%・縦帯56px→52pxへ縮小し、`.ticket-strip-label`のfont-size/letter-spacing/paddingも比例して詰めた)は目視シミュレーションのみで実ブラウザ未確認。**実ブラウザで**: 縦帯上下の英字表記(単勝WIN・複勝PLACE/SHOW・枠連BRACKET QUINELLA・馬連QUINELLA・ワイドQUINELLA/PLACE・馬単EXACTA・三連複TRIO・三連単TRIFECTA。特に8文字のQUINELLA/TRIFECTA)が1行に収まり3行に増える等の変な折り返しが起きないこと、単勝・複勝の馬名が概ね9文字前後まで省略(...)されずに表示されること、縦帯が以前より左・やや細く見えること、左情報列(レース名・JRA◯◯・月日)や他の券種の買い目表示が崩れていないことを確認する | `docs/design/screens.md`「購入方式グループのダイアログ」 |
| 🔵 実機検証未完了 | CSV取込直後の馬名バックフィル(2026-09-18。取込先レースが既に出走馬表〈`races.entries`〉を持っている場合、`POST /api/ticket-imports`の全行取込処理後に`raceCache`上の対象レースぶんだけ`backfillHorseNamesForRace()`を呼び、その場で馬名・騎手を`imported_ticket_items`/`tickets`のselectionsへ反映するよう変更。以前はレース管理画面で出走馬表を保存し直すまで馬名が表示されなかった)は`node --check`のみ。**実ブラウザで**: 出走馬表が既に登録済みのレースの購入履歴CSVを取り込んだ直後に、単勝・複勝の馬券ダイアログで馬名が表示されること、出走馬表が未登録のレースを含むCSVでも取込自体が失敗しないこと(従来通り馬番のみで取り込まれ、後で出走馬表を登録すれば従来のバックフィル経路で馬名が反映されること)を確認する | `docs/design/csv-import.md` |
| 🔵 実機検証未完了 | 左情報列の高さ調整に伴う単勝・複勝表示崩れの修正(2026-09-18。左列下側ブロック〈レース名・JRA◯◯・月日〉を合計欄の下端に揃えるため`.ticket-info-col`の`grid-row`を合計欄の行までまたがせていたところ、合計欄の行の必要高さが増えて1行目〈買い目列`.ticket-buy-col`を含む〉が圧迫され、単勝・複勝で馬名が表示されない・金額が馬名から離れて下の方に表示される不具合が発生。`.ticket-info-bottom`を`position:absolute`で`.ticket-face-main`〈`position:relative`を追加〉の下端に直接固定する方式に変更しグリッドの行サイズ計算への影響を無くした。あわせて単勝・複勝の金額行〈`.ticket-single-amount`〉を`.ticket-selection-area`の外の別要素から同じ要素の中〈馬名の直後〉へ移し、`.ticket-selection-area`の`flex:1`による引き伸ばしで金額が離れないようにした)は`node --check`のみ。**実ブラウザで**: 単勝・複勝の1点買いで馬番+馬名がその下の金額行と隣接して表示されること、左列下側ブロック(レース名・JRA◯◯・月日)の下端が合計欄の下端と揃うこと、他の券種(馬連・三連単等)の買い目表示・方式ボックス・合計欄のレイアウトが崩れていないことを確認する | `docs/design/screens.md`「購入方式グループのダイアログ」 |
| 🔵 実機検証未完了 | D1日次行読み取り上限(500万行)超過障害(2026-09-11)への対応。①`GET /api/races/:id/horse-history`:`race_results.horse_key`列+インデックスを追加し、全件スキャン→`WHERE horse_key IN (...)`の直接絞り込みに変更(あわせて馬ごと直近5走まで・`field_size`の相関サブクエリ解消)。②`GET /api/data-search/race-stats`:`race_results`とのJOIN全件スキャン→フィルタ該当`race_id`のみ`IN`(90件チャンク)取得 →(2026-09-12。ユーザー数増加を見据え)`race_stats_cache`テーブルへの事前計算キャッシュ化(`race_results`書き込み時にDBトリガーで自動無効化・次回読み取り時に自動再計算)に変更。マイグレーション適用・`horse_key`バックフィル(`race_results` 14768件)は2026-09-12に本番完了済み。`node --check`と設計上のシミュレーションのみで、**実ブラウザでの数値確認が未実施**: 予想登録画面で過去成績が(旧仕様と同じ内容で・直近5走に絞られた形で)表示されること、データ検索画面「レース成績」タブが従来と同じ数値を返すこと、結果PDFを再取込した際にレース成績タブの数値が更新されること(トリガーによる自動再計算の確認)を確認する | `docs/design/horse-aliases.md`「`race_results.horse_key`」・`docs/design/race-results.md`「予想登録画面での過去成績参照」・`docs/design/data-search.md`「サーバー処理」 |

| 🔵 実機検証一部完了 | JRAレース結果ユーザースクリプト取込み(2026-09-13。JRA公式サイトの結果ページ上で動くユーザースクリプト`public/jra-result-importer.user.js`(`https://keiba-yosou-app.pages.dev/jra-result-importer.user.js`を開くだけでインストール可能)から、ページのHTML(`public/jra-result-html.js`で解析)を`POST /api/races/results-import`〈PDFインポートと同一エンドポイント〉へ送信できるようにした。認証は管理画面「APIトークン」〈`functions/api/admin/api-token.js`〉で発行する個人用アクセストークン〈`Authorization: Bearer`〉。あわせて発走時刻`races.post_time`を新規保存し、馬券購入画面のレース選択グリッドに表示するようにした。マイグレーション〈`@STEP: races_post_time`・`@STEP: users_api_token`〉は本番`keiba-yosou-db`へ適用済み)は、**iPhone Safari(Userscripts拡張)+スマホ版サイト(sp.jra.jp)で実機確認済み**(2026-09-13。2026-09-12中山12レース分を送信し成功、本番DBの`races`(race_name・post_time・course_type・distance・weight_type・class_flags・weather・track_condition・finish_order)・`race_results`(全頭分)・payouts(全式別)がJRA公式ページの表示と一致することを`wrangler d1 execute`で確認済み)。実機確認の過程で、スマホ版のHTML構造がPC版と全く異なることが判明し専用パーサー(`jraResultHtmlParseMobilePage`)を追加、重賞・特別戦でレース名が空になる不具合(`.titleRaceName`未対応)・class_flagsが年齢条件込みだと空になる不具合(正規表現の数字除外)も発見・修正済み。**未確認のまま残っている点**: ①PC版(`www.jra.go.jp`)側は`jraResultHtmlParseRaceUnit`のコードレビューのみで実機確認していない、②「12時実行なら途中まで・17時実行なら全レース」という部分確定の挙動は未確認(1回で全レース確定済みの状態でしか試していない)、③`races.post_time`が馬券購入画面のレース選択グリッドに実際に表示されることは未確認(DB上の値は確認済み) | `docs/design/results-import.md`「ユーザースクリプトによるHTML取込み」・`docs/design/auth-multiuser.md`「個人用アクセストークン」 |

## D1無料枠の日次上限に関する注意(2026-09-12発生)

**方針: D1は無料枠(Workers Free)を維持する。有料プランへの切り替えはユーザーの絶対条件により選択肢に入れない。**
以下は2026-09-12に実際に日次上限へ到達した際の記録と、再発防止のために今後
常に意識すべき注意点。恒久的なルールは`CLAUDE.md`「絶対に破ってはいけない不変条件」にも
記載済み。

**事実(公式ドキュメント・実機テストで確認済み)**

- D1無料枠の日次上限は **rows_read 500万行/日・rows_written 10万行/日**。リセットは毎日
  UTC 0時(日本時間 朝9時)。([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/))
- **どちらか一方でも上限に達すると、読み取りを含むD1への全クエリがエラーになる**
  (公式FAQより引用: "When your account hits the daily read and/or write limits, you will
  not be able to run queries against D1." [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/))。
  「書き込みが80%」という警告メールが来ていても、実際に先に尽きるのは読み取り上限の
  こともある(今回がそう)。「rows_writtenが80%」の警告だけを見て「書き込みを控えれば
  大丈夫」と判断しないこと。
- 本番で実際に確認したエラー: `wrangler d1 execute --remote` で読み取り専用に近いクエリを
  投げても以下のように即座に拒否される状態になった。
  ```
  Your account has exceeded D1's free tier daily row read limit.
  Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. [code: 7500]
  ```
  **この状態になったら、待つ以外の対処法は無い**(無料枠維持のため有料プランへの
  切り替えは行わない)。UTC 0時のリセットを待つ。

**2026-09-12に何が起きたか(`wrangler d1 insights <db> --time-period 1d --sort-by writes/reads` で判明した内訳)**

| 内容 | 消費量 | 性質 |
|---|---|---|
| `race_results`の馬名・馬キー一括正規化(管理画面「一括補正」`normalizeExistingHorseNames`) | rows_written 約41,895行(13,965回実行) | 一時的な一括メンテナンス作業 |
| 結果CSV18ファイルの一括インポート(`race_results`のUPSERT) | rows_written 約23,786行(3,398回実行) | 今回のユーザー操作 |
| `idx_race_results_horse_key`インデックスの再作成が2回記録(本来`IF NOT EXISTS`で2回目は無害のはずが、テーブル全行数分を消費) | rows_written 約14,769行×2回 | migration.sqlの`@STEP`を手動適用する際の運用ミスの疑い(未確定) |
| **`races_cache`の保存失敗ループ**(下記参照) | rows_read 数十万〜(`SELECT * FROM races`が213回・519,984行等) | **コードのバグ**(このセッションで修正済み) |
| 通常操作(馬券購入・レース登録・予想印/メモ等) | 数千行程度 | 通常運用 |

**`races_cache`の保存失敗ループ(直接の引き金・修正済み)**

同日に`races_cache`(`races`全件取得の事前計算キャッシュ)をチャンク分割方式へ
書き直した際、`recomputeRacesCache()`のキャッシュ保存(`db.batch`)に例外処理が
無かった。rows_written上限に迫っていたタイミングで保存が失敗するたびに例外を
投げてしまい、「保存できない→次のアクセスでまた`races`全件を再計算のため読み直す
→また保存に失敗」というループに陥った。本来1回読めば済むはずの`races`全件SELECT
(2,000行超)を画面を見るたびに繰り返し発生させてしまい、rows_read上限(500万行/日)を
先に使い切って、読み取りを含む全てのD1クエリが失敗する状態(全画面で情報が見れない
状態)を招いた。**対策**: `_lib/races-cache.js`の`recomputeRacesCache()`の保存処理を
try/catchで囲み、保存に失敗しても`races`から読み取れた結果はそのまま返すよう変更
(キャッシュへの保存はあくまでbest-effort。保存の失敗が読み取り自体の失敗に
波及してはならない)。詳細は`docs/design/data-model.md`「races全件取得の事前計算
キャッシュ」参照。

**今後、同じことを起こさないための注意点(要チェックリスト化)**

1. **`*_cache`系テーブル(`races_cache`・`race_stats_cache`)への保存は必ずbest-effort
   (try/catch)にする**。読み取り経路の中で行うDB書き込みは、失敗しても読み取り自体を
   失敗させてはいけない。新しいキャッシュを追加する際は必ずこの形にする。
2. **大きな一括処理(複数ファイルCSV/PDFインポート、管理画面の「一括補正」系ボタン)を
   同じUTC日に複数回・重ねて実行しない**。今回は「一括補正」+「18ファイルインポート」+
   「インデックス再作成の重複」が同日に重なったことで上限に到達した。単体では
   問題にならない規模でも、合算で上限を超えうる。
3. **大きな一括処理の前に、可能であれば`wrangler d1 insights <db名> --time-period 1d
   --sort-by writes --sort-type sum --limit 20`(および`--sort-by reads`)で当日の
   消費状況を確認する**。特に直前に上限警告メールが来ている場合は必須。
4. **`migration.sql`の`@STEP`を手動で`wrangler d1 execute`適用する前に、
   `SELECT name FROM schema_migrations WHERE name='...'`で未適用であることを必ず確認する**。
   適用済みのステップを誤って再実行すると、`CREATE INDEX IF NOT EXISTS`のような
   本来無害なはずの文でも対象テーブルの全行数分を消費することが今回観測された
   (原因未確定だが、二重適用を避けることでリスク自体を無くせる)。
5. 上記1〜4を守っていても、ユーザー数・データ量が増えるほど日次上限に近づくのは
   構造的な問題(無料枠を維持する前提である以上、上限そのものは動かせない)。
   将来的にはRead1本あたりのコストを継続的に下げる(不要な全件SELECT箇所を都度
   見直す。`CLAUDE.md`「絶対に破ってはいけない不変条件」参照)以外に恒久解決は無い
   ことを認識しておく。

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
