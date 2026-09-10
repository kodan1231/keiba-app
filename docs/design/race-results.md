> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# レース結果の詳細記録(race_results)

出走馬一覧PDF・JRAレース結果PDFから取得できる情報のうち、「レース前の予定」(`races.entries`)
とは別に、「レース確定後の記録」を馬単位で保持するための専用テーブル。**既存の
`races.finish_order`(払戻判定に使う上位3着のみ)・`races.payouts`は変更せずそのまま維持し**、
`race_results`は記録・将来の集計参照用の追加データという位置づけにする(払戻判定ロジックへの
影響を避けるため)。

### 目的・想定用途

- 馬名ベースで「過去出走レース一覧」(出走したレースの条件・着順・タイム等)を横断的に
  参照できるようにする。**予想登録画面での参照は実装済み**(2026-09-10。下記「予想登録画面での
  過去成績参照」)。騎手別の単勝率等の集計は引き続きスコープ外(BACKLOG「クラスタM」)
- 騎手名ベースで競馬場・コース種別ごとの単勝率・連対率・複勝率を算出できるようにする
  (同上、参照用APIは別タスク)
- 「競走中の出来事」を該当馬に紐付けて記録し、管理者が確認・追記できるようにする

### スキーマ

```sql
CREATE TABLE race_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  horse_number INTEGER,
  waku_number INTEGER,        -- 常にnull想定。PDFからは取得できないため手動入力用の列としてのみ保持
  horse_name TEXT,
  sex_age TEXT,                -- 性齢 例:"牡3"
  weight_carried REAL,         -- 負担重量 例:57.0
  jockey TEXT,                 -- 見習い減量記号を含む表記のまま保持
  status TEXT NOT NULL DEFAULT 'finished', -- finished/scratched(取消)/excluded(除外)/stopped(中止)
  finish_position INTEGER,     -- 着順(全馬)。取消・除外はNULL
  time_text TEXT,              -- タイム 例:"1:25.0"(生テキストのまま)
  margin TEXT,                 -- 着差 例:"クビ" "１ 1/4" "大差"(表記ゆれが大きいためTEXT)
  corner_positions TEXT,       -- 個別コーナー通過順位(生テキストのまま)
  final_furlong_time REAL,     -- 推定上り 例:37.2
  body_weight INTEGER,         -- 馬体重
  body_weight_change TEXT,     -- 増減 例:"+2" "-2" "初出走" "計不"(数値以外もあるためTEXT)
  win_popularity INTEGER,      -- 単勝人気
  incident_note TEXT,          -- 競走中の出来事(該当時に自動転記)。管理者が編集可
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(race_id, horse_number)
);

CREATE INDEX idx_race_results_race_id ON race_results(race_id);
CREATE INDEX idx_race_results_horse_name ON race_results(horse_name);
```

保持しないもの(意図的に対象外): 単勝オッズ(全馬分は結果PDFに存在しない。存在するのは
1着馬の払戻金額から逆算できる近似値のみで、正式なオッズ表示ではないため保存しない)、
本賞金・付加賞、調教師名。`race_results.waku_number`は`races.entries`側とは異なり自動計算
の対象外で、手動入力可能な列としてのみ保持する(PDFから取得できないため常に`null`のまま
運用する想定)。

### 更新ルール

- `results-import.js`から、複数レースをまとめて処理するバルク版`upsertRaceResultsBulk()`
  (`functions/api/_lib/race-results.js`)を使い、`race_id`+`horse_number`をキーに`UPSERT`する
- **`incident_note`は自動転記の対象になった場合でも、既存に管理者が手動で追記した内容が
  あれば無条件で上書きしない**。具体的には、既存の`incident_note`が空、または直前の
  自動転記内容と完全一致する場合のみ、新しい自動転記内容で上書きする(管理者が加筆した
  痕跡があれば上書きしない)
- `waku_number`はPDFから取得できないため、インポート処理は常に`null`を送信する
  (既存の手動入力値がある場合は上書きしない)
- レース削除時(`DELETE /api/races/:id`)は、`race_results`も`ON DELETE CASCADE`で
  連動して削除される

### 取消・除外・中止の扱い

| status | 意味 | finish_position | time_text等 | corner_positions | body_weight |
|---|---|---|---|---|---|
| `finished` | 通常の完走 | あり | あり | あり | あり |
| `scratched` | 取消(発走前・体重測定前) | NULL | NULL | NULL | NULL(測定前のため) |
| `excluded` | 除外(体重測定後) | NULL | NULL | NULL | あり(測定後のため) |
| `stopped` | 競走中止(発走後、レース中に競走を中止) | NULL | NULL | あり(中止までの通過分のみ・個数は可変) | あり(発走前に測定済みのため) |

`stopped`(中止)は、発走はしたがレース中に競走を中止した馬。取消・除外と異なり発走はしている
ため、単勝人気・馬体重(増減)は取得できるが、タイム・着差・推定上りは記録されない。コーナー
通過順位は「中止するまでに通過した分」のみが記録され、個数はレースにより異なる(実例では
2〜4個)。解析は`public/jra-result-pdf.js`の`jraResultParseStopRow()`が、着順ラベルに続く
トークン列から「末尾の整数=単勝人気」「その手前で(数字)+(括弧書きの増減)の並びを検出した
箇所=馬体重(増減)、その直後からのトークン=調教師名」「馬体重より手前の末尾側の連続した
整数トークン=コーナー通過順位、残りの先頭側トークン=騎手名」という構造でトークンを
後ろから順に切り出す方式で解析する(コーナー通過順位の個数が可変のため、固定長の正規表現
では対応できないための工夫)。

降着・失格など、上記以外の着順未確定ケースは今回対象外(`docs/BACKLOG.md`参照)。

### `races.entries`との役割分担

| | `races.entries` | `race_results` |
|---|---|---|
| 用途 | 購入・予想印・馬メモの対象データ(現行機能が依存) | 記録・将来の集計参照用 |
| 性齢・負担重量 | 出走馬一覧PDF時点の予定値 | レース結果PDF時点の確定値(正) |
| 馬体重 | 保持しない | 保持する |
| 着順 | 保持しない(`races.finish_order`が上位3着のみ別途保持) | 全馬の着順を保持する |
| 更新元 | 出走馬一覧PDF・結果PDFの両方 | 結果PDFのみ |

### 画面での参照(レース管理画面)

- `races.html`の払戻モーダル(`race-payout-modal`)内に「結果詳細」セクション
  (`race-results-detail-section`)があり、`GET /api/races/:id/results`で取得した
  全着順・タイム・着差・馬体重・単勝人気・出来事メモを表として表示する
  (`public/races.js`の`loadRaceResultsDetail()`)
- 着順・タイム等はPDFインポート経由でのみ更新される(この画面から編集はできない)。
  `incident_note`(競走中の出来事メモ)のみ、管理者がテキストエリアで編集し
  「出来事メモを保存」ボタンから`PUT /api/races/:id/results`(馬番ごとに個別送信)で
  保存できる
- `race_results`にデータが無いレース(結果PDF未取込)ではこのセクション自体が
  非表示になる

### 予想登録画面での過去成績参照(2026-09-10)

- `prediction.html`で各馬の行を開くと、馬メモの下に「過去成績(出走履歴)」表を表示する
- 取得は `GET /api/races/:id/horse-history`(`functions/api/races/[id]/horse-history.js`)。
  対象レースの`entries[].horse_name`(元の値と空白正規化値の両方)をキーに
  `race_results`を`races`とJOINして引き、**表示中のレース自身(`race_id`)を除外**し、
  `race_date`降順で全件返す
- 各行の頭数(`field_size`)は相関サブクエリで数えるが、**`status IN ('finished','stopped')`
  に限定して「実際に発走した頭数」を出す**。取消(`scratched`)・除外(`excluded`)は
  `race_results`に行が残るものの発走していないので数えない(単純な`COUNT(*)`だと
  取消・除外がいたレースで頭数が1〜数頭多く出てしまう)。中止(`stopped`)は発走済みなので
  数に含める
- バインド数は「出走頭数 × 2 + 1」で自然にバウンドされ、D1の1クエリ100パラメータ上限に
  収まる(過去レースIDの集合をINで渡す方式は使い込むと上限に抵触しうるため採らない)
- 全ユーザー共有データのため`requireAdmin`せず、ログインのみで閲覧可(`GET .../results`と同じ)
- `race_results.horse_name`は取込時に空白正規化されていないため、レスポンスの
  グルーピングキーはサーバー側で正規化した馬名にする。クライアントの`normalizeHorseName()`と
  同じ畳み込み(全角スペース等 → 半角1つ・trim)

