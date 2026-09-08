> `docs/DESIGN.md` から機能単位で分割したファイル。現状の仕様のみ記載。
> 「〜」参照 は `docs/design/` 内の見出し名(`grep -rn "見出し" docs/design/` で辿れる)。
> 過去の経緯・完了履歴は `archive/documents/BACKLOG_HISTORY.md`。

# CSS / JS のキャッシュ対策

`public/_headers`(Cloudflare Pages のレスポンスヘッダー設定ファイル)で、`/*.css` と
`/*.js` に `Cache-Control: no-cache` を付与する。これはブラウザにキャッシュ自体はさせるが、
**使う前に必ずサーバーへ再検証させる**指定で、変更が無ければ 304(数百バイト)が即返るため
実質コストは小さく、`style.css` や各 `*.js` を変更・デプロイしたら次回読み込みで確実に反映される。

HTML からは `<link rel="stylesheet" href="style.css">` / `<script src="xxx.js">` の形で
**クエリパラメータを付けずに**参照する。CSSやJSを変更しても HTML 側の編集は不要。

> 2026-09-08 以前は全 HTML で `style.css?v=YYYYMMDDHHmm`(実際には `v=1`, `v=2`, ... の
> 連番)という手動キャッシュバスティングを行っていたが、更新漏れで反映されない事故が
> 起きやすいため `_headers` 方式へ移行し、全 HTML から `?v=` を除去した。`?v=` は復活させない。

## DBマイグレーションの運用(node不要・wranglerコマンドのみで手動運用)

`migration.sql`には**まだ本番へ適用していないスキーマ変更のみ**を、`-- @STEP: 名前`
ブロックとして末尾に追記していく。各ブロックが適用済みかどうかは、DB自身に作成される
`schema_migrations`テーブルに記録する(名前をキーに1行1件)。

適用手順(手動・wranglerのみ):

1. `migration.sql`に新しい`-- @STEP: 名前`ブロックを追記する
2. そのブロックのSQLだけを一時ファイルにコピーし、まず`--local`で試してから`--remote`
   (本番)に適用する
3. 成功したら`schema_migrations`に`INSERT INTO schema_migrations (name) VALUES
   ('ステップ名');`で記録する
4. `migration.sql`から該当ブロックを削除し、内容を`schema.sql`へ反映する(新規DBでも最初から
   最新構造になるように)。これにより`migration.sql`は常に「これから適用すべき差分だけ」を
   保持する軽量な状態を保つ

DROP/RENAMEを伴う破壊的な変更は極力避け、`ALTER TABLE ADD COLUMN`や`CREATE TABLE/INDEX
IF NOT EXISTS`など、途中で失敗しても安全な内容にすること。途中で失敗した場合は
`PRAGMA table_info`等で実際にどこまで反映されているかを確認してから、schema_migrationsへの
記録や残りのSQLを個別に対応する。`DROP`/`RENAME`を伴う変更は再実行すると
データを壊す恐れがあるため、特に慎重に確認すること。

**「本番は既に運用中でユーザーの実データが入っている」という前提に基づく破壊的変更回避
ルール**: `DROP TABLE`・`DELETE`・既存データを上書きする`UPDATE`など、データやテーブルを
削除・巻き戻す可能性のある変更は極力行わない。追加的な変更(`ALTER TABLE ADD COLUMN`、
`CREATE TABLE/INDEX IF NOT EXISTS`)を基本とし、どうしても削除的な変更が必要な場合は、
影響範囲を明示した上で作業前に必ずユーザーの承認を得ること。なお、出走馬一覧PDFインポート
機能の`horse_number`のnullable化は、`entries`がスキーマレスなJSON列であるため、
そもそもこのマイグレーション手順の対象外(DDL変更不要)である。

更新後に再デプロイします。

```bash
npx wrangler pages deploy public --project-name=keiba-yosou-app
```

> 注意: `migration.sql` は既存DBを最新版へ更新するためのものです。新規DBは `schema.sql` を使用してください。
> 既存DBに複数ユーザー対応のマイグレーションを適用した場合は、管理者アカウント作成後に
> `archive/migrations/assign_existing_data_to_admin.sql` を1回実行して、既存データを管理者アカウントに割り当ててください
> (README「複数ユーザー対応について」参照)。

## DBファイルの役割

- `schema.sql`: 新規DBを最新版で構築するための最終スキーマ。新規構築時に1回実行する
- `migration.sql`: 既存DBを最新版へ更新するための統合マイグレーション。**未適用の`-- @STEP`
  ブロックのみ**を保持する(適用済みの内容は`schema.sql`に反映し、ファイルからは削除する)
- `archive/migrations/`: 過去の番号付きmigration・過去の`migration.sql`(旧`latest1.sql`)の
  アーカイブ・単発マイグレーションファイルの履歴保管場所。通常のセットアップ・更新では使用しない
- `archive/scripts/migrate.js`: 以前使用していた自動適用ラッパー(廃止済み・履歴保管のみ。
  旧ファイル名`latest1.sql`を参照するコードのまま保管している)

新しいスキーマ変更を行う場合は、`schema.sql`と`migration.sql`の両方を更新し、このファイル
(`docs/design/ops.md`)の該当箇所も合わせて更新してください。
