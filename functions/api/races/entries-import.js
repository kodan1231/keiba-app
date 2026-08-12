import {
  requireAdmin,
  backfillHorseNamesForRace,
  linkUnregisteredImportsToRace,
  mergeEntriesByHorseName,
  recomputeTicketPayoutsForRace,
} from "../_shared.js";

// 出走馬一覧PDF(枠番・馬番なし/あり 共通)からの一括登録・更新。管理者専用。
// 詳細な設計方針は docs/DESIGN.md「出走馬一覧PDFインポート」参照。
//
// 重要: 既存レースがある場合、レース行(races.id)は絶対に削除・再作成しない。
// DELETE→INSERTしてしまうと、prediction_marks/prediction_notesがON DELETE CASCADEで
// 一緒に消えてしまうため、既存レースは常にUPDATEで対応する。
//
// 2026-08-11: entriesのマージロジックは、JRAレース結果PDFインポート(results-import.js)と
// 共通の functions/api/_shared.js の mergeEntriesByHorseName() を使うよう統一した
// (以前はこのファイル内に個別のmergeEntries()を持っていた)。性齢(sex_age)・
// 負担重量(weight_carried)のマージにも対応している。

function normalizeHorseName(v) {
  return String(v ?? "").replace(/[\u3000\s]+/g, " ").trim();
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

    const incomingEntries = item.entries
      .filter((e) => normalizeHorseName(e?.horse_name)) // 念のための防御(空馬名は登録しない)
      .map((e) => ({
        horse_name: e.horse_name,
        waku_number: e.waku_number ?? null,
        horse_number: e.horse_number ?? null,
        jockey: e.jockey || null,
        sex_age: e.sex_age || null,
        weight_carried: e.weight_carried ?? null,
      }));

    if (!existing) {
      const { entries } = mergeEntriesByHorseName([], incomingEntries);
      const ins = await env.DB.prepare(
        `INSERT INTO races (race_date, track, race_number, race_name, course_type, distance,
          weight_type, class_flags, course_direction, entries)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        raceDate,
        track,
        raceNumber,
        item.race_name || null,
        item.course_type || null,
        item.distance ? Number(item.distance) : null,
        item.weight_type || null,
        item.class_flags || null,
        item.course_direction || null,
        JSON.stringify(entries)
      ).run();
      const id = ins.meta.last_row_id;
      await linkUnregisteredImportsToRace(env.DB, id, raceDate, track, raceNumber);
      if (entries.some((e) => e.horse_number !== null)) {
        await backfillHorseNamesForRace(env.DB, id, entries);
      }
      // 保険: 木・金の出走馬インポート時点では通常finish_order/payoutsは未確定のため
      // 実質何もしないが、結果PDFが先に取り込まれるイレギュラーな運用に備えて呼んでおく。
      await recomputeTicketPayoutsForRace(env.DB, id, null, null, entries);
      results.push({ status: "created", id, key, conflicts: [] });
      continue;
    }

    let currentEntries = [];
    try { currentEntries = JSON.parse(existing.entries || "[]"); } catch { currentEntries = []; }

    const { entries: mergedEntries, conflicts } = mergeEntriesByHorseName(currentEntries, incomingEntries);

    const fields = ["entries = ?"];
    const values = [JSON.stringify(mergedEntries)];
    if (!existing.race_name && item.race_name) { fields.push("race_name = ?"); values.push(item.race_name); }
    if (!existing.course_type && item.course_type) { fields.push("course_type = ?"); values.push(item.course_type); }
    if (!existing.distance && item.distance) { fields.push("distance = ?"); values.push(Number(item.distance)); }
    if (!existing.weight_type && item.weight_type) { fields.push("weight_type = ?"); values.push(item.weight_type); }
    if (!existing.class_flags && item.class_flags) { fields.push("class_flags = ?"); values.push(item.class_flags); }
    if (!existing.course_direction && item.course_direction) { fields.push("course_direction = ?"); values.push(item.course_direction); }
    values.push(existing.id);

    await env.DB.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    await linkUnregisteredImportsToRace(env.DB, existing.id, raceDate, track, raceNumber);
    if (mergedEntries.some((e) => e.horse_number !== null)) {
      await backfillHorseNamesForRace(env.DB, existing.id, mergedEntries);
    }

    // 保険: このレースが既に着順・払戻確定済み(木金を省略し結果PDFが先に取り込まれていた等)の
    // 場合でも、出走馬情報の更新だけでpayoutが崩れないよう、既存の確定情報のまま再計算しておく。
    const existingFinishOrder = existing.finish_order ? JSON.parse(existing.finish_order) : null;
    const existingPayouts = existing.payouts ? JSON.parse(existing.payouts) : null;
    if (existingFinishOrder || existingPayouts) {
      await recomputeTicketPayoutsForRace(env.DB, existing.id, existingFinishOrder, existingPayouts, mergedEntries);
    }

    results.push({ status: "updated", id: existing.id, key, conflicts });
  }

  return Response.json({ ok: true, results });
}
