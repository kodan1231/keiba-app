// 調教師名エイリアス(略称・表記ゆれ→正しい調教師名)。2026-10-06追加。
// netkeiba馬柱テキストの貼り付け取り込み(docs/design/umabashira-paste.md)で、
// 「栗東・橋口」のような略称を馬情報マスタ(horses.trainer)のフルネームに揃えるために使う。
// 騎手名エイリアス(_lib/jockey-alias.js)と同じ構図(突き合わせキー → 正しい表記)。

import { memoized } from "./memo-cache.js";

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

// 使い回し版(2026-11-18。7日で約265回・約14万行を毎回全件読んでいた)。同じ実行環境で2分(_lib/memo-cache.js)。
// 使うのは馬柱の取り込み(書き込み)だけだが、調教師名は候補の表示と horses.trainer の補完にしか使わず、
// 管理画面でエイリアスを変えたときは invalidateMemo(MEMO_TRAINER_ALIASES) で捨てる(別の実行環境は最大2分遅れる)
export const MEMO_TRAINER_ALIASES = "trainer_aliases";
export function loadTrainerAliasMapCached(db) {
  return memoized(MEMO_TRAINER_ALIASES, () => loadTrainerAliasMap(db));
}

// 保存済みの調教師名の一覧(未登録の略称の候補用。2026-11-18〜 同じ実行環境で10分使い回す。1回約4,200行を読んでいた)
export const MEMO_KNOWN_TRAINERS = "known_trainers";
export function loadKnownTrainersCached(db) {
  return memoized(MEMO_KNOWN_TRAINERS, async () => {
    const { results } = await db.prepare("SELECT DISTINCT trainer FROM horses WHERE trainer IS NOT NULL").all();
    return (results || []).map((r) => r.trainer).filter(Boolean);
  }, 10 * 60 * 1000);
}

// 調教師名1件をエイリアスで変換する。登録が無ければ null(呼び出し元が略称のまま使うか判断する)。
export function resolveTrainerAlias(aliasMap, rawName) {
  const key = trainerAliasKeyOf(rawName);
  if (!key || !aliasMap) return null;
  return aliasMap.get(key) || null;
}
