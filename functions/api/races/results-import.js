import {
  requireAdmin,
  backfillHorseNamesForRace,
  linkUnregisteredImportsToRace,
  recomputeTicketPayoutsForRaces,
  mergeEntriesByHorseName,
  upsertRaceResultsBulk,
  loadJockeyAliasMap,
  applyJockeyAliasMap,
} from "../_shared.js";

// 2026-08-30: entries-import.js と同じ理由(Cloudflare Pages Functionsの1リクエスト
// あたりのサブリクエスト数上限に抵触し「一括登録に失敗しました」となる不具合)により、
// レースごとに逐次await(SELECT/INSERT/UPDATE/race_results UPSERT/払戻再計算等)していた
// 実装を、「1回のSELECTでまとめて取得→メモリ上で判定→db.batch()でまとめて書き込む」
// 方式へ書き直した。race_results UPSERT(upsertRaceResultsBulk)・tickets.payout再計算
// (recomputeTicketPayoutsForRaces)はいずれも複数レースをまとめて処理するバルク版を
// functions/api/_shared.js に新設し、そちらを使う(単一レース向けの
// upsertRaceResults()・recomputeTicketPayoutsForRace() は他の呼び出し元
// ([id].js・entries-import.js・tickets/bulk.js)のためにそのまま維持している)。
// 業務ロジック(fill-empty/overwrite/skip-existingの各モード・entries共通マージ・
// 騎手名エイリアス正規化・incident_noteの保護ルール等)自体は変更していない。

const BET_TYPES = ["tan", "fuku", "wakuren", "umaren", "umatan", "wide", "sanrenpuku", "sanrentan"];

function normRaceKey(r) { return `${r.race_date}__${String(r.track || "").trim()}__${Number(r.race_number)}`; }

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { request, env } = context;
  const db = env.DB;

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "リクエストが不正です" }, { status: 400 }); }
  const races = Array.isArray(body?.races) ? body.races : [];
  if (!races.length) return Response.json({ error: "インポート対象のレースがありません" }, { status: 400 });

  const aliasMap = await loadJockeyAliasMap(db);

  const results = [];
  const items = [];

  for (const item of races) {
    if (!item?.race_date || !item?.track || !Number(item?.race_number)) {
      results.push({ status: "invalid", key: normRaceKey(item || {}), message: "開催日・競馬場・レース番号が不足しています" });
      continue;
    }
    const raceNumber = Number(item.race_number);

    const incomingEntries = (Array.isArray(item.entries) ? item.entries : []).map((e) => ({
      horse_name: e.horse_name,
      waku_number: e.waku_number ?? null,
      horse_number: e.horse_number ?? null,
      jockey: e.jockey ? applyJockeyAliasMap(aliasMap, e.jockey) : null,
      sex_age: e.sex_age || null,
      weight_carried: e.weight_carried ?? null,
    }));
    const finishOrder = Array.isArray(item.finish_order) && item.finish_order.length ? item.finish_order : null;
    const payouts = item.payouts && typeof item.payouts === "object" ? item.payouts : {};
    const raceResultsInput = (Array.isArray(item.race_results) ? item.race_results : []).map((r) => (
      r.jockey ? { ...r, jockey: applyJockeyAliasMap(aliasMap, r.jockey) } : r
    ));

    items.push({
      raceDate: item.race_date,
      track: item.track,
      raceNumber,
      key: normRaceKey(item),
      item,
      incomingEntries,
      finishOrder,
      payouts,
      raceResultsInput,
    });
  }

  if (!items.length) return Response.json({ ok: true, results });

  // 1) 既存レースをまとめて取得する。
  const uniqueDates = [...new Set(items.map((x) => x.raceDate))];
  const datePlaceholders = uniqueDates.map(() => "?").join(",");
  const { results: existingRaceRows } = await db
    .prepare(`SELECT * FROM races WHERE race_date IN (${datePlaceholders})`)
    .bind(...uniqueDates)
    .all();
  const existingByKey = new Map(
    (existingRaceRows || []).map((r) => [`${r.race_date}__${r.track}__${r.race_number}`, r])
  );

  const toInsert = [];
  const toUpdate = [];

  for (const it of items) {
    const rk = `${it.raceDate}__${it.track}__${it.raceNumber}`;
    const existing = existingByKey.get(rk);

    if (!existing) {
      const { entries } = mergeEntriesByHorseName([], it.incomingEntries);
      toInsert.push({ ...it, entries });
      continue;
    }

    const existingFinish = existing.finish_order ? JSON.parse(existing.finish_order) : null;
    const existingPayouts = existing.payouts ? JSON.parse(existing.payouts) : null;
    const finishDiff = JSON.stringify(existingFinish || null) !== JSON.stringify(it.finishOrder || null);
    const payoutDiff = JSON.stringify(existingPayouts || {}) !== JSON.stringify(it.payouts || {});

    if (body.mode === "skip-existing") {
      results.push({ status: "skipped", id: existing.id, key: it.key, finishDiff, payoutDiff });
      continue;
    }

    let currentEntries = [];
    try { currentEntries = JSON.parse(existing.entries || "[]"); } catch { currentEntries = []; }
    const { entries: mergedEntries } = mergeEntriesByHorseName(currentEntries, it.incomingEntries);

    toUpdate.push({ ...it, existing, existingFinish, existingPayouts, finishDiff, payoutDiff, mergedEntries });
  }

  // 2) 新規レースをまとめてINSERTする。
  if (toInsert.length) {
    const stmts = toInsert.map((it) =>
      db.prepare(
        `INSERT INTO races (race_date, track, race_number, race_name, course_type, distance,
          weight_type, class_flags, course_direction, weather, track_condition,
          entries, finish_order, payouts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.raceDate, it.track, it.raceNumber, it.item.race_name || null, it.item.course_type || null,
        it.item.distance ? Number(it.item.distance) : null,
        it.item.weight_type || null, it.item.class_flags || null, it.item.course_direction || null,
        it.item.weather || null, it.item.track_condition || null,
        JSON.stringify(it.entries),
        it.finishOrder ? JSON.stringify(it.finishOrder) : null,
        Object.keys(it.payouts).length ? JSON.stringify(it.payouts) : null
      )
    );
    const batchResults = await db.batch(stmts);
    batchResults.forEach((res, i) => {
      const id = res.meta.last_row_id;
      toInsert[i].id = id;
      results.push({ status: "created", id, key: toInsert[i].key, race_name: toInsert[i].item.race_name || null });
    });
  }

  // 3) 既存レースをまとめてUPDATEする。各レースごとに、実際にDBへ書き込まれる
  //    finish_order/payoutsの最終値(finalFinishOrder/finalPayoutsObj)も同時に
  //    算出しておき、後段の払戻再計算(recomputeTicketPayoutsForRaces)で
  //    再SELECTせずそのまま使う。
  if (toUpdate.length) {
    const stmts = [];
    for (const it of toUpdate) {
      const fields = [];
      const values = [];
      let finishOrPayoutTouched = false;

      const finishTouch = body.mode === "overwrite" || !it.existingFinish;
      if (finishTouch) {
        fields.push("finish_order = ?");
        values.push(it.finishOrder ? JSON.stringify(it.finishOrder) : null);
        finishOrPayoutTouched = true;
      }
      it.finalFinishOrder = finishTouch ? it.finishOrder : it.existingFinish;

      const payoutTouch = body.mode === "overwrite" || !it.existingPayouts || Object.keys(it.existingPayouts || {}).length === 0;
      if (payoutTouch) {
        fields.push("payouts = ?");
        values.push(Object.keys(it.payouts).length ? JSON.stringify(it.payouts) : null);
        finishOrPayoutTouched = true;
      }
      it.finalPayoutsObj = payoutTouch ? (Object.keys(it.payouts).length ? it.payouts : null) : it.existingPayouts;

      fields.push("entries = ?");
      values.push(JSON.stringify(it.mergedEntries));
      if (!it.existing.race_name && it.item.race_name) { fields.push("race_name = ?"); values.push(it.item.race_name); }
      if (!it.existing.course_type && it.item.course_type) { fields.push("course_type = ?"); values.push(it.item.course_type); }
      if (!it.existing.distance && it.item.distance) { fields.push("distance = ?"); values.push(Number(it.item.distance)); }
      if (!it.existing.weight_type && it.item.weight_type) { fields.push("weight_type = ?"); values.push(it.item.weight_type); }
      if (!it.existing.class_flags && it.item.class_flags) { fields.push("class_flags = ?"); values.push(it.item.class_flags); }
      if (!it.existing.course_direction && it.item.course_direction) { fields.push("course_direction = ?"); values.push(it.item.course_direction); }
      if (it.item.weather) { fields.push("weather = ?"); values.push(it.item.weather); }
      if (it.item.track_condition) { fields.push("track_condition = ?"); values.push(it.item.track_condition); }

      it.id = it.existing.id;
      it.finishOrPayoutTouched = finishOrPayoutTouched;
      it.fieldsCount = fields.length;

      values.push(it.existing.id);
      stmts.push(db.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`).bind(...values));
    }
    if (stmts.length) await db.batch(stmts);

    toUpdate.forEach((it) => {
      results.push({
        status: it.fieldsCount ? "updated" : "unchanged",
        id: it.id,
        key: it.key,
        finishDiff: it.finishDiff,
        payoutDiff: it.payoutDiff,
      });
    });
  }

  const allProcessed = [...toInsert, ...toUpdate];

  // 4) 未登録レースへのCSV取込データの紐付けをまとめて行う。
  {
    const { results: pendingGroups } = await db
      .prepare(
        `SELECT id, race_date, track, race_number FROM imported_ticket_groups
         WHERE race_id IS NULL AND race_date IN (${datePlaceholders})`
      )
      .bind(...uniqueDates)
      .all();

    const raceIdByKey = new Map(allProcessed.map((it) => [`${it.raceDate}__${it.track}__${it.raceNumber}`, it.id]));
    const groupIdsByRaceId = new Map();
    for (const g of pendingGroups || []) {
      const rid = raceIdByKey.get(`${g.race_date}__${g.track}__${Number(g.race_number)}`);
      if (!rid) continue;
      if (!groupIdsByRaceId.has(rid)) groupIdsByRaceId.set(rid, []);
      groupIdsByRaceId.get(rid).push(g.id);
    }

    if (groupIdsByRaceId.size) {
      const stmts = [];
      for (const [rid, groupIds] of groupIdsByRaceId) {
        const placeholders = groupIds.map(() => "?").join(",");
        stmts.push(
          db.prepare(`UPDATE imported_ticket_groups SET race_id = ? WHERE id IN (${placeholders})`).bind(rid, ...groupIds)
        );
        stmts.push(
          db.prepare(`UPDATE imported_ticket_items SET race_id = ? WHERE group_id IN (${placeholders})`).bind(rid, ...groupIds)
        );
      }
      if (stmts.length) await db.batch(stmts);
    }
  }

  // 5) 馬名・騎手のバックフィルをまとめて行う。
  const raceIdsNeedingBackfill = allProcessed
    .filter((it) => (it.entries || it.mergedEntries || []).some((e) => e.horse_number !== null && e.horse_number !== undefined))
    .map((it) => it.id);

  if (raceIdsNeedingBackfill.length) {
    const nameByRaceId = new Map();
    for (const it of allProcessed) {
      const entries = it.entries || it.mergedEntries || [];
      const m = new Map();
      for (const e of entries) {
        const hn = Number(e.horse_number);
        if (!Number.isInteger(hn)) continue;
        const horse_name = e.horse_name ? String(e.horse_name).trim() : "";
        const jockey = e.jockey ? String(e.jockey).trim() : "";
        if (!horse_name && !jockey) continue;
        m.set(hn, { horse_name: horse_name || null, jockey: jockey || null });
      }
      if (m.size) nameByRaceId.set(it.id, m);
    }

    const idPlaceholders = raceIdsNeedingBackfill.map(() => "?").join(",");
    for (const table of ["imported_ticket_items", "tickets"]) {
      const { results: rows } = await db
        .prepare(`SELECT id, race_id, selections FROM ${table} WHERE race_id IN (${idPlaceholders})`)
        .bind(...raceIdsNeedingBackfill)
        .all();

      const stmts = [];
      for (const row of rows || []) {
        const nameMap = nameByRaceId.get(row.race_id);
        if (!nameMap) continue;
        let selections;
        try { selections = JSON.parse(row.selections || "[]"); } catch { continue; }
        if (!Array.isArray(selections) || !selections.length) continue;

        let changed = false;
        const next = selections.map((s) => {
          const info = nameMap.get(Number(s?.horse_number));
          if (!info) return s;
          const merged = { ...s };
          if (info.horse_name && merged.horse_name !== info.horse_name) { merged.horse_name = info.horse_name; changed = true; }
          if (info.jockey && merged.jockey !== info.jockey) { merged.jockey = info.jockey; changed = true; }
          return merged;
        });

        if (changed) {
          stmts.push(db.prepare(`UPDATE ${table} SET selections = ? WHERE id = ?`).bind(JSON.stringify(next), row.id));
        }
      }
      if (stmts.length) await db.batch(stmts);
    }
  }

  // 6) race_results(全着順・タイム等の詳細記録)をまとめてUPSERTする。
  const raceResultsList = allProcessed
    .filter((it) => it.raceResultsInput && it.raceResultsInput.length)
    .map((it) => ({ raceId: it.id, records: it.raceResultsInput }));
  if (raceResultsList.length) {
    await upsertRaceResultsBulk(db, raceResultsList);
  }

  // 7) 着順・払戻が確定/更新されたレース分の tickets.payout をまとめて再計算する。
  //    新規作成レースはfinish_order/payoutsのいずれかがあれば対象、既存レースは
  //    finishOrPayoutTouchedがtrueのものだけを対象にする。既存レースについては
  //    ステップ3で算出済みの finalFinishOrder/finalPayoutsObj(実際にDBへ書き込まれた
  //    値と同じ)をそのまま使い、UPDATE直後の再SELECTは行わない。
  const recomputeUpdates = [];
  for (const it of toInsert) {
    if (it.finishOrder || Object.keys(it.payouts).length) {
      recomputeUpdates.push({
        raceId: it.id,
        finishOrder: it.finishOrder || null,
        payoutsObj: Object.keys(it.payouts).length ? it.payouts : null,
        entries: it.entries,
      });
    }
  }
  for (const it of toUpdate) {
    if (it.finishOrPayoutTouched) {
      recomputeUpdates.push({
        raceId: it.id,
        finishOrder: it.finalFinishOrder || null,
        payoutsObj: (it.finalPayoutsObj && Object.keys(it.finalPayoutsObj).length) ? it.finalPayoutsObj : null,
        entries: it.mergedEntries,
      });
    }
  }
  if (recomputeUpdates.length) {
    await recomputeTicketPayoutsForRaces(db, recomputeUpdates);
  }

  return Response.json({ ok: true, results });
}