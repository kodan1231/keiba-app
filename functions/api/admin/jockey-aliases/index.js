import { requireAdmin, jockeyAliasKeyOf, readJsonBody, jsonError, invalidateMemo, MEMO_JOCKEY_ALIASES, loadJockeyAliasMapCached } from "../../_shared.js";

// 管理者向け: 騎手名エイリアス(表記ゆれ→正しい表記)の一覧取得・追加。
// 詳細な設計方針はdocs/design/jockey-aliases.md「騎手名エイリアス管理(jockey_aliases)」参照。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  // ?map=1(2026-10-16): 取り込みの画面(ブックマークレット・馬柱の貼り付け)用の対応表だけを返す { ok, map: { 突き合わせキー: 正しい騎手名 } }。
  // 同じ実行環境で使い回している対応表(loadJockeyAliasMapCached。2分)を返すので、ほとんど D1 を読まない。
  // 以前は取り込みのたびに下の一覧(並べ替えつき)を丸ごと読み、3日間で約56万行になっていた。
  // 保存のときはサーバーが毎回読み直した対応表で正規化するので、画面の候補が最大2分古くても保存される値は正しい
  if (new URL(context.request.url).searchParams.get("map") === "1") {
    const m = await loadJockeyAliasMapCached(env.DB);
    return Response.json({ ok: true, map: Object.fromEntries(m) });
  }
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
  invalidateMemo(MEMO_JOCKEY_ALIASES); // この実行環境で使い回している分を捨てる(2026-10-07。_lib/memo-cache.js)

  const { request, env } = context;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const aliasDisplay = String(data?.alias_display || "").trim();
  const canonicalName = String(data?.canonical_name || "").trim();

  if (!aliasDisplay) {
    return jsonError("表記ゆれ側の騎手名を入力してください", 400);
  }
  if (!canonicalName) {
    return jsonError("正しい表記を入力してください", 400);
  }
  if (aliasDisplay.length > 100 || canonicalName.length > 100) {
    return jsonError("騎手名が長すぎます", 400);
  }

  const aliasKey = jockeyAliasKeyOf(aliasDisplay);
  if (!aliasKey) {
    return jsonError("表記ゆれ側の騎手名が不正です", 400);
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
      return jsonError("この表記(空白違いを含む)は既に登録されています。既存のエイリアスを削除してから登録し直してください。", 409);
    }
    console.error("jockey alias insert error", e);
    return jsonError("登録に失敗しました", 500);
  }
}
