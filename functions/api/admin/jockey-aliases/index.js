import { requireAdmin, jockeyAliasKeyOf } from "../../_shared.js";

// 管理者向け: 騎手名エイリアス(表記ゆれ→正しい表記)の一覧取得・追加。
// 詳細な設計方針はdocs/DESIGN.md「騎手名エイリアス管理(jockey_aliases)」参照。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  // 2026-08-17変更: 一覧の並び順を「登録日時の新しい順」から「表記ゆれ側(alias_display)の
  // 文字列昇順」に変更した。SQLiteの標準的なバイト順比較によるソートで、他画面
  // (stats.jsの名前列ソート等)と同じ方式に揃えている(濁点・拗音等を正規化した
  // 厳密な五十音順ではない)。同じ表記ゆれ側の値が複数ある場合は、登録日時の
  // 新しい順を副次キーとして使う。
  const { results } = await env.DB.prepare(
    `SELECT id, alias_key, alias_display, canonical_name, created_at
     FROM jockey_aliases ORDER BY alias_display ASC, created_at DESC, id DESC`
  ).all();

  return Response.json({ ok: true, items: results || [] });
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const aliasDisplay = String(data?.alias_display || "").trim();
  const canonicalName = String(data?.canonical_name || "").trim();

  if (!aliasDisplay) {
    return Response.json({ error: "表記ゆれ側の騎手名を入力してください" }, { status: 400 });
  }
  if (!canonicalName) {
    return Response.json({ error: "正しい表記を入力してください" }, { status: 400 });
  }
  if (aliasDisplay.length > 100 || canonicalName.length > 100) {
    return Response.json({ error: "騎手名が長すぎます" }, { status: 400 });
  }

  const aliasKey = jockeyAliasKeyOf(aliasDisplay);
  if (!aliasKey) {
    return Response.json({ error: "表記ゆれ側の騎手名が不正です" }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `INSERT INTO jockey_aliases (alias_key, alias_display, canonical_name, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(aliasKey, aliasDisplay, canonicalName, now).run();

    return Response.json({
      ok: true,
      id: result.meta.last_row_id,
      alias_key: aliasKey,
      alias_display: aliasDisplay,
      canonical_name: canonicalName,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return Response.json(
        { error: "この表記(空白違いを含む)は既に登録されています。既存のエイリアスを削除してから登録し直してください。" },
        { status: 409 }
      );
    }
    console.error("jockey alias insert error", e);
    return Response.json({ error: "登録に失敗しました" }, { status: 500 });
  }
}
