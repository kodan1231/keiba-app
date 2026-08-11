import { requireAdmin, backfillHorseNamesForRace, linkUnregisteredImportsToRace } from "../_shared.js";

// 出走馬一覧PDF(枠番・馬番なし/あり 共通)からの一括登録・更新。管理者専用。
// 詳細な設計方針は docs/DESIGN.md「出走馬一覧PDFインポート」参照。
//
// 重要: 既存レースがある場合、レース行(races.id)は絶対に削除・再作成しない。
// DELETE→INSERTしてしまうと、prediction_marks/prediction_notesがON DELETE CASCADEで
// 一緒に消えてしまうため、既存レースは常にUPDATEで対応する。

function normalizeHorseName(v) {
  return String(v ?? "").replace(/[\u3000\s]+/g, " ").trim();
}

// entries配列を馬番順に並べ替える。races.js の出走馬表編集画面は
// 「entries配列のi番目 ≒ 馬番(i+1)」という前提で行を描画するため、マージ後は必ずソートし直す。
// 枠番・馬番が未確定(null)の間は五十音順(馬名)のままにしておく
// (ソートすべき数値情報がまだ無いため、馬名順が自然な並びになる)。
function sortEntriesByHorseNumber(entries) {
  return [...entries].sort((a, b) => {
    const an = a.horse_number, bn = b.horse_number;
    const aNull = an === null || an === undefined;
    const bNull = bn === null || bn === undefined;
    if (aNull && bNull) {
      return normalizeHorseName(a.horse_name).localeCompare(normalizeHorseName(b.horse_name), "ja");
    }
    if (aNull) return 1;
    if (bNull) return -1;
    return an - bn;
  });
}

// 既存entriesと取込entriesを、馬名をキーにマージする。
// - 新しい馬名 → 追加
// - 既存の馬名で、取込側の枠番・馬番がnull → 何もしない(確定情報を未確定情報で
//   誤って上書きしない。木曜インポート後に金曜データが来て初めて値が入る想定)
// - 既存の馬名で、取込側の枠番・馬番が値あり、既存がnull → 更新(確定)
// - 既存の馬名に既に確定済みの値があり、取込側が異なる値 → 自動上書きせず
//   競合として報告するのみ(実運用ではまず発生しないイレギュラーな状態と想定)
function mergeEntries(existingEntries, incomingEntries) {
  // 馬名が空の既存entries項目(手動編集での保存ミスや過去のインポート不具合等で
  // 紛れ込んだ空行)は、名前をキーにしたマージでは永久にどの馬とも一致せず、
  // 新しい実データが「別の馬」として追加され続けて重複・空欄混在の原因になる。
  // マージ前に除去することで、次回インポート時に自動的にクリーンアップされるようにする。
  const cleanedExisting = (Array.isArray(existingEntries) ? existingEntries : [])
    .filter((e) => normalizeHorseName(e?.horse_name));
  const merged = cleanedExisting.map((e) => ({ ...e }));
  const byName = new Map(merged.map((e, i) => [normalizeHorseName(e.horse_name), i]));
  const conflicts = [];

  for (const incoming of incomingEntries) {
    const name = normalizeHorseName(incoming.horse_name);
    if (!name) continue;
    const idx = byName.get(name);

    if (idx === undefined) {
      merged.push({
        horse_name: incoming.horse_name,
        waku_number: incoming.waku_number ?? null,
        horse_number: incoming.horse_number ?? null,
        jockey: incoming.jockey || null,
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

    if (incoming.jockey) existing.jockey = incoming.jockey;
  }

  return { entries: merged, conflicts };
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const races = Array.isArray(body?.races) ? body.races : [];
  if (!races.length) {
    return Response.json({ error: "インポート対象のレースがありません" }, { status: 400 });
  }

  const results = [];

  for (const item of races) {
    const raceDate = item?.race_date;
    const track = item?.track;
    const raceNumber = Number(item?.race_number);
    const key = `${raceDate} ${track} ${raceNumber}R`;

    if (!raceDate || !track || !raceNumber || !Array.isArray(item?.entries) || item.entries.length === 0) {
      results.push({ status: "invalid", key, message: "開催日・競馬場・レース番号・出走馬情報が不足しています" });
      continue;
    }

    const existing = await env.DB.prepare(
      "SELECT * FROM races WHERE race_date = ? AND track = ? AND race_number = ?"
    ).bind(raceDate, track, raceNumber).first();

    if (!existing) {
      const entries = sortEntriesByHorseNumber(item.entries
        .filter((e) => normalizeHorseName(e?.horse_name)) // 念のための防御(空馬名は登録しない)
        .map((e) => ({
          horse_name: e.horse_name,
          waku_number: e.waku_number ?? null,
          horse_number: e.horse_number ?? null,
          jockey: e.jockey || null,
        })));
      const ins = await env.DB.prepare(
        `INSERT INTO races (race_date, track, race_number, race_name, course_type, distance, entries)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        raceDate,
        track,
        raceNumber,
        item.race_name || null,
        item.course_type || null,
        item.distance ? Number(item.distance) : null,
        JSON.stringify(entries)
      ).run();
      const id = ins.meta.last_row_id;
      await linkUnregisteredImportsToRace(env.DB, id, raceDate, track, raceNumber);
      if (entries.some((e) => e.horse_number !== null)) {
        await backfillHorseNamesForRace(env.DB, id, entries);
      }
      results.push({ status: "created", id, key, conflicts: [] });
      continue;
    }

    let currentEntries = [];
    try { currentEntries = JSON.parse(existing.entries || "[]"); } catch { currentEntries = []; }

    const { entries: mergedEntriesRaw, conflicts } = mergeEntries(currentEntries, item.entries);
    // マージ後は必ず馬番順にソートし直す(木曜(馬番なし)→金曜(馬番あり)の更新で、
    // entries配列の並びが最初のインポート時(五十音順)のまま残ってしまわないようにするため)。
    const mergedEntries = sortEntriesByHorseNumber(mergedEntriesRaw);

    const fields = ["entries = ?"];
    const values = [JSON.stringify(mergedEntries)];
    if (!existing.race_name && item.race_name) { fields.push("race_name = ?"); values.push(item.race_name); }
    if (!existing.course_type && item.course_type) { fields.push("course_type = ?"); values.push(item.course_type); }
    if (!existing.distance && item.distance) { fields.push("distance = ?"); values.push(Number(item.distance)); }
    values.push(existing.id);

    await env.DB.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    await linkUnregisteredImportsToRace(env.DB, existing.id, raceDate, track, raceNumber);
    if (mergedEntries.some((e) => e.horse_number !== null)) {
      await backfillHorseNamesForRace(env.DB, existing.id, mergedEntries);
    }

    results.push({ status: "updated", id: existing.id, key, conflicts });
  }

  return Response.json({ ok: true, results });
}
