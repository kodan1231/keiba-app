// 調教師名エイリアス(略称・表記ゆれ→正しい調教師名)。2026-10-06追加。
// netkeiba馬柱テキストの貼り付け取り込み(docs/design/umabashira-paste.md)で、
// 「栗東・橋口」のような略称を馬情報マスタ(horses.trainer)のフルネームに揃えるために使う。
// 騎手名エイリアス(_lib/jockey-alias.js)と同じ構図(突き合わせキー → 正しい表記)。

// 突き合わせキー: NFKC正規化+全空白除去(「手塚 貴久」と「手塚貴久」を同じにする)。
export function trainerAliasKeyOf(name) {
  if (!name) return "";
  return String(name).normalize("NFKC").replace(/[　\s]+/g, "");
}

// trainer_aliases の全件を { alias_key: canonical_name } の Map で返す(小さいテーブルのため全件)。
// テーブルが無い(マイグレーション未適用)場合は空の Map。
export async function loadTrainerAliasMap(db) {
  const map = new Map();
  if (!db) return map;
  try {
    const { results } = await db.prepare("SELECT alias_key, canonical_name FROM trainer_aliases").all();
    for (const r of results || []) {
      if (r.alias_key) map.set(r.alias_key, r.canonical_name);
    }
  } catch (e) {
    console.error("trainer_aliases: read failed (ignored)", e);
  }
  return map;
}

// 調教師名1件をエイリアスで変換する。登録が無ければ null(呼び出し元が略称のまま使うか判断する)。
export function resolveTrainerAlias(aliasMap, rawName) {
  const key = trainerAliasKeyOf(rawName);
  if (!key || !aliasMap) return null;
  return aliasMap.get(key) || null;
}
