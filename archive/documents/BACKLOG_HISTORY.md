# Backlog 作業履歴アーカイブ

`docs/BACKLOG.md`から退避した、完了済みタスクの要約です。詳細な調査ログ・日付単位の作業記録は
持たず、決定事項・実装内容の要点のみを記録します。

**2026-08-15: 本ファイルと`archive/documents/pre-fix-v1.0/BACKLOG.md`を統合し、本ファイルへ
一本化した(後者は削除済み)。あわせて、FIX ver1.0期(2026-08-10〜08-15)に完了したタスク
(クラスタA-1・B-3・J・K・L・N-2)を追記した。**

**2026-08-16: モバイル購入履歴画面のレースカード表示改善・ルートURLリダイレクト・
クラスタB(結果確定済みレース購入時の払戻即時反映)・騎手名エイリアス管理の新規実装を
追記した(期間5)。**

**2026-08-25: `archive/documents/`配下のファイル数圧縮のため、以下の作業を実施した。**
- JRAレース結果PDFインポートの旧修正記録6本(`JRA_RESULT_PDF_IMPORT_FIX_V3〜V5.md`・
  `_DIAGNOSTIC_V6.md`・`_VALIDATION.md`・`_PAYOUT_ISSUE_INVESTIGATION.md`)を削除。
  内容はいずれも`archive/documents/pre-fix-v1.0/JRA_RESULT_PDF_IMPORT.md`(統合サマリ)に
  要約済みのため、実質的な重複だった。
- v10時代の開発ログ5本(`DATA_MODEL_AUDIT.md`・`IMPLEMENTATION_NOTES_V10.md`・
  `BUGFIX_VALIDATION.md`・`CSV_IMPORT_SETUP.md`・`FIX_VERIFICATION.md`)を削除し、
  要点を下記「期間0」として本ファイルへ折り込んだ(内容はいずれも現行の
  `README.md`/`docs/DESIGN.md`/`docs/TESTING.md`にも反映済みで、これらのファイル自体は
  「当時の生ドキュメント」としての参照価値以上のものは持っていなかった)。
- 削除対象ファイルの一覧は本zip添付の`DELETIONS.txt`を参照。

新しいセッションで同じ修正を重複して行わないための参考資料として保管しています。現状の仕様は
`README.md` / `docs/DESIGN.md` / `docs/TESTING.md`を、未着手タスクの一覧は`docs/BACKLOG.md`を
参照してください。

---

## 期間0: v10確定期(〜2026-08-04頃。2026-08-25に旧5ファイルから要約統合)

**データモデル・ファイル運用の確定**
- 通常購入は`tickets`(購入グループ`group_id` + 1点1行)、CSV原本は`imported_tickets`、
  CSV購入グループは`imported_ticket_groups`、CSV個別買い目は`imported_ticket_items`という
  役割分担を確定(この構成は現在も維持されている)。
- DBファイルの役割を「`schema.sql`=新規構築用の最終形」「`latest1.sql`(現`migration.sql`)=
  既存DBを最新へ追いつかせる差分」として整理(現行のDBマイグレーション運用の原型)。

**CSV取込ロジックの初期バグ修正**
- 通常購入は着順・払戻確定後の変更・削除をロックする仕様だったが(のちに2026-07-31に
  全面撤廃)、集計画面の的中/確定判定が「着順のみ確定・払戻レート未入力」のケースを
  正しく拾えていなかった不具合を修正(`race_finish_order`/`race_payouts`のいずれかで
  判定するよう変更。この考え方は現行の`stats.js`の的中率判定にも引き継がれている)。

**手動テストチェックリストの整備**
- CSVインポート・予想印・馬メモ・馬券購入(組み合わせ生成数)・マイグレーション整合性の
  確認手順を整備。以後`docs/TESTING.md`として版を重ねて現在に至る。

**セットアップ手順の整備**
- ローカル/リモートD1への`latest1.sql`適用手順、`wrangler pages dev`でのローカル起動、
  CSVインポートAPI(`multipart/form-data`)の基本仕様を整備(現行README「セットアップ手順」の原型)。

---

## 期間1: 複数ユーザー対応期(〜2026-08-04)

**フェーズ1〜4(バグ修正・小規模改善)**
- CSV取込の複数的中払戻計算・重複判定キーへの日付追加、着順/払戻保存不具合の修正
- 予想登録画面の騎手名配置変更、予想印のドロップダウン化(1頭1印)、予想印に「消」を追加
- 出走頭数を5〜18頭化・枠番自動初期値の追加、レース編集画面に出走馬表とは独立した1〜3着
  セレクト(馬番のみ)を追加し、馬名未登録でも払戻入力できるように変更

**フェーズ5〜8(カレンダー・集計UI)**
- 購入履歴・レース管理画面にカレンダーを追加(常時表示・日付選択で絞り込み)
- 集計画面(レース別/競馬場別/騎手別)に列見出しクリックでの昇順⇔降順ソート機能を追加
- 三連複・三連単の2頭軸購入画面をJRA/netkeiba風の1リスト形式(軸/相手チェック列)に変更

**フェーズ9(CSVインポート反映)**
- CSV取込結果のうち着順が一意に定まる情報を`races.finish_order`へ、払戻レートを式別ごとに
  `races.payouts`へ反映する処理を追加
- 出走馬表登録・更新時に、同じレース・馬番を参照する購入履歴へ馬名・騎手を書き戻す
  バックフィル処理(`backfillHorseNamesForRace`)を実装

**フェーズ10〜11(予想登録画面・ロック仕様)**
- 予想登録画面のヘッダーを「日付・競馬場・R・レース名・頭数」の順に再設計し、購入ボタンを
  ヘッダー内に配置
- 通常購入(`tickets`)のロック仕様(着順・払戻確定後の編集・削除禁止)を全面撤廃

**フェーズ12(CSVインポートのN+1クエリ障害修正)**
- `ticket-imports`のGET/POSTがN+1クエリでCloudflare Workersのサブリクエスト数上限に抵触して
  いた障害を、関連データの一括取得・メモリ上グルーピング方式へ変更して解消

**フェーズ13(複数ユーザー対応の実装・2026-08-01)**
- `users`テーブルを新設し、自己登録制(招待コード無し)のログイン・登録を実装
- 管理者判定は環境変数`ADMIN_USERNAMES`で行う方式に決定(DBにフラグは持たせない)
- `tickets`/`imported_tickets`/`imported_ticket_groups`/`prediction_notes`/`prediction_marks`/
  `horse_notes`へ`user_id`を追加し、全APIをユーザー単位フィルタに対応
- レース登録・編集・削除を管理者限定化、CSV取込時のレース自動作成を廃止
- 管理者向け画面(`admin.html`: 未登録レース一覧・登録ユーザー一覧)を新設

**フェーズ14(モバイル対応・2026-08-02)**
- 購入画面の組み合わせ選択表・予想登録画面の馬行に、430px以下向けレイアウト調整を追加

**フェーズ15(スキーマ拡張・マイグレーション運用整備・2026-08-02〜08-03)**
- `races`に`course_type`/`distance`を追加
- マイグレーションファイルの再実行安全化を試行錯誤(`schema_migrations`テーブル・
  `-- @STEP`分割・Node.jsによる自動適用スクリプト等)した末、Windows環境でのNode.js不安定挙動
  により自動化を断念し、「`-- @STEP`単位を手動でwranglerのみで適用し、適用後はファイルから
  削除する」という現行の運用方式に確定した

## 期間2: リファクタリング(2026-08-04)
- 重複していた`escapeHtml`/`escapeAttr`を`utils.js`へ統一
- CSVインポートのUNIQUE制約違反時のエラーハンドリングを追加(該当行をスキップし
  `conflicted`件数・`conflicts`配列として報告)

## 期間3: pre-fix-v1.0期(2026-08-04〜2026-08-10)

**各画面の小規模改善**
- 購入履歴画面: 収支表示の実数化、同日内ソート順の統一、削除時の即時反映、カレンダー
  「今日」ボタンでの日付選択、購入済みレースの背景色表示
- レース管理画面: 未登録枠クリックでの事前入力モーダル、出走馬表/払戻モーダルの分割、
  払戻入力欄のグリッドレイアウト化
- 予想登録画面: 馬メモ有無バッジの追加、購入馬券欄の開閉可能化
- 管理画面: 登録ユーザー一覧の登録日時JST表示化
- 全画面: モバイルヘッダー(masthead)の折り返し不具合修正・高さ削減対応

**JRAレース結果PDFインポートの調査・修正(2026-08-05〜08-09)**
- 初期実装で解析結果が0レースになる不具合を、PDF.js抽出テキストの行内連結ロジック
  (単純タブ連結→間隔実測による連結/スペース/タブの3段階判定)への変更で解消
- 騎手名抽出、出走馬の並び順(馬番順ソート)、枠番未取得時のフォールバック計算、複数行に
  またがる払戻(複勝・ワイド等のcarryState方式)への対応を実装
- 払戻確定時に購入済みticketsのpayoutが全ユーザー分再計算されない不具合、および枠番未確定の
  枠連馬券が誤って「不的中」判定される不具合を修正(`recomputeTicketPayoutsForRace`の実装・
  呼び出し漏れ解消)
- **上記の詳細な修正の時系列(v3〜v6・payout issue調査)は、2026-08-25に
  `archive/documents/pre-fix-v1.0/JRA_RESULT_PDF_IMPORT.md`(統合サマリ)へ一本化し、
  個別ファイル(`JRA_RESULT_PDF_IMPORT_FIX_V3〜V5.md`・`_DIAGNOSTIC_V6.md`・`_VALIDATION.md`・
  `_PAYOUT_ISSUE_INVESTIGATION.md`)は削除した。経緯を詳しく追いたい場合は同ファイルを参照**

**出走馬一覧PDFインポートの新規実装(2026-08-07〜08-09)**
- 枠番・馬番なし/あり両対応の出走馬一覧PDFを解析し、馬名をキーにマージする機能を新規実装
- 実PDFでの検証により、枠番はテキスト取得不可(色付きアイコンのみ)と判明。調教師名の混入、
  マージ後の空行残留、特定騎手名でのみ発生する連結不具合等を順次調査・修正

## 期間4: FIX ver1.0期(2026-08-10〜2026-08-15)

**2026-08-10 整理**: README/DESIGN/TESTING/BACKLOGを「現状のみを記す生きたドキュメント」として
再整理し、過去の作業ログを`archive/documents/`へ退避する運用に統一した。

**クラスタA-1**: レースカードの表示順を「日付・競馬場・レース番号(左)」「購入額・払戻額・収支
(右)」に変更

**クラスタB-3**: 購入モーダルの初期表示を「単勝選択済み・馬選択画面まで自動表示」に変更

**クラスタJ(予想登録画面・2026-08-10〜08-11、全5件完了)**
- J-1: 購入馬券欄の各買い目行で購入金額をその場で編集可能に(`PUT /api/tickets/:id`)
- J-2: モバイルでの操作説明文を非表示に
- J-3: モバイルで予想印セレクトが画面端で見切れる不具合を修正
- J-4: メモ展開トグルの折返し不具合を修正、馬メモ登録済み行の背景色を購入済みレースと
  揃えて変更
- J-5: メモ入力欄のプレースホルダー説明文を削除

**クラスタK(モーダル共通ESCキー対応・2026-08-12・完了)**
- 出走馬編集・払戻編集・出走馬一覧PDFインポート・JRAレース結果PDFインポート・開催日程一括
  登録・馬券購入モーダルの全6モーダルで、ESCキー押下時にキャンセル相当(保存せず閉じる)の
  挙動を実装
- 共通ヘルパー`registerEscToClose(modalEl, closeFn)`を`utils.js`に新設

**クラスタL(出走馬/結果PDFインポートの統合修正・race_results新設・2026-08-11〜08-12・完了)**
- 出走馬一覧PDFインポートとJRAレース結果PDFインポートで異なっていたentriesマージロジックを、
  共通ヘルパー`mergeEntriesByHorseName()`(`functions/api/_shared.js`)に統一
- `races`テーブルへレース条件詳細カラム(`weight_type`/`class_flags`/`course_direction`/
  `weather`/`track_condition`)を追加、`entries[].sex_age`/`weight_carried`を追加
- 新テーブル`race_results`(馬単位の確定結果を1頭1行で記録: 全着順・タイム・着差・
  コーナー通過順位・推定上り・馬体重・単勝人気・取消/除外・競走中の出来事メモ)を新設し、
  結果PDFインポート時にUPSERTするよう実装
- 枠番の推定値をDBへ保存する処理を廃止し、`null`のまま送信するよう方針転換(表示用の目安
  計算のみ`races.js`側に残す)
- レース管理画面の払戻モーダルに`race_results`詳細の閲覧・`incident_note`編集UIを追加
- `migration.sql`の`race_results_and_conditions`ステップは2026-08-12に本番DB適用・
  `schema_migrations`記録済み。内容は`schema.sql`に統合済み

**クラスタN-2(コース種別・距離の表示欠落修正・2026-08-14・完了)**
- コース種別が未入力(null)で距離のみ入力されている場合、距離も含めて一覧・モーダルの
  どちらにも表示されない不具合を修正
- 共通関数`formatCourseText(courseType, distance)`を新設し、`renderRaceRow()`・
  `openPayoutModal()`に重複していたロジックを統一

## 期間5: FIX ver1.0期・追加改善(2026-08-16)

**モバイル購入履歴画面のレースカード表示改善(2026-08-16・完了)**
- モバイル(`700px`以下)のレースカードヘッダーが縦長になりすぎる問題に対応。1行目に
  競馬場・レース番号・レース名(日付は非表示。カレンダーで既に選択済みのため)、2行目に
  「購入額・払戻額・収支」を左寄せ表示し、開閉矢印(▸/▾)を2行目末尾へ移動する2行構成へ変更
- レース名は画面幅に収まらない場合のみCSSの`text-overflow: ellipsis`で省略(固定文字数
  カットではない)
- PC(`700px`超)の表示は変更なし。HTML構造はPC・モバイル共通(`public/app.js`の
  `renderRaceCard()`)で、CSSの`order`/`flex-basis`/`margin-right:auto`(`public/style.css`の
  `@media (max-width: 700px)`)のみで見た目を切り替える方式で実装

**ルートURLのリダイレクト(2026-08-16・完了。※2026-08-16(2)にファイルリネーム方式へ変更済み)**
- ログイン後の初期画面を「馬券購入」画面にしたいという要望に対応。各画面がそれぞれ独立して
  ログイン画面を内包しページ間の自動遷移を行わない設計のため、「ルートURL(`/`)へアクセスした
  際にどの画面が表示されるか」で対応することにした
- 当初は`functions/_middleware.js`によるHTTPリダイレクト方式で実装したが、Cloudflare Pagesの
  「`*.html`付きURLへのアクセスを拡張子なしURLへ自動的に308リダイレクトする」標準挙動と衝突し、
  「馬券履歴」ナビリンクをクリックしても馬券購入画面に遷移してしまう不具合が生じたため、
  2026-08-16(2)に**ファイル名リネーム方式**(`buy.html`→`index.html`、旧`index.html`→
  `history.html`)へ修正した。現行の実装・詳細は`docs/DESIGN.md`「トップページ(/)の表示に
  ついて」参照

**クラスタB: 結果確定済みレース購入時の払戻即時反映(2026-08-16・完了)**
- 過去に購入した馬券の履歴を残す目的で、既に着順・払戻が確定済みのレースへ後から購入した
  場合、保存時点では`payout`が`null`(未確定)のままとなり、レース管理画面で払戻を再保存する
  まで購入履歴・集計画面に「未確定」表示が残り続ける不具合を修正
- `functions/api/tickets/bulk.js`(通常購入API)で、チケットのINSERT直後に対象レースの
  `finish_order`/`payouts`を確認し、いずれかが確定済みであれば既存の
  `recomputeTicketPayoutsForRace()`(`functions/api/_shared.js`。JRAレース結果PDF一括登録・
  払戻編集モーダル保存時に既に使われているロジック)を呼び出して即座に払戻を計算・反映する
  よう変更した。新規ロジックの追加ではなく既存ロジックの再利用のため実装リスクは低い
- 払戻の即時反映処理が失敗しても、購入自体(履歴の記録)はロールバックしない
  (`try/catch`で握りつぶし、ログのみ残す設計)
- CSVインポート経由の購入履歴(`imported_ticket_items`)は元々「取込時点で決着済み」という
  前提のデータのため、この問題は対象外(今回のスコープにも含めていない)

**騎手名エイリアス管理(jockey_aliases)の新規実装(2026-08-16・完了)**
- 同一騎手がPDFインポート・手動入力(netkeibaテキスト貼り付け含む)経由で異なる表記
  (異体字・空白有無・文字欠落等)で登録され、`stats.html`の騎手別収支集計が同一人物を
  複数行に分裂させてしまう問題への対応
- 表記ゆれ→正しい表記の対応表`jockey_aliases`テーブルを新設(`migration.sql`へ
  `-- @STEP: jockey_aliases`を追記。2026-08-25時点でも実DBへは未適用の可能性あり。
  `docs/BACKLOG.md`の運用作業チェックリストを参照)
- 突き合わせキー(`alias_key`)は見習い減量記号(☆▲△★◇)と空白(全角/半角)を除去した
  文字列とし、姓名間のスペース有無は同一人物として扱う仕様にした
- 今後登録されるデータの救済: レース新規登録・編集(`functions/api/races/index.js`・
  `[id].js`)、出走馬一覧PDFインポート(`entries-import.js`)、JRAレース結果PDFインポート
  (`results-import.js`)の保存直前に、`loadJockeyAliasMap()`で1回だけ取得したエイリアス
  Mapを使って`applyJockeyAliasMap()`で正規化する(N+1回避)
- 既存データの救済: 管理画面(`admin.html`)の「既存データの騎手名を一括補正する」ボタンから
  `normalizeExistingJockeyNames()`を実行し、`races.entries`・`race_results.jockey`・
  `tickets.selections`・`imported_ticket_items.selections`のうちエイリアスと一致した
  表記のみを一括書き換え(未登録の表記は変更しない。冪等)
- 管理画面にエイリアスの一覧・追加・削除UIを新設(編集機能は無し。API4種はいずれも
  管理者限定)
- 併せて、過去のセッションで`docs/DESIGN.md`・`docs/BACKLOG.md`に誤って残っていた
  「race_results関連機能が実装待ち」「migration.sqlのrace_results_and_conditionsが
  未適用」という誤記述(実際は2026-08-12に実装・適用完了済み)を修正し、ドキュメントの
  正確性を回復した

**購入画面 レース選択グリッドのUI改修(2026-08-16・完了)**
- 経緯: BACKLOGクラスタB「レース選択画面のnetkeiba風UI改修」のうち②③④、および新規要望
  (モバイルの競馬場タブ化・タブ並び順)をまとめて実装した
- **モバイル(700px以下)の競馬場タブ化**: `public/buy.js`の`renderGrid()`を改修し、
  `#race-track-tabs`にその日開催のある競馬場だけをタブ表示。選択中タブの競馬場カラム
  (R1〜12昇順)だけを表示し、他は`display:none`にする。日付切り替え時はタブ選択を
  その日の先頭競馬場(並び順の一番東)へリセットする
- **タブ・カラムの並び順**: 新定数`RACE_TRACK_ORDER`(`public/buy.js`)で「中央4場(主要場)
  を東から → 中央ローカル6場を東から → 南関東4場を東から → その他地方10場を東から」の
  順に固定。地方競馬場(南関東・その他)は本アプリのデータ構造上元々track列は自由入力
  だったため追加のスキーマ変更は不要だった。南関東・その他地方の並び順(経度概算)は
  ユーザー承認済みだが確証は無いため、違和感があれば`RACE_TRACK_ORDER`を修正する運用とする
- **PC(700px超)の3競馬場同時表示**: `#race-grid .race-track-column`の最小幅を240px→200pxへ
  縮小し、`.buy-main`(max-width:720px)内で最低3競馬場が横スクロール無しで収まるようにした
- **コース情報表示**: 各レース行の頭数表示の左に、`formatCourseText(course_type,
  distance)`によるコース情報(例: `ダ1800m`)を追加。元々`races.js`内にのみ定義されていた
  `formatCourseText`/`courseTypeShort`を`public/utils.js`へ移動し、`races.js`・`buy.js`
  両方から共有する形に統一した(重複定義の解消)
- **メモありマーク「▼」**: 出走馬にログインユーザー自身の空でない馬メモが1頭でもあれば
  頭数表示の右に「▼」を表示。判定はレースごとの個別APIを叩くN+1を避けるため、
  `GET /api/horse-notes`(`race_id`省略時)を新設し、自分の空でないメモがある馬名一覧
  (`{ names: [...] }`)を1回のリクエストでまとめて取得する方式にした
  (`functions/api/horse-notes/index.js`)。既存の`race_id`指定時の挙動(予想登録画面)には
  影響しない
- CSSは`#race-grid`配下にスコープしたセレクタのみを追加し、`races.html`のレース管理画面の
  カラム表示(同じ`.race-columns`/`.race-track-column`クラスを使用)には影響しないよう配慮した
- スタイルシート変更に伴い、運用ルール(`docs/DESIGN.md`「CSSのキャッシュ対策」)に従って
  全HTMLファイルの`style.css?v=`を`v=1`→`v=2`へ更新した
- 残タスク: レース番号とレース名の間隔詰め(①)のみBACKLOGに残置。実機(実ブラウザ)での
  動作検証は未実施(コードレビューのみ)。

## 期間6: FIX ver1.0期・ドキュメント整合性の是正(2026-08-17)

**部首文字正規化の回帰不具合の修正(2026-08-16発見・2026-08-17ドキュメント確認・完了)**
- 2026-08-14の人名異体字保護修正(全文への`NFKC`正規化の廃止)の副作用で、JRA PDFの
  テキスト抽出結果に含まれる「日」「月」「発」「走」「馬」等の通常の漢字が、康熙部首
  (Kangxi Radicals, U+2F00–2FD5)・CJK部首補助(CJK Radicals Supplement, U+2E80–2EF3)と
  いう別のUnicodeブロックの文字として抽出されるケースがあり、日付・発走時刻等の検出が
  0件になる回帰不具合(解析結果0レース)が発生していた
- `public/jra-result-pdf.js`の`jraResultNormalizeRadicals()`・`public/jra-entries-pdf.js`の
  `jraEntriesNormalizeRadicals()`として、該当2ブロックの文字のみを対象にした
  `normalize("NFKC")`適用処理を追加して解消した。対象は個別文字のテーブル化ではなく
  Unicodeブロック全体とし、将来別の部首文字が出現しても自動対応できるようにした
- 「戸崎」等の人名異体字保護(2026-08-14修正の効果)には影響しない(対象の部首ブロックが、
  異体字の原因だったCJK互換漢字ブロック等とは重複しないため)
- パーサーバージョンを更新: `public/jra-result-pdf.js`は`9.2.0-radical-fix`、
  `public/jra-entries-pdf.js`は`1.4.0-radical-fix`
- 併せて、出走馬一覧PDFインポートで抽出した性齢(`sex_age`)・負担重量(`weight_carried`)を
  `entries`へ含めてサーバーへ送信する処理も、コード実装は既に完了していた(ドキュメント側の
  「実装待ち」表記が古いままだった)ことを確認し、`docs/DESIGN.md`の記述を実態に合わせて
  修正した
- 実ブラウザのPDF.jsでの実機検証は未実施(コードレビューのみ)。`docs/BACKLOG.md`
  「調査中の不具合」参照

## 期間7: リファクタリング(2026-08-17)

**クラスタI: トラック(競馬場)リストの重複整理(完了)**
- `JRA_TRACKS`(`public/parse.js`)・`JRA_ENTRIES_TRACKS`(`public/jra-entries-pdf.js`)・
  `JRA_RESULT_PDF_TRACKS`(`public/jra-result-pdf.js`)の3つが、いずれも中央10場
  (札幌・函館・福島・新潟・東京・中山・中京・京都・阪神・小倉)を全く同じ並び順で保持する
  重複配列になっていた
- 共有定数`JRA_CENTRAL_TRACKS`を`public/utils.js`に新設し、上記3ファイルはそれぞれ
  元の変数名を維持したまま`JRA_CENTRAL_TRACKS`を参照する形に変更した
  (例: `const JRA_TRACKS = JRA_CENTRAL_TRACKS;`)。ESモジュールを使わないグローバル
  スクリプト構成のため、`races.html`で`utils.js`が該当3ファイルより必ず先に
  読み込まれる点を利用している。変数名・参照箇所・挙動はいずれも変更していないため、
  この集約自体で表示・解析結果が変わることはない
- `public/buy.js`の`RACE_TRACK_ORDER`(表示順序用。中央4場を先頭にした独自順序・
  地方競馬場を含む)は用途が異なるため、統合対象から明示的に除外した
- 調査の過程で、`JRA_ENTRIES_TRACKS`(`jra-entries-pdf.js`)自体がファイル内のどこからも
  参照されていないこと(開催情報の検出はこの配列を使わずハードコードされた正規表現で
  行われている)、および`JRA_RESULT_PDF_TRACKS`を使う`jraResultParseTrack()`
  (`jra-result-pdf.js`)もファイル内のどこからも呼ばれていないことが判明した。
  いずれも今回は変数名・挙動を変えない方針を優先し、削除は行っていない
  (未使用コードの削除自体は今回のスコープ外)
- `docs/BACKLOG.md`クラスタIの「CSSキャッシュバスティングの一元化」は、ビルドツール
  導入が前提になり「Node不要・wranglerのみで手動運用」という方針と衝突するため、
  2026-08-17に改めて対象外であることをユーザー確認済み(着手しない)
- Node上での構文チェック(`node --check`)のみ実施。実ブラウザでの動作確認は未実施
  (ユーザー側で実施予定)

## 期間8: ドキュメント整理(2026-08-25)

**アーカイブ文書のファイル数圧縮(完了)**
- `archive/documents/`配下に残っていた、内容が既に別ファイルへ要約・統合済みの
  重複ドキュメント11本を削除した(削除ファイル一覧は本アーカイブ更新時に添付した
  `DELETIONS.txt`参照)。
  - JRAレース結果PDFインポートの旧修正記録6本 → `pre-fix-v1.0/JRA_RESULT_PDF_IMPORT.md`
    (統合サマリ)に要約済みのため削除。詳細な時系列を追いたい場合は同ファイルを参照
  - v10時代の開発ログ5本 → 要点を本ファイル「期間0」として折り込んだうえで削除
- `archive/documents/pre-fix-v1.0/README.md`・`DESIGN.md`・`TESTING.md`・
  `JRA_RESULT_PDF_IMPORT.md`の4本、および`archive/migrations/`配下(旧DBを手動で
  追いつかせるための実行可能な参照資料のため)は今回の圧縮対象から除外し、従来通り
  保管を継続する
- `docs/BACKLOG.md`・`docs/DESIGN.md`・`docs/TESTING.md`・`README.md`など現行の
  生きたドキュメント自体には内容変更なし(参照リンクの張り替えも不要。個別ファイルへの
  直接リンクは元々置いていなかったため)

---

## 期間9: リファクタリング・日付/金額フォーマッタの集約(2026-09-07)

**クラスタI: `formatDate`の重複整理(完了)**
- `formatDate`が`utils.js`・`prediction.js`・`races.js`・`stats.js`・`admin.js`の5箇所に
  独立して定義されており、グローバルスコープでの`<script>`読込順によって「月日2桁
  (`2026/08/24(日)`)」と「月日1桁(`2026/8/24(日)`)」のどちらが有効になるかが画面ごとに
  変わっていた。その結果、全画面共通の`cart.js`(かご)の日付表示が、開いている画面に
  よって1桁/2桁で揺れていた
- `public/utils.js`に以下を集約し、各画面のローカル定義を撤去した:
  - `formatDate(dateStr)` → `2026/08/24(日)`(全画面共通の標準表記。月日2桁ゼロ埋めへ統一)
  - `formatDateMdW(dateStr)` → `8/24(日)`(管理画面「未登録レース一覧」。年なし)
  - `formatDateMd(dateStr)` → `8/24`(集計画面レース別の集計名。年・曜日なし)
  - いずれもパース不能時は入力文字列をそのまま返すガードを追加
- あわせて金額表示の直書き(`¥${n.toLocaleString()}`)が約35箇所、符号付き金額
  (`${p>=0?"+":""}¥...`)が約10箇所に散在していたため、`formatYen`/`formatSignedYen`/
  `formatSignedNum`を`utils.js`に新設し全置換した。出力は従来と同一(負号は`¥`の後ろ)。
  内部で`Number(n||0)`を通すため、文字列が渡っても桁区切りが効くようになった
- `admin.js`の`formatDateTime()`(DBの生UTC文字列→JST変換)は用途が異なるため統合対象外、
  `admin.js`内に残置
- **表示変更点**: 予想画面・レース管理画面・かごの日付が月日1桁→2桁に変わる。
  集計・管理画面の年なし/曜日なし表記、およびその他画面の見た目は不変
- `node --check`(8ファイル)・静的レビューのみ実施。実ブラウザでの目視確認は未実施
  (`docs/BACKLOG.md`の🔵実機検証未完了に記載)
- 仕様は`docs/design/screens.md`「日付・金額の共通フォーマッタ」に追記

**③ サーバハンドラの定型コードを `functions/api/_lib/http.js` へ集約(完了)**
- `let data; try { data = await request.json(); } catch { return <400> }` が13ファイル、
  正の整数ID検証(`Number(x); if (!Number.isInteger(id) || id <= 0) return <400>`)が6ファイルに
  独立して書かれていた。エラーレスポンスも `Response.json({error},{status})` と
  `new Response(JSON.stringify({error}), {status, headers})` が混在(`predictions/index.js` は
  独自の `jsonError` を持っていた)
- `_lib/http.js` を新設し `_shared.js` から re-export:
  - `jsonError(message, status = 400, extra?)` — `{ error, ...extra }` を返す(`Response.json`相当)
  - `readJsonBody(request)` → 成功 `{ data }` / 失敗 `{ error: <400> }`
  - `parsePositiveIntId(raw, label = "ID")` → 成功 `{ id }` / 失敗 `{ error: <400> }`
- 17ファイルを書き換え。全エラーレスポンスを `jsonError` に統一(混在していた2形式を解消)。
  `Content-Type` ヘッダが付いていなかった `new Response(JSON.stringify(...))` 系の400/500に
  ヘッダが付くようになった(挙動改善。レスポンスボディは不変)
- **メッセージの微変更**: クエリパラメータ欠落時の `race_id`(GET `predictions`・`horse-notes`)が
  「race_idが必要です」→「race_idが不正です」に統一された
- **対象外**: `ticket-imports/index.js`(CSV取込。`formData()`使用・エラー形が `{ok:false,error}` で
  他と異なる)、`_middleware.js`(認証前の一度きりの応答)は変更しない
- `node --check`(19ファイル)のみ。実機検証は未実施

**① HTML共通シェル(masthead/nav/login-screen)を `public/shell.js` へ集約(完了)**
- 6HTML(index/history/stats/prediction/races/admin)がログイン画面(`#login-screen` 約14行)と
  ヘッダー(`header.masthead` 約6〜10行)を丸ごと重複保持しており、ナビ項目変更・ログイン画面の
  文言変更のたびに6ファイル編集が必要だった(かごバッジ追加時に実際に発生)
- `public/shell.js` を新設(IIFE。各HTMLで `utils.js` の直後・`auth.js` より前に読込)。
  実行時に `#login-screen` と `header.masthead` の中身を生成注入する。各HTMLは
  `<body data-page="...">` + 空の `<div id="login-screen">` + 空の `<header class="masthead">` だけ持つ
- ナビ項目は `NAV_ITEMS` 配列、ページ固有ヘッダーボタン(history のCSVインポート、races の
  PDFインポート×2・レース登録)は `PAGE_ACTIONS` で一元管理。ボタンidは従来通りのため
  `app.js`/`races.js` のイベント登録は無変更で動作。`data-admin-only` も従来通り付与し
  `auth.js` が表示切替
- `<head>`(フォント・`style.css?v=3`)は各HTMLに残置(FOUC回避・`?v=` 運用のため)
- 生成HTMLは従来のDOM構造と同一(空白のみ差異)。`#app-screen`/`#login-screen` は
  `hidden` 状態で注入されるため描画のちらつきは無い
- 各HTMLが概ね半減(例: history.html 76→約40行)
- 仕様は `docs/design/screens.md`「全画面共通シェル(shell.js)」に追記

**②③① の実機確認(2026-09-08 完了)**
- ユーザーが実ブラウザで ②(日付・金額表記)③(各APIのエラー応答含む動作)①(6画面の
  ログイン前後・ナビ・管理者/一般切替・かごバッジ・パスワード変更モーダル)を確認し、
  問題なしと判断。`docs/BACKLOG.md` の🔵実機検証未完了3件は解消済み

**馬券かごバッジ: 0件時の非表示修正(2026-09-08)**
- `cart.js` が注入する `.cart-badge-count { display: inline-flex }` が `hidden` 属性の
  デフォルト `display:none` を上書きしており、選択中0件でも赤丸「0」が表示され続けていた。
  `.cart-badge-count[hidden] { display: none }` を注入スタイルに追加して打ち消した

**デッドコード削除(2026-09-08)**
- 呼び出し元が0件の関数・定数を約146行削除(`node --check` と全文検索で0ヒットを確認):
  - `combos.js`: `slotsForNormal` `slotsForBox` `slotsForFormation` `slotsForAxis1Unordered`
    `slotsForAxis1Ordered` `slotsForAxis2Ordered`(buy.jsの2分割・購入モーダル再実装で不要化)
  - `bettypes.js`: `availableMethods`(`buy-purchase-modal.js` の `methodsFor()` に置換済み)
  - `stats.js`: `fetchImportedTicketHistory`(`loadAndRender` が直接 `authedFetch` 済み)
  - `jra-result-pdf.js`: `jraResultToHalfwidthAscii` `jraResultNormalizeRadicals`
    `jraResultParseTrack` `jraResultParseCourse` `jraResultParseNumberList`
    `jraResultPayoutTypeAt` + 定数 `JRA_RESULT_PDF_TRACKS` `JRA_RESULT_BET_MAP`
  - `jra-entries-pdf.js`: `jraEntriesToHalfwidthAscii` `jraEntriesNormalizeRadicals`
    `jraEntriesParseWeather` + 定数 `JRA_ENTRIES_TRACKS`
  - `utils.js`: 定数 `JRA_CENTRAL_TRACKS`(上記トラック配列エイリアスを全て削除した結果、
    参照元が消滅。将来必要になれば1行で再追加できる)
- `races.js`/`buy.js` 冒頭コメントの `JRA_CENTRAL_TRACKS` を例に挙げた記述を一般化
- `docs/ROADMAP.md` クラスタI の「トラックリスト重複整理」「buy.js/races.js巨大ファイル分割」を
  完了化。新たに「jra-result-pdf.js パーサ分割」「app.js⇄prediction.js グループ描画共通化」を追加

**B: 購入馬券グループ表示の共通部品化(2026-09-08。方向1=部品のみ共通化)**
- 購入履歴画面(`app.js` `renderGroupRow`)と予想登録画面(`prediction.js`
  `renderPurchasedTickets`)は、`.group-card > .group-card-head` + `.group-detail` の
  同型UIを持つが、編集可否・削除ボタン・ステータスバッジ・買い目の馬名表示有無等の
  機能セットが異なる。単一の設定駆動レンダラに寄せると差分吸収フラグが約7個必要で
  可読性・リグレッション面が不利と判断し、**差分の無い純粋関数だけ**を新規
  `public/ticket-view.js` に集約:
  - `groupTicketsByGroupId(tickets)` / `sumTicketAmount` / `sumSettledPayout`
  - `ticketMoneyText(tickets)` → `<span class="group-money">` の「購入¥… / 払戻¥…」文字列
  - `ticketGroupStatus(group)` → 「確定済み」「一部確定」「未確定」
  - `selectionCellHtml(betType, selections)` → 馬名付き `.sel-item` markup(app.js の IIFE を抽出)
- レンダラ本体・DOMイベント配線・変更後の再描画方式は両ファイルに残置
- `ticket-view.js` は `history.html` と `prediction.html` のみ読込(`utils.js`/`bettypes.js` の後、
  `app.js`/`prediction.js` の前)
- 予想画面の買い目セルは馬番のみ(`formatSelections`)据え置き。`selectionCellHtml`(馬名付き)は
  現状 app.js のみ使用(将来 prediction が採用可能)
- 挙動は維持。app.js の `t.amount` 直参照が `Number(t.amount||0)` になり不正データ耐性が向上
- `app.js` −30行 / `prediction.js` −12行、`ticket-view.js` +61行。`node --check` 3ファイル通過

**C: jra-result-pdf.js のパーサ関数分割(2026-09-08)**
- `jraResultParseExtractedPages`(527行・コードベース最大の関数)を、**ロジック不変**で
  2つのヘルパーに関数抽出:
  - `detectRaceHeaders(lines, contexts, diagnostics, pushSample)` → レース境界(ヘッダー)
    検出の2パス(約120行)
  - `parseRaceBlock(block, header, number, diagnostics)` → レース1件分のブロックから
    race/raceDiag を抽出、`{race, raceDiag, include}` を返す(約250行)
  - 本体は約130行のオーケストレータ(①行フラット化 → ②`detectRaceHeaders` → ③per-race
    ループで`parseRaceBlock` → ④マージ・検証)
- **意図的な差分は6箇所のみ**:
  1. `JRA_RESULT_PDF_PARSER_VERSION` に `-split` 接尾辞(診断パネルで新コードだと分かる)
  2〜4. ループ変数 `h` → 関数引数 `header`(`h.date`/`h.track` の参照3行)
  5〜6. `pageStart`/`pageEnd` の `lines[h.index].page` → `block[0].page`
        (`block = lines.slice(h.index, end)` なので `block[0] === lines[h.index]`)
  7. `records.push({race:current,diag:raceDiag})`(try内)→ `include = true` フラグ +
     呼び出し側 `if (include) records.push(...)`。判定条件・`raceDiagnostics.push` は不変
- パース処理のコード(正規表現・`jraResult*` 呼び出し・`diagnostics.*++`・`current.*.push` 等)は
  **1行も変更していない**。原本と新版の「実行文の行集合」を突き合わせて、上記6箇所以外の
  差分ゼロを確認
- `node --check` 通過。実PDF(複数レース入り)での動作確認・診断パネルの各カウンタ一致確認は
  ユーザー(実機検証環境なし)
- 仕様は `docs/design/results-import.md`「解析ロジックの要点」に追記

**ドキュメント整理・実機検証済み項目の棚卸し(2026-09-08)**
- `docs/BACKLOG.md` 🔰セクションを 2026-08-30 付け → 現状に更新
- `docs/ROADMAP.md` クラスタF(馬券かご=実装済み)の確定仕様44行をポインタ1段落に、
  クラスタI(全完了)を要約1段落に圧縮(ROADMAP 123→88行)
- `docs/BACKLOG.md` 🔵実機検証未完了から、ユーザーが実運用で確認済みの3件
  (PDFインポート / 一括購入・redirect / サブリクエスト数対策)を削除
- **migration 3件の本番適用状況を確認**(ユーザーが `wrangler d1 execute --remote` で照会):
  `jockey_aliases`(91行)・`tickets_refunded`(列あり)・`users_last_login`(列あり)は
  いずれもスキーマ適用済み。`schema_migrations` 台帳は `users_last_login` のみ記録済みで
  `jockey_aliases` / `tickets_refunded` は記録漏れ。`migration.sql` から3つの `@STEP` ブロックを
  削除(内容は `schema.sql` に反映済み・再実行リスク消滅)。台帳の記録漏れは
  `INSERT OR IGNORE INTO schema_migrations ...` で埋められるが必須ではない

**BACKLOG の各タスク再精査(2026-09-08)**
- ⚠️テーブルと未着手クラスタを実コードと突き合わせ、陳腐化した記述を修正:
  - パーサー「非対称性(結果PDF側に未反映)」→ 2026-09-01 の `jra-pdf-common.js` 共通化で解消済み。
    ⚠️の該当行から削除、特定騎手バグの記述のみ残す
  - `GET /api/ticket-imports` の的中率漏れ → 「CSV取込は現在すべて payout 非null」で前提が
    一部変化。実害は「CSV取込後にレース結果が確定しても `imported_ticket_items` が
    再計算されない」点に修正
  - PDF払戻の矢印区切り → 具体的な修正方針(区切りクラスに `→>` 追加)を追記
  - クラスタE-1(CSV外れ馬券も確定扱い)→ 2026-08-14 実装済みのため削除
  - クラスタG(結果一括登録の残課題)→ 中身は⚠️#1・#2 へのポインタのみだったため削除
- **N-3(ログアウトAPI 401 でCookieが消えない)**: 一旦「実装しない」としたが、修正が1行で
  済むため 2026-09-08 のタスク再精査でユーザーが「やる」に方針変更。`docs/BACKLOG.md` の
  「優先順位」A 段へ。修正は `functions/_middleware.js` の `isPublicAuthRoute` に
  `url.pathname === "/api/auth/logout"` を追加するだけ

**BACKLOG の優先順位をユーザー方針で再整理(2026-09-08)**
- `docs/BACKLOG.md` の「優先順位」を A(早め)/B(中期)/C(そのうち)/後回し/クローズ に再編:
  - **A 段(早め)**: N-3 ログアウト修正、払戻の矢印区切り修正(**バグ確定**: 連系=`-`・単系=`→`
    で、パーサが `[-,、]` のみのため馬単・三連単の払戻を取りこぼしている)、payout マージを
    常に上書きに、CSV取込後の再計算(ユーザーが困っている)、CSV返還行の payout 見直し
    (要CSVサンプル)、N-4 の性齢・負担重量の表示、CSSキャッシュバスティング一元化
  - **後回し**: N-1 馬番重複防止(インポート運用が主)、クラスタD 未登録レース登録モーダル化
  - **クローズ**: 騎手名連結の不具合 →「とりあえず解決」(騎手エイリアス運用でカバー)、
    ROADMAP クラスタH 外部データ取得 → 対象外(手段が存在しない)、
    ROADMAP クラスタI CSSキャッシュ → BACKLOG A 段へ移動
- `docs/ROADMAP.md`: クラスタF/H/I は経緯のみに圧縮。生きているのは クラスタM だけ

**枠番自動計算の不具合修正(2026-09-08)**
- `computeWakuNumberFromHorseNumber()`(`_lib/entries-merge.js`)・`defaultWakuNumber()`
  (`races-entries-modal.js`)が **7頭以下のレースで誤った枠番**を返していた
  (`horseCount<=7` で `base=Math.floor(horseCount/8)=0` になり、若い枠から順に「0頭」が
  割り当たって枠番が全体的に後ろへずれる。例: 5頭立てで馬番1が枠4)。8頭以上は正常。
- 両関数に `if (horseCount <= 8) return horseNumber;` の早期リターンを追加(8頭以下は
  例外なく枠番=馬番)。
- あわせて `mergeEntriesByHorseName()` に補正ロジックを追加: **馬番が1〜Nの連番で揃った
  8頭以下の出走馬表**に限り、`waku_number` が `horse_number` と一致しない確定値を
  再計算値で上書きする(8頭以下は枠番に選択の余地が無いため安全)。旧バグで誤保存された
  レースは同じPDFを再インポートすれば自動補正される。
- `node --check` 通過。修正後アルゴリズムの出力を頭数3〜18で確認しJRAの枠番割当ルールと一致。
  実PDFでの確認はユーザー。仕様は `docs/design/data-model.md`「枠番は馬番から自動計算」に追記

**A段バグ修正3件(2026-09-08。優先順位 A 段の軽い3つ)**
- **N-3 ログアウト401**: `functions/_middleware.js` の `isPublicAuthRoute` に
  `url.pathname === "/api/auth/logout"` を追加。セッション切れ状態で「退場」を押しても
  Set-Cookie(Max-Age=0)が返るようになった
- **払戻の矢印区切り対応**: JRA払戻表は連系(馬連・ワイド・枠連・3連複)=「-」、
  単系(馬単・3連単)=「→」(ユーザー確認)。`jra-result-pdf.js` の払戻抽出
  (`jraResultAddPayout` の `.split`、`jraResultParsePayoutLine` の2つの matchAll regex、
  `extractBySize` の `.split`)の区切りクラス `[-,、]` に `→` を追加。これで馬単・3連単の
  払戻レートが正しく `combo` に入る(単系は split 順=着順をそのまま使う)。
  既に誤登録されているレースは下記 overwrite で再インポートすれば直る
- **payout マージを常に上書きに**: `results-import.js` に `mode:"overwrite"` の挙動を追加し、
  `jra-result-pdf.js` の送信を `fill-empty` → `overwrite` に変更。**取込側PDFに着順/払戻が
  あるレースは、既存を式別マージせず丸ごと置き換える**(CSV等で一部式別だけ入っていた
  レースも完全な払戻で上書き。⚠️「マージが all-or-nothing」も同時解消)。取込側が空
  (PDF解析で取れなかった)のレースは既存を維持。`recomputeTicketPayoutsForRaces` は従来通り
  呼ばれ、通常購入(`tickets`)の payout は再計算される(CSV分の再計算は別タスク=A段に残)
- `node --check` 3ファイル通過。実PDFでの動作確認はユーザー。
  仕様は `docs/design/results-import.md` に反映

**払戻の矢印区切り — 実PDFで検証(2026-09-08)**
- ユーザー提供の JRA結果PDF(2026-09-06 4回中山2日・12レース)の払戻表を確認した結果、
  **馬単・3連単も含め全式別が `-`(ハイフン)**(例: 馬単 `2-7`、3連単 `2-7-6`)。`→` は
  払戻表には出現しない(`→` は Club JRA-Net購入履歴CSV 側の 3連単表記で、そちらは既存対応済み)。
  → 結果PDFの払戻パースに不具合は無かった。上で追加した `→` 対応は将来のための保険として残す

**CSV取込後の再計算(2026-09-08。A段)**
- `imported_ticket_items`(CSV取込分の個別買い目)の `payout`・`is_hit` は取込時点のCSV列で
  決まり、その後レース結果が確定・変更されても再計算されず、「CSV先 → 結果PDF後」の順だと
  的中判定がずれたまま残っていた
- `functions/api/_lib/ticket-payout.js` をリファクタ: 1枚分の払戻計算を `computeSettledPayout()`
  に切り出し、`tickets` と `imported_ticket_items` の両方を同じ内部関数
  `buildRecomputeStatements()` で処理するように変更
- `recomputeTicketPayoutsForRace` / `recomputeTicketPayoutsForRaces` の**シグネチャは不変**。
  内部で `imported_ticket_items` も SELECT → 再計算 → `db.batch()` で更新するようになった。
  4つの呼び出し元([id].js / results-import.js / entries-import.js / tickets/bulk.js)は無変更で
  CSV分も追従する
- **安全策**: Club JRA-Net CSV は決着済みデータのため、レース結果から的中が確認できない場合に
  既存の正の `payout` を 0 に落とすことはしない(0/null → 確定、増額方向のみ更新)。
  判定不能(`combo === null` = 枠番未確定等)のときも CSV 由来の値を維持
- `node --check` 通過。実DB・実ブラウザでの確認はユーザー。
  仕様は `docs/design/payout-refund.md`・`csv-import.md` に反映

**N-4 第1段階 — 性齢・負担重量の表示(2026-09-08。A段)**
- `entries[].sex_age`(性齢 "牡4")・`weight_carried`(負担重量 56.0)はPDFインポートで保存済みだが
  どの画面にも出していなかった。予想登録画面(`public/prediction.js` `renderHorses()`)の
  馬名行に、馬名の右へ小さめ文字で「性齢 ・ 負担重量 ・ 騎手」を「・」区切り表示
  (従来は騎手名のみ表示していた `<small>` を拡張)
- 値の無い項目は連結しない(手動登録レースは性齢・負担重量が無い)。全項目空なら `<small>` ごと出さない
- 負担重量は `Number(w).toFixed(1)` で `56.0kg` 表示(文字列/数値どちらで来ても対応)
- スコープは「予想画面の馬一覧のみ」(ユーザー選択)。race一覧カード/払戻モーダルの
  `weight_type`/`class_flags`/`course_direction`/`weather`/`track_condition` は第2段階として据え置き
- CSS変更なし。`node --check` 通過。`docs/design/screens.md`「予想登録画面」に反映

**N-4 に伴う予想画面・馬行レイアウト調整(2026-09-08。iPhone SE3 で馬名が2〜3文字しか
見えない問題への対応)**
- 枠番の独立バッジ(`.mini-waku`)を予想画面から廃止。馬番の丸(`.prediction-horse-number.waku-tint`)
  の背景色を枠色(`--waku-1`〜`--waku-8`)にして枠番を表現。`waku-0`(未確定)は輪郭のみ
- 馬名列を2段組みに変更(1段目=馬名、2段目=「性齢 ・ 負担重量 ・ 騎手」を1行・省略記号あり)。
  行の高さは元々予想印セレクト(32px)で決まっており、馬名2段ぶんがその中に収まるため実質不変
- `.horse-note-toggle` のグリッドを5列→4列(馬番・馬名・予想印・開閉)に。base /
  `@media(max-width:700px)` / `@media(max-width:430px)` の3か所すべて更新
  (従来は700px以下のルールが4列指定のまま5要素で崩れていた)
- `.mini-waku` の CSS 自体は購入モーダル(`buy-purchase-modal.js`)で使用中のため残す
- `node --check` 通過。`docs/design/screens.md`「予想登録画面」「レスポンシブ」を更新

**CSSキャッシュ一元化(2026-09-08。E段→完了)**
- 従来は全HTMLで `style.css?v=1` / `xxx.js?v=3` の連番クエリを手動更新しており、更新漏れで
  変更が反映されない事故が起きやすかった
- `public/_headers`(Cloudflare Pages)を新規作成し、`/*.css` と `/*.js` に
  `Cache-Control: no-cache`(キャッシュはさせるが使用前に必ず再検証。未変更なら304即返し)
- 全6HTML(index/history/stats/prediction/races/admin)から `?v=` を除去。以後 CSS/JS 変更時の
  HTML編集は不要
- `shell.js` に `<link>` 生成を寄せる当初案は不採用(FOUC回避のため `<head>` 直書きを維持)
- `docs/design/ops.md`「CSS / JS のキャッシュ対策」を全面改訂。`?v=` は復活させない旨を明記

**購入履歴の一括削除(2026-09-08。旧クラスタA)**
- 対象は**通常購入(`tickets`)のみ**。ユーザー方針で CSV取込分(`imported_ticket_items` /
  レガシー `imported_tickets`)は一括削除も行ごと削除も対象外と確定 → チェックボックスを出さない
- 新設 API `POST /api/tickets/bulk-delete`(`functions/api/tickets/bulk-delete.js`)。
  body `{ ids: number[] }`。`DELETE FROM tickets WHERE user_id=? AND id IN (...)` を
  `db.batch()`(100件ずつチャンク)で実行し `{ ok, deleted }` を返す。
  **着順・払戻に影響しないため `recomputeTicketPayouts*` は呼ばない**
- UI(`public/app.js` / `shell.js` / `style.css`): ヘッダー「選択削除」ボタンで選択モード。
  グループカード/レースカードのヘッダーにチェックボックス(レース側は子グループの
  `checked`/`indeterminate` を反映)。下部固定バー `#bulk-action-bar`(選択中 N 点 /
  キャンセル / 削除する)。選択モード中は行内編集input・行削除×・レース管理リンクを
  CSS(`body.history-selection-mode`)で非表示
- `selectedTicketIds` は再描画をまたいで保持しない(`applyHistoryFilter()` でクリア →
  `syncBulkSelectionUi()` がチェックを付け直す)
- `node --check` 通過。実ブラウザ確認はユーザー。`docs/design/screens.md`「購入履歴画面」に
  「履歴の一括削除(選択モード)」節を追加

**同・操作性の改善(2026-09-08。「複数選択の方法が分からない」というフィードバック)**
- チェックボックスをタップさせる方式をやめ、**見出し行(レース/グループのヘッダー)全体を
  タップ対象**(`.bulk-selectable`)にした。チェックボックスは `pointer-events:none` の
  見た目インジケータに降格。選択済みは背景ハイライト(`.bulk-selected` / `.bulk-partial`)
- 選択モード中は**全レースカードを開いた状態**にして、開閉矢印を隠す
  (`renderRaceCard`/`renderGroupRow` が `selectionMode` を見て展開状態・矢印を制御)
- 一覧先頭に操作説明(`.bulk-hint`)、下部バーは未選択時「タップして購入を選択」表示
- モバイル(`600px`以下)のレース見出し2行化(矢印を行末へ送る `order` 調整)は
  選択モード時だけ解除
