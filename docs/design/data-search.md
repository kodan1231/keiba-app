> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# データ検索画面(レース成績集計)

`race_results`(JRAレース結果PDF取込済みの馬単位の確定結果)と `races.payouts`(払戻)を
横断集計して、競馬場・コース種別・距離ごとの傾向を表示する画面。ROADMAP「クラスタM」の
「騎手名ベースの集計」に相当する。

- 画面: `public/data-search.html` / `public/data-search.js`
- API: `GET /api/data-search/race-stats`(`functions/api/data-search/race-stats.js`)
- NAV: `shell.js` の `NAV_ITEMS` に **「データ検索」**(`page: "data-search"` / `href: "data-search.html"`)。
  `adminOnly` は付けない。`race_results` / `races` はどちらも全ユーザー共有データのため、
  ログインしていれば誰でも閲覧できる(`GET /api/races/:id/results` ・
  `GET /api/races/:id/horse-history` と同じ扱い。`requireAdmin` しない)

## 検索ハブとしての構成

将来「馬名検索」「騎手検索」等のタブを同画面へ追加できるよう、`data-search.html` は
`stats.html` と同じくタブ切り替え構成にする(`.stats-tabs` / `.stats-panel` のクラスを流用)。
**現時点で実装するタブは「レース成績」の1つだけ**。

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

### ① 平均単勝金額 / 単勝○円以下率

- 分母 = フィルタ該当かつ `payouts.tan` が入っているレース(レース数も表示する)
- 各レースの単勝払戻(100円あたりの `rate`)を1値化する。同着で `payouts.tan` に複数
  エントリがある場合はその平均を「そのレースの単勝金額」とする
- 平均単勝金額 = 対象レースの「そのレースの単勝金額」の平均
- 300円以下率 = (単勝金額 ≤ 300 のレース数) ÷ 分母。500円以下・1000円以下も同様
  (入れ子。300以下のレースは500以下・1000以下にも計上される)

### ② 平均馬連金額

- 分母 = フィルタ該当かつ `payouts.umaren` が入っているレース(レース数も表示する)
- 同着で複数組があればその平均を「そのレースの馬連金額」とし、対象レースで平均する

### ③ 高勝率騎手トップ5 / ④ 高複勝率騎手トップ5

- 母集団 = フィルタ該当レースの `race_results` 行のうち `jockey` が非空のもの
- **騎乗回数(分母)** = `status ∈ {finished, stopped}` の行数(`scratched`(取消)・
  `excluded`(除外)は騎乗回数に数えない)
- 勝率 = (`finish_position = 1` の回数) ÷ 騎乗回数
- 複勝率 = (`finish_position ≤ 3` の回数) ÷ 騎乗回数(**出走頭数によらず一律「3着以内率」**。
  少頭数レースの実際の複勝圏(7頭以下は2着まで)とはずれる)
- **最低騎乗回数(足切り)** N = `max(5, ⌈対象レース数 × 0.05⌉)`、上限 50。
  騎乗回数が N 未満の騎手はランキング対象外。ここでの「対象レース数」は
  **スコープ内で `race_results` が存在するレース数**(API レスポンスの `jockeys.resultRaceCount`)。
  画面には「対象 R レース / 最低騎乗 N 回」を明記する
- 騎手名の名寄せ: 先頭の見習い減量記号(`☆▲△★◇`)を除去し、空白を畳み込んだ文字列を
  集約キーにする(`jockeyAliasKeyOf` と同じ考え方。エイリアス正規化自体は取込・
  管理画面の「既存データ正規化」で適用済みの前提)。表示名は記号を除いた形にする
- ソート: 率の降順 → 騎乗回数の降順。5位が同率なら同率の騎手を全員表示する
- 各行: 順位 / 騎手名 / 率 / 「(勝 or 複)n・騎乗 m」

### ⑤ 馬番別成績

- `horse_number`(1〜18)ごとに: 出走数 / 1着 / 2着 / 3着 / 勝率 / 連対率(2着以内)/
  複勝率(3着以内)
- 出走数 = その馬番の `race_results` 行数(`scratched`・`excluded` は除外)
- 出走数が 0 の馬番は行を出さない
- **馬番18などは18頭立てのレースにしか出現しない**ため、大きい馬番ほど出走数が
  少なくなる(母数が偏る)。その旨を注記表示する

## API 仕様

`GET /api/data-search/race-stats?track=&course_type=&distance=`

- `course_type` は `芝` / `ダート` / 空 のみ受け付ける(それ以外は 400)
- `distance` は正の整数のみ(不正は 400)

### サーバー処理(サブリクエスト2本で完結)

レース単位のループで1件ずつ問い合わせない。以下の2クエリのみ:

1. **払戻・選択肢用(フィルタ条件を掛けずに全 `races` を取得)**:
   `SELECT track, course_type, distance, payouts FROM races`。メモリ上で
   - `trackOptions` = distinct `track`
   - `distanceOptions` = 「選択中の競馬場(未選択なら全部)」かつ `course_type ∈ {芝,ダート}`
     (選択中のコース種別があればそれに一致)かつ `distance` 非 NULL の distinct 昇順
   - 払戻集計(①②)は `track` / `course_type`(`芝`/`ダート`、未指定時は
     `NULL または 芝/ダート`)/ `distance` の各フィルタをメモリ側で適用してから集計
   - `payouts` 列は 1 行 100 バイト前後。数千〜1万行程度なら全件取得でも許容範囲。
     行数が増えて重くなったら precompute テーブルか期間フィルタ導入を検討する
2. **騎手・馬番集計用**: `race_results` を `races` と JOIN し、`races` 側の
   `track` / `course_type` / `distance` で WHERE(`race_results` は大きいテーブルのため
   全件取得はしない)。
   `SELECT rr.race_id, rr.horse_number, rr.jockey, rr.status, rr.finish_position
    FROM race_results rr JOIN races r ON r.id = rr.race_id <WHERE ...>`
   - JOIN 方式にすることで、対象レースが多くても `WHERE race_id IN (...)` のチャンク分割
     (=サブリクエスト増)が不要になる(`GET /api/races/:id/horse-history` と同じ方針)
   - `course_type` 未指定時の WHERE は `(r.course_type IS NULL OR r.course_type IN ('芝','ダート'))`
   - `race_results` が無いレース(払戻だけ入力済み)はこのクエリの対象外。①②の分母と
     ③④⑤の分母が別々になるのはこのため

### レスポンス

```json
{
  "filters": { "track": "", "course_type": "", "distance": null },
  "trackOptions": ["東京", "中山", ...],
  "distanceOptions": [1200, 1400, 1600, ...],
  "win":    { "avg": 512.3, "raceCount": 830,
              "under300Rate": 0.41, "under500Rate": 0.63, "under1000Rate": 0.82 },
  "umaren": { "avg": 3120.5, "raceCount": 780 },
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

- 平均・率は対象 0 件のとき `null`(画面は「該当データなし」表示)

## 既知の制約・今後

- `races.course_type` / `races.distance` は現状インデックスが無い。行数が増えたら
  `migration.sql` に `races(track, course_type, distance)` の複合インデックスを追加する
  (`@STEP: races_track_course_distance_index`)
- 複勝率は一律「3着以内率」。少頭数レースの実際の複勝圏(2着以内)とはずれる
- 降着・失格馬の `race_results.status` は今回対象外(`docs/BACKLOG.md` 参照)。
  現状は `finished` として扱われる
- 馬名検索・騎手個別検索タブは未実装(検索ハブの土台だけ用意)
