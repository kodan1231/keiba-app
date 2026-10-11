import { readJsonBody, parsePositiveIntId, jsonError } from "../_shared.js";

// 重賞メモ(2026-10-12追加): 重賞1つ×年ごとのメモ。ログインユーザー自身の分だけを読み書きする。
// 予想登録画面(重賞のレースのとき)とデータ検索「重賞検索」タブから使う。
// 仕様は docs/design/graded-race-search.md「重賞メモ」。
//
// D1の読み取り: GET は UNIQUE(user_id, graded_race_id, year) のインデックスで
// その重賞の自分のメモ(1年1件。多くて十数行)だけを読む。POST は graded_races を主キーで1行
// 読んでから1行を書く(または消す)。

const MAX_MEMO_LENGTH = 5000;
const MIN_YEAR = 1980;
const MAX_YEAR = 2100;

export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const { id: gradedRaceId, error } = parsePositiveIntId(url.searchParams.get("graded_race_id"), "graded_race_id");
  if (error) return error;

  const { results } = await env.DB.prepare(
    "SELECT year, memo, updated_at FROM graded_race_notes WHERE user_id = ? AND graded_race_id = ? ORDER BY year DESC"
  ).bind(userId, gradedRaceId).all();
  return Response.json({ graded_race_id: gradedRaceId, notes: results || [] });
}

// { graded_race_id, year, memo }。memo が空なら、その年のメモを削除する。
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const { id: gradedRaceId, error: idError } = parsePositiveIntId(data?.graded_race_id, "graded_race_id");
  if (idError) return idError;
  const year = Number(data?.year);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return jsonError("年が不正です", 400);
  const memo = typeof data?.memo === "string" ? data.memo.trim() : "";
  if (memo.length > MAX_MEMO_LENGTH) return jsonError(`メモは${MAX_MEMO_LENGTH}文字以内です`, 400);

  const graded = await env.DB.prepare("SELECT id FROM graded_races WHERE id = ?").bind(gradedRaceId).first();
  if (!graded) return jsonError("重賞が見つかりません", 404);

  const now = new Date().toISOString();
  if (!memo) {
    await env.DB.prepare(
      "DELETE FROM graded_race_notes WHERE user_id = ? AND graded_race_id = ? AND year = ?"
    ).bind(userId, gradedRaceId, year).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO graded_race_notes (user_id, graded_race_id, year, memo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, graded_race_id, year) DO UPDATE SET memo = excluded.memo, updated_at = excluded.updated_at`
    ).bind(userId, gradedRaceId, year, memo, now, now).run();
  }
  return Response.json({ ok: true, graded_race_id: gradedRaceId, year, memo, updated_at: memo ? now : null });
}
