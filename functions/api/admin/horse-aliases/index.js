import { requireAdmin, horseAliasKeyOf, readJsonBody, jsonError } from "../../_shared.js";

// 管理者向け: 馬名エイリアス(表記ゆれ→正しい馬名)の一覧取得・追加。
// 詳細な設計方針は docs/design/horse-aliases.md 参照。jockey_aliases と同じ構図。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT id, alias_key, alias_display, canonical_name, created_at
     FROM horse_aliases ORDER BY alias_display ASC, created_at DESC, id DESC`
  ).all();

  return Response.json({ ok: true, items: results || [] });
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const aliasDisplay = String(data?.alias_display || "").trim();
  const canonicalName = String(data?.canonical_name || "").trim();

  if (!aliasDisplay) return jsonError("表記ゆれ側の馬名を入力してください", 400);
  if (!canonicalName) return jsonError("正しい馬名を入力してください", 400);
  if (aliasDisplay.length > 100 || canonicalName.length > 100) {
    return jsonError("馬名が長すぎます", 400);
  }

  const aliasKey = horseAliasKeyOf(aliasDisplay);
  if (!aliasKey) return jsonError("表記ゆれ側の馬名が不正です", 400);
  // 正しい馬名と突き合わせキーが一致するエイリアスは無意味(自己参照)。
  if (horseAliasKeyOf(canonicalName) === aliasKey && aliasDisplay === canonicalName) {
    return jsonError("表記ゆれ側と正しい馬名が同じです", 400);
  }

  try {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `INSERT INTO horse_aliases (alias_key, alias_display, canonical_name, created_at)
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
      return jsonError("この表記(全角/半角・空白違いを含む)は既に登録されています。既存のエイリアスを削除してから登録し直してください。", 409);
    }
    console.error("horse alias insert error", e);
    return jsonError("登録に失敗しました", 500);
  }
}
