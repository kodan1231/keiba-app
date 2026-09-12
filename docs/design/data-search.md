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
2. **`race_results`(`race_stats_cache` テーブルの事前計算キャッシュから読む)**:
   `_lib/race-stats-cache.js` の `getRaceResultsGroupedByRaceId(db)` が
   `SELECT payload FROM race_stats_cache WHERE id = 1`(1行read)を返す。`payload` は
   `{ race_id: [{horse_number,jockey,status,finish_position}, ...], ... }` というJSONで、
   `race_results` 全件を `race_id` でグルーピングしたもの。
   - **無効化はDBトリガー**(`schema.sql`/`migration.sql` の `race_stats_cache` テーブル
     定義参照)で自動的に行う。`race_results` への INSERT/DELETE、および集計に使う列
     (`horse_number`/`jockey`/`status`/`finish_position`)の UPDATE があると、トリガーが
     `payload` を `NULL` に戻す(`incident_note` のみの編集では発火しない)
   - 読み取り側は `payload` が `NULL`(未計算 or 無効化された)なら、その場で
     `race_results` を全件スキャンして再計算し、1行にUPSERTしてから使う
     (`recomputeRaceStatsCache`)。次回以降は保存済みの1行を読むだけで済む
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
- **`finish_order` フォールバックのレースでは取消・除外馬を判別できない**ため、その馬の
  騎手の騎乗回数・その馬番の出走数がわずかに増える(結果PDF由来で全頭ぶんの
  `race_results` があるレースでは `status` で正しく除外される)
- **同着**は `finish_order` / `race_results.finish_position` の表現力の範囲でのみ扱う
  (`finish_order` は同着を区別しない)
- 降着・失格馬の `race_results.status` は今回対象外(`docs/BACKLOG.md` 参照)。
  現状は `finished` として扱われる
- 馬名検索・騎手個別検索タブは未実装(検索ハブの土台だけ用意)
