// レース結果詳細(race_results)へのUPSERT。
// 2026-09-01: functions/api/_shared.js から分割(リファクタリング。詳細は_lib/auth.js冒頭の注記参照)。
//
// JRAレース結果PDFインポートで解析した馬単位の結果レコードを race_results へ反映する。
// records: [{ horse_number, waku_number, horse_name, sex_age, weight_carried, jockey,
//             status, finish_position, time_text, margin, corner_positions,
//             final_furlong_time, body_weight, body_weight_change, incident_note }]
//
// incident_note は、既存値が空、または直前の自動転記内容と完全一致する場合のみ
// 新しい自動転記内容で上書きする(管理者が手動で加筆した内容を保護するため)。
//
// jockeyフィールドは、呼び出し元(results-import.js)が事前に jockey_aliases で正規化した
// 値を渡す想定(この関数自体は正規化を行わない)。

export async function upsertRaceResults(db, raceId, records) {
  if (!db || !raceId || !Array.isArray(records) || records.length === 0) return { updated: 0 };

  const horseNumbers = records
    .map((r) => Number(r.horse_number))
    .filter((n) => Number.isInteger(n));
  let existingByNumber = new Map();
  if (horseNumbers.length) {
    const placeholders = horseNumbers.map(() => "?").join(",");
    const { results } = await db.prepare(
      `SELECT horse_number, incident_note, waku_number FROM race_results WHERE race_id = ? AND horse_number IN (${placeholders})`
    ).bind(raceId, ...horseNumbers).all();
    existingByNumber = new Map((results || []).map((r) => [
      Number(r.horse_number),
      { incident_note: r.incident_note || "", waku_number: r.waku_number ?? null },
    ]));
  }

  const statements = [];
  const now = new Date().toISOString();
  for (const r of records) {
    const horseNumber = Number(r.horse_number);
    if (!Number.isInteger(horseNumber)) continue;

    const existing = existingByNumber.get(horseNumber) || null;

    const newIncident = r.incident_note || null;
    const existingIncident = existing ? existing.incident_note : null;
    // 既存値が空、または「新しい自動転記内容と完全一致(前回も同じ注記だった)」の場合のみ上書きする。
    // 既存値が空でなく、かつ新しい内容と異なる場合は、管理者による加筆とみなして保持する。
    const incidentToSave = (!existingIncident || existingIncident === newIncident)
      ? newIncident
      : existingIncident;

    // waku_number はPDFから取得できないため、取込側は基本的にnullを送る。
    // 既存に手動入力された値があれば、それを消さないよう維持する。
    const wakuToSave = (r.waku_number !== null && r.waku_number !== undefined)
      ? r.waku_number
      : (existing ? existing.waku_number : null);

    statements.push(db.prepare(
      `INSERT INTO race_results
        (race_id, horse_number, waku_number, horse_name, sex_age, weight_carried, jockey,
         status, finish_position, time_text, margin, corner_positions, final_furlong_time,
         body_weight, body_weight_change, win_popularity, incident_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(race_id, horse_number) DO UPDATE SET
         waku_number=excluded.waku_number,
         horse_name=excluded.horse_name,
         sex_age=excluded.sex_age,
         weight_carried=excluded.weight_carried,
         jockey=excluded.jockey,
         status=excluded.status,
         finish_position=excluded.finish_position,
         time_text=excluded.time_text,
         margin=excluded.margin,
         corner_positions=excluded.corner_positions,
         final_furlong_time=excluded.final_furlong_time,
         body_weight=excluded.body_weight,
         body_weight_change=excluded.body_weight_change,
         win_popularity=excluded.win_popularity,
         incident_note=excluded.incident_note,
         updated_at=excluded.updated_at`
    ).bind(
      raceId,
      horseNumber,
      wakuToSave,
      r.horse_name || null,
      r.sex_age || null,
      r.weight_carried ?? null,
      r.jockey || null,
      r.status || "finished",
      r.finish_position ?? null,
      r.time_text || null,
      r.margin || null,
      r.corner_positions || null,
      r.final_furlong_time ?? null,
      r.body_weight ?? null,
      r.body_weight_change || null,
      r.win_popularity ?? null,
      incidentToSave,
      now,
      now
    ));
  }

  if (statements.length) await db.batch(statements);
  return { updated: statements.length };
}

// ---- 複数レースをまとめて処理するバルク版 ----
// results-import.js(JRAレース結果PDF一括登録)が、12レース分などをまとめて処理する際に
// レースごとの逐次呼び出しによるサブリクエスト数超過を避けるために使う。
// raceRecordsList: [{ raceId, records }, ...]
export async function upsertRaceResultsBulk(db, raceRecordsList) {
  const targets = (raceRecordsList || []).filter((x) => x && x.raceId && Array.isArray(x.records) && x.records.length);
  if (!db || !targets.length) return { updated: 0 };

  const raceIds = targets.map((x) => x.raceId);
  const placeholders = raceIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT race_id, horse_number, incident_note, waku_number FROM race_results WHERE race_id IN (${placeholders})`)
    .bind(...raceIds)
    .all();
  const existingMap = new Map(
    (results || []).map((r) => [`${r.race_id}_${r.horse_number}`, { incident_note: r.incident_note || "", waku_number: r.waku_number ?? null }])
  );

  const statements = [];
  const now = new Date().toISOString();

  for (const { raceId, records } of targets) {
    for (const r of records) {
      const horseNumber = Number(r.horse_number);
      if (!Number.isInteger(horseNumber)) continue;

      const existing = existingMap.get(`${raceId}_${horseNumber}`) || null;

      const newIncident = r.incident_note || null;
      const existingIncident = existing ? existing.incident_note : null;
      const incidentToSave = (!existingIncident || existingIncident === newIncident) ? newIncident : existingIncident;

      const wakuToSave = (r.waku_number !== null && r.waku_number !== undefined) ? r.waku_number : (existing ? existing.waku_number : null);

      statements.push(
        db
          .prepare(
            `INSERT INTO race_results
              (race_id, horse_number, waku_number, horse_name, sex_age, weight_carried, jockey,
               status, finish_position, time_text, margin, corner_positions, final_furlong_time,
               body_weight, body_weight_change, win_popularity, incident_note, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(race_id, horse_number) DO UPDATE SET
               waku_number=excluded.waku_number,
               horse_name=excluded.horse_name,
               sex_age=excluded.sex_age,
               weight_carried=excluded.weight_carried,
               jockey=excluded.jockey,
               status=excluded.status,
               finish_position=excluded.finish_position,
               time_text=excluded.time_text,
               margin=excluded.margin,
               corner_positions=excluded.corner_positions,
               final_furlong_time=excluded.final_furlong_time,
               body_weight=excluded.body_weight,
               body_weight_change=excluded.body_weight_change,
               win_popularity=excluded.win_popularity,
               incident_note=excluded.incident_note,
               updated_at=excluded.updated_at`
          )
          .bind(
            raceId,
            horseNumber,
            wakuToSave,
            r.horse_name || null,
            r.sex_age || null,
            r.weight_carried ?? null,
            r.jockey || null,
            r.status || "finished",
            r.finish_position ?? null,
            r.time_text || null,
            r.margin || null,
            r.corner_positions || null,
            r.final_furlong_time ?? null,
            r.body_weight ?? null,
            r.body_weight_change || null,
            r.win_popularity ?? null,
            incidentToSave,
            now,
            now
          )
      );
    }
  }

  if (statements.length) await db.batch(statements);
  return { updated: statements.length };
}
