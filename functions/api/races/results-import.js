import { requireAdmin, backfillHorseNamesForRace, linkUnregisteredImportsToRace } from "../_shared.js";

const BET_TYPES = ["tan", "fuku", "wakuren", "umaren", "umatan", "wide", "sanrenpuku", "sanrentan"];

function normRaceKey(r) { return `${r.race_date}__${String(r.track || "").trim()}__${Number(r.race_number)}`; }

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "リクエストが不正です" }, { status: 400 }); }
  const races = Array.isArray(body?.races) ? body.races : [];
  if (!races.length) return Response.json({ error: "インポート対象のレースがありません" }, { status: 400 });

  const results = [];
  for (const item of races) {
    if (!item?.race_date || !item?.track || !Number(item?.race_number)) {
      results.push({ status: "invalid", key: normRaceKey(item || {}), message: "開催日・競馬場・レース番号が不足しています" });
      continue;
    }
    const raceNumber = Number(item.race_number);
    const existing = await env.DB.prepare(
      "SELECT * FROM races WHERE race_date = ? AND track = ? AND race_number = ?"
    ).bind(item.race_date, item.track, raceNumber).first();

    const entries = Array.isArray(item.entries) ? item.entries : [];
    const finishOrder = Array.isArray(item.finish_order) && item.finish_order.length ? item.finish_order : null;
    const payouts = item.payouts && typeof item.payouts === "object" ? item.payouts : {};

    if (!existing) {
      const ins = await env.DB.prepare(
        `INSERT INTO races (race_date, track, race_number, race_name, course_type, distance, entries, finish_order, payouts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.race_date, item.track, raceNumber, item.race_name || null, item.course_type || null,
        item.distance ? Number(item.distance) : null, JSON.stringify(entries),
        finishOrder ? JSON.stringify(finishOrder) : null,
        Object.keys(payouts).length ? JSON.stringify(payouts) : null
      ).run();
      const id = ins.meta.last_row_id;
      await linkUnregisteredImportsToRace(env.DB, id, item.race_date, item.track, raceNumber);
      await backfillHorseNamesForRace(env.DB, id, entries);
      results.push({ status: "created", id, key: normRaceKey(item), race_name: item.race_name || null });
      continue;
    }

    const existingFinish = existing.finish_order ? JSON.parse(existing.finish_order) : null;
    const existingPayouts = existing.payouts ? JSON.parse(existing.payouts) : null;
    const finishDiff = JSON.stringify(existingFinish || null) !== JSON.stringify(finishOrder || null);
    const payoutDiff = JSON.stringify(existingPayouts || {}) !== JSON.stringify(payouts || {});
    const hasNewEntries = entries.length > 0 && (!existing.entries || JSON.parse(existing.entries || "[]").length === 0);

    if (body.mode === "skip-existing") {
      results.push({ status: "skipped", id: existing.id, key: normRaceKey(item), finishDiff, payoutDiff });
      continue;
    }

    const fields = []; const values = [];
    if (body.mode === "overwrite" || !existingFinish) { fields.push("finish_order = ?"); values.push(finishOrder ? JSON.stringify(finishOrder) : null); }
    if (body.mode === "overwrite" || !existingPayouts || Object.keys(existingPayouts || {}).length === 0) { fields.push("payouts = ?"); values.push(Object.keys(payouts).length ? JSON.stringify(payouts) : null); }
    if (hasNewEntries) { fields.push("entries = ?"); values.push(JSON.stringify(entries)); }
    if (!existing.race_name && item.race_name) { fields.push("race_name = ?"); values.push(item.race_name); }
    if (!existing.course_type && item.course_type) { fields.push("course_type = ?"); values.push(item.course_type); }
    if (!existing.distance && item.distance) { fields.push("distance = ?"); values.push(Number(item.distance)); }
    if (fields.length) { values.push(existing.id); await env.DB.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run(); }
    if (hasNewEntries) await backfillHorseNamesForRace(env.DB, existing.id, entries);
    await linkUnregisteredImportsToRace(env.DB, existing.id, existing.race_date, existing.track, existing.race_number);
    results.push({ status: fields.length ? "updated" : "unchanged", id: existing.id, key: normRaceKey(item), finishDiff, payoutDiff });
  }
  return Response.json({ ok: true, results });
}
