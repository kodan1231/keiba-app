// 複数のAPIエンドポイントで共有するヘルパー関数。
// ファイル名を "_" で始めているため、Cloudflare Pages Functions では
// このファイル自体はルートとして扱われない(_middleware.js と同じ扱い)。

// CSVインポート時点では馬名・騎手が分からず、購入履歴(imported_ticket_items / tickets)の
// selections には馬番だけが入っている場合がある。レース管理画面で出走馬表(馬名・騎手)を
// 登録・更新したタイミングで、同じレース・馬番を参照している購入履歴の selections に
// 馬名・騎手を書き戻す(バックフィルする)。
//
// 対象は race_id で紐付く imported_ticket_items と tickets のみ。
// (レース登録より前にインポートされ、まだ race_id と紐付いていない旧形式の
//  imported_tickets 生データは対象外。CSV再取込で自然に解消される想定)
export async function backfillHorseNamesForRace(db, raceId, entries) {
  if (!db || !raceId || !Array.isArray(entries) || entries.length === 0) return { updated: 0 };

  const nameByNumber = new Map();
  for (const e of entries) {
    const horseNumber = Number(e?.horse_number);
    if (!Number.isInteger(horseNumber)) continue;
    const horse_name = e?.horse_name ? String(e.horse_name).trim() : "";
    const jockey = e?.jockey ? String(e.jockey).trim() : "";
    if (!horse_name && !jockey) continue;
    nameByNumber.set(horseNumber, { horse_name: horse_name || null, jockey: jockey || null });
  }
  if (nameByNumber.size === 0) return { updated: 0 };

  let updated = 0;
  for (const table of ["imported_ticket_items", "tickets"]) {
    const { results } = await db.prepare(`SELECT id, selections FROM ${table} WHERE race_id = ?`).bind(raceId).all();
    const statements = [];
    for (const row of results || []) {
      let selections;
      try {
        selections = JSON.parse(row.selections || "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(selections) || selections.length === 0) continue;

      let changed = false;
      const next = selections.map((s) => {
        const info = nameByNumber.get(Number(s?.horse_number));
        if (!info) return s;
        const merged = { ...s };
        if (info.horse_name && merged.horse_name !== info.horse_name) {
          merged.horse_name = info.horse_name;
          changed = true;
        }
        if (info.jockey && merged.jockey !== info.jockey) {
          merged.jockey = info.jockey;
          changed = true;
        }
        return merged;
      });

      if (changed) {
        statements.push(db.prepare(`UPDATE ${table} SET selections = ? WHERE id = ?`).bind(JSON.stringify(next), row.id));
        updated++;
      }
    }
    if (statements.length) await db.batch(statements);
  }

  return { updated };
}
