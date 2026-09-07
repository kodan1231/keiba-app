> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# 出走馬インポート・レース結果インポートの運用フロー

出走馬一覧PDFインポートとJRAレース結果PDFインポートは、同じ`races.entries`(出走馬情報)
を扱う点で共通の関心事を持つため、この節でまず全体のフローと共通ルールを整理する。
個々の実装詳細は下記「出走馬一覧PDFインポート」「JRAレース結果PDFインポート」
「レース結果の詳細記録(race_results)」を参照。

### 想定フロー

```
木        : 出走馬一覧(枠番・馬番未確定)PDFをインポート  ※任意。省略されうる
金        : 出走馬一覧(枠番・馬番確定後)PDFを同じ機能で再インポート  ※任意。木を省略して
            金から始める運用もある
土・日     : JRAレース結果PDFをインポート(着順・払戻・race_resultsを確定)
```

木・金は**どちらも省略され、土日の結果PDFインポートのみでレースが新規登録される運用も
ありうる**(実際の運用として確認済み)。この前提により、結果PDF側の実装は「出走馬情報が
すでに確定済みの状態で結果だけ追記する」ケースと「結果PDFが出走馬情報の初出になる」
ケースの両方に耐えられる必要がある。

### タイミングごとの確定情報・再計算方針

| タイミング | 確定させる情報 | `recomputeTicketPayoutsForRace()`呼び出し |
|---|---|---|
| 木(entries未確定) | レース名・コース情報・条件詳細(weight_type/class_flags/course_direction)・馬名(五十音順)・性齢・負担重量(予定)・騎手名(記号付き) | **保険として呼ぶ**(finish_order/payouts未確定なら何もしないため無害) |
| 金(entries確定) | 枠番(馬番から自動計算)・馬番(未確定→確定)・馬名を馬番順にソート・性齢・負担重量(予定の確定)・騎手名(不一致なら上書き) | **保険として呼ぶ**(同上) |
| 土日(results) | 着順(全馬・`race_results`)・払戻・天候・馬場状態・馬体重・タイム・着差・コーナー通過順位・推定上り・単勝人気・騎手名(不一致なら上書き) | **必ず呼ぶ** |

木・金時点での再計算呼び出しは、通常フローでは`finish_order`/`payouts`が存在しないため
実質何もしない。ただし「木金を省略して結果PDFが先に取り込まれ、後から出走馬一覧PDFで
枠番だけ確定させる」といったイレギュラーな順序の運用に備えた保険であり、安全側に倒して
常に呼び出す方針とする。

### 出走馬情報(`entries`)のマージルールは共通

出走馬一覧PDFインポート・JRAレース結果PDFインポートのどちらも、`entries`は**馬名を
キーに1頭ずつマージ**する共通ロジックを用いる。共通ヘルパー`functions/api/_lib/entries-merge.js`の
`mergeEntriesByHorseName()`として実装済みで、両インポート処理(`entries-import.js`・
`results-import.js`)双方から呼び出されている。

- 新しい馬名 → `entries`に追加
- 既存の馬名で、取込側の`waku_number`/`horse_number`/`sex_age`/`weight_carried`が**null**
  → 何もしない(未確定情報で既存の確定情報を誤って消さない)
- 既存の馬名で、取込側が**値あり**、既存が**null** → 更新(未確定→確定の一方向更新)
- 既存の馬名に**既に確定済みの値があり、取込側が異なる値**(`waku_number`/`horse_number`のみ対象)
  → **自動上書きしない**。「競合」として報告するのみ(管理者が手動確認)。`sex_age`・
  `weight_carried`は変わりうる値のため、この競合検出の対象外とし、取込側の値があれば
  無条件で上書きする
- **騎手名(`jockey`)は競合の概念を設けず、取込側の値があれば無条件で上書きする**
  (騎手変更の可能性を考慮するため)。見習い減量記号(☆▲△★◇)は騎手名の先頭に
  残したまま保存する(出走馬一覧PDF・結果PDFいずれの取込でも記号付きの表記に揃える)
- **馬番(`horse_number`)が確定していて枠番(`waku_number`)が未確定の場合、出走頭数から
  枠番を自動計算して確定値として埋める**(2026-08-30〜。詳細は上記「枠番は馬番から自動
  計算して保存する」参照)。この処理は競合検出の対象外で、既に枠番が確定済みの馬は
  上書きしない

マージ前に、既存`entries`側の馬名が空の項目は除去してからマージする(空行がどの馬とも
一致せず残り続けるのを防ぐため)。マージ後は`entries`を必ず馬番順にソートし直す
(枠番・馬番が未確定の間は馬名(五十音)順)。`race_name`・`course_type`・`distance`・
`weight_type`・`class_flags`・`course_direction`は、既存が空の場合のみ埋める
(既存の管理者入力を上書きしない)。`weather`・`track_condition`はレース結果PDFのみに
出現するため、結果インポート時に上書きしてよい(常に最新の結果PDFの値を正とする)。

### 実装上の注意(サブリクエスト数対策・2026-08-30)

`functions/api/races/entries-import.js`・`functions/api/races/results-import.js`は、
以前レースごとに個別クエリ(既存レース確認・出走馬表マージ後の書き込み・CSV未登録
データの紐付け・馬名バックフィル・`race_results`のUPSERT・`tickets.payout`再計算)を
逐次実行しており、12レース分のPDFを一括インポートするとCloudflare Pages Functionsの
1リクエストあたりのサブリクエスト数上限に抵触し、「一括登録に失敗しました」という
汎用エラーになる不具合があった(`functions/api/ticket-imports/index.js`で以前に
発生したのと同じ構造の問題)。

現在はいずれも「対象レースをまとめて1回のSELECTで取得→メモリ上で判定→
`db.batch()`でまとめて書き込む」方式に書き直しており、クエリ回数はレース件数に
依存せずほぼ一定になっている。`race_results`のUPSERT・`tickets.payout`再計算は
複数レースをまとめて処理するバルク版(`upsertRaceResultsBulk()`は
`functions/api/_lib/race-results.js`・`recomputeTicketPayoutsForRaces()`は
`functions/api/_lib/ticket-payout.js`)を新設し、`results-import.js`から利用している。単一レースのみを扱う既存の
`upsertRaceResults()`・`recomputeTicketPayoutsForRace()`(単数形)は、他の呼び出し元
(`functions/api/races/[id].js`・`entries-import.js`・`functions/api/tickets/bulk.js`)の
ために変更せずそのまま維持している。この関数(および同様に「1件ごとにDBへ問い合わせる
ループ」を含む実装)を今後変更・追加する際は、同じ問題を再発させないよう注意すること。

### 今回スコープに含めないもの(BACKLOGへ引き継ぎ)

- `finish_order`/`payouts`のマージが「既存が完全に空の場合のみ」しか反映しない問題
  (`results-import.js`)は今回は対応しない。**土日の「必ず再計算」自体は行うが、
  マージが不完全なまま(元データの反映漏れが残ったまま)の状態に対して再計算する
  ことになる**点に注意。別タスクとして`docs/BACKLOG.md`に残す
- パーサー(`jra-entries-pdf.js`/`jra-result-pdf.js`)の非対称性(タブ保持による
  区切り判定の精度・ギャップ実測しきい値の上限キャップの有無)の統一は、実機未検証の
  結果PDFパーサーへの影響範囲が読みにくいため見送る。別タスクとして`docs/BACKLOG.md`に残す
- 降着・失格など、着順が確定しない特殊ケースのうち**取消・除外・中止以外**
  (`race_results.status`の`demoted`/`disqualified`等)は対象外。`finished`/`scratched`
  (取消)/`excluded`(除外)/`stopped`(中止)の4種類に対応する
- 馬名ベース・騎手名ベースの集計画面(過去出走レース一覧、競馬場・コース種別ごとの
  単勝率/連対率/複勝率)は、今回は`race_results`にデータを貯める(スキーマ+取込処理)
  までとし、参照・集計用のAPI/画面は別タスクとしてBACKLOGへ回す
- 上記「レース条件の詳細カラム」の画面表示への反映も、スキーマ・取込は完了しているが
  画面表示は別タスクとしてBACKLOG(クラスタN-4)へ回す

