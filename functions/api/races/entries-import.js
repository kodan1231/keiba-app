import {
  requireAdmin,
  mergeEntriesByHorseName,
  recomputeTicketPayoutsForRace,
  loadJockeyAliasMap,
  applyJockeyAliasMap,
} from "../_shared.js";

// 出走馬一覧PDF(枠番・馬番なし/あり 共通)からの一括登録・更新。管理者専用。
// 詳細な設計方針は docs/DESIGN.md「出走馬一覧PDFインポート」参照。
//
// 重要: 既存レースがある場合、レース行(races.id)は絶対に削除・再作成しない。
// DELETE→INSERTしてしまうと、prediction_marks/prediction_notesがON DELETE CASCADEで
// 一緒に消えてしまうため、既存レースは常にUPDATEで対応する。
//
// 2026-08-30: レースごとに逐次await(SELECT/INSERT/UPDATE/バックフィル等)していた
// 実装を、Cloudflare Pages Functionsの1リクエストあたりのサブリクエスト数上限
// (無料プランは50)に抵触して「一括登録に失敗しました」となる不具合が報告されたため、
// 「1回のSELECTでまとめて取得→メモリ上で判定→db.batch()でまとめて書き込む」方式へ
// 書き直した。functions/api/ticket-imports/index.js(CSVインポート)で既に採用している
// パターンを踏襲している。レース件数が増えても、このAPI呼び出し全体のクエリ回数は
// ほぼ一定(十数回程度)に収まる。業務ロジック(馬名マージ・競合検出・騎手名エイリアス
// 正規化・CSV未登録データの紐付け・馬名バックフィル・払戻保険再計算)自体は変更していない。

function normalizeHorseName(v) {
  return String(v ?? "").replace(/[\u3000\s]+/g, " ").trim();
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const db = env.DB;

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

  const aliasMap = await loadJockeyAliasMap(db);

  const results = [];
  const items = [];

  for (const item of races) {
    const raceDate = item?.race_date;
    const track = item?.track;
    const raceNumber = Number(item?.race_number);
    const key = `${raceDate} ${track} ${raceNumber}R`;

    if (!raceDate || !track || !raceNumber || !Array.isArray(item?.entries) || item.entries.length === 0) {
      results.push({ status: "invalid", key, message: "開催日・競馬場・レース番号・出走馬情報が不足しています" });
      continue;
    }

    const incomingEntries = item.entries
      .filter((e) => normalizeHorseName(e?.horse_name)) // 念のための防御(空馬名は登録しない)
      .map((e) => ({
        horse_name: e.horse_name,
        waku_number: e.waku_number ?? null,
        horse_number: e.horse_number ?? null,
        jockey: e.jockey ? applyJockeyAliasMap(aliasMap, e.jockey) : null,
        sex_age: e.sex_age || null,
        weight_carried: e.weight_carried ?? null,
      }));

    items.push({
      raceDate,
      track,
      raceNumber,
      key,
      incomingEntries,
      race_name: item.race_name || null,
      course_type: item.course_type || null,
      distance: item.distance ? Number(item.distance) : null,
      weight_type: item.weight_type || null,
      class_flags: item.class_flags || null,
      course_direction: item.course_direction || null,
    });
  }

  if (!items.length) {
    return Response.json({ ok: true, results });
  }

  // 1) 既存レースをまとめて取得する。race_date の IN 句で絞り込み、track/race_number は
  //    メモリ上で照合する(1レースごとに個別SELECTするより大幅にクエリ回数を削減できる。
  //    同一開催日のPDF一括インポートでは全レースが同じrace_dateのため、実質1回で済む)。
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
    } else {
      let currentEntries = [];
      try {
        currentEntries = JSON.parse(existing.entries || "[]");
      } catch {
        currentEntries = [];
      }
      const { entries: mergedEntries, conflicts } = mergeEntriesByHorseName(currentEntries, it.incomingEntries);
      toUpdate.push({ ...it, existing, mergedEntries, conflicts });
    }
  }

  // 2) 新規レースをまとめてINSERTする(db.batch()で1回のラウンドトリップにまとめる)。
  if (toInsert.length) {
    const stmts = toInsert.map((it) =>
      db
        .prepare(
          `INSERT INTO races (race_date, track, race_number, race_name, course_type, distance,
            weight_type, class_flags, course_direction, entries)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          it.raceDate,
          it.track,
          it.raceNumber,
          it.race_name,
          it.course_type,
          it.distance,
          it.weight_type,
          it.class_flags,
          it.course_direction,
          JSON.stringify(it.entries)
        )
    );
    const batchResults = await db.batch(stmts);
    batchResults.forEach((res, i) => {
      const id = res.meta.last_row_id;
      toInsert[i].id = id;
      results.push({ status: "created", id, key: toInsert[i].key, conflicts: [] });
    });
  }

  // 3) 既存レースをまとめてUPDATEする。
  if (toUpdate.length) {
    const stmts = toUpdate.map((it) => {
      const fields = ["entries = ?"];
      const values = [JSON.stringify(it.mergedEntries)];
      if (!it.existing.race_name && it.race_name) {
        fields.push("race_name = ?");
        values.push(it.race_name);
      }
      if (!it.existing.course_type && it.course_type) {
        fields.push("course_type = ?");
        values.push(it.course_type);
      }
      if (!it.existing.distance && it.distance) {
        fields.push("distance = ?");
        values.push(it.distance);
      }
      if (!it.existing.weight_type && it.weight_type) {
        fields.push("weight_type = ?");
        values.push(it.weight_type);
      }
      if (!it.existing.class_flags && it.class_flags) {
        fields.push("class_flags = ?");
        values.push(it.class_flags);
      }
      if (!it.existing.course_direction && it.course_direction) {
        fields.push("course_direction = ?");
        values.push(it.course_direction);
      }
      values.push(it.existing.id);
      return db.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`).bind(...values);
    });
    await db.batch(stmts);
    toUpdate.forEach((it) => {
      it.id = it.existing.id;
      results.push({ status: "updated", id: it.existing.id, key: it.key, conflicts: it.conflicts });
    });
  }

  const allProcessed = [...toInsert, ...toUpdate];

  // 4) 未登録レースへのCSV取込データの紐付け(linkUnregisteredImportsToRace相当)を
  //    まとめて行う。対象のrace_dateにマッチする未紐付けの imported_ticket_groups を
  //    1回のSELECTでまとめて取得し、race_date/track/race_numberが一致するものだけを
  //    メモリ上で振り分けたうえで、まとめてUPDATEする。
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

  // 5) 馬名・騎手のバックフィル(backfillHorseNamesForRace相当)をまとめて行う。
  //    horse_numberが確定した馬を1頭以上含むレースだけを対象にする。
  const raceIdsNeedingBackfill = allProcessed
    .filter((it) => (it.entries || it.mergedEntries || []).some((e) => e.horse_number !== null && e.horse_number !== undefined))
    .map((it) => it.id);

  if (raceIdsNeedingBackfill.length) {
    const nameByRaceId = new Map(); // raceId -> Map(horseNumber -> {horse_name, jockey})
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
        try {
          selections = JSON.parse(row.selections || "[]");
        } catch {
          continue;
        }
        if (!Array.isArray(selections) || !selections.length) continue;

        let changed = false;
        const next = selections.map((s) => {
          const info = nameMap.get(Number(s?.horse_number));
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
          stmts.push(db.prepare(`UPDATE ${table} SET selections = ? WHERE id = ?`).bind(JSON.stringify(next), row.id));
        }
      }
      if (stmts.length) await db.batch(stmts);
    }
  }

  // 6) 払戻の保険再計算(recomputeTicketPayoutsForRace)は、既に着順または払戻が
  //    確定済みだった既存レース(通常の木・金の出走馬インポートではほぼ発生しない)
  //    だけを対象にする。新規作成したレースは、この時点でticketsが存在しえないため
  //    (linkUnregisteredImportsToRaceが紐付けるのはimported_ticket_groups/itemsのみで、
  //    通常購入のticketsテーブルはこの経路では紐付かない)呼び出し自体を省略している。
  const settledExisting = toUpdate.filter((it) => it.existing.finish_order || it.existing.payouts);
  for (const it of settledExisting) {
    const finishOrder = it.existing.finish_order ? JSON.parse(it.existing.finish_order) : null;
    const payoutsObj = it.existing.payouts ? JSON.parse(it.existing.payouts) : null;
    await recomputeTicketPayoutsForRace(db, it.id, finishOrder, payoutsObj, it.mergedEntries);
  }

  return Response.json({ ok: true, results });
}