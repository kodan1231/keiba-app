> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# 払戻確定時のticket反映(全ユーザー対応)

`races`(共有データ)と購入馬券(ユーザーごとに分離されたデータ)がまたがる処理のため、
着順・払戻レートが確定・更新された際は、**そのレースを購入した全ユーザーの購入馬券**の
payout を再計算・反映する必要がある。

- 払戻計算ロジック(`public/payout.js`の`computeWinningCombos`・`ticketMatchesCombo`・
  `findStoredRate`相当)は`functions/api/_lib/ticket-payout.js`にサーバー側実装として移植されており、
  単一レース向けの`recomputeTicketPayoutsForRace(db, raceId, finishOrder, payoutsObj,
  entries)`と、複数レースをまとめて処理するバルク版`recomputeTicketPayoutsForRaces(db,
  updates)`(`updates`は`{raceId, finishOrder, payoutsObj, entries}`の配列。2026-08-30追加)
  の2種類が公開されている
- **対象テーブル(2026-09-08〜)**: `tickets`(通常購入。`payout`・`refunded` を更新)に加えて
  `imported_ticket_items`(CSV取込分。`payout`・`is_hit` を更新)も同じ計算ロジックで再計算する。
  ただし Club JRA-Net購入履歴CSV は「既に決着済み」データのため、レース結果から的中が確認
  できない場合に**既存の正の `payout` を 0 へ落とすことはしない**(`0`/`null` → 確定 と
  増額方向の更新のみ)。これにより「CSV取込 → 後日レース結果を登録」の順で、CSV取込分の
  的中判定・払戻が結果登録時に自動で埋まるようになった(それ以前は取込時点の値で固定されていた)
- 呼び出し元:
  - `functions/api/races/[id].js`の`onRequestPut`(レース管理画面の払戻編集モーダルからの
    保存。単一レース版を使う)
  - `functions/api/races/results-import.js`(JRAレース結果PDF一括登録。**必ず**呼び出す。
    複数レースをまとめて処理するバルク版`recomputeTicketPayoutsForRaces()`を使う。
    詳細は上記「実装上の注意(サブリクエスト数対策)」参照)
  - `functions/api/races/entries-import.js`(出走馬一覧PDFインポート。**保険として**呼び出す。
    木・金の出走馬インポート時点では通常`finish_order`/`payouts`が存在しないため
    実質何もしないが、木金を省略して結果PDFが先に取り込まれるイレギュラーな運用への
    備えとして呼び出す。単一レース版を使う)
  - `functions/api/tickets/bulk.js`(通常購入。過去に購入した馬券の履歴を残す目的の購入
    操作であっても、対象レースが既に着順・払戻確定済みの場合、保存時点で`payout`が
    未確定のまま残ってしまう不具合があったため、チケットINSERT直後に対象レースの
    `finish_order`/`payouts`を確認し、いずれかが確定済みであれば呼び出す。未確定レースの
    場合は何もしない。呼び出しが失敗しても購入自体(履歴の記録)はロールバックしない
    (`try/catch`で握りつぶし、ログのみ残す)。単一レース版を使う。この呼び出しは`user_id`で
    絞り込まないため、購入したのが誰であっても、同じレースを既に購入していた他ユーザーの
    ticketsも(値に変化がなければ実質無害な形で)一緒に再計算される)
  上記いずれも、`user_id`で絞り込まず該当`race_id`の全`tickets`を対象に払戻額を
  再計算・一括更新(`db.batch()`)する
- `races.js`側は、払戻モーダル内の「◯点購入」表示のためだけに`GET /api/tickets`由来の
  `currentTickets`を使う(表示専用。反映処理には使わない)。ticketを個別にPUTするループは
  持たない
- `computeWinningCombos`が返す組み合わせ配列に`combo: null`(判定不能。枠番未確定の枠連等)が
  含まれる場合、`computeTicketPayout`/`recomputeTicketPayoutsForRace`/
  `recomputeTicketPayoutsForRaces`のいずれも、その馬券の払戻を「0円(不的中確定)」にせず
  `null`(未確定のまま)を返す。枠連以外の式別(単勝・複勝・馬連・ワイド・馬単・三連複・
  三連単)は`wakuOf()`を使わないため影響しない

**今後の注意点**: `races.finish_order`/`races.payouts`を書き換えるコードパスを新規に
追加・変更する場合は、必ず`recomputeTicketPayoutsForRace`(または複数レースをまとめて
処理する場合は`recomputeTicketPayoutsForRaces`)の呼び出しが漏れていないか確認すること
(現時点の呼び出し元は`functions/api/races/[id].js`・`functions/api/races/results-import.js`・
`functions/api/races/entries-import.js`・`functions/api/tickets/bulk.js`の4箇所)。
`races`(共有)と`tickets`/`prediction_marks`/`horse_notes`等(ユーザーごとに分離)をまたぐ
処理を新たに書く際は、「今操作しているユーザーから見えているデータ」だけを更新対象に
しないこと。出走馬一覧PDFインポート(`entries-import.js`)も同様の考え方で、`race_id`を
キーに全ユーザー分の`imported_ticket_groups`/`tickets`へ`backfillHorseNamesForRace`を
適用している(user_idで絞り込まない)。

### 払戻確定バッジ・的中率集計の判定

購入画面のレース名見出し横の「確定済」バッジ、予想登録画面の「結果確定済(購入する)」
表示、集計画面の的中率集計の判定対象(分母)は、いずれも「着順(`races.finish_order`)または
払戻(`races.payouts`)のいずれかが確定している」ことを基準に判定するが、**実際の払戻レート
(式別ごとのデータ)が1件以上あるかどうか**で判定する必要がある。

**理由**: `races.payouts`は式別ごとの払戻レート(`{tan:[...], fuku:[...], ...}`)に加えて、
JRAレース結果PDFインポートが取消・除外・中止馬を検出した際に`payouts.refunds`(返還対象の
馬番・枠番の記録であり、払戻レートそのものではない)を保持することがある。単純に
`Object.keys(payouts).length > 0`で判定すると、返還対象馬がいるだけで実際の払戻レートが
1件も登録されていないレースでも「確定済」と誤判定されてしまう。

この判定は共有関数`hasSettledPayoutRates(payouts)`(`public/utils.js`)に一本化しており、
`refunds`キーを判定対象から除外し、他の式別キーに実際のレート配列(要素数1以上)があるか
どうかだけを見る。購入画面(`buy.js`)・予想登録画面(`prediction.js`)・集計画面
(`stats.js`の的中率集計)の3箇所が、この共有関数を使って統一的に判定する。

## 返還(refund)処理

出走取消・競走除外となった馬が絡む組み合わせ馬券は、JRAのルール上「不的中」ではなく
「返還」となり、購入金額が全額払い戻される。**「中止」(発走後にレースを中止した馬)は
返還の対象外**である点に注意(発走している=競走に参加しているため、通常通り
不的中判定される。取消・除外との違いは下記「返還対象の判定ルール」参照)。

### 対応範囲

JRAレース結果PDFインポート由来の通常購入(`tickets`)のみを対象とする。CSVインポート
由来(`imported_tickets`/`imported_ticket_items`)の返還処理は対象外とし、別タスクの
ままとする(`docs/BACKLOG.md`参照。CSV側の「的中／返還」列の実際の表記が未確認のため)。

### スキーマ

`tickets`テーブルに`refunded`カラム(INTEGER、`0`/`1`のブール値。デフォルト`0`)を持つ。

`tickets.payout`は従来通り「その馬券の払戻金額」を表す(返還時は購入金額と同額を
セットする)。`refunded`は「その払戻が返還によるものか、的中によるものか」を区別する
ためだけのフラグで、`payout`の意味自体は変えない。返還時: `payout = amount`
(購入金額と同額。収支±0)・`refunded = 1`。的中時: `payout = レートに応じた払戻額`・
`refunded = 0`。不的中確定時: `payout = 0`・`refunded = 0`。未確定時: `payout = null`・
`refunded = 0`。

### 返還対象の判定ルール

`jraResultParseRefund()`が解析・保存している`races.payouts.refunds`
(`[{horse_numbers:[...], waku_numbers:[...]}, ...]`。返還馬番・返還同枠)を使う。
取消・除外馬の馬番は`refunds[].horse_numbers`に、その馬が単独で占めていた枠(枠内の
出走馬が全頭返還対象になった枠)は`refunds[].waku_numbers`(返還同枠)に、それぞれ
別々に記録されている。判定は式別によって参照する配列が異なる:

- **馬番ベースの式別**(単勝・複勝・馬連・馬単・ワイド・三連複・三連単): 買い目
  (`selections`)の馬番のいずれか1つでも`refunds[].horse_numbers`に含まれていれば返還。
  1点の買い目に複数頭が含まれる式別(馬連・三連複等)では、そのうち1頭でも返還対象なら
  買い目全体が返還になる(JRAの実際の運用に合わせる)
- **枠番ベースの式別**(枠連): 買い目の枠番のいずれか1つでも`refunds[].waku_numbers`
  (返還同枠)に含まれていれば返還。**個別の返還馬番だけでは枠連の返還は判定しない**
  (枠内に出走馬が1頭でも残っていれば、その枠連自体は返還にならないため。実例:
  1枠1頭ずつ配置されたレースで馬番8(5枠)・馬番10(6枠)がともに除外された場合、
  返還同枠は「5枠, 6枠」となり、この2枠を含む枠連の買い目のみが返還対象になる)
- 「中止」は`race_results.status='stopped'`として記録されるのみで、`refunds`配列には
  一切追加されないため、上記いずれの判定にも該当しない(=返還されず、通常の
  不的中判定のまま)。取消・除外・中止の判定ロジック自体を区別する必要はなく、
  `refunds`配列に載っているかどうかだけで自然に切り分けられる

### 実装方針

- 返還判定ロジック(`races.payouts.refunds`と買い目の突き合わせ)は**サーバー側
  (`functions/api/_lib/ticket-payout.js`の`recomputeTicketPayoutsForRace`/
  `recomputeTicketPayoutsForRaces`)にのみ実装し、判定結果を`tickets.refunded`へ確定保存
  する**。クライアント側(`public/payout.js`の`computeTicketPayout`)は判定ロジックを
  複製せず、**取得済みの`ticket.refunded`フラグをそのまま信頼する**(`ticket.refunded`が
  真であれば、常に`ticket.amount`をそのまま返す)。**この設計にした理由**: 返還判定は
  「購入金額の変更に応じて再計算する必要がある値」ではなく「一度確定したら不変の状態」
  であるため、判定ロジック自体をクライアントに複製するとサーバー・クライアントの実装が
  ズレるリスクを増やすだけと判断した。`computeTicketPayout`は購入履歴・予想登録画面で
  購入金額を編集した際に払戻額を再計算するために呼ばれるが、返還確定済みの馬券は金額編集後も
  常に新しい購入金額と同額を返せば足りるため、この設計で要件を満たせる
- サーバー側の判定は的中判定(`computeWinningCombos`によるコンボ照合)より**先に**行う。
  返還対象の買い目は、たとえ結果的に的中コンボと一致していたとしても、返還として扱う
  (返還は取消・除外により対象そのものが競走から除かれたことを意味するため、的中/不的中の
  判定自体が成立しない)
- `stats.js`の的中率集計(`computeHitRate`)は、`payout > 0 && !refunded`を的中の条件とし、
  返還を的中としてカウントしない。収支・回収率の計算(`computeGroupStats`)は`payout`
  (返還時は購入金額と同額)をそのまま使うため、返還によって収支・回収率が歪むことはない
  (返還は収支±0になるよう設計されているため)
- `functions/api/tickets/[id].js`(手動の購入額編集API)は`refunded`を編集可能フィールドに
  含めない。返還状態は結果確定時にサーバー側でのみ確定させるべき値であり、購入額編集の
  たびにクライアントから送信・上書きされるべきではないため(購入額を編集した場合、
  `refunded`列自体は既存の値のまま維持され、`payout`だけが新しい購入額に追随して
  再計算される)

### 画面表示

- 購入履歴画面(`app.js`)・予想登録画面(`prediction.js`)の買い目明細行で、`refunded=1`の
  場合は「払戻¥X」ではなく「返還¥X」と表示する
- グループカードのステータスバッジ(「確定済み」「一部確定」「未確定」)は変更しない
  (返還も「確定」の一種として扱う)

