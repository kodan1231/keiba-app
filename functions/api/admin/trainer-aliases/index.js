import { requireAdmin, trainerAliasKeyOf, readJsonBody, jsonError } from "../../_shared.js";

// 管理者向け: 調教師名エイリアス(略称・表記ゆれ→正しい調教師名)の一覧取得・追加。2026-10-06追加。
// 騎手名エイリアス(functions/api/admin/jockey-aliases/index.js)と同じ形。
// 用途は docs/design/umabashira-paste.md「略称のエイリアス」参照。
export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { results } = await context.env.DB.prepare(
    `SELECT id, alias_key, alias_display, canonical_name, created_at
     FROM trainer_aliases ORDER BY alias_display ASC, created_at DESC, id DESC`
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
  if (!aliasDisplay) return jsonError("表記ゆれ側(略称)の調教師名を入力してください", 400);
  if (!canonicalName) return jsonError("正しい調教師名を入力してください", 400);
  if (aliasDisplay.length > 100 || canonicalName.length > 100) return jsonError("調教師名が長すぎます", 400);

  const aliasKey = trainerAliasKeyOf(aliasDisplay);
  if (!aliasKey) return jsonError("表記ゆれ側の調教師名が不正です", 400);

  try {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `INSERT INTO trainer_aliases (alias_key, alias_display, canonical_name, created_at)
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
    console.error("trainer alias insert error", e);
    return jsonError("登録に失敗しました", 500);
  }
}
