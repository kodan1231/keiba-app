> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# JRAレース結果PDFインポート

`races.html`の「JRAレース結果PDFをインポート」機能(管理者専用)。JRA公式サイトの
「レース結果一覧」PDF(1開催日・1ファイルにつき12レース分)をブラウザ側でPDF.jsにより
テキスト抽出し、`public/jra-result-pdf.js`で解析したうえで`POST /api/races/results-import`
(`functions/api/races/results-import.js`)へ送信、レース情報・出走馬・着順(上位3着+
`race_results`への全着順)・払戻・レース条件詳細をまとめて登録する。未登録のレースは
新規作成し、既存レースは確認のうえ更新できる。木・金の出走馬インポートを省略し、この
インポートのみでレースが新規登録される運用もありうる(上記「出走馬インポート・レース結果
インポートの運用フロー」参照)。12レース程度の一括登録でも安定して動作するよう、
レースごとの逐次クエリではなくバッチ化した実装になっている(上記「実装上の注意
(サブリクエスト数対策)」参照)。

パーサーはクライアント側(`public/jra-result-pdf.js`)で完結しており、画面上の「解析診断
情報」パネルで抽出行数・レース開始検出数・着順検出数・払戻検出数などを確認できる。

### 解析ロジックの要点

- **全角文字正規化**: JRA PDFのテキスト抽出結果を正規表現で解析する前に、Unicode正規化を
  行う。全角英数記号(U+FF01–FF5E)・全角スペース(U+3000)のみを半角化する変換と、
  康熙部首(Kangxi Radicals, U+2F00–2FD5)・CJK部首補助(CJK Radicals Supplement,
  U+2E80–2EF3)ブロックの文字のみを対象にした`.normalize("NFKC")`適用の2段構成
  (実体は`public/jra-pdf-common.js`の`jraPdfNormalizeUnit()`。半角化の
  `jraPdfToHalfwidthAscii()`と部首正規化の`jraPdfNormalizeRadicals()`を順に適用する。
  `jra-result-pdf.js`側は薄いラッパー`jraResultNormalizeUnit()`経由で呼ぶ)。
  `.normalize("NFKC")`を全文へ一括適用すると、CJK互換漢字ブロック(人名の
  異体字を多く含む。例: 「戸崎」)まで標準字形へ変換されてしまう副作用がある一方、部首記号
  ブロックの文字(JRA PDFで「日」「月」「発」「走」「馬」等の通常の漢字がこのブロックの
  文字として抽出されるケースがある)を正規化しないと「発走時刻」「年」「月」「日」等の
  正規表現が軒並み不一致になりレース開始検出が0件になる。この2ブロックは人名異体字の
  ブロックとは重複しないため、両立できている。詳細は下記「全角文字正規化の方針」参照
- **行内テキストの連結(ギャップ実測方式)**: PDF.jsが返す個々のテキスト断片は、見た目の
  間隔と1対1で対応しない。直前の要素の右端から今回の要素の左端までの実測ギャップを、
  直前要素の文字幅に対する比率で判定し、「連結(区切りなし)/半角スペース/タブ(列区切り)」の
  3段階に振り分けて結合する。単純に一律タブで連結する実装では、「発走時刻」等の単語内部に
  不要な区切りが入り、正規表現が軒並み不一致になる問題があったため、この方式を採用している。
  実体は`public/jra-pdf-common.js`の`jraPdfJoinRowItems()`で、出走馬一覧PDF側と結果PDF側が
  同一実装を共有する(2026-09-01に共通化。「タブの保持」「ギャップしきい値の上限キャップ」も
  両方に適用済み)
- **レース境界の検出**: 「発走時刻」ラベルと時刻(「N時M分」)を基準に、開催情報(日付・
  競馬場・開催回)を近傍から補完してレースヘッダーを復元する(`detectRaceHeaders()`)。
  「発走時刻を変更」「発走時刻N分遅延」等の注記は新しいレース開始として誤検出しないよう除外する
- **パーサーの構成(2026-09-08分割)**: `jraResultParseExtractedPages()`(エントリポイント)は
  ①行フラット化+診断初期化 → ②`detectRaceHeaders()`でレース境界検出 → ③レースごとに
  `parseRaceBlock()`でブロック抽出 → ④重複マージ・検証、の順で組み立てる。②③は元は
  単一の527行関数の内部フェーズだったが、ロジック不変で関数抽出した。診断パネルの
  パーサーバージョン表記に`-split`接尾辞が付いているのはこの分割版であることを示す
- **レース条件詳細の抽出**: 発走時刻行の直後にある条件文(例: `3歳 未勝利（混合）［指定］
  馬齢 コース：1,400メートル（ダート・右）`)から`weight_type`(馬齢/定量/別定/ハンデ)・
  `class_flags`(条件フラグの生テキスト)・`course_direction`(左/右)を抽出する。天候・
  馬場状態の行(例: `天候 晴 ダート 良`)から`weather`・`track_condition`を分離して抽出する
- **出走馬・着順の抽出**: 馬番・馬名・性齢・負担重量・騎手名・タイムの位置関係から抽出する。
  騎手名先頭の見習い減量記号(▲△☆◇)は**除去せず残す**(出走馬一覧PDFインポートと表記を
  揃え、木・金・土日いずれのインポート結果でも同じ表記で騎手名の一致/不一致を判定できる
  ようにするため)。出走馬は着順順ではなく**馬番昇順**に並べ替える(`races.js`側の
  「entries配列のi番目≒馬番(i+1)」という前提に合わせるため)
- **枠番はPDFから取得できないため常に`null`のまま送信するが**、`mergeEntriesByHorseName()`
  側で馬番が確定していれば出走頭数から自動計算して確定値として保存する(2026-08-30〜。
  上記「枠番は馬番から自動計算して保存する」参照)
- **払戻表の解析**: 単勝/複勝/枠連/馬連/馬単/ワイド/3連複/3連単の3列グリッドレイアウトを
  解析する。複勝・ワイドのように複数行にまたがる式別は、2行目以降にラベル(「複勝」等)が
  再印字されないため、「組み合わせの頭数(1頭/2頭/3頭)ごとに直前式別を保持する」方式
  (`carryState`)で継続データの式別を判定する
- **返還情報の取得**: 「返還」の文字列を含む行から、返還対象の馬番・枠番を抽出する
- **全着順・タイム・着差等の抽出**: 下記「レース結果の詳細記録(race_results)」参照
- **取消・除外・中止馬の抽出**: `取消 17 ラルス 牡3 55.0 △柴田 裕一郎 吉田 直弘`
  (馬体重なし)・`除外 13 ピアス 牝3 55.0 黛 弘人 458 (-4) 森 一誠`(馬体重あり)のように、
  行頭が「取消」「除外」で始まる行は、着順・タイム等を持たない特殊行として`race_results`へ
  `status='scratched'`(取消)/`status='excluded'`(除外)で登録する。行頭が「中止」で始まる行
  (例: `中止 7 ヒロイックヴァース 牡3 55.0 横山 武史 2 2 7 480 (+4) 浅利 英明 3`)は競走
  中止馬として`status='stopped'`で登録する(詳細は下記「レース結果の詳細記録」の
  「取消・除外・中止の扱い」参照)。**これら取消・除外・中止の馬も、完走馬と同様に
  `races.entries`(出走馬リスト)へ追加する**(以前は完走馬のみを`entries`に追加しており、
  出走馬情報をインポートせず結果PDFのみをインポートした場合に頭数が実際より少なく計算され、
  枠番の目安計算(`defaultWakuNumber()`)や予想登録・購入画面の頭数・馬番一覧にズレが
  生じる不具合があったための対応)。この修正により`entries`の頭数は常に実際の出走頭数
  (取消・除外・中止を含む)と一致する。取消・除外・中止馬も`horse_number`が確定していれば
  通常の馬と同様に予想登録・購入画面に表示され、馬券を購入できる(レースの結果が確定する
  前に馬券を購入する、という現実の購入行動と整合させるための意図的な仕様。的中し得ない
  馬券を買えてしまうこと自体は制限しない)
- **競走中の出来事等の抽出**: 「競走中の出来事等」の見出し以降の箇条書き
  (例: `・ アリハム号は、枠内駐立不良〔立上る〕。`)から馬名(「◯◯号」の「号」を除いた
  部分)を特定し、一致する`race_results`行の`incident_note`へ転記する。複数頭にまたがる
  場合は該当する各馬の行にそれぞれ転記する。転記後の内容はレース管理画面から管理者が
  編集できる(下記「レース結果の詳細記録」参照)

### 全角文字正規化の方針

`public/jra-result-pdf.js`・`public/jra-entries-pdf.js`はいずれも、JRA PDFのテキスト抽出
結果を正規表現で解析する前に、Unicode正規化を行っている。

人名の異体字(主にCJK互換漢字ブロック、U+F900–FAFF・CJK互換漢字補助、U+2F800–2FA1F。
「戸崎」騎手等)を`.normalize("NFKC")`で全文一括正規化すると標準字形へ変換されてしまう
問題を避けるため、全角英数記号(U+FF01–FF5E)・全角スペース(U+3000)のみを半角化する独自
変換(`public/jra-pdf-common.js` の `jraPdfNormalizeUnit()`。両パーサーが共通で使う)を基本とする。

一方でJRA PDFのテキスト抽出結果では、「日」「月」「土」「発」「走」「馬」などの通常の
漢字が、見た目は同じでも**康熙部首(Kangxi Radicals, U+2F00–2FD5)・CJK部首補助
(CJK Radicals Supplement, U+2E80–2EF3)**という別のUnicodeブロックの文字として出力される
ケースがある。これらはNFKC正規化では標準の漢字へ変換されるが、上記の限定変換だけでは
変換されないままとなり、「発走時刻」「年」「月」「日」等の正規表現が軒並み不一致になって
レース開始検出が0件になる(解析結果0レース)。

**対応**: 全角英数記号の半角化に加えて、**康熙部首(U+2F00–2FD5)・CJK部首補助
(U+2E80–2EF3)の範囲の文字のみ**、1文字ずつ`String.prototype.normalize("NFKC")`を適用して
標準の漢字へ変換する処理を追加している(`jraResultNormalizeUnit()`/`jraEntriesNormalizeUnit()`
内)。この2つのUnicodeブロックは部首記号専用であり、人名の異体字(CJK互換漢字、
U+F900–FAFF・CJK互換漢字補助、U+2F800–2FA1F)とは別のブロックのため、人名の字体を
変えることなく日付・発走時刻等の検出を成立させられる。

対象範囲は実際にPDFで確認できた特定の文字(日月土走馬等)に限定せず、**両Unicodeブロック
全体**を対象にしている(将来別の部首文字が出現しても自動的に対応できるようにするため)。

**実装対象ファイル**: `public/jra-result-pdf.js`(`jraResultNormalizeUnit()`)・
`public/jra-entries-pdf.js`(`jraEntriesNormalizeUnit()`)。

### サーバー側の反映(`results-import.js`)

- 未登録のレースは`INSERT`で新規作成する。既存レースは常に`UPDATE`で対応し、
  レース行(`races.id`)を削除して作り直すことは行わない(`prediction_marks`/
  `prediction_notes`が`ON DELETE CASCADE`で消えるのを避けるため)
- **出走馬情報(`entries`)のマージは、出走馬一覧PDFインポートと共通の`mergeEntriesByHorseName()`
  を使う**。詳細は上記「出走馬情報(entries)のマージルールは共通」参照。**ただし
  `finish_order`/`payouts`のマージ方式(fill-emptyのみ)は変更していない**(既知の制約
  として残る。下記「既知の制約・未解決の課題」参照)
- **`race_results`への反映**: 解析した全馬分の結果行(`finished`/`scratched`/`excluded`/
  `stopped`)を、複数レースをまとめて処理するバルク版`upsertRaceResultsBulk()`
  (`functions/api/_lib/race-results.js`)で`race_id`+`horse_number`をキーに`INSERT ... ON CONFLICT
  DO UPDATE`し、既存の`incident_note`(管理者が手動編集した内容)を**自動転記の内容で
  無条件上書きしない**(下記「レース結果の詳細記録」の更新ルール参照)
- 着順・払戻レートを更新した場合は、そのレースを購入した全ユーザーの`tickets.payout`を
  複数レースをまとめて処理するバルク版`recomputeTicketPayoutsForRaces()`
  (`functions/api/_lib/ticket-payout.js`)で**必ず**再計算・反映する(下記「払戻確定時のticket反映」
  参照)。着順・払戻を書き換えるコードパスを新規に追加する際は、この関数の呼び出しが
  漏れていないか必ず確認すること
- 出走馬(馬名・騎手)が更新された場合は、同じレース・馬番を参照しているCSV取込データ・
  購入履歴へ`backfillHorseNamesForRace()`でバックフィルする
- レースが未登録のまま取り込まれていたCSVデータがあれば、`linkUnregisteredImportsToRace()`
  により自動的に紐付ける
- 上記いずれも「まとめてSELECT→メモリ上で判定→`db.batch()`でまとめて書き込む」方式で
  実装されており、レース件数によらずクエリ回数がほぼ一定になっている(上記「実装上の注意
  (サブリクエスト数対策)」参照)

### 既知の制約・未解決の課題

- `results-import.js`の`finish_order`/`payouts`のマージは「既存が完全に空の場合のみ」しか
  反映しない設計になっており、CSVインポート等で一部式別だけ既に登録されている場合、
  PDFインポートの新しい結果が反映されないことがある(**未修正**。`docs/BACKLOG.md`
  「調査中の不具合」参照)。土日の結果インポートでは`tickets.payout`の再計算自体は必ず
  行うが、この反映漏れがあるとマージ後のデータが不完全なまま再計算することになる点に注意
- 払戻金額抽出の正規表現が、組み合わせの矢印区切り(→)に対応していない可能性がある
  (馬単・三連単で該当しうる。未検証)
- パーサー(`jra-result-pdf.js`)の行内テキスト連結が、出走馬一覧PDFインポート側で
  対策済みの「タブ保持」「ギャップしきい値の上限キャップ」に未対応(`docs/BACKLOG.md`参照)
- 降着・失格など、取消・除外・中止以外の特殊な着順未確定ケースは対象外(`docs/BACKLOG.md`参照)
- 実ブラウザのPDF.jsでの動作検証は完全には完了していない。次回実機で試す際は、
  `docs/testing/race-results.md`・`docs/testing/entries-import.md`の該当項目、および
  「解析診断情報」パネルの抽出全文を確認し、
  結果をこのドキュメントに反映すること
- 2026-08-30に実装したサブリクエスト数対策(バッチ化)・枠番自動計算は、いずれも実機
  (実際のPDF・実DB)での動作検証が未実施(コードレビュー・構文チェックのみ)。
  `docs/BACKLOG.md`「調査中の不具合」参照

### 関連ファイル

- `public/jra-result-pdf.js`: クライアント側の解析ロジック本体
- `functions/api/races/results-import.js`: サーバー側の反映処理
- サーバー側の横断ヘルパーは `functions/api/_lib/` 配下に機能別に分割されている
  (`functions/api/_shared.js` は re-export するだけの窓口)。この機能に関係するもの:
  - `functions/api/_lib/ticket-payout.js`: `recomputeTicketPayoutsForRace()`・
    `recomputeTicketPayoutsForRaces()`(複数レース一括版)
  - `functions/api/_lib/entries-merge.js`: `mergeEntriesByHorseName()`・
    `backfillHorseNamesForRace()`・`linkUnregisteredImportsToRace()`・
    `computeWakuNumberFromHorseNumber()`(非export・内部)
  - `functions/api/_lib/race-results.js`: `upsertRaceResults()`・
    `upsertRaceResultsBulk()`(複数レース一括版)
  - `functions/api/_lib/jockey-alias.js`: `loadJockeyAliasMap()`・
    `applyJockeyAliasMap()`・`normalizeExistingJockeyNames()`

