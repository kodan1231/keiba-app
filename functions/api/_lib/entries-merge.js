// races.entries(出走馬情報)のマージ・バックフィル・CSV未登録データの紐付けに関するヘルパー。
// 2026-09-01: functions/api/_shared.js から分割(リファクタリング。詳細は_lib/auth.js冒頭の注記参照)。

// レースが未登録の間にインポートされた imported_ticket_groups / imported_ticket_items は
// race_id が NULL のまま保存されている。管理者がそのレースを登録(または編集)したタイミングで、
// 日付・競馬場・レース番号が一致する未紐付けデータを探してレースに紐付ける。
export async function linkUnregisteredImportsToRace(db, raceId, raceDate, track, raceNumber) {
  if (!db || !raceId || !raceDate || !track || !raceNumber) return { linkedGroups: 0 };
  const { results: groups } = await db.prepare(
    `SELECT id FROM imported_ticket_groups WHERE race_id IS NULL AND race_date = ? AND track = ? AND race_number = ?`
  ).bind(raceDate, track, raceNumber).all();
  if (!groups || !groups.length) return { linkedGroups: 0 };
  const groupIds = groups.map((g) => g.id);
  const placeholders = groupIds.map(() => "?").join(",");
  await db.batch([
    db.prepare(`UPDATE imported_ticket_groups SET race_id = ? WHERE id IN (${placeholders})`).bind(raceId, ...groupIds),
    db.prepare(`UPDATE imported_ticket_items SET race_id = ? WHERE group_id IN (${placeholders})`).bind(raceId, ...groupIds),
  ]);
  return { linkedGroups: groupIds.length };
}

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

// ---- 出走馬情報(entries)の共通マージロジック ----
// 出走馬一覧PDFインポート(entries-import.js)・JRAレース結果PDFインポート(results-import.js)の
// 両方から呼び出す共通ヘルパー。馬名(horse_name)をキーに1頭ずつマージする。
// 詳細仕様は docs/DESIGN.md「出走馬情報(entries)のマージルールは共通」参照。
//
// マージルール:
//   - 新しい馬名 → entries に追加
//   - 既存の馬名で、取込側の waku_number/horse_number が null → 何もしない
//     (未確定情報で既存の確定情報を誤って消さない)
//   - 既存の馬名で、取込側が値あり・既存が null → 更新(未確定→確定の一方向更新)
//   - 既存の馬名に既に確定済みの値があり、取込側が異なる値(waku_number/horse_numberのみ対象)
//     → 自動上書きしない。「競合」として報告するのみ
//   - sex_age(性齢)・weight_carried(負担重量)は競合の概念を設けず、取込側に値があれば
//     無条件で上書きする(レース確定に伴い変わりうる値のため)
//   - jockey(騎手名)も競合の概念を設けず、取込側に値があれば無条件で上書きする
//     (騎手変更の可能性を考慮するため)。見習い減量記号(☆▲△★◇)は先頭に残したまま保存する。
//     呼び出し元(entries-import.js/results-import.js)が、この関数に渡す前に jockey名を
//     jockey_aliases テーブルで正規化する(applyJockeyAliasMap)。この関数自体は正規化を
//     行わず、渡された値をそのまま使う(責務を分離するため)。
//
// マージ前に、既存entries側の馬名が空の項目を除去してからマージする(空行が
// どの馬とも一致せず残り続けるのを防ぐため)。
//
// 戻り値: { entries: マージ後の配列(馬番順。未確定間は馬名順にソート済み), conflicts: [...] }
function normalizeHorseNameForMerge(v) {
  return String(v ?? "").replace(/[\u3000\s]+/g, " ").trim();
}

// 馬番から枠番を計算する。JRAでは馬番の抽選後、出走頭数に応じて機械的に枠番が割り当てられる
// (枠自体は抽選対象ではなく頭数から一意に決まる)ため、馬番が確定していれば枠番も確定させて
// よい。races.js「出走頭数から枠番の初期値を計算する」(defaultWakuNumber())と同じ
// アルゴリズム。8頭以下は1頭1枠、9頭以上は余りを大きい枠番(7・8枠)側から順に1頭ずつ
// 多く割り振る。
function computeWakuNumberFromHorseNumber(horseNumber, horseCount) {
  const base = Math.floor(horseCount / 8);
  const remainder = horseCount % 8;
  let n = horseNumber;
  for (let waku = 1; waku <= 8; waku++) {
    const size = waku > (8 - remainder) ? base + 1 : base;
    if (n <= size) return waku;
    n -= size;
  }
  return 8;
}

export function mergeEntriesByHorseName(existingEntries, incomingEntries) {
  const cleanedExisting = (Array.isArray(existingEntries) ? existingEntries : [])
    .filter((e) => normalizeHorseNameForMerge(e?.horse_name));
  const merged = cleanedExisting.map((e) => ({ ...e }));
  const byName = new Map(merged.map((e, i) => [normalizeHorseNameForMerge(e.horse_name), i]));
  const conflicts = [];

  for (const incoming of (Array.isArray(incomingEntries) ? incomingEntries : [])) {
    const name = normalizeHorseNameForMerge(incoming?.horse_name);
    if (!name) continue;
    const idx = byName.get(name);

    if (idx === undefined) {
      merged.push({
        horse_name: incoming.horse_name,
        waku_number: incoming.waku_number ?? null,
        horse_number: incoming.horse_number ?? null,
        jockey: incoming.jockey || null,
        sex_age: incoming.sex_age || null,
        weight_carried: incoming.weight_carried ?? null,
      });
      byName.set(name, merged.length - 1);
      continue;
    }

    const existing = merged[idx];

    for (const field of ["waku_number", "horse_number"]) {
      const incomingVal = incoming[field];
      if (incomingVal === null || incomingVal === undefined) continue; // 未確定情報では既存値を消さない
      const existingVal = existing[field];
      if (existingVal === null || existingVal === undefined) {
        existing[field] = incomingVal; // 未確定→確定 の更新
      } else if (existingVal !== incomingVal) {
        conflicts.push({ horse_name: incoming.horse_name, field, existing: existingVal, incoming: incomingVal });
      }
    }

    // sex_age・weight_carried は競合検出の対象外。取込側に値があれば無条件で上書きする。
    if (incoming.sex_age) existing.sex_age = incoming.sex_age;
    if (incoming.weight_carried !== null && incoming.weight_carried !== undefined) {
      existing.weight_carried = incoming.weight_carried;
    }
    // jockey も競合の概念を設けず、取込側に値があれば無条件で上書きする。
    if (incoming.jockey) existing.jockey = incoming.jockey;
  }

  // 馬番が確定している馬は、枠番も自動計算して確定値として埋める(PDFからは枠番をテキスト
  // 抽出できず常にnullで来るため、ここで計算しない限り永久にnullのまま残ってしまう)。
  // 頭数は entries 配列全体の件数を使う(races.js の出走馬表編集画面が採用しているのと
  // 同じ基準)。既に枠番が入っている馬(手動入力等で確定済み)は上書きしない。
  const horseCount = merged.length;
  for (const e of merged) {
    if (Number.isInteger(e.horse_number) && (e.waku_number === null || e.waku_number === undefined)) {
      e.waku_number = computeWakuNumberFromHorseNumber(e.horse_number, horseCount);
    }
  }

  return { entries: sortEntriesByHorseNumberForMerge(merged), conflicts };
}

// entries配列を馬番順に並べ替える。races.js の出走馬表編集画面は
// 「entries配列のi番目 ≒ 馬番(i+1)」という前提で行を描画するため、マージ後は
// 必ずソートし直す。枠番・馬番が未確定(null)の間は五十音順(馬名)のままにしておく。
function sortEntriesByHorseNumberForMerge(entries) {
  return [...entries].sort((a, b) => {
    const an = a.horse_number, bn = b.horse_number;
    const aNull = an === null || an === undefined;
    const bNull = bn === null || bn === undefined;
    if (aNull && bNull) {
      return normalizeHorseNameForMerge(a.horse_name).localeCompare(normalizeHorseNameForMerge(b.horse_name), "ja");
    }
    if (aNull) return 1;
    if (bNull) return -1;
    return an - bn;
  });
}
