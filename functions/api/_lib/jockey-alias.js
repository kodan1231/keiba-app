// 騎手名エイリアス(表記ゆれ吸収)機能。
// 2026-09-01: functions/api/_shared.js から分割(リファクタリング。詳細は_lib/auth.js冒頭の注記参照)。
//
// レース結果PDFインポート・出走馬一覧PDFインポート・手動入力(netkeibaテキスト貼り付け含む)
// それぞれで同一騎手が異なる表記(異体字・スペース有無・文字欠落等)で登録されてしまい、
// 集計画面(stats.html)の騎手別収支が同一人物なのに複数行に分裂する不具合への対応。
// 詳細な設計方針はdocs/DESIGN.md「騎手名エイリアス管理(jockey_aliases)」参照。
//
// 見習い減量記号(☆▲△★◇)は残したまま、記号を除いた部分の空白(全角/半角問わず)を
// すべて除去した文字列を突き合わせキー(alias_key)とする。これにより「戸崎 圭太」
// 「戸崎圭太」は同一キーとして扱われる(要件: スペース有無は同一人物とみなす)。
const JOCKEY_MARK_RE = /^([☆▲△★◇])/;

// 表記ゆれ文字列から突き合わせキーを生成する(見習い記号除去・空白除去)。
// 管理画面でのエイリアス登録時(alias_keyの算出)・正規化適用時の両方で使う共通ロジック。
export function jockeyAliasKeyOf(name) {
  if (!name) return "";
  const s = String(name);
  const m = s.match(JOCKEY_MARK_RE);
  const withoutMark = m ? s.slice(1) : s;
  return withoutMark.replace(/[\u3000\s]+/g, "");
}

// jockey_aliases テーブルの全件を { alias_key: canonical_name } のMapとして取得する。
// 1リクエストにつき騎手名がまとまった件数出現する取込処理(PDFインポート等)で、
// 騎手名1件ごとにDBへ問い合わせるN+1構成を避けるため、呼び出し元は本関数で1回だけ
// 取得したMapを使い回すこと(functions/api/ticket-imports/index.js等、既存の
// N+1回避パターンを踏襲)。
export async function loadJockeyAliasMap(db) {
  const map = new Map();
  if (!db) return map;
  const { results } = await db.prepare(
    "SELECT alias_key, canonical_name FROM jockey_aliases"
  ).all();
  for (const r of results || []) {
    if (r.alias_key) map.set(r.alias_key, r.canonical_name);
  }
  return map;
}

// 騎手名1件を、事前に取得済みのエイリアスMapと突き合わせて正規化する。
// マッチするエイリアスが無い場合は元の表記のままを返す(未登録の表記ゆれは
// 変更しない=誤爆防止。これらは管理画面からのエイリアス追加、または一括補正機能
// (normalizeExistingJockeyNames)で別途対応する)。
// 見習い減量記号は、取込側の表記にあれば正規化後の名前の先頭に復元する。
export function applyJockeyAliasMap(aliasMap, rawName) {
  if (!rawName || !aliasMap || aliasMap.size === 0) return rawName;
  const s = String(rawName);
  const m = s.match(JOCKEY_MARK_RE);
  const mark = m ? m[1] : "";
  const key = jockeyAliasKeyOf(s);
  if (!key) return rawName;
  const canonical = aliasMap.get(key);
  if (!canonical) return rawName;
  return mark ? `${mark}${canonical}` : canonical;
}

// entries配列(出走馬一覧PDF/結果PDF/手動入力いずれの形式も同じ {jockey, ...} 構造)の
// jockeyフィールドを、エイリアスMapで一括正規化する(配列を新規に作り直して返す。
// 元の配列は変更しない)。
export function applyJockeyAliasesToEntries(aliasMap, entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e) => (
    e && e.jockey ? { ...e, jockey: applyJockeyAliasMap(aliasMap, e.jockey) } : e
  ));
}

// 既存データ一括補正(管理画面「一括補正を実行する」ボタンから呼び出す想定)。
// jockey_aliasesに登録済みのエイリアスとキーが一致する騎手名だけを対象に、
// 以下4テーブルの保存済みデータを書き換える。未登録の表記ゆれは変更しない
// (誤爆防止。何度実行しても安全=冪等な設計)。
//   - races.entries (JSON配列。各要素のjockeyフィールド)
//   - race_results.jockey (単一カラム)
//   - tickets.selections (JSON配列。各要素のjockeyフィールド)
//   - imported_ticket_items.selections (JSON配列。各要素のjockeyフィールド)
// 各テーブルとも「1回のSELECTで全件取得→メモリ上で判定→変更対象だけdb.batch()で
// まとめてUPDATE」という、本プロジェクトの他のバッチ処理(CSVインポート等)と
// 同じ方式でCloudflare Workersのサブリクエスト数上限を回避する。
export async function normalizeExistingJockeyNames(db) {
  const aliasMap = await loadJockeyAliasMap(db);
  const result = { races: 0, race_results: 0, tickets: 0, imported_ticket_items: 0 };
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
        if (!e?.jockey) return e;
        const normalized = applyJockeyAliasMap(aliasMap, e.jockey);
        if (normalized !== e.jockey) { changed = true; return { ...e, jockey: normalized }; }
        return e;
      });
      if (changed) {
        statements.push(db.prepare("UPDATE races SET entries = ? WHERE id = ?").bind(JSON.stringify(next), row.id));
        result.races++;
      }
    }
    if (statements.length) await db.batch(statements);
  }

  // race_results.jockey
  {
    const { results } = await db.prepare("SELECT id, jockey FROM race_results WHERE jockey IS NOT NULL").all();
    const statements = [];
    for (const row of results || []) {
      if (!row.jockey) continue;
      const normalized = applyJockeyAliasMap(aliasMap, row.jockey);
      if (normalized !== row.jockey) {
        statements.push(db.prepare("UPDATE race_results SET jockey = ? WHERE id = ?").bind(normalized, row.id));
        result.race_results++;
      }
    }
    if (statements.length) await db.batch(statements);
  }

  // tickets.selections
  {
    const { results } = await db.prepare("SELECT id, selections FROM tickets").all();
    const statements = [];
    for (const row of results || []) {
      let selections;
      try { selections = JSON.parse(row.selections || "[]"); } catch { continue; }
      if (!Array.isArray(selections) || selections.length === 0) continue;
      let changed = false;
      const next = selections.map((s) => {
        if (!s?.jockey) return s;
        const normalized = applyJockeyAliasMap(aliasMap, s.jockey);
        if (normalized !== s.jockey) { changed = true; return { ...s, jockey: normalized }; }
        return s;
      });
      if (changed) {
        statements.push(db.prepare("UPDATE tickets SET selections = ? WHERE id = ?").bind(JSON.stringify(next), row.id));
        result.tickets++;
      }
    }
    if (statements.length) await db.batch(statements);
  }

  // imported_ticket_items.selections
  {
    const { results } = await db.prepare("SELECT id, selections FROM imported_ticket_items").all();
    const statements = [];
    for (const row of results || []) {
      let selections;
      try { selections = JSON.parse(row.selections || "[]"); } catch { continue; }
      if (!Array.isArray(selections) || selections.length === 0) continue;
      let changed = false;
      const next = selections.map((s) => {
        if (!s?.jockey) return s;
        const normalized = applyJockeyAliasMap(aliasMap, s.jockey);
        if (normalized !== s.jockey) { changed = true; return { ...s, jockey: normalized }; }
        return s;
      });
      if (changed) {
        statements.push(db.prepare("UPDATE imported_ticket_items SET selections = ? WHERE id = ?").bind(JSON.stringify(next), row.id));
        result.imported_ticket_items++;
      }
    }
    if (statements.length) await db.batch(statements);
  }

  return result;
}
