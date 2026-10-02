// 馬名エイリアス(表記ゆれ吸収)機能。jockey_aliases と同じ構図。
//
// race_results(JRAレース結果PDF由来)と races.entries(出走馬一覧PDF/手動入力由来)で、
// 同じ馬が異なる表記(半角カナ/全角カナ・互換文字・空白の有無)で保存されてしまい、
// 予想登録画面の「過去成績(出走履歴)」で馬名の突き合わせが成立しない問題への対応。
// 詳細な設計方針は docs/design/horse-aliases.md 参照。
//
// 突き合わせキー(alias_key)は「NFKC 正規化 + 全空白除去」。
//   - NFKC: 半角カナ→全角カナ、互換文字の畳み込み
//   - 空白除去: 全角/半角スペース・タブ等をすべて落とす
// JRA の馬名は全国で一意に登録されるため、空白・幅を落としても別馬と衝突しない。
// これでも吸収しきれない表記ゆれ(異体字・文字欠落等)は、管理画面から
// 「表記ゆれ側 → 正しい馬名」を明示登録して対応する(jockey_aliases と同じ運用)。

import { runBatchInChunks } from "./http.js";

export function horseAliasKeyOf(name) {
  if (!name) return "";
  return String(name).normalize("NFKC").replace(/[　\s]+/g, "");
}

// horse_aliases 全件を { alias_key: canonical_name } の Map で取得する。
// 1リクエストで馬名がまとまった件数出現する取込処理(PDFインポート等)が、
// 馬名1件ごとに DB へ問い合わせる N+1 を避けるため、呼び出し元はこれで1回だけ
// 取得した Map を使い回す(loadJockeyAliasMap と同じパターン)。
export async function loadHorseAliasMap(db) {
  const map = new Map();
  if (!db) return map;
  const { results } = await db.prepare(
    "SELECT alias_key, canonical_name FROM horse_aliases"
  ).all();
  for (const r of results || []) {
    if (r.alias_key) map.set(r.alias_key, r.canonical_name);
  }
  return map;
}

// 複数の馬名から、race_results.horse_key を引くための検索キー集合を作る
// (2026-10-02に races/[id]/horse-history.js から切り出し。データ検索「重賞検索」
// タブの graded-race-horses.js と共用)。
// 検索キーは「エイリアス適用後の馬名の正規化キー」に加えて、「horse_aliases 側で
// その正しい馬名を指しているエイリアスキー(逆引き)」も含める。これにより、
// race_results 側がまだ旧表記のまま(horse_key が旧表記のキー)でも一致する。
// 戻り値:
//   canonByKey:  Map<正規化キー, エイリアス適用後の馬名>
//   searchKeyToKey: Map<race_results.horse_key が取り得る値, 正規化キー>
// 呼び出し側は [...searchKeyToKey.keys()] を IN 句に渡す。件数は
// 「馬名数 × (1 + その馬のエイリアス数)」になるため、呼び出し側で上限を確認すること。
export function buildHorseSearchKeys(aliasMap, rawNames) {
  const reverseAliasKeys = new Map();
  for (const [aliasKey, canonicalName] of aliasMap) {
    let list = reverseAliasKeys.get(canonicalName);
    if (!list) { list = []; reverseAliasKeys.set(canonicalName, list); }
    list.push(aliasKey);
  }
  const canonByKey = new Map();
  const searchKeyToKey = new Map();
  for (const raw of rawNames) {
    if (raw === null || raw === undefined || raw === "") continue;
    const canon = applyHorseAliasMap(aliasMap, raw);
    const key = horseAliasKeyOf(canon);
    if (!key) continue;
    if (!canonByKey.has(key)) canonByKey.set(key, canon);
    searchKeyToKey.set(key, key);
    for (const aliasKey of reverseAliasKeys.get(canon) || []) {
      searchKeyToKey.set(aliasKey, key);
    }
  }
  return { canonByKey, searchKeyToKey };
}

// 馬名1件を、取得済みの Map と突き合わせて正規化する。
// マッチするエイリアスが無ければ元の表記のまま返す(誤爆防止)。
export function applyHorseAliasMap(aliasMap, rawName) {
  if (!rawName || !aliasMap || aliasMap.size === 0) return rawName;
  const key = horseAliasKeyOf(rawName);
  if (!key) return rawName;
  return aliasMap.get(key) || rawName;
}

// entries 配列(出走馬一覧PDF/結果PDF/手動入力いずれも {horse_name, ...} 構造)の
// horse_name を一括正規化する(配列を新規に作り直して返す。元の配列は変更しない)。
export function applyHorseAliasesToEntries(aliasMap, entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e) => (
    e && e.horse_name ? { ...e, horse_name: applyHorseAliasMap(aliasMap, e.horse_name) } : e
  ));
}

// 既存データ一括補正(管理画面「既存データの馬名を一括補正する」ボタンから実行)。
// horse_aliases に登録済みのエイリアスとキーが一致する馬名だけを対象に、以下を書き換える。
// 未登録の表記ゆれは変更しない(誤爆防止。何度実行しても安全=冪等)。
//   - races.entries          (JSON配列。各要素の horse_name)
//   - race_results.horse_name (単一カラム)。あわせて horse_key(突き合わせキー。下記参照)も同期
//   - horse_notes.horse_name  (単一カラム。UNIQUE(horse_name, user_id) 衝突時はメモを連結)
//   - tickets.selections            (JSON配列。各要素の horse_name)
//   - imported_ticket_items.selections (JSON配列。各要素の horse_name)
// 各テーブルとも「1回のSELECTで全件取得 → メモリ判定 → 変更行だけ db.batch() で
// まとめて書き込む」方式でサブリクエスト数上限を回避する(jockey 版と同じ)。
export async function normalizeExistingHorseNames(db) {
  const aliasMap = await loadHorseAliasMap(db);
  const result = { races: 0, race_results: 0, horse_notes: 0, tickets: 0, imported_ticket_items: 0 };
  const now = new Date().toISOString();

  // race_results.horse_name / horse_key
  // horse_key = horseAliasKeyOf(horse_name) は GET /api/races/:id/horse-history が
  // 対象馬をインデックス経由で直接引くための突き合わせキー(docs/design/horse-aliases.md)。
  // 既存行への初回バックフィルもこのボタンが兼ねるため、horse_aliases が1件も無くても
  // (=リネーム対象が無い場合でも)このブロックだけは実行する。
  {
    const { results } = await db.prepare(
      "SELECT id, horse_name, horse_key FROM race_results WHERE horse_name IS NOT NULL"
    ).all();
    const statements = [];
    for (const row of results || []) {
      if (!row.horse_name) continue;
      const normalized = applyHorseAliasMap(aliasMap, row.horse_name);
      const expectedKey = horseAliasKeyOf(normalized);
      if (normalized !== row.horse_name || row.horse_key !== expectedKey) {
        statements.push(
          db.prepare("UPDATE race_results SET horse_name = ?, horse_key = ?, updated_at = ? WHERE id = ?")
            .bind(normalized, expectedKey, now, row.id)
        );
        result.race_results++;
      }
    }
    if (statements.length) await runBatchInChunks(db, statements);
  }

  if (aliasMap.size === 0) return result;

  // races.entries
  {
    const { results } = await db.prepare("SELECT id, entries FROM races").all();
    const statements = [];
    for (const row of results || []) {
      let entries;
      try { entries = JSON.parse(row.entries || "[]"); } catch { continue; }
      if (!Array.isArray(entries) || entries.length === 0) continue;
      let changed = false;
      const next = entries.map((e) => {
        if (!e?.horse_name) return e;
        const normalized = applyHorseAliasMap(aliasMap, e.horse_name);
        if (normalized !== e.horse_name) { changed = true; return { ...e, horse_name: normalized }; }
        return e;
      });
      if (changed) {
        statements.push(db.prepare("UPDATE races SET entries = ? WHERE id = ?").bind(JSON.stringify(next), row.id));
        result.races++;
      }
    }
    if (statements.length) await runBatchInChunks(db, statements);
  }

  // horse_notes.horse_name (per-user, UNIQUE(horse_name, user_id))。
  // 表記ゆれ名のメモと正しい名の既存メモが同一ユーザーで両方あると衝突するため、
  // 「集約先(正しい名の行)へメモを改行連結し、表記ゆれ名の行は削除する」で寄せる。
  {
    const { results } = await db.prepare("SELECT id, user_id, horse_name, memo FROM horse_notes").all();
    const rows = results || [];
    const targetKey = (userId, name) => `${userId} ${name}`;
    // 先に「正規化しても名前が変わらない行(=集約先になれる行)」を登録しておく。
    const byTarget = new Map();
    for (const r of rows) {
      if (!r.horse_name) continue;
      const canon = applyHorseAliasMap(aliasMap, r.horse_name);
      if (canon === r.horse_name) {
        byTarget.set(targetKey(r.user_id, canon), { keepId: r.id, memo: r.memo || "" });
      }
    }
    const statements = [];
    for (const r of rows) {
      if (!r.horse_name) continue;
      const canon = applyHorseAliasMap(aliasMap, r.horse_name);
      if (canon === r.horse_name) continue;
      const tk = targetKey(r.user_id, canon);
      const target = byTarget.get(tk);
      if (!target) {
        // 集約先が無い → この行の名前を正しい名へ付け替え、以後の集約先にする
        statements.push(db.prepare("UPDATE horse_notes SET horse_name = ?, updated_at = ? WHERE id = ?").bind(canon, now, r.id));
        byTarget.set(tk, { keepId: r.id, memo: r.memo || "" });
        result.horse_notes++;
      } else {
        // 集約先あり → メモを改行連結して集約先を更新し、この行は削除する
        const merged = [target.memo, r.memo || ""].map((s) => (s || "").trim()).filter(Boolean).join("\n");
        if (merged !== target.memo) {
          statements.push(db.prepare("UPDATE horse_notes SET memo = ?, updated_at = ? WHERE id = ?").bind(merged, now, target.keepId));
          target.memo = merged;
        }
        statements.push(db.prepare("DELETE FROM horse_notes WHERE id = ?").bind(r.id));
        result.horse_notes++;
      }
    }
    if (statements.length) await runBatchInChunks(db, statements);
  }

  // tickets.selections / imported_ticket_items.selections
  for (const table of ["tickets", "imported_ticket_items"]) {
    const { results } = await db.prepare(`SELECT id, selections FROM ${table}`).all();
    const statements = [];
    for (const row of results || []) {
      let selections;
      try { selections = JSON.parse(row.selections || "[]"); } catch { continue; }
      if (!Array.isArray(selections) || selections.length === 0) continue;
      let changed = false;
      const next = selections.map((s) => {
        if (!s?.horse_name) return s;
        const normalized = applyHorseAliasMap(aliasMap, s.horse_name);
        if (normalized !== s.horse_name) { changed = true; return { ...s, horse_name: normalized }; }
        return s;
      });
      if (changed) {
        statements.push(db.prepare(`UPDATE ${table} SET selections = ? WHERE id = ?`).bind(JSON.stringify(next), row.id));
        result[table]++;
      }
    }
    if (statements.length) await runBatchInChunks(db, statements);
  }

  return result;
}
