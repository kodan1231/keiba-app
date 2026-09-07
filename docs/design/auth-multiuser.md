> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# 認証・複数ユーザー対応

- 個別ログイン: ログイン画面の「新規ユーザー登録」から、誰でもユーザー名+パスワードで
  アカウントを自己登録できる(招待コード等の承認フローは無い)
- 管理者判定: DBにフラグを持たせず、Cloudflare Pagesの環境変数`ADMIN_USERNAMES`
  (カンマ区切りのユーザー名リスト)に含まれるユーザー名でログインした人だけを管理者として
  扱う。`functions/api/_lib/auth.js`の`isAdminUsername()`で判定し、`functions/_middleware.js`が
  リクエストごとに`context.data.isAdmin`へセットする
- セッション: Cookieのペイロードに`user_id`・`username`・有効期限を含め、`env.APP_PASSWORD`を
  HMAC署名鍵として利用する(ログイン用パスワードとしては使わないが、署名鍵としては流用する)
- **最終ログイン日時(`users.last_login_at`。2026-08-30〜)**: ログイン成功のたびに
  `functions/api/auth/login.js`が`UPDATE users SET last_login_at = datetime('now')`で
  更新する。新規登録(`functions/api/auth/register.js`)は成功と同時にログイン状態になる
  ため、登録日時をそのまま初期値としてセットする(新規登録直後のユーザーが「未ログイン」
  表示にならないようにするため)。この更新に失敗してもログイン処理自体は失敗させない
  (致命的でない付随処理として扱う)。管理画面(`admin.html`)の登録ユーザー一覧に
  「最終ログイン日時(JST)」列として表示する(`functions/api/admin/users.js`が返し、
  `public/admin.js`が`created_at`と同じ方式でJSTに変換して表示する)
- データの所有者(user_id)を持つテーブル: `tickets`・`imported_tickets`・
  `imported_ticket_groups`・`prediction_notes`・`prediction_marks`・`horse_notes`。
  いずれも全APIハンドラで`WHERE user_id = ?`のフィルタ、新規作成時の`user_id`セットを
  行っており、他ユーザーのデータは常に「存在しない(404)」として扱う
  (`imported_ticket_items`自体はuser_idを持たず、`imported_ticket_groups`とのJOIN経由で
  所有者を判定する)
- `races`(レース情報)・`race_results`は全ユーザー共有のデータであり、user_idを持たない。
  登録・編集・削除は管理者のみが行える(`functions/api/races/*`で`requireAdmin()`により
  ガードしている)。**共有データ(`races`/`race_results`)と`tickets`(ユーザーごとに分離)が
  またがる処理を書く際は、「管理者が見えている・操作できているデータ」と「実際に更新すべき
  対象データ」が一致するとは限らない点に注意すること**(下記「払戻確定時のticket反映」参照)
- CSVインポート時のレース自動作成は行わない。レースが未登録のまま取り込まれたデータ
  (`imported_ticket_groups.race_id IS NULL`)は、管理画面(`admin.html`)の「未登録レース一覧」
  から確認でき、管理者がそのレースを登録すると`linkUnregisteredImportsToRace()`により
  自動的に紐付く。**この「未登録レース一覧」(`GET /api/admin/unregistered-races`)は
  `imported_ticket_groups`を`user_id`で絞り込まず全ユーザー分を対象に集計しており、
  管理者自身のCSV取込データに限定されていない(通常購入`tickets`は購入フロー上、
  未登録レースへの購入自体が発生しないため対象外)**
- 既存データ(個別ログイン導入前のデータ)の扱い: DBマイグレーション直後はuser_idがNULLの
  ままなので、管理者アカウント作成後に`assign_existing_data_to_admin.sql`を1回実行して
  管理者アカウントへ一括で割り当てる運用とする(README参照)。「所有者を変更」する機能は
  用意していない

