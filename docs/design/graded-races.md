> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# 重賞マスタ・レース分類(重賞/条件戦/その他)

集計画面(`stats.html`)の「総合成績」「レース別」タブで、購入したレースを
「すべて／重賞のみ／条件戦のみ」で絞り込むための機能(2026-09-19追加)。

## 分類ロジック(`functions/api/_lib/race-classification.js`)

各レースを次の優先順位で3分類する。

1. **条件戦**: `races.class_flags` に「新馬」「未勝利」「1勝クラス」のいずれかを
   含む(`isConditionRace()`)。メイクデビュー系のレース(`races.race_name`が
   「メイクデビュー◯◯」)も`class_flags`は「新馬」表記になるため自動的に含まれる。
   2勝クラス以上・オープン(特別・重賞含む)は対象外。
2. **重賞**: 条件戦に該当しないレースについて、`races.race_name` を
   `graded_races` マスタと突き合わせて判定する(`classifyRace()`)。
3. **その他**: 上記いずれにも該当しない(無名の2勝クラス以上、特別戦、
   `graded_races`に未登録の重賞、レース情報が無いレガシー取込等)。
   「すべて」にのみ表示され、「重賞のみ」「条件戦のみ」には出てこない。

## 重賞マスタ(`graded_races`)

```sql
CREATE TABLE graded_races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,              -- 表示用のレース名(重賞一覧ページの表記。例: "紫苑S")
  name_key TEXT NOT NULL UNIQUE,   -- 突き合わせキー(gradedRaceNameKey()で計算)
  grade TEXT NOT NULL,             -- "G1" / "G2" / "G3"
  is_jump INTEGER NOT NULL DEFAULT 0, -- 障害重賞(「J・G」表記)かどうか
  track TEXT,                      -- 参考情報(任意)
  course_type TEXT,                -- 参考情報(任意)
  distance INTEGER,                -- 参考情報(任意)
  age_condition TEXT,              -- 参考情報(任意)
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'jra_import'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

`track`/`course_type`/`distance`/`age_condition` は分類ロジックでは使わない参考情報
(管理画面での確認用)。分類に使うのは `name_key` と `grade`/`is_jump` のみ。

## 突き合わせキー(`gradedRaceNameKey()`)

JRA公式サイト「N年 重賞レース一覧」ページのレース名表記と、結果・出走馬PDFから
保存される `races.race_name` の表記は、次の2点で系統的に異なる。

- **回次表記の有無**: 重賞一覧ページは「紫苑S」「中山記念」のように回次(第N回)を
  含まないが、結果・出走馬PDFは「第11回紫苑ステークス」「第100回中山記念」のように
  回次込みで保存される。
- **略記の有無**: 重賞一覧ページは「ステークス→S」「カップ→C」「トロフィー→T」を
  略記するが、結果・出走馬PDFは正式表記(「ステークス」「カップ」「トロフィー」)の
  ままになる。

そのため、次の正規化を両方の文字列に適用してから比較する(`graded_races`への
登録時に`name`から計算して`name_key`へ保存し、分類時は`races.race_name`に対して
その場で計算する)。

1. NFKC正規化 + 全角/半角スペース除去
2. 先頭の「第N回」を除去
3. 先頭に誤って混入したグレードバッジ表記(「GⅠ」「J・GⅢ」等)を除去
   (2026-09-19以前にインポートされた一部の`race_name`に、結果PDF解析のズレで
   グレードバッジが誤って先頭に付いたまま保存されているケースがあるための防御。
   `docs/design/results-import.md`「単勝人気(重賞・特別戦のみの追加項目に注意)」
   参照。NFKC正規化でローマ数字Ⅰ/Ⅱ/Ⅲが`I`/`II`/`III`へ分解された後の形も許容する)
4. 末尾の「ステークス」「カップ」「トロフィー」をそれぞれ「S」「C」「T」に統一する

この正規化だけで自動一致しない表記ゆれ(改称・新設等)は、管理画面「重賞管理」から
そのレースの実際の`races.race_name`表記のまま追加登録すれば、以後は個別に一致する
(`horse_aliases`等と同じ「自動一致を基本にしつつ、外れたものは手動登録で拾う」方針。
厳密な一意名寄せの仕組みは持たない)。

## 管理画面「重賞管理」(`admin.html`)

- 一覧表示・手入力での追加/編集/削除(`GET/POST /api/admin/graded-races`、
  `PUT/DELETE /api/admin/graded-races/:id`)
- JRA公式「N年 重賞レース一覧」ページ(PDF)からの一括インポート
  (`public/jra-graded-races-pdf.js`でクライアント側解析 →
  `POST /api/admin/graded-races/import`で`name_key`一致ならUPDATE、
  無ければINSERT。グレードは年度によって変わりうる〈昇格・降格〉ため、
  再インポートのたびに上書きする方針)

### JRA重賞一覧PDFの解析(実機未検証)

**このPDFパーサーは実ブラウザのPDF.js抽出結果での検証が済んでいない
(`docs/design/results-import.md`の各パーサーと同じ注記)。** 特に次の前提が
崩れた場合の事故を警戒した設計にしている。

- ページの構造(視覚上の表): 月日 / レース名 / 競馬場 / 性齢 / コース / 優勝馬 /
  騎手 / 結果(グレードバッジ+「レース結果」ボタン) / 過去成績。ユーザー提供の
  PDFでは、グレードバッジ+ボタン列(「結果」列)の内容が各レース行のテキストとは
  別に、ページ末尾側へレース行と同じ並び順でまとめて抽出される(表内レース行が
  すべて先に並び、その後にグレード表記が続く)。そのため「レース行を先頭から
  抽出」「グレード表記を別途抽出」した上で、**出現順**に1件ずつ対応付ける方式を
  取っている(Y座標等の位置情報には依存しない)
- ページ1のみ表ヘッダー(「...過去成績」)の前に「GⅠレース」等のタブ見出しが
  あり、これを誤ってグレード表記として拾わないよう、ヘッダーが見つかれば
  それより後ろだけを対象にする
- **レース行数とグレード表記の数が一致しない場合、レコードを1件も返さず
  エラーとして報告する**(位置ズレのまま誤った組み合わせで登録する事故を防ぐため。
  2026-09-19に発覚した単勝人気誤取得〈`docs/design/results-import.md`参照〉と
  同種の「見た目とPDF.js抽出結果の位置ズレ」を警戒した設計)
- 優勝馬・騎手名は解析しない(重賞マスタの用途〈レース名・グレードの分類〉には
  不要なため、解析対象を絞ってパーサーの複雑さ・誤爆リスクを下げている)

## 集計画面(`stats.html`)側の実装

- `GET /api/tickets`・`GET /api/ticket-imports` のレスポンス各行に
  `race_category`("graded"/"condition"/"other")を付与する
  (`loadGradedRaceMap()`で`graded_races`を1回読み、`classifyRace()`で判定)。
  `race_id`が無いレガシー取込は`"other"`固定
- `public/stats.js`: 「総合成績」「レース別」タブそれぞれに独立した
  「すべて/重賞のみ/条件戦のみ」フィルタ(`categoryFilterState`)を持つ。
  全購入データ(`allTickets`)はフィルタ切替のたびに再フェッチせず、
  クライアント側で`filterByCategory()`し再描画するだけ
- 「コース別」「騎手別」タブにはこのフィルタは無い(全期間・全レース区分の集計の
  まま。要望があれば同じ`race_category`を使って追加できる)
