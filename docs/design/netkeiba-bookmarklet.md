> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。

# netkeibaページのブックマークレット取り込み(2026-10-08追加)

PC の Chrome で開いた netkeiba のレースページを、ブックマークレット「馬券帳へ取込」1回で
レース管理画面へ渡し、確認画面を経て取り込む機能。**管理者のみ**。

**経緯**: 馬柱は「テキストから一括入力」へのコピー&貼り付け(`docs/design/umabashira-paste.md`)で
取り込んでいたが、手間を減らしたいという要望。アプリのサーバーから netkeiba を取りに行く方式は、
netkeiba が Cloudflare からのアクセスを拒否しており(`docs/design/data-search.md`「netkeiba連携」)、
利用規約上も機械的な取得は避ける方針のため採らない。アプリ画面内に netkeiba を埋め込んで読む方式は
ブラウザの制限(別サイトの中身は読めない)で不可能。**利用者が自分で開いたページの内容を、
ブックマークレットでアプリへ渡す**方式にした(netkeiba への通信はページを開いたときのものだけ。
アプリから netkeiba へは問い合わせない)。ブックマークレットは公開しない(管理画面からのみ入手)。

## 対象ページ(中央・地方とも同じ構造。2026-10-08 に実物で確認)

| 種類 | URL | 取り込み先 |
|---|---|---|
| 馬柱(5走) | `race.netkeiba.com` / `nar.netkeiba.com` の `/race/shutuba_past.html?race_id=...` | 出走馬表モーダル+馬情報マスタ(貼り付け取り込みと同じ確認画面) |
| 結果・払戻 | 同じく `/race/result.html?race_id=...` | 結果取込API(`POST /api/races/results-import`。JRA結果取込と同じ処理) |

## 流れ

1. 管理画面「netkeiba取込ブックマークレット」のリンクをブックマークバーへドラッグして登録する
   (`public/admin.js` の `setupNetkeibaBookmarklet`。リンク先は管理画面を開いたときのアプリの origin)
2. netkeiba の対象ページでブックマークを押すと:
   - 対象外のページなら案内を出して終わる(ホスト名とパスで判定)
   - ページの HTML(`document.documentElement.outerHTML`)と URL をクリップボードにもコピーする(下記の予備手段用)
   - `races.html?nk=1` を新しいタブで開き、そのタブから `"nk-ready"` が届いたら `postMessage` で
     `{ type: "nk-page", url, html }` を送る(送り先 origin はアプリの origin に限定)
3. レース管理画面(`public/races-netkeiba-import.js`)は、レース一覧の読み込み後(`loadRaces()` の
   `nkOnRacesLoaded()`)に opener へ `"nk-ready"` を送り、受け取ったら `public/netkeiba-html.js` で読み取る。
   受け取るのは origin が `https://race.netkeiba.com` / `https://nar.netkeiba.com` で、かつ `url` のホストと
   一致するメッセージだけ。HTML は `DOMParser` で読む(スクリプトは実行されない)
4. **予備手段**: 5秒たっても受け取れない場合(netkeiba 側の設定でタブ間のやり取りが切れている等)は、
   貼り付け欄を出す。ブックマークレットがコピーした内容を貼り付けて「読み込む」で同じ処理をする
5. 馬券帳に未ログインならログイン画面が出る。ログイン後にレース一覧を読み込んでから受け取りを始める

## 読み取り(`public/netkeiba-html.js`)

- **開催日・競馬場・R**: ページのタイトル「毎日王冠(G2) 5走表示 | 2026年10月4日 東京11R …」から
- **レース名**: `.RaceName` の文字だけ(グレードは別要素。地方は「Jpn1」等が文字で付くので除く)
- **コース等**: `.RaceData01`(「15:45発走 / 芝1800m (左 A) / 天候:曇 / 馬場:良」)。`ダ`→ダート、`障`→障害
- **条件**: `.RaceData02` の span(4つ目以降。「サラ系」を除き、重量種別・頭数・本賞金を除く。重複語は1つに)
- **騎手**: 中央はリンク(`<a>`)の文字、地方はリンク無しの文字(性齢・斤量の span を除いた残り)。
  中央の馬柱・結果の騎手は**略称**(「幸」「横山典」等)、地方はおおむねフルネーム
- **馬柱**: `table.Shutuba_Past5_Table`(同じクラスの表が複数あるが先頭が全頭)の `tr.HorseList`。
  出力は `parseNetkeibaUmabashira()`(`public/parse.js`)と同じ形(父・母・母父・所属・調教師・性齢・毛色・
  騎手・斤量・過去走の騎手名)
- **結果**: `table.RaceTable01`。**列は見出しの文字で探す**(中央と地方で列の並び・有無が違う。地方は
  通過順の列が無い)。取消・除外・中止は着順欄の文字で判定。払戻は `table.Payout_Detail_Table`
  (金額は `<br>` 区切り、馬番は組み合わせごとに同じ数の枠〈空欄を含む〉で並ぶので等分して読む)。
  **枠単(地方のみ)はアプリに券種が無いため読まない**

## 馬柱(5走)の取り込み

- 同じ開催日・競馬場・R のレースが登録済みならその出走馬表編集、無ければ新規登録の出走馬表モーダルを開く
  (カレンダーもその日へ移す)。レース名・コース種別・距離は入力欄が空のときだけページの値で埋める
- そのまま貼り付け取り込みと同じ確認画面(`startUmabashiraPreview`)を出す。以降(血統の不一致の選択・
  略称のエイリアス登録・「反映する」・「保存する」)は `docs/design/umabashira-paste.md` と同じ

## 結果の取り込み

確認画面(`#nk-result-modal`)に、レース(登録済みなら「更新」、無ければ「新しく登録」)・全着順
(着順・馬番・馬名・騎手・タイム・人気)・払戻を出し、「反映する」で `POST /api/races/results-import`
(`mode: "overwrite"`。JRA結果取込と同じ。着順・払戻は置き換え、`race_results` も更新、
購入履歴の払戻も再計算)へ1レース分を送る。

**騎手名の扱い**(中央は略称のため。騎手成績が略称で分かれないように):
1. 騎手名エイリアスに登録済みなら正しい名前
2. 登録済みのレースの出走馬表で、同じ馬(馬名)の騎手がこの略称を含むならその騎手(例「幸」→「幸 英明」)
3. 既知の騎手名(`GET /api/data-search/jockeys`)と同じならそのまま
4. それ以外は「未登録」としてエイリアス登録の欄を出す(候補は既知の騎手名のうちこの名前を含むもの。
   騎乗数の多い順に5件)。登録しなくても反映できる(その名前のまま保存される)

送るレコードの騎手名は 1・2 で置き換えたもの(エイリアスはサーバー側の取込でもかかる)。

**調教師**: 中央(`race.netkeiba.com`)の結果ページの調教師は略称のため送らない(送ると
`applyImportedTrainerNames` で馬情報マスタの調教師〈フルネーム〉が略称で上書きされる)。地方は送る。

## JRA公式ページ(2026-10-10追加)

同じブックマークレットで、JRA公式サイト(PC版 `www.jra.go.jp/JRADB/…`)の次のページも取り込める。いずれも
1ページに1開催日・1競馬場の全レースが入っており、1回押すだけでまとめて取り込める(出走馬一覧PDF・結果の取り込みの代わり)。

| 種類 | 読み取り | 送り先(既存のAPI。サーバー側の変更は無い) |
|---|---|---|
| 出走馬一覧(出馬表。`accessD.html`) | `public/jra-entries-html.js`(`jraEntriesHtmlParsePage`) | `POST /api/races/entries-import`(出走馬一覧PDFと同じ) |
| レース結果(`accessS.html`) | `public/jra-result-html.js`(`jraResultHtmlParsePage`。ユーザースクリプトと同じ) | `POST /api/races/results-import`(`mode: "overwrite"`) |

- JRA のページは URL が共通(`/JRADB/accessD.html` 等。画面遷移は POST)のため、ブックマークレットは
  ホスト名とパス(`/JRADB/` で始まる)だけで受け付け、どのページかは受け取り側が中身で判定する
  (出走馬一覧は `li[id^="syutsuba_"]`、結果は `.race_result_unit`)。どちらでもなければ案内を出す
- 確認画面(`#nk-batch-modal`)に開催日・競馬場・レースごとの内容(出走馬一覧は頭数と馬番の有無、結果は頭数・1〜3着・
  払戻の種類数)と「登録済み/新規」を出し、「登録する」で送る。送った後はレース一覧を読み直してその日を表示する
- **出走馬一覧**: 枠・馬番・馬名・性齢・負担重量・騎手・調教師、レース名・条件(年齢・クラス・混合/指定)・重量種別・
  コース・発走時刻。騎手・調教師は**フルネーム**(netkeiba と違い略称ではない)。見習いの減量記号(☆▲△◇★)は
  騎手名の先頭に残す(出走馬一覧PDFと同じ表記)。**枠順確定前のページ**は枠・馬番が空のため null で送る
  (PDFと同じ扱い。確定後のページを取り込むと馬番が入る)。取消・除外の表示は実物を未確認(2026-10-10時点)
- **発走時刻**: 出走馬一覧の取込API が `post_time` も受け取って保存するようにした(2026-10-10。PDF には無い項目のため
  以前は保存していなかった)。新規レースは保存、既存レースは公式ページの値と違えば置き換える(繰り下げ等に追随)。
  取り込み済みで発走時刻が空のレースは、同じページを取り込み直すと入る
- **結果**: 既存の結果ページ用の読み取り(`docs/design/results-import.md`「ユーザースクリプトによるHTML取込み」)を
  そのまま使う。調教師はフルネームのため馬情報マスタへも反映される(`applyImportedTrainerNames`)
- 2026-10-10 にブックマークレットの対象判定を変えたため、それ以前に登録したブックマークは登録し直す必要がある

## 関連ファイル

- `public/netkeiba-html.js`(netkeiba の読み取り)、`public/jra-entries-html.js`(JRA出走馬一覧の読み取り)、`public/jra-result-html.js`(JRA結果の読み取り。既存)、`public/races-netkeiba-import.js`(受け取り・確認画面)、
  `public/races.html`(受け取り欄・結果の確認モーダル)、`public/races.js`(`loadRaces()` から `nkOnRacesLoaded()`)
- `public/admin.html` / `public/admin.js`(ブックマークレットの配布)
- サーバー側の変更は無い(既存の `POST /api/admin/horses/paste-import`・`POST /api/races/results-import`・
  `POST /api/admin/jockey-aliases` を使う)
