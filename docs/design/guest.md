# ゲスト閲覧(2026-10-14追加)

ログインしていない人(ゲスト)に、**次の開催週末の中央のレースの出走馬情報**と**データ検索**だけを見せる機能。
予想登録・馬券購入・集計は使えない(ユーザー要望。ゲストは「本人の予想の参考」に使う想定)。仕様はユーザー確認済み。

## 入り方

- **2026-10-14 変更(`docs/design/app-split.md`)**: ゲスト閲覧はデータ検索用アプリ(https://keiba-search.pages.dev)になった。
  **合言葉は廃止**し、公開している間は URL を知っていれば誰でも見られる(画面を開いたときにゲストの Cookie を渡す。
  `functions/_middleware.js` の `searchPage`)。以前の `/g/<合言葉>` はどのアプリでも `https://keiba-search.pages.dev/guest` へ移す。
  管理画面「ゲスト閲覧」には合言葉付きURLの代わりにデータ検索用アプリのURLを出し、「URLを作り直す」は外した(止めたい端末はブロック)。
  以下の合言葉の説明は経緯(手元の開発環境〈all〉では今も `/g/<合言葉>` で入れる)。
- **2026-10-15 変更(ユーザー承認)**: 合言葉の仕組みを削除した。`functions/g/[key].js`・管理APIの合言葉の作り直し
  (`POST /api/admin/guest { action: "regenerate" }`)と GET の `path`・設定の `key` をなくし、設定は `{ enabled, version }` だけ
  (本番に残っている `key` は読まず、次に公開を切り替えたときに消える)。ゲストの Cookie は `functions/_middleware.js` の
  `issueGuestCookie` が渡す: search では画面を開いたとき、**手元の開発環境(all)では `/guest` を開いたときだけ**
  (ログインしている人はセッションが優先されるので変わらない)。端末の行は最初に API を使ったときに `recordGuestAccess` が作る。
  本番の `/g/...` は引き続き `_lib/app-role.js` の `pageRedirect` が search の `/guest` へ移す。端末・IPのブロックとアクセス履歴はそのまま。
  以下の `/g/<合言葉>`・URLの作り直し・`key` の説明は経緯。

- 管理画面「ユーザー」タブの「ゲスト閲覧」(2026-10-14 当初は「ゲスト」タブ。ユーザー管理と同じ意味合いのためユーザータブへ移した)で公開すると、ゲスト用URL `/g/<合言葉>` が出る(合言葉は推測できないランダムな文字列)。
  URLを知っていれば誰でも見られる(ログイン不要)。
- `/g/<合言葉>`(`functions/g/[key].js`)は、合言葉が今の設定と一致すれば、端末ID入りの署名つきCookie `kbg`
  (HttpOnly・1年。署名は `APP_PASSWORD` の HMAC。中身は端末ID・合言葉の版)を渡し、ゲスト用のレース一覧 `/guest` へ移る。
  既に `kbg` を持っていれば端末IDはそのまま(URLを作り直した後に入り直しても同じ端末として扱う)。
- **URLを作り直す**と合言葉と版が変わり、古いURLも、古いURLから入った端末の Cookie も使えなくなる(新しいURLから入り直せば使える)。
- 公開を止めると、ゲストは全員使えなくなる。
- Cookie 名は `...session` にしない(`_lib/auth.js` の `verifySessionToken` が `/session=/` で探すため)。

## ニックネーム(2026-10-16追加。ユーザー要望・仕様確認済み)

- 初めて開いたときに**ニックネームの登録画面**を出す(`public/auth.js` の `showGuestNicknameForm`)。名前だけ・**1〜10文字**・パスワードなし。
  前後の空白は取り、制御文字は不可。**重複は断る**(全角半角・大文字小文字・空白の違いは同じとみなす。409 `nickname_taken`)。
- 登録は `POST /api/guest/nickname`(`functions/api/guest/nickname.js`)。端末の行(`guest_devices`)に名前とキー(`nickname_key`。UNIQUE)を書き、
  名前入りの Cookie `kbg`(`n`)を渡す。2回目以降は Cookie の名前を使い、**API のたびに D1 を読まない**。
- 名前が無いうちは `/api/auth/check`(`need_nickname: true` を返す)と登録以外は 403 `guest_need_name`。**端末の行は登録のときに作る**
  (アクセスの記録 `recordGuestAccess` は名前のある端末だけ)ので、名前を登録しないボット等は一覧に並ばない。
- Cookie が消えた・別のブラウザ(iPhone の Safari と Chrome、ホーム画面のアプリ、プライベートブラウズ等は Cookie が別)では、また登録画面が出る。
  同じ人が別の名前で登録しうる(許容。ユーザー判断)。設定の版を作り直しても名前は引き継ぐ(`issueGuestCookie`)。
- 管理画面「ゲスト閲覧」の端末の一覧に「名前」の列。**既定では名前のある端末だけ**(`GET /api/admin/guest?all=1` で名前なしも。
  画面の「名前なしも表示」)。名前の無い端末の数(`unnamed_count`)も出す。ブロック中の行は名前が無くても効く。
- 背景(2026-10-16 の本番): 端末の一覧26件のうち、管理者のものが7件(アプリ分離で Cookie の署名の秘密情報が変わり作り直し+iPhone のブラウザ違い)、
  残り19件はデータセンターの IP からの1回だけのアクセス(ボット・クローラー)だった。
- `@STEP: guest_nickname`(列 `nickname`・`nickname_key`、UNIQUE インデックス)。アプリの振り分けは `/api/guest/` を main で 404(`_lib/app-role.js`)。

## サーバー側の制限(`functions/api/_lib/guest.js` の `resolveGuest`。`functions/_middleware.js` から)

- `/api/*` で**ログインのセッションが無く**、`kbg` があるときだけゲストとして扱う(ログインしている人はセッションを優先)。
  `context.data.isGuest = true`(`userId` は null)。
- 使えるのは **GET の次のAPIだけ**(`GUEST_API_RULES`)。それ以外は 403 `guest_forbidden`(書き込みはすべて不可):
  - `/api/auth/check`(`is_guest: true` を返す)
  - `/api/races?index=1`(`races/index.js` が期間内の中央のレースだけに絞る)
    - 2026-10-14: ゲスト画面からの取得は `&guest=1` を付け(`public/utils.js` の `fetchRaceIndex({ guestView })`)、ログイン中に開いても同じに絞る
      (管理者がゲスト画面を確認したとき、ログインが優先されて全レースが並んでいた。ログインを強制的に外す案は取りやめ)
  - `/api/races/:id`、`/api/races/:id/horse-history`、`/api/races/:id/horse-best`
  - `/api/data-search/*`(`race-factors`・`jockey-course` は `race_id` のレース)
  - `/api/pace-weights`(比率の読み取り。計算し直し `recompute` は不可)
- レースを指定するAPIは、そのレースが**期間内の中央のレース**でなければ 403 `guest_out_of_range`(races を主キーで1行読む)。
- 期間(`guestRaceWindow`): 日本時間の**今日〜次の月曜**(月曜は祝日開催のため。今日が月曜なら翌週の月曜まで)。
  中央 = 札幌・函館・福島・新潟・東京・中山・中京・京都・阪神・小倉。例: 10/14(水)なら 10/14〜10/19 のうち登録済みの中央のレース
  (実際は 10/17・10/18)。
- 公開停止・版違い → 401 `guest_invalid`、ブロック → 403 `guest_blocked`(画面は案内文を出す)。
- 使用量が多い日の自動一時停止(`_lib/service-guard.js`)はゲストのデータ検索にもそのまま効く。

## アクセス履歴とブロック

- 表 `guest_devices`(端末ID・初回/最終アクセス・最後のIP〈CF-Connecting-IP〉・ブラウザ・おおよそのアクセス回数・ブロック・メモ)、
  `guest_ip_blocks`(ブロックしたIP)。@STEP: guest_access。
- 記録は `recordGuestAccess`: 1端末につき**10分に1回まで**書く(その間の回数をまとめて足す。同じ実行環境ごと)。
  端末の行は `/g/<合言葉>` を開いたときに作る。書き込みの目安: ゲスト20人が1日12時間使って約1,500行/日。
- 設定(app_settings key='guest': `{ enabled, key, version }`)とブロックの一覧は同じ実行環境で**1分使い回す**
  (ブロック・解除・URLの作り直しの反映は最大1分遅れる)。ブロックの一覧の読み取りは `guest_devices WHERE blocked = 1`
  (端末の数だけの小さな表)と `guest_ip_blocks`。
- 管理画面「ユーザー」タブの「ゲスト閲覧」(`/api/admin/guest`): 公開の切り替え・URLの表示/コピー/作り直し・今見られる期間・
  端末の一覧(最終アクセスの新しい順に200件。回数・IP・ブラウザ・初回・メモ)・端末のブロック/解除・その端末のIPをブロック・
  IPを入力してブロック・ブロックしたIPの解除。Cookie を消されて端末IDが変わっても、IPのブロックで止められる。

## 画面

- `guest.html`(`body data-page="guest"`): 予想登録画面と同じ部品(`prediction.js`)を `GUEST_VIEW` で閲覧専用にして使う。
  - レース未指定: 期間内のレース一覧(`guest.js`。日付 → 競馬場 → R。R・レース名・コース・発走・頭数)。
  - `?race=ID`: 出馬表・馬柱(近5走)・展開・時計(総合推奨馬を含む)。予想印・馬メモ・重賞メモ・勝負レース・投票ボタン・
    購入馬券は出さず、それらの取得もしない。ヘッダーの右に「一覧へ」。
- `data-search.html`: そのまま使える。重賞検索の重賞メモは出さない。
- ナビ(`shell.js`): ゲストには「今週のレース」「データ検索」だけ(`data-guest-ok`)。かご・退場・ユーザー名も隠す(`body.guest-mode`)。
  ゲストがそれ以外の画面を開くと `guest.html` へ移る(`auth.js` の `GUEST_PAGES`)。
- 普段のユーザー・管理者がゲスト用URLを開いても、ログイン中はセッションが優先される(ゲストにはならない)。

## 注意

- 取り込んだデータには netkeiba・JRA公式のページ由来のものが含まれる。ゲストに見せる(第三者に提供する)前に、各サイトの利用規約を
  確認すること(ユーザーに説明済み)。
