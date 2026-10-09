> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# データ検索画面(レース成績集計)

レース確定データ(`races.payouts` / `races.finish_order` / `races.entries` と、あれば
`race_results`)を横断集計して、競馬場・コース種別・距離ごとの傾向を表示する画面。
ROADMAP「クラスタM」の「騎手名ベースの集計」に相当する。

**着順の正のソースは `race_results`(結果PDF由来・全頭)だが、手入力・CSVインポート・
結果PDF未取込のレースもカバーするため、`race_results` が全頭ぶん揃っていないレースは
`races.finish_order`(上位3着)+ `races.entries`(全出走馬)へフォールバックする**
(下記「③④⑤ 共通」参照)。

- 画面: `public/data-search.html` / `public/data-search.js`
- API: `GET /api/data-search/race-stats`(`functions/api/data-search/race-stats.js`)
- NAV: `shell.js` の `NAV_ITEMS` に **「データ検索」**(`page: "data-search"` / `href: "data-search.html"`)。
  `adminOnly` は付けない。`race_results` / `races` はどちらも全ユーザー共有データのため、
  ログインしていれば誰でも閲覧できる(`GET /api/races/:id/results` ・
  `GET /api/races/:id/horse-history` と同じ扱い。`requireAdmin` しない)

## 検索ハブとしての構成

将来「騎手検索」等のタブを同画面へ追加できるよう、`data-search.html` は
`stats.html` と同じくタブ切り替え構成にする(`.stats-tabs` / `.stats-panel` のクラスを流用)。
**現時点で実装済みのタブは「レース成績」「馬情報検索」「重賞検索」「騎手検索」の4つ**(馬情報検索は2026-09-28、
重賞検索は2026-10-02、騎手検索は2026-10-03追加。重賞検索の仕様は `docs/design/graded-race-search.md`、
騎手検索は下記「騎手検索タブ」)。

## フィルタ(すべて任意・未選択=すべて)

| 項目 | UI | クエリパラメータ | 挙動 |
|---|---|---|---|
| 競馬場 | セレクト | `track` | `races.track` 完全一致。選択肢は API が返す `trackOptions`(データに存在する競馬場) |
| コース種別 | セレクト「すべて(芝・ダート)/ 芝 / ダート」 | `course_type` | `races.course_type` 完全一致。**`障害` は常に対象外**(未指定時も `course_type IS NULL OR course_type IN ('芝','ダート')` で絞る) |
| 距離 | セレクト(完全一致) | `distance` | `races.distance` 完全一致。選択肢は API が返す `distanceOptions`。`distance IS NULL` のレースは距離指定時は除外 |

- `distanceOptions` は「競馬場・コース種別で絞ったうえで `course_type` が `芝`/`ダート` のレースに
  実在する距離」を昇順で返す。競馬場・コース種別のセレクトを変えたら距離セレクトを再取得する
- 期間(開催年等)フィルタは今回は持たない

## 表示項目(レース成績タブ)

### ① 単勝金額 中央値 / 単勝○円以下率

- 分母 = フィルタ該当かつ `payouts.tan` が入っているレース(レース数も表示する)
- 各レースの単勝払戻(100円あたりの `rate`)を1値化する。同着で `payouts.tan` に複数
  エントリがある場合はその平均を「そのレースの単勝金額」とする
- 単勝金額 中央値 = 対象レースの「そのレースの単勝金額」の中央値(件数が偶数なら真ん中2つの平均)。
  **2026-10-03に平均から中央値へ変更**(以前は「平均単勝金額」。まれな高配当に引っ張られにくい
  代表値にするため。平均は表示しない。APIのフィールドも `win.avg` → `win.median`)
- 300円以下率 = (単勝金額 ≤ 300 のレース数) ÷ 分母。500円以下・1000円以下も同様
  (入れ子。300以下のレースは500以下・1000以下にも計上される)

### ② 馬連金額 中央値

- 分母 = フィルタ該当かつ `payouts.umaren` が入っているレース(レース数も表示する)
- 同着で複数組があればその平均を「そのレースの馬連金額」とし、対象レースでの中央値を出す
  (2026-10-03に平均から中央値へ変更。以前は「平均馬連金額」。APIは `umaren.avg` → `umaren.median`)

### ③④⑤ 共通: 着順データの取り方(レースごとに2ソースを使い分ける)

③④⑤ は「出走した各馬の (馬番・騎手・出走したか・1〜3着か)」というレース単位の配列を
作って集計する。この配列を作るソースを**レースごとに**選ぶ:

1. **`race_results` が全頭ぶん揃っているレース** → `race_results` を使う(最も正)。
   「全頭ぶん」= そのレースの `race_results` 行数 ≥ `races.entries` の要素数。
   結果PDFインポートで取り込んだレースはこちらになる。
   - 出走したか = `status ∈ {finished, stopped}`(`scratched`(取消)・`excluded`(除外)は除外)
   - 1〜3着 = `finish_position`(1/2/3。4着以下・NULL は「着外」)
2. **上記に満たないレース**(手入力・CSVインポート・結果PDFのパース不完全など) →
   `races.entries` + `races.finish_order`(上位3着)を使う。
   - 出走したか = 常に true(`entries` から取消馬を判別できないため。※下記「既知の制約」)
   - 1〜3着 = `finish_order` の 0/1/2 番目に一致すれば 1/2/3着

`race_results` が1〜数頭しか無い(パース不完全な)レースは 1 の条件を満たさず、自動的に
2 へフォールバックする。`entries` も `finish_order` も無いレースは ③④⑤ の対象外。

### ③ 高勝率騎手トップ5 / ④ 高複勝率騎手トップ5

- 母集団 = 上記で作った各レースの配列のうち「出走した」かつ `jockey` 非空の馬
- **騎乗回数(分母)** = その馬の数
- 勝率 = (1着の回数) ÷ 騎乗回数
- 複勝率 = (1〜3着の回数) ÷ 騎乗回数(**出走頭数によらず一律「3着以内率」**。
  少頭数レースの実際の複勝圏(7頭以下は2着まで)とはずれる)
- **最低騎乗回数(足切り)** N = `max(5, ⌈対象レース数 × 0.05⌉)`、上限 50。
  騎乗回数が N 未満の騎手はランキング対象外。ここでの「対象レース数」は
  **スコープ内で着順データが取れたレース数**(API レスポンスの `jockeys.resultRaceCount`)。
  画面には「対象 R レース / 最低騎乗 N 回」を明記する
- 騎手名の名寄せ: 先頭の見習い減量記号(`☆▲△★◇`)を除去し、空白を畳み込んだ文字列を
  集約キーにする(`jockeyAliasKeyOf` と同じ考え方。エイリアス正規化自体は取込・
  管理画面の「既存データ正規化」で適用済みの前提)。表示名は記号を除いた形にする
- ソート: 率の降順 → 騎乗回数の降順。5位が同率なら同率の騎手を全員表示する
- 各行: 順位 / 騎手名 / 率 / 「(勝 or 複)n・騎乗 m」

### ⑤ 馬番別成績

- `horse_number`(1〜18)ごとに: 出走数 / 1着 / 2着 / 3着 / 勝率 / 連対率(2着以内)/
  複勝率(3着以内)
- 出走数 = その馬番で「出走した」馬の数
- 出走数が 0 の馬番は行を出さない
- **馬番18などは18頭立てのレースにしか出現しない**ため、大きい馬番ほど出走数が
  少なくなる(母数が偏る)。その旨を注記表示する

## API 仕様

`GET /api/data-search/race-stats?track=&course_type=&distance=`

- `course_type` は `芝` / `ダート` / 空 のみ受け付ける(それ以外は 400)
- `distance` は正の整数のみ(不正は 400)

### サーバー処理(2026-09-12にrace_results側を事前計算キャッシュへ変更。経緯は下記)

レース単位のループで1件ずつ問い合わせない。以下の処理のみ:

1. **races 全件(フィルタ条件を掛けずに取得。毎回ライブ)**:
   `SELECT id, track, course_type, distance, payouts, entries, finish_order FROM races`。
   メモリ上で
   - `trackOptions` = distinct `track`
   - `distanceOptions` = 「選択中の競馬場(未選択なら全部)」かつ `course_type ∈ {芝,ダート}`
     (選択中のコース種別があればそれに一致)かつ `distance` 非 NULL の distinct 昇順
   - `track` / `course_type`(`芝`/`ダート`、未指定時は `NULL または 芝/ダート`)/ `distance`
     の各フィルタを適用してから、①② の払戻集計と ③④⑤ の着順集計を行う
   - ③④⑤ は「③④⑤ 共通」のルールで、レースごとに `race_results`(下記キャッシュを
     `race_id` でグルーピングしたもの)か `finish_order`+`entries` を選んで集計する
   - `entries` / `payouts` 列を全件取得する。数千〜1万行程度なら許容範囲
2. **`race_results`(`race_stats_cache` テーブルの事前計算キャッシュから読む)**
   (**2026-10-07廃止**: 下記「集計用の小さいキャッシュ」へ置き換えた後、どのコードからも使われなく
   なったため、`_lib/race-stats-cache.js`・テーブル・無効化トリガーを `@STEP: perf_indexes_ticket_views` で
   削除した。以下は経緯として残す):
   `_lib/race-stats-cache.js` の `getRaceResultsGroupedByRaceId(db)` が
   `SELECT payload FROM race_stats_cache ORDER BY chunk_index`(複数行read)の結果を
   マージして返す。各行の `payload` は
   `{ race_id: [{horse_number,jockey,status,finish_position}, ...], ... }` というJSONの
   一部(`race_id` 単位でチャンク分割)で、全チャンクを連結すると `race_results` 全件を
   `race_id` でグルーピングしたものと同じになる。
   - **2026-09-19修正**: 当初は1行固定で `race_results` 全件のグルーピング結果を
     1つのJSONにまとめていたが、`race_results` が26,000行規模まで育った結果、1行の
     JSON(約2.3MB)がD1の「1行(1カラム値)あたり2,000,000バイト」の上限を超えて
     UPDATEが失敗し、`GET /api/data-search/race-stats` が500になる(データ検索画面
     「集計の取得に失敗しました」)障害が発生した。`races_cache` が2026-09-12に
     同種の障害を経てチャンク分割方式(下記「races全件取得の事前計算キャッシュ」参照)へ
     変更されたのと同じ対処を、当時この `race_stats_cache` には反映し忘れていたのが
     原因。累積バイト数がチャンクの上限(1,500,000バイト。安全マージン込み)を超えたら
     新しい行(チャンク)に切り替える方式にした
   - **無効化はDBトリガー**(`schema.sql`/`migration.sql` の `@STEP:
     race_stats_cache_chunked` 参照)で自動的に行う。`race_results` への
     INSERT/DELETE、および集計に使う列(`horse_number`/`jockey`/`status`/
     `finish_position`)の UPDATE があると、トリガーが `race_stats_cache` の全行を
     削除する(`incident_note` のみの編集では発火しない)
   - 読み取り側は行が無ければ(未計算 or 無効化された)、その場で `race_results` を
     全件スキャンして再計算し、チャンク分割して保存してから使う
     (`recomputeRaceStatsCache`)。次回以降は保存済みの行を読むだけで済む。
     保存(`db.batch`)の失敗は必ずbest-effortで握りつぶし、読み取れた結果は
     そのまま返す(`races_cache` の `recomputeRacesCache()` と同じ考え方。
     CLAUDE.md「絶対に破ってはいけない不変条件」参照)
   - 「行数 ≥ `entries` 要素数」のレースだけ `race_results` を正のソースとして採用する
     (それ未満は `finish_order` へフォールバック)。この判定・フィルタ適用は今まで通り
     読み取り側(メモリ)で行う

**経緯**: 以前は `race_results` を `races` と JOIN し、`races` 側のカラムで WHERE していた
(JOIN条件が `races` 側のため `race_results` 側の絞り込みが効かず、フィルタの有無や内容に
かかわらず `race_results` をほぼ全件スキャンしてしまっていた。D1無料枠の日次行読み取り
上限〈500万行〉超過障害〈2026-09-11〉の一因)。その後 `race_id IN (...)` チャンク分割
方式(フィルタ該当レースのぶんだけ取得)に変更したが、フィルタ無しの初期表示では
結局ほぼ全件読むことになる点は変わらなかった。`race_results` はユーザー数が増えるほど
「複数ユーザーが同じ検索条件を見る」頻度も上がる**全ユーザー共有データ**であるため、
2026-09-12に「`race_results` を `race_id` でグルーピングしたものを事前計算し、
書き込みがあるまで全ユーザーで使い回すキャッシュ」方式へ変更した。

### レスポンス

```json
{
  "filters": { "track": "", "course_type": "", "distance": null },
  "trackOptions": ["東京", "中山", ...],
  "distanceOptions": [1200, 1400, 1600, ...],
  "win":    { "median": 410, "raceCount": 830,
              "under300Rate": 0.41, "under500Rate": 0.63, "under1000Rate": 0.82 },
  "umaren": { "median": 1850, "raceCount": 780 },
  "jockeys": {
    "resultRaceCount": 800,
    "minRides": 40,
    "topWin":  [ { "name": "ルメール", "rate": 0.31, "count": 60, "rides": 193 }, ... ],
    "topShow": [ { "name": "ルメール", "rate": 0.61, "count": 118, "rides": 193 }, ... ]
  },
  "byHorseNumber": [
    { "horseNumber": 1, "starts": 640, "win": 55, "second": 61, "third": 58,
      "winRate": 0.086, "quinellaRate": 0.181, "showRate": 0.271 },
    ...
  ]
}
```

- 中央値・率は対象 0 件のとき `null`(画面は「-」表示)

## 馬情報検索タブ(2026-09-28追加)

馬名の部分一致で検索し、馬齢・性別・血統(父/母/母父)・調教師・馬主・生産牧場・
過去全出走履歴を表示するタブ。血統・馬主・生産牧場は現行の一括取込(出走馬一覧PDF/
結果PDF/結果HTML)のいずれからも取得できないため、netkeiba(db.netkeiba.com)から
取得してキャッシュする(ユーザー承認済み。詳細は下記「netkeiba連携」)。

- 画面: `public/data-search.html`(`data-panel="horse-info"`)/ `public/data-search.js`(`hi*`)
- API:
  - `GET /api/data-search/horse-search?q=`(`functions/api/data-search/horse-search.js`)
    … 検索候補一覧(部分一致・最大50件)。**2026-10-07からは入力文字を含む馬名だけを SQL(`json_each` + `LIKE`)で
    取り出し、出走回数も SQL で数える**(以前は `races_cache`〈約10MB〉を丸ごと解析しておりCPU時間上限超過の恐れがあった。
    読み取りは races 全件〈約3,700行〉/回。本番データで旧方式と結果が一致)。
    **`q` は2文字未満だと400**(1文字だと該当馬が多すぎて絞り込みの意味が薄いうえ、
    races全件スキャンのコストに見合わないため。クライアント側(`data-search.js`の
    `HI_SEARCH_MIN_LENGTH`)でも2文字未満は送信しない)
  - `GET /api/data-search/horse-info?name=`(`functions/api/data-search/horse-info.js`)
    … 詳細(馬齢・性別・過去全出走履歴・血統/調教師/馬主/生産牧場)。`race_results` は
    `horse_key` の直接検索(`GET /api/races/:id/horse-history` と同じ設計。回数上限なし)
  - `PUT /api/data-search/horse-info`(同ファイル。**管理者専用**)
    … `{ name, sire?, dam?, dam_sire?, trainer?, owner?, breeder? }` で手動編集
    (`data_source='manual'`)。`{ name, action: "refetch" }` でnetkeibaから強制再取得
    (手動編集済みでも上書きする。管理者の明示操作のため)
- いずれのGETも全ユーザー共有データの閲覧のため `requireAdmin` しない(`race-stats.js`
  と同じ扱い)。編集・再取得のみ管理者専用(`races` 等の他の共有データ編集と同じ扱い)

### 画面レイアウト(2026-09-29変更)

- 血統(父/母/母父)と調教師・馬主・生産牧場は、それぞれ見出し付きの別々の段(`.overall-grid`)
  で表示する。1段あたりのカード枚数が3枚に減るぶん、カード幅を広げる(`.hi-master-grid`。
  `minmax(220px, 1fr)`)
- **編集フォームは常時表示しない**。管理者向けの操作は「編集する」「netkeibaから再取得する」の
  2ボタンのみを常時表示し、「編集する」を押した時だけ編集フォーム(血統+調教師/馬主/生産牧場の
  6項目)が開く。「保存する」で送信後、または「キャンセル」でフォームは閉じる(表示専用の
  カード表示に戻る)。別の馬を検索し直した場合もフォームは閉じた状態にリセットする
- 血統カードの下に出す取得状況のお知らせ(取得元・取得失敗の理由)のうち、「「編集する」から
  手入力できます」等の操作への誘導文は**管理者にだけ**出す。一般ユーザーには状況だけを出す
  (2026-10-02。それまでは全員に「下のフォームから手入力できます」と出ており、ボタンが無い
  一般ユーザーにも編集できそうに見えていた。また9/29の変更でフォームは常時表示ではなく
  なったため「下のフォーム」という文言自体も古くなっていた)
- **取得失敗の文言には「いつの取得結果か」を付ける**(2026-10-03): 失敗した馬も `horses` に
  `fetch_error` 付きで保存され、その後は自動で取り直さない(管理者の「netkeibaから再取得する」のみ)。
  以前は失敗理由だけを出していたため、今回失敗したのか過去の失敗のままなのかが分からなかった。
  `GET /api/data-search/horse-info` の `master.fetchedNow`(この問い合わせでnetkeibaへ取得を
  試みたか。`_lib/horse-master.js` の `getOrFetchHorseMaster`/`refetchHorseInfoFromNetkeiba` が
  返す行に付ける `fetched_now` 目印。DBには保存しない)と `fetchedAt` を使い、
  `data-search.js` の `hiFetchErrorWithWhenText()` で
  「今回の取得で、netkeibaに取得を拒否されました(HTTP 400)。」/
  「2026/10/3 13:23の取得時に、…(その後は自動で再取得していません)」のように出し分ける。
  重賞検索タブの出走馬詳細も同じ関数を使う(`graded-race-horses` APIの `master.fetched_at` を追加)。
  失敗した馬を一定時間後に自動で取り直す仕組みは**設けない**(2026-10-03にユーザー判断。上記の文言と
  管理者向けの再取得の案内を見て、管理者が「netkeibaから再取得する」を押す運用)

### 表示項目の出どころ

| 項目 | 出どころ |
|---|---|
| 馬齢・性別 | 自アプリの `race_results`(直近出走の `sex_age` をそのまま採用。去勢等で性別が変わりうるため常に最新レースを正とする。生年月日は保持しない) |
| 過去全出走履歴 | 自アプリの `race_results`(`horse_key` で直接検索。結果PDF/結果HTML未取込のレースは含まれない。予想登録画面の「過去成績」と同じ制約) |
| 血統(父/母/母父)・馬主・生産牧場 | netkeiba(下記参照)。取得できなければ空欄+手動編集可能 |
| 調教師 | netkeibaに加え、2026-09-28以降に取り込む出走馬一覧PDF/結果PDF/結果HTMLからも取得できる(下記「調教師の反映」参照) |

### `horses` テーブル(馬情報マスタ)

`schema.sql` / `migration.sql`(`@STEP: horses_master`)参照。`horse_key`
(= `horseAliasKeyOf(horse_name)`。`horse_aliases` と同じキー)で1馬1行。
「検索されて初めて取得するオンデマンドキャッシュ」であり、`races`/`race_results` の
全件規模とは違い、実際に検索されたことがある馬の分だけ行ができる。

`data_source` は `'netkeiba'` / `'import'` / `'manual'` の3値。**`'manual'`(管理者が
編集フォームで保存した)行は、管理者の明示的な「netkeibaから再取得」操作以外では
自動上書きしない**(netkeiba再取得・出走馬一覧PDF等の取込どちらも対象外にする)。
1レコード全体で1つの `data_source` しか持たない(フィールド単位の来歴は追跡しない)ため、
「調教師だけ手動修正したら血統欄の自動更新も止まる」という割り切りをしている。

### netkeiba連携

**2026-10-08 廃止**: アプリ(サーバー)から netkeiba への自動取得(馬情報検索で初めて開いた馬の取得・管理者の
「netkeibaから再取得する」・拒否されたときの取得の一時停止と管理画面の設定)をすべてやめた。血統・調教師・毛色・所属は、
レース管理画面で netkeiba の馬柱(5走)をブックマークレット/貼り付けで取り込んだとき(docs/design/netkeiba-bookmarklet.md・
docs/design/umabashira-paste.md)と、管理者の手入力で登録する。馬情報検索・重賞検索・馬柱では登録済みの分だけを表示し、
未登録なら「血統等は未登録です」と出す(管理者には取り込み・手入力の案内)。以前の取得失敗の記録(`horses.fetch_error`)は
表示に使わない。`_lib/netkeiba.js`・`functions/api/admin/netkeiba-pause.js`・`external_fetch_pause` テーブルは削除した
(`@STEP: cleanup_unused_tables`)。以下はそれ以前の仕様(経緯として残す)。

`_lib/netkeiba.js`(取得・パースのみ。DB不使用)/ `_lib/horse-master.js`(DB連携)。

- **取得元**: netkeiba(db.netkeiba.com)。個人の馬券帳アプリからオンデマンド(検索された
  馬についてのみ、1回きり)で取得する用途として2026-09-28にユーザー承認済み。
  取得先サイトの利用規約・負荷への配慮は運用者の自己責任(このアプリの想定利用規模は
  個人〜少人数)。
- **馬名→netkeiba馬IDの解決**: `db.netkeiba.com/?pid=horse_list&word=<検索語>` を叩く。
  完全一致1件のみの場合は馬個別ページ(`/horse/<id>/`)へ302リダイレクトされる
  (このレスポンス本文はプロフィールテーブルを含む馬個別ページそのもの)。
  リダイレクトされない場合(該当0件、または同名馬が複数存在。JRA登録馬名は数十年後に
  再利用され得るため実際に起こり得る)は検索結果一覧ページをパースし、名前が完全一致する
  候補だけに絞る。複数候補が残った場合、自アプリの直近出走履歴から推定した生年
  (`race_date`の年 − `sex_age`の年齢 + 1)に最も近い候補を採用する(推定できなければ
  先頭候補。**取り違えのリスクが残る既知の制約**。誤りは管理者が編集フォームで修正する)
- **血統(父/母/母父)**: 馬個別ページから読み込まれる非同期API
  (`db.netkeiba.com/horse/ajax_horse_pedigree.html?input=UTF-8&output=json&id=<id>`)。
  返る血統表は常に「父側2行+母側2行」の3代簡易表(2026-09-28に実データで確認済み)。
  検索結果一覧ページ側にも父/母/母父の列があり、そちらで済ませられる場合はこのAPIを
  呼ばない(完全一致1件のリダイレクト経路のみ、この非同期APIを追加で呼ぶ)
- **調教師・馬主・生産牧場**: 完全一致1件の場合は馬個別ページの「プロフィール」テーブル
  (`db_prof_table`)、複数候補の場合は検索結果一覧ページの該当列から取得する
- **EUC-JPエンコーディング**: db.netkeiba.comはレガシーなEUC-JPサイトで、検索クエリも
  EUC-JPでパーセントエンコードする必要がある(UTF-8のままでは文字化けして0件になる)。
  CloudflareWorkersの`TextEncoder`はUTF-8固定でEUC-JP出力ができないため、全角カタカナ
  (JIS X 0208第5行。EUC-JPでは `[0xA5, コードポイント - 0x3000]` の単純な線形変換。
  2026-09-28に実データで確認済み)だけを手動でパーセントエンコードする。
  長音「ー」(EUC-JP `A1 BC`)・中黒「・」(`A1 A6`)は第1行の記号のため個別に変換する
  (2026-10-02修正。それまでは一律に第5行として変換しており、長音を含む馬名は必ず
  `not_found` になっていた。該当馬は管理者の「netkeibaから再取得」で取り直す)。**JRA登録馬名は
  全角カタカナのみという前提**のため、それ以外の文字(漢字・ひらがな等)を含む馬名は
  エンコード不可としてnetkeiba取得自体を諦める(`fetch_error='encoding_unsupported'`。
  手動編集にフォールバック)。レスポンス側(HTML本文)のEUC-JP→Unicodeデコードは
  `TextDecoder("euc-jp")` に依存する(WorkersのEncoding Standard実装が対応している前提。
  **wrangler dev実機での動作確認が必要**。対応していない場合は例外となり、
  `getOrFetchHorseMaster`がcatchしてfetch_errorに記録する〈読み取り自体は失敗しない〉)
- **取得のタイミング**: `GET /api/data-search/horse-info` で該当馬の `horses` 行が
  無いときだけ、その場でnetkeiba取得を試み、成功・失敗いずれの結果も保存する
  (失敗時も `fetch_error` を記録して行を作ることで、以後の検索で毎回netkeibaへ
  問い合わせるのを防ぐ)。以後は管理者の「netkeibaから再取得」ボタンでのみ再試行する
- **失敗理由(`fetch_error`)のコード**(2026-10-02に詳細化。それまではnetkeibaの拒否ページも
  表が無いため一律 `not_found` になっており、ボット対策で弾かれているのか本当に該当馬が
  いないのか区別できなかった。実際に2026-10-02時点で本番のほぼ全馬が血統不明になっており、
  原因切り分けのために導入):
  | コード | 意味 |
  |---|---|
  | `encoding_unsupported` | 馬名にカタカナ以外を含み検索語を作れない |
  | `network_error` | 通信自体が失敗 |
  | `http_<status>` | 検索ページが200以外(403ならボット対策による拒否) |
  | `unexpected_page` | 200だが馬個別ページでも検索結果一覧でもない(アクセス制限・メンテナンス・構造変更) |
  | `not_found` | 検索結果一覧に名前が完全一致する馬がいない |
  | `parse_error` | 解析中の例外 |
  | `pedigree_http_<status>` / `pedigree_unexpected_response` / `pedigree_network_error` | 完全一致1件(馬個別ページ)経路で、血統の非同期APIだけ失敗。調教師・馬主・生産牧場は保存し、`fetch_error` に理由を残す(それまでは血統だけ空のまま成功扱いだった) |

  画面のお知らせ文はこのコードから作る(`data-search.js` の `hiFetchErrorText`。重賞検索タブも共用)。
- **取得の一時停止**(2026-10-04追加): netkeiba から取得を拒否されたら、**管理画面で設定した時間
  (既定6時間。1〜72時間)**は netkeiba へ問い合わせない。設定は管理画面「netkeiba取得の一時停止」
  (`GET/PUT /api/admin/netkeiba-pause`。`external_fetch_pause.pause_hours`。未設定なら
  `_lib/horse-master.js` の `NETKEIBA_PAUSE_HOURS_DEFAULT`)。変更は次に拒否されたときから使われ、
  今の停止期限は変えない。管理画面には今停止中か(期限・きっかけの失敗コード)も出す。
  - 経緯: 2026-10-03〜04に、短時間の連続取得(重賞検索タブの一括取得。18頭で約50回を数秒)の
    数時間後から、数時間単位で HTTP 400 で拒否される状態が2回起きた(1回目は10/3 13:23〜、
    遅くとも23:25には解除。2回目は10/4 1:41〜)。制限中に問い合わせを重ねると解除を遅らせる
    おそれがあるため。重賞検索タブからの取得自体も同時期に廃止した(`docs/design/graded-race-search.md`)
  - 停止のきっかけ: 取得失敗コードが `http_<status>` / `pedigree_http_<status>` / `unexpected_page`
    (相手の制限とみなすもの)。`not_found`・`encoding_unsupported` 等では止めない
  - 停止中の動作:
    - 馬情報検索で未取得の馬を開いても問い合わせず、`horses` に**行を作らない**(失敗として
      記録しない)。画面は「…まで netkeiba への取得を見合わせています。見合わせ期間が過ぎた後に
      この馬を開き直すと、自動で取得します。」(`fetchError='paused'`・`pausedUntil`)
    - 管理者の「netkeibaから再取得する」も問い合わせず、既存の内容を変えずに 409
      (`{ error, pausedUntil, master }`)を返す。画面は見合わせ期限をアラートで出す
    - 今回の取得で拒否されて停止を始めた場合は、失敗理由に続けて見合わせ期限も出す
  - 停止明けの最初の問い合わせが再び拒否されたら、そこからまた設定時間止める(制限が長引いても
    問い合わせは設定時間に1回程度にとどまる)
  - 状態は `external_fetch_pause` テーブル(`service='netkeiba'` の1行。列は `pause_hours`〈設定〉・
    `paused_until`〈停止期限。NULL=停止していない〉・`reason`。`@STEP: external_fetch_pause`)。
    読み取りは「未取得の馬を開いたとき・再取得ボタン」のときだけ1行、書き込みは拒否されたときだけ。
    **テーブルが無い・読み書きに失敗した場合は「止めない」扱い**で、取得は従来どおり動く
    (そのため、コードのデプロイとマイグレーション適用の順序は問わない。停止の保存に失敗した
    場合は画面に「見合わせ中」と出さない)

### 調教師の反映(出走馬一覧PDF/結果PDF/結果HTML)

2026-09-28以降、以下の取込経路は調教師名も解析結果に含めるようになった
(従来は騎手名との境界判定にのみ使い、保存せず捨てていた。`docs/design/entries-import.md`
`docs/design/results-import.md` 参照)。

- `public/jra-entries-pdf.js`(出走馬一覧PDF)
- `public/jra-result-pdf.js`(JRAレース結果PDF)
- `public/jra-result-html.js`(結果HTMLユーザースクリプト。**PC版のtd.trainerセレクタは
  他列の命名規則からの類推で、実ページでの確認ができていない**。誤っていてもnullに
  なるだけで取込自体は失敗しない。スマホ版は実データで確認済み)

`races.entries` / `race_results` 自体には調教師カラムを追加しない(既存の
`mergeEntriesByHorseName` のフィールドホワイトリストにも含めない)。代わりに
`_lib/horse-master.js` の `applyImportedTrainerNames(db, entries)` が、取込1回に含まれる
`{horse_name, trainer}` の集合を受け取り、**「既にhorsesテーブルに行がある馬」だけ**
`trainer` 列を上書きする(best-effort。`data_source='manual'` の行は対象外)。
新規にhorses行を作ることはしない(オンデマンドキャッシュの設計を保つため)。
`entries-import.js` / `results-import.js` それぞれの取込処理の最後で1回だけ呼ぶ
(1回の取込に含まれるユニーク馬の horse_key は90件ずつチャンク分割してIN句に渡す)。

## 集計用の小さいキャッシュ(`race_lineup_cache`。2026-10-07追加)

(2026-10-08〜: races.id の範囲〈200件〉ごとの行で持ち、変わった範囲だけ作り直す。docs/design/data-model.md
「キャッシュを範囲ごとに作り直す」。以下の「1行=チャンク」「トリガーで全行削除」の記述はそれ以前のもの)

**経緯**: レース成績タブ・騎手検索タブは、表示のたびに `races_cache`(約10MB。3,739レース×全出走馬)と
`race_stats_cache`(約3.8MB。race_results 49,536行)を丸ごと読み込んで集計していた。データの増加で
1リクエストのCPU時間が150〜280ms(本番データでの計測。うちJSON解析だけで約50ms)に達し、2026-10-07に
Cloudflare Workers のCPU時間上限超過(`exceededResources`。当日23件、CPU中央値128ms)で
「集計の取得に失敗しました」になった。集計に要るのは各レースのごく一部の項目だけのため、それだけを
詰めて持つ専用キャッシュを設けた(通信量は増やさない。サーバー側の処理だけを軽くする)。

- 対象: `GET /api/data-search/race-stats`(レース成績)、`GET /api/data-search/jockeys`・`jockey-stats`(騎手検索)
- 実装: `functions/api/_lib/race-lineup-cache.js`(`getRaceLineups`)
- 中身(レースごと): 日付・競馬場・コース種別・距離・単勝の値・馬連の値(いずれも同着は平均。
  レース成績タブの①②と同じ1値化)・**出走した各馬の[馬番, 騎手, 着順(1〜3、着外は0)]**。
  出走馬の一覧は「③④⑤ 共通: 着順データの取り方」と同じ規則(race_results が全頭そろっていれば
  それ、無ければ entries + finish_order。取消・除外は含めない)で、作り直し時に確定させておく。
  騎手名はチャンクごとの辞書(配列)に入れ、各馬は辞書の番号で持つ。騎手名エイリアスの適用は
  従来どおり読み取り側で行う(エイリアスを登録・削除してもキャッシュの作り直しは不要)
- 保存: `races_cache` と同じく `chunk_index` ごとの複数行(`CHUNK_MAX_BYTES` 超過で次の行)。
  保存の失敗は握りつぶす(best-effort)
- **作り直しは他のキャッシュに依存しない**: `races_cache`・`race_stats_cache` は読まず、DB から
  必要な列だけを読む。
  - races: `id, race_date, track, course_type, distance, finish_order` と、`payouts` の `tan`・`umaren`
    部分(`json_extract`)、出走頭数(`json_array_length(entries)`)。`entries` 本体は読まない
    (不正なJSONでSQL全体が失敗しないよう `json_valid` で守る)
  - race_results: `race_id` ごとに `group_concat` で1行にまとめた文字列(区切りは制御文字)
  - `entries` 本体は、race_results が全頭そろっていないレースの分だけ `id IN (...)` で読む(90件ずつ)
  - 読み取り行数は races 全件+race_results 全件(2026-10-07時点で約5.3万行)/回。CPU時間は
    大きなJSONの解析をしないため小さい
  - 他のキャッシュを使わないのは、作り直しが重いと「CPU時間切れで保存前に打ち切られ、次の
    リクエストでまた作り直す」を繰り返す恐れがあるため(2026-09-12の `races_cache` 障害と同じ構図を避ける)
- 無効化: DBトリガー(`@STEP: race_lineup_cache`)。races の INSERT/UPDATE/DELETE、
  race_results の INSERT/DELETE と `horse_number`/`jockey`/`status`/`finish_position` の UPDATE で全行削除
- 単勝・馬連の値(同着は平均、rate > 0 のみ)は SQL 側(`json_each` + `AVG`)で計算する。作り直しは
  1回の走査で詰めた形を作り、チャンクの切り替えはレースを処理する前に行う(途中で切り替えると、
  そのレースの騎手番号が前のチャンクの辞書を指したままになる。実装中に本番データとの比較で見つけた)
- **計測(2026-10-07。本番データ・手元のNode)**: キャッシュは約57万バイト(2行)。旧方式と出力が完全一致
  (レース成績の絞り込み3通り・騎手一覧412人・騎手成績)。CPU時間は、レース成績(絞り込みなし)約312ms→約79ms、
  騎手一覧 約172ms→約31ms、騎手成績 約219ms→約32ms。作り直しは約47〜94ms(races / race_results の
  更新後の最初の1回だけ)。

## 騎手検索タブ(2026-10-03追加)

騎手名の一部を入力して候補から騎手を選び、**通算成績・年度別成績・コース別成績**を表で出すタブ。

- 画面: `public/data-search.html`(`data-panel="jockey"`)/ `public/jockey-search.js`(`js*`)
- API(いずれも全ユーザー共有データの閲覧のため `requireAdmin` しない):
  - `GET /api/data-search/jockeys`(`functions/api/data-search/jockeys.js`)
    … 騎手の全件一覧 `{ jockeys: [{ name, rides }] }`(騎乗数の降順)。**タブを初めて開いたときに
    1回だけ取得し、候補の絞り込み(部分一致)は画面側で行う**(騎手は数百人規模のため。入力の
    たびにAPIを呼ばない。馬名と違い1文字〈例:「武」〉から候補を出す)
  - `GET /api/data-search/jockey-stats?name=`(`functions/api/data-search/jockey-stats.js`)
    … 選んだ騎手の成績(下記レスポンス)。該当騎手が無ければ404

### 集計対象・定義(レース成績タブの③④と同じ考え方)

- **データの読み方**: `races` は `races_cache`、`race_results` は `race_stats_cache`
  (いずれも事前計算キャッシュ。数行のread)から読み、メモリ上で集計する。`race_results`・
  `races` を直接全件SELECTしない(レース成績タブと同じ)。追加のDB変更・インデックスは不要
- **レースごとの着順ソース**: レース成績タブ「③④⑤ 共通」と同じく、`race_results` が全頭ぶん
  揃っていればそれを使い、揃っていなければ `races.entries` + `races.finish_order`(上位3着)で補う
  (`_lib/race-lineup.js` の `buildRaceLineup()` をレース成績タブと共用)。補ったレースは
  取消馬も騎乗数に入る(`entries` から取消を判別できないため)
- **障害レースも含める**(レース成績タブは芝・ダートのみだが、騎手検索は障害騎手もいるため)。
  コース別では `course_type` が「障害」の行として別に出る
- **騎乗数** = 出走した(`status` が `finished`/`stopped`。補ったレースは全出走馬)騎乗の数。
  1着/2着/3着 = `finish_position`、着外 = 騎乗数 − (1着+2着+3着)
- **単勝率** = 1着 ÷ 騎乗数、**連対率** = 2着以内 ÷ 騎乗数、**複勝率** = 3着以内 ÷ 騎乗数
  (出走頭数によらず一律「3着以内率」。レース成績タブと同じ)
- **騎手の名寄せ**: `jockey_aliases` のエイリアスを適用(`applyJockeyAliasMap`)したうえで、
  `jockeyAliasKeyOf`(見習い減量記号☆▲△★◇の除去+全空白除去)をキーにまとめる。表示名は
  記号を除き空白を1つに畳んだ形。取込時に正規化済みの前提だが、未補正の古いデータも
  エイリアス登録済みなら同一騎手にまとまる
- **通算** = アプリに取り込まれているレースの範囲での通算(実際の生涯成績ではない)。
  対象期間(最初と最後の騎乗日)を画面に出す
- **年度別** = `races.race_date` の年ごと(新しい年が上)。**今年を含む過去5年ぶんだけ表示する**
  (2026-10-03。例: 2026年なら2022〜2026年。それより前の年は通算・コース別にのみ含まれる。
  APIは全年を返し、画面側〈`jockey-search.js` の `JS_YEAR_TABLE_YEARS`〉で絞る。該当年が無ければその旨を表示)
- **コース別** = 競馬場 × コース種別(芝/ダート/障害)× 距離 ごと(例:「東京 芝1600m」)。
  `course_type`/`distance` が無いレースは「コース不明」としてまとめる。
  **並び順(2026-10-03変更)**: ①競馬場(中央4場 → 中央ローカル6場 → 南関東4場 → その他地方。
  `utils.js` の `TRACK_DISPLAY_ORDER`。`buy.js` の `RACE_TRACK_ORDER` と同じ並び。一覧に無い
  競馬場は後ろで名前順、競馬場不明は最後)→ ②芝 → ダート → 障害 → ③距離の短い順(不明は最後)。
  並べ替えは画面側(`jockey-search.js` の `jsSortCourses()`)で行う。当初は騎乗数の多い順だった

### 表の列

通算・年度別・コース別とも「(年度/コース)・騎乗数・1着・2着・3着・着外・単勝率・連対率・
複勝率」。通算は1行の表。

### レスポンス(`GET /api/data-search/jockey-stats`)

```jsonc
{
  "name": "戸崎 圭太",
  "period": { "from": "2025-01-05", "to": "2026-09-28" },
  "total":  { "rides": 812, "first": 120, "second": 98, "third": 85, "other": 509,
              "winRate": 0.148, "quinellaRate": 0.268, "showRate": 0.373 },
  "byYear":   [ { "year": 2026, "rides": 410, ... }, ... ],          // 新しい年が先
  "byCourse": [ { "track": "東京", "course_type": "芝", "distance": 1600, "rides": 64, ... }, ... ] // APIは騎乗数の降順。表示は画面側で並べ替え
}
```

## 既知の制約・今後(レース成績タブ)

- `races.course_type` / `races.distance` は現状インデックスが無い。行数が増えたら
  `migration.sql` に `races(track, course_type, distance)` の複合インデックスを追加する
  (`@STEP: races_track_course_distance_index`)
- 複勝率は一律「3着以内率」。少頭数レースの実際の複勝圏(2着以内)とはずれる
- **`finish_order` フォールバックのレースでは取消・除外馬を判別できない**ため、その馬の
  騎手の騎乗回数・その馬番の出走数がわずかに増える(結果PDF由来で全頭ぶんの
  `race_results` があるレースでは `status` で正しく除外される)
- **同着**は `finish_order` / `race_results.finish_position` の表現力の範囲でのみ扱う
  (`finish_order` は同着を区別しない)
- 降着・失格馬の `race_results.status` は今回対象外(`docs/BACKLOG.md` 参照)。
  現状は `finished` として扱われる

## 既知の制約・今後(馬情報検索タブ)

- netkeibaは非公式なスクレイピング的利用であり、サイト側のHTML構造変更で
  取得・パースが壊れる可能性がある(壊れても`fetch_error`に記録されるだけで、
  他画面・取込処理には影響しない)
- 同名馬(数十年後の名前再利用)の取り違えリスクが残る(上記「netkeiba連携」参照)
- `td.trainer`(結果HTML・PC版)は実ページでの確認ができていない
- 過去全出走履歴は `race_results` ベースのみ(結果PDF/結果HTML未取込のレースは
  「出走履歴なし」に見える。`races.entries` のみのレースへのフォールバックは今回未実装)
- 騎手個別検索タブは未実装(検索ハブの土台だけ用意)
