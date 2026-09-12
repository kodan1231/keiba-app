> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# データ構造

| データ | テーブル | 備考 |
|---|---|---|
| 通常購入 | `tickets` | 購入グループ`group_id` + 組み合わせ1点=1行。ユーザーごとに分離 |
| CSV原本(Club JRA-Net等) | `imported_tickets` | 外部CSVの原本をそのまま保持。ユーザーごとに分離 |
| CSV購入グループ | `imported_ticket_groups` | CSVの1行=1購入グループ。ユーザーごとに分離 |
| CSV個別買い目 | `imported_ticket_items` | 組み合わせを個別買い目へ分解したもの。`user_id`は持たず、`imported_ticket_groups`とのJOINで所有者を判定する |
| 予想印 | `prediction_marks` | **1頭につき1つまで**(ドロップダウン選択式)。印の種類: ◎○▲△☆消。ユーザーごとに分離(`UNIQUE(race_id, horse_number, user_id)`)。**`horse_number`はNOT NULL制約があるため、枠番・馬番が未確定の馬には印を付けられない** |
| 予想メモ・勝負レースフラグ | `prediction_notes` | レース単位の自由記述メモ(`prediction.html`)+「勝負レース」フラグ(`is_key_race`。2026-09-12追加。ONのレースは馬券購入画面のレース一覧に★表示)。ユーザーごとに分離(`UNIQUE(race_id, user_id)`)。詳細は`docs/design/screens.md`「予想登録画面」 |
| 馬メモ | `horse_notes` | 馬名をキーに継続管理。馬名はtrim/空白正規化+`horse_aliases`で保存。ユーザーごとに分離(`UNIQUE(horse_name, user_id)`)。**馬名がキーのため、枠番・馬番の有無に関係なく常に利用できる** |
| 馬名エイリアス | `horse_aliases` | 表記ゆれ側の馬名 → 正しい馬名 の対応表。全ユーザー共有。`race_results` と `races.entries` の馬名表記が食い違い、予想画面の過去成績が紐付かない問題への対応。詳細は `docs/design/horse-aliases.md` |
| 騎手名エイリアス | `jockey_aliases` | 表記ゆれ側の騎手名 → 正しい表記。全ユーザー共有。詳細は `docs/design/jockey-aliases.md` |
| ユーザーアカウント | `users` | ログイン画面から自己登録できる(招待コード等の制限なし)。ログイン成功時刻を`last_login_at`に記録する |
| レース | `races` | 出走馬表(予定)・着順(上位3着)・払戻・レース条件を保持。全ユーザー共有 |
| レース結果詳細 | `race_results` | 馬単位の確定結果(全着順・タイム・着差・馬体重・コーナー通過順位等)を1頭1行で記録。全ユーザー共有。詳細は下記「レース結果の詳細記録(race_results)」参照 |
| racesの事前計算キャッシュ | `races_cache` | `races`全件をJSON配列としてチャンク分割して保持。詳細は下記「races全件取得の事前計算キャッシュ(races_cache)」参照 |

### races全件取得の事前計算キャッシュ(races_cache。2026-09-12〜)

`GET /api/races`(全画面共通の入口)・データ検索画面「レース成績」タブ・購入履歴画面の
CSV取込一覧(コース種別・距離の付与)など、`races`を無条件に全件SELECTする箇所が
複数あった。`races`は「元々軽いテーブル」という前提で許容されてきたが、開催が
積み重なるほど育ち続けるテーブルであり、2026-09-12に`imported_ticket_items`で
実際に発生した障害(全ユーザー・全件SELECTをテーブルが育つ前提の無い設計のまま
放置し、D1日次行読み取り上限の75%を1エンドポイントだけで消費した。ユーザー数
2〜4人時点で発生。ユーザー数増加を見据え先回りで対応)と同じ構造のリスクが
あったため、`race_stats_cache`(下記「データ検索画面のレース成績集計」参照)と
同じ発想で導入した。

- `races_cache`に`races`の全カラムをJSON配列で保持する
  (`_lib/races-cache.js`の`getAllRacesRaw()`/`recomputeRacesCache()`)。
- 無効化はDBトリガー(`schema.sql`/`migration.sql`の`@STEP: races_cache_chunked`)で行う。
  `races`への INSERT/UPDATE/DELETE があれば自動的に`races_cache`の全行が削除され、
  次回読み取り時に自動再計算される。`race_stats_cache`と異なり、`races`は
  全カラムをキャッシュしているため列を限定せず全ての更新で無効化する。
- 呼び出し側(`races/index.js`・`data-search/race-stats.js`・`ticket-imports/index.js`)
  は必要な列だけをメモリ上で取り出して使う。返る行の形は元の`SELECT * FROM races`と
  同じ(entries/finish_order/payoutsはJSON文字列のまま。各呼び出し側の既存の
  `JSON.parse`はそのまま使える)。

**チャンク分割(2026-09-12。障害対応)**: 導入当初は`races_cache`を1行固定にして
`races`全件を1つのJSONにまとめていたが、同日中に結果CSV18ファイルの一括インポートで
`races.entries`/`finish_order`/`payouts`が多数のレース分まとめて埋まり、累積JSONが
D1の「1行(1カラム値)あたり2,000,000バイト」の上限を超えて`UPDATE races_cache`が
失敗、`GET /api/races`に依存する馬券購入画面・データ検索画面・レース管理画面が
軒並み500になる障害が発生した。`races`は今後も無制限に育ち続けるテーブルであり、
1行固定のままではインポート件数を絞っても遅かれ早かれ同じ場所で再発するため、
`races_cache`を複数行(チャンク)に分割して保持する方式に変更した。

- `recomputeRacesCache()`は`races`全件を読んだ後、行ごとのJSONバイト数を積算し、
  `CHUNK_MAX_BYTES`(1,500,000バイト。2MB上限に対する安全マージン)を超える手前で
  新しいチャンクに切り替える。件数ベースではなくバイト数ベースで区切っているのは、
  1レースあたりのJSONサイズが`entries`/`finish_order`/`payouts`の内容量によって
  大きくばらつくため(結果未確定のレースは小さく、結果確定済み・出走頭数が多い
  レースは大きい)。
- `races_cache`の行は`chunk_index`をキーに複数行持つ(`id=1`固定ではない)。
  `getAllRacesRaw()`は全チャンクを`chunk_index`順に読んで`payload`(JSON配列)を
  連結し、元の`SELECT * FROM races`と同じ配列に戻す。
- 無効化(トリガー)は`races_cache`の全行をDELETEするだけにした(チャンク数が
  可変なため、特定行のUPDATEでは無効化しきれない)。次回`getAllRacesRaw()`が
  空を見て全チャンクを再計算・再保存する。
- バイト数の計算は`TextEncoder`でUTF-8バイト長を測る(`String.length`は
  UTF-16コード単位数であり、日本語(馬名・騎手名・レース名等)を含むJSONでは
  実際のバイト数を大きく過小評価するため、それで見積もると同じ2MB上限に
  再び到達しうる)。

**保存失敗時のbest-effort化(2026-09-12。同日2度目の障害対応)**: チャンク分割
導入直後、`recomputeRacesCache()`の`races_cache`への保存(`db.batch`)に例外処理が
無かったため、D1の日次rows_written上限(10万/日)に迫っていたタイミングで保存が
失敗するたびに例外を投げていた。その結果「保存できない→次のアクセスでまた`races`
全件を再計算のため読み直す→また保存に失敗」というループに陥り、本来1回読めば
済むはずの`races`全件SELECT(数千行)を画面を見るたびに繰り返し発生させてしまい、
D1のもう一方の上限であるrows_read(500万/日)まで先に使い切って、読み取りを含む
全てのD1クエリが失敗する状態(=全画面で情報が見れない状態)を招いた。対策として、
`recomputeRacesCache()`の保存処理をtry/catchで囲み、**保存に失敗しても`races`から
読み取れた結果(`rows`)はそのまま呼び出し元へ返す**ようにした(次回のアクセスで
再度保存を試みるだけで、読み取り自体は保存の成否に関係なく常に成功する)。
D1無料枠の日次上限そのものの詳細・注意点は`CLAUDE.md`「絶対に破ってはいけない
不変条件」、当日の消費内訳の実例は`docs/BACKLOG.md`「D1無料枠の日次上限に関する
注意」参照。

### レース情報のコース種別・距離

`races`テーブルは`course_type`(TEXT)・`distance`(INTEGER)を持つ。

- `course_type`: `芝`/`ダート`/`障害`のいずれか。**任意入力**(NULL可)。
  一覧・カード等での表示時は`芝`→`芝`、`ダート`→`ダ`、`障害`→`障`と1〜2文字に短縮して表示する
  (保存値そのものはフルの日本語表記のまま)
- `distance`: メートル単位の整数。**任意入力**(NULL可)
- コース情報が無いレースを集計等で扱う場合は、フォールバックとして競馬場(`track`)単位で扱う
- **表示時の組み立て**: `public/utils.js`の`formatCourseText(courseType, distance)`が、
  コース種別・距離をそれぞれ独立した要素として組み立て、**登録されている方だけを表示する**
  (courseLabelが空(コース種別未入力)の場合でも、距離が入力済みなら距離だけを表示する)。
  `public/races.js`の`renderRaceRow()`(レース一覧カード)・`openPayoutModal()`(払戻モーダルの
  読み取り専用情報)、および`public/buy.js`の`renderGrid()`(購入画面のレース選択グリッド)が
  この共通関数を呼び出す。`races.html`は`utils.js`を各画面固有のJS(`races.js`等)より先に
  読み込む構成のため、この共有が成立している

### レース条件の詳細カラム

出走馬一覧PDF・JRAレース結果PDFいずれにも、以下のレース条件詳細が「発走時刻：hh時mm分」の
直後に1行で出現する(例: `3歳 未勝利（混合）［指定］ 馬齢 コース：1,400メートル（ダート・右）`)。
このうち以下を`races`テーブルのカラムとして保持している(スキーマは`schema.sql`に統合済み):

| カラム | 型 | 内容 | 例 |
|---|---|---|---|
| `weight_type` | TEXT | 斤量区分 | `"馬齢"` `"定量"` `"別定"` `"ハンデ"` |
| `class_flags` | TEXT | 条件フラグ等の生テキスト(指定/特指/混合/牝馬限定等をまとめて保持。構造化が難しいため生テキストのまま保存) | `"未勝利（混合）［指定］"` |
| `course_direction` | TEXT | コースの回り(左/右)。障害等、回りの概念が無いレースは`NULL` | `"右"` |
| `weather` | TEXT | 天候。結果PDFのみに出現(出走馬一覧PDFには無い) | `"晴"` |
| `track_condition` | TEXT | 馬場状態。結果PDFでは`"天候 晴 ダート 良"`のように天候とセットの1行で出現するが、**解析時に分離して別カラムに保存する** | `"良"` |

**今回のスコープに含めないもの**(意図的に対象外): 発走時刻、本賞金、付加賞、調教師名、
単勝オッズ(全馬分は結果PDFに存在しないため。理由は下記「レース結果の詳細記録」参照)。
**画面表示は一部のみ対応**: `class_flags` / `weight_type` は予想登録画面のヘッダー2行目で
条件バッジ「牝」(`class_flags` に「牝」を含む=牝馬限定)・「H」(`weight_type` または
`class_flags` に「ハンデ」を含む=ハンデ戦)として表示している(`prediction.js`
`renderRaceHeader()`)。それ以外のカラム(`course_direction` / `weather` /
`track_condition` 等)およびレース一覧カード・払戻モーダルへの表示は未対応。残りは
`docs/BACKLOG.md`「クラスタN-4」として優先度低のタスクに残している。

### 出走馬(`races.entries`)の枠番・馬番

出走馬一覧PDFインポート(下記参照)対応により、`races.entries`(JSON配列)内の各出走馬
オブジェクトの`horse_number`は**null になりうる**(馬番の抽選前に登録するケースに対応する
ため)。`entries`はスキーマレスなJSON列のため、この仕様にDBマイグレーションは不要。

馬の同一性は、`horse_number`ではなく**`horse_name`(馬名)をキー**に判定する
(未確定時は馬名しか手がかりがないため。`horse_notes`が馬名をキーにしているのと同じ考え方)。
JRAの馬名は全国で一意に登録されるため、同一レース内に同名の別馬が存在する心配はない。
ただしPDF抽出結果の表記ゆれ(空白の入り方等)で同一馬が別馬として扱われないよう、
比較前には`horse_notes`等と同じ正規化(全角スペース等の空白類を1つの半角スペースへ
畳み込み・trim)を必ず通すこと。

**枠番(`waku_number`)は馬番から自動計算して保存する(2026-08-30〜)**。JRAでは馬番の抽選後、
出走頭数に応じて機械的に枠番が割り当てられる(枠自体は抽選対象ではなく、頭数と馬番から
一意に決まる)ため、`horse_number`が確定していれば`waku_number`も確定させてよい。詳細は
下記「枠番は馬番から自動計算して保存する」参照。そのため、`horse_number`が`null`の間は
`waku_number`も計算しようがなく`null`のままだが、`horse_number`が確定すると同時に
`waku_number`も自動的に埋まる(PDFからは枠番をテキスト抽出できないため、この自動計算を
経由しない限り`waku_number`は永久に`null`のままになる)。

`horse_number`がnullの馬が1頭でも含まれるレースは、以下のように扱われる:

- **購入(`buy.js`)**: 選択・購入できない(「枠番・馬番が未確定のため購入できません」という
  案内を表示してブロックする。`hasUnconfirmedEntries()`)
- **予想印(`prediction.js`)**: その馬の予想印セレクトは無効化される(`prediction_marks`が
  `horse_number NOT NULL`のため、そもそも保存できない)。一覧の並び順は、馬番が無い馬がいる
  場合は馬名(五十音)順にフォールバックする
- **馬メモ(`horse_notes`)**: 馬名がキーのため、通常通り利用できる(制限なし)
- **レース管理画面(`races.js`)**: 出走馬登録状況バッジに「(枠番未確定)」の表示が付く
- **枠連(wakuren)の払戻判定**: `waku_number`が未確定の出走馬が絡む枠連馬券は、的中組み合わせ
  自体を算出できないため「不的中(0円)」と断定せず「判定不能(未確定のまま)」として扱う
  (詳細は下記「払戻確定時のticket反映」参照。2026-08-30の自動計算導入後は、`horse_number`が
  確定していれば`waku_number`も同時に確定するため、この「判定不能」状態は実運用上ほぼ
  「馬番自体が未確定」の場合に限られる)

### 枠番は馬番から自動計算して保存する(2026-08-30〜)

JRAの馬番は抽選で決まるが、**枠番自体は抽選対象ではなく、出走頭数と馬番から機械的に
一意に決まる**(8頭以下は1頭1枠、9頭以上は余りを大きい枠番(7・8枠)側から順に1頭ずつ
多く割り振る)。そのため、**馬番が確定していれば枠番も確定できる**という前提のもと、
`mergeEntriesByHorseName()`(`functions/api/_lib/entries-merge.js`)内で、馬番が確定していて枠番が
未確定(`null`)の馬について自動計算し、確定値としてDBへ保存する。

計算ロジック(`computeWakuNumberFromHorseNumber(horseNumber, horseCount)`)は`races-entries-modal.js`の
出走馬表編集画面が使う`defaultWakuNumber()`と同じアルゴリズムをバックエンド側に複製した
もの(フロント専用グローバルスクリプトのためモジュールimportができず、共通化していない)。
`horseCount`は`entries`配列全体の件数を使う。

**8頭以下の扱い(2026-09-08修正)**: 8頭以下は例外なく「枠番=馬番」なので、両関数とも
`horseCount <= 8` で早期リターンする。以前は8頭以下でもループを回していたため、
`horseCount <= 7` のとき`base = Math.floor(horseCount/8) = 0`になり、若い枠から順に「0頭」が
割り当たって枠番が全体的に後ろへずれる不具合があった(例: 5頭立てで馬番1が枠4になる)。

**既に誤った枠番で保存済みのレースの補正**: 通常、確定済みの`waku_number`は再インポートでも
上書きしない。ただし`mergeEntriesByHorseName()`は例外として、**馬番が1〜Nの連番で揃った
8頭以下の出走馬表**に限り、`waku_number`が`horse_number`と一致しない馬の枠番を再計算値で
上書きする(8頭以下は枠番に選択の余地が無いため安全)。旧バグで誤保存されたレースは、
同じPDFを再インポートすれば自動的に補正される。

この計算は`mergeEntriesByHorseName()`を経由する2つの取込経路
(`functions/api/races/entries-import.js`・`functions/api/races/results-import.js`)の
両方に自動的に適用される。既に確定済みの枠番(手動入力等)は原則上書きしない(`waku_number`が
`null`の場合のみ計算する)。例外は上記「補正」のケースのみ。

**過去に取り込んだレース(旧仕様で`waku_number`がnullのまま保存されているもの)を直すには**、
該当PDFを同じインポート機能で再度取り込み直せばよい。マージ処理の中で既存`entries`の
`waku_number`も同じロジックで埋められるため、専用の一括補正機能は用意していない。

**枠連(wakuren)馬券の払戻判定への影響**: 枠連の的中判定は購入時点の`selections`ではなく、
清算時点で`races.entries`から最新の`waku_number`を引いて判定する実装になっている
(`computeWinningCombos`の`wakuOf()`)。そのため、この変更を適用した状態でレース確定・
払戻計算を行えば、これまで「枠番未確定のため判定不能」だった枠連馬券も正しく的中/不的中
判定されるようになる(既存の判定ロジック自体は変更していない)。

**2026-08-30より前の設計との違い(履歴)**: 以前は「木・金の出走馬インポートが省略され
結果PDFのみでレースが登録される運用がありうるため、推定値をDBに保存すると誤った
的中/不的中が確定するリスクがある」という理由で、推定値は表示専用(`races.js`側がその場で
計算するだけ)にとどめ、DBには保存しない方針だった。「馬番が確定すれば枠番は一意に決まる
(抽選対象ではない)」という前提をプロジェクト側で確認できたため、この方針を転換した。

### `races.entries`への性齢・負担重量の追加

出走馬一覧PDFの馬柱には性齢(例: `牡2`)・負担重量(例: `55.0kg`)が含まれている。これは
「レース前の予定情報」であり、通常はレース確定後の値と一致するが、稀に負担重量が変わる
ケース(騎手変更に伴う減量特典の有無等)もありうるため、以下の2箇所に分けて保持する:

- `races.entries[].sex_age` / `races.entries[].weight_carried`: 出走馬一覧PDF取込時点の
  予定値。出走馬一覧インポートの共通マージルール(下記参照)に従い、木→金の未確定→確定の
  一方向更新で扱う
- `race_results[].sex_age` / `race_results[].weight_carried`: レース結果PDF取込時点の
  確定値(こちらが最終的な正)

**JRAレース結果PDFインポートは `races.entries` 側にも反映する(2026-09-11修正)**。
`public/jra-result-pdf.js` は完走馬の性齢・負担重量を `race_results` 用の詳細行
(`jraResultParseFullResultRow`)・取消/除外/中止の専用行(`jraResultParseScratchRow` /
`jraResultParseStopRow`)からそれぞれ抽出しているが、**以前はそれを `race_results` にしか
反映しておらず、同時に構築している `entries`(`races.entries` へマージされ、予想登録画面の
馬名行に表示される配列)には性齢・負担重量を渡していなかった**。そのため、出走馬一覧PDFを
取り込まずレース結果PDFのみで登録したレースは、`race_results` には性齢・負担重量が
正しく入っているのに、予想登録画面(`entries` 参照)では馬名・騎手しか出ない不具合が
あった(2026-09-11発覚)。`jraResultApplySexAgeWeightToEntries()` で `entries` 側にも
反映するよう修正。**修正前に取り込み済みのレースは、この修正だけでは直らず、該当の
結果PDFを再取込する(または `race_results` から `races.entries` への一括バックフィルを
別途実行する)必要がある。**

**単勝オッズは`races.entries`に追加しない**(時々刻々変わる値であり、時価スナップショットを
保存する意義が薄いと判断したため)。

**馬体重は`races.entries`に追加しない**(出走馬一覧PDF公開時点では基本的に常に空欄であり、
実際に値が入るのはレース結果確定後のため。`race_results.body_weight`にのみ保持する)。

