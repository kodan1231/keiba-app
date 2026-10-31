# アプリの入口の分離(予想・擬似購入用 / データ検索用 / 管理者用)

2026-10-14 ユーザー要望・仕様確認済み。同じリポジトリ・同じ D1(keiba-yosou-db)を、3つの Cloudflare Pages プロジェクト(URL)で公開し、
どのURLで来たかで、見せる画面・使えるAPI・ログインの扱いを分ける(権限の分離)。

| アプリ | URL(Pages プロジェクト) | 画面 | ログイン |
|---|---|---|---|
| 予想・擬似購入用(main) | https://keiba-yosou-app.pages.dev(以前からのもの) | 馬券購入・履歴・集計・予想登録 | 要(一般ユーザー・管理者) |
| データ検索用(search) | https://keiba-search.pages.dev | 今週のレース(以前のゲスト画面 `guest.html`)・データ検索 | 不要。全員ゲスト |
| 管理者用(admin) | https://keiba-admin.pages.dev | 管理画面・レース管理(取り込み) | 要(管理者だけ) |

## しくみ

- 判定は `functions/api/_lib/app-role.js` の `appRoleOf`(ホスト名。プレビューの `<hash>.keiba-search.pages.dev` も含む。
  環境変数 `APP_ROLE` があればそれ)。手元(localhost 等)は `all` で、分けない(以前と同じ動き)。画面側は `public/utils.js` の
  `currentAppRole` `appUrl`(同じURLの表 `APP_URLS`)。
- 3つのプロジェクトは同じファイルを公開する(GitHub の同じリポジトリ・ルート・出力 `public`。組み立てのコマンドなし)。
  ファイルは3つとも存在するが、画面・APIへのリクエストは必ず `functions/_middleware.js` を通り、そこで振り分ける。
  アプリごとに含めるファイルを組み立てる方式は、Pages の組み立て(Functions のフォルダの扱い)に不確かな点があり、
  今の画面を止める危険があるため採らなかった。
- **画面**(`pageRedirect`): 他のアプリの画面を開いたら、そのアプリの同じ画面へ移す(302。`?` 以降も渡す)。
  `/` はアプリの最初の画面(search は `/guest`、admin は `/admin`、main は `index.html`)。以前のゲスト用URL `/g/<合言葉>` は
  search の `/guest` へ(受け口の `functions/g/[key].js` は2026-10-15に削除。手元の all では `/guest` を開くとゲストの Cookie を渡す)。
- **API**:
  - main: `/api/admin/*`・`/api/cron/*`・取り込み(`entries-import` `results-import`)・レースの編集(`POST /api/races`、
    `PUT/DELETE /api/races/:id`、`PUT /api/races/:id/results`)・データ検索(予想登録画面が使う `race-factors` `jockey-course`、馬券購入画面の目印の `race-signals` `race-signal`〈2026-11-01〉を除く)は 404
    (`blockedOnMain`)。ゲストの Cookie は見ない
  - search: ログインの Cookie・トークンは見ず、全員ゲスト(`searchApi`。使えるのは `_lib/guest.js` の `GUEST_API_RULES` だけ。
    レース単位のAPIは期間内の中央のレースだけ)。ログイン・新規登録・夜間計算は 404
  - admin: ログイン・ログアウト以外は管理者だけ(管理者でないログインは 403 `admin_only`。画面は「管理者のアカウントで
    ログインしてください」と出してログアウトする。`public/auth.js`)。新規登録は 404(ログイン画面の新規登録のボタンも出さない)。
    夜間計算の受け口(`/api/cron/pace-step`)は admin だけ
- **アカウント**: main と admin で同じ(同じ users 表)。URL が違うのでログインはアプリごと。管理者の判定は今までどおり ADMIN_USERNAMES。
  search はドメインが別なのでログインの Cookie が届かず、管理者が開いても未ログインの人と同じ見え方。
- **データ検索用の入り方**(`docs/design/guest.md`): 合言葉は廃止。管理画面「ゲスト閲覧」で公開している間は、URL を知っていれば誰でも見られる。
  画面を開いたときにゲストの Cookie(kbg。端末ID)が無ければ渡す(DB には書かない。端末の行は API を使ったときに作る)。
  端末ごとの履歴・ブロック、IP のブロックは今までどおり。公開を止めると「現在、公開を停止しています」。
  検索エンジンには載せない(`robots.txt` で全部 Disallow、`X-Robots-Tag: noindex`)。
- **ナビ**(`public/shell.js`): アプリごとに出す項目を変え、他のアプリの画面は `appUrl` でそのアプリの URL へのリンクにする。
  main: 馬券購入・履歴・集計・データ検索(→search)・レース管理/管理(管理者だけ。→admin)。search: 今週のレース・データ検索・馬券帳へ(→main。2026-10-15 追加。データ検索から戻れなかったため。**馬券帳の画面から移ってきたときだけ出す**: search は別URLで
  馬券帳のログイン状態を見られないため、移ってきたときの referrer が main なら sessionStorage〈kb_from_main〉に印を付け、そのタブの間だけ出す。
  馬券帳はログインしないと開けないので、実質ログイン中の人だけ。直接・ブックマークから開いたゲストには出さない。`public/shell.js` の `cameFromMain`)。
  admin: レース管理・管理・馬券帳へ(→main)。画面の中のリンク(購入履歴の「払戻を編集」→admin、馬券購入・予想登録の
  「過去のデータ」→search 等)も `appUrl`。
- **外から呼ぶもの**: JRA結果のユーザースクリプト(`public/jra-result-importer.user.js`。1.1.0)と夜間計算の Worker
  (`workers/pace-cron`)の送り先を admin にした(2026-10-18: Worker は削除し、夜間の計算は GitHub Actions〈`.github/workflows/pace-nightly.yml`〉から admin を呼ぶ)。ユーザースクリプトは admin の管理画面のリンクから入れ直す。
  netkeiba・JRA のブックマークレットは管理画面のある URL(admin)を使うので、admin の管理画面からブックマークを登録し直す。

## 公開の設定(Cloudflare)

- 新しい2つの Pages プロジェクト(keiba-search・keiba-admin)は、管理画面で GitHub のこのリポジトリにつなぐ
  (本番のブランチ main、組み立てのコマンドなし、出力のフォルダ `public`、ルートのフォルダはそのまま)。
- D1 のつなぎ(`DB` → keiba-yosou-db)はリポジトリの `wrangler.toml` で3つとも同じ。
- 秘密情報(`wrangler pages secret put --project-name <名前>`): 3つとも `APP_PASSWORD`(ログイン・ゲストの Cookie の署名。
  アプリごとに別の値にしてよい。search はゲストの Cookie の署名だけに使う)。main・admin は `ADMIN_USERNAMES`。
  admin は `PACE_CRON_SECRET`(夜間計算)・`CF_ANALYTICS_TOKEN`(D1 の使用量)。
- D1 の使用量・無料枠は分ける前と同じ(アカウントで共通)。
