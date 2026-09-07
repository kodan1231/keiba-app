# セットアップ(テスト観点)

> `docs/TESTING.md` から機能単位で分割したテスト観点。
> 過去の日付単位の追記履歴は `archive/documents/pre-fix-v1.0/TESTING.md`。

## 0. セットアップ

新規ローカルDBの場合:

```bash
npx wrangler d1 execute keiba-yosou-db --local --file=./schema.sql
```

既存ローカルDBを最新版へ更新する場合(`migration.sql`に未適用の`-- @STEP`ブロックが
残っている場合のみ。無ければ`schema.sql`実行時点で最新):

```bash
npx wrangler d1 execute keiba-yosou-db --local --file=./migration.sql
```

(未適用ブロックがある場合、実行後に該当ブロック名を`schema_migrations`へ`INSERT`する。
詳細は`docs/design/ops.md`「DBマイグレーションの運用」参照)

**前提**: `migration.sql`の`-- @STEP: users_last_login`ブロックを事前に適用しておくこと
(`users.last_login_at`列が存在しない状態だと、管理画面の登録ユーザー一覧APIが
失敗する)。

```bash
npx wrangler d1 execute keiba-yosou-db --local --file=migration.sql
```

ローカル起動:

```bash
npx wrangler pages dev public
```

