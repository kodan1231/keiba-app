// 複数のAPIエンドポイントで共有するヘルパー関数の入口ファイル。
// ファイル名を "_" で始めているため、Cloudflare Pages Functions では
// このファイル自体はルートとして扱われない(_middleware.js と同じ扱い)。
//
// 2026-09-01リファクタリング: 以前はこのファイル1つに全ヘルパー(認証・出走馬マージ・
// 騎手名エイリアス・払戻再計算・race_results UPSERT)が集約されており、1000行超に
// なっていた。修正のたびにファイル全体を貼り付け・再生成する必要がありトークン消費が
// 大きかったため、機能単位で functions/api/_lib/ 配下へ分割した。
// このファイルは分割後の各モジュールを re-export するだけの薄い窓口として残しており、
// 既存の `import { X } from "../_shared.js"`(または "./_shared.js" 等の相対パス違い)は
// 一切変更せずそのまま動作する。
//
// 新しい関数を追加する場合は、内容に応じて以下のいずれかのファイルに追記し、
// 単体で完結しない横断的なヘルパーの場合のみ新しい _lib/*.js ファイルを追加して
// ここに re-export 行を足すこと。

export * from "./_lib/auth.js";
export * from "./_lib/entries-merge.js";
export * from "./_lib/jockey-alias.js";
export * from "./_lib/ticket-payout.js";
export * from "./_lib/race-results.js";
