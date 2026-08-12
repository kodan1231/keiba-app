import { backfillHorseNamesForRace, linkUnregisteredImportsToRace, requireAdmin, recomputeTicketPayoutsForRace } from "../_shared.js";

// PUT(編集)・DELETE(削除)ともに管理者のみ実行可能。
export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env, params } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "リクエストが不正です" }), { status: 400 });
  }

  const fields = [];
  const values = [];

  for (const key of [
    "race_date", "track", "race_number", "race_name", "course_type", "distance",
    // 2026-08-11追加: レース条件詳細カラム。手動編集用のUIは今回未整備だが、
    // PDFインポート以外の経路(将来のUI等)からも更新できるよう受け付けておく。
    "weight_type", "class_flags", "course_direction", "weather", "track_condition",
  ]) {
    if (key in data) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if ("entries" in data) {
    if (!Array.isArray(data.entries)) {
      return new Response(JSON.stringify({ error: "entriesの形式が不正です" }), { status: 400 });
    }
    fields.push("entries = ?");
    values.push(JSON.stringify(data.entries));
  }
  if ("finish_order" in data) {
    fields.push("finish_order = ?");
    values.push(data.finish_order ? JSON.stringify(data.finish_order) : null);
  }
  if ("payouts" in data) {
    fields.push("payouts = ?");
    values.push(data.payouts ? JSON.stringify(data.payouts) : null);
  }

  if (fields.length === 0) {
    return new Response(JSON.stringify({ error: "更新する項目がありません" }), { status: 400 });
  }

  values.push(params.id);
  await env.DB.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  // 出走馬表(馬名・騎手)が更新された場合、同じレースを参照しているCSV取込データ・
  // 購入履歴のうち、馬番だけで馬名・騎手が空になっているものへ反映(バックフィル)する。
  if ("entries" in data) {
    await backfillHorseNamesForRace(env.DB, Number(params.id), data.entries);
  }
  // 日付・競馬場・レース番号のいずれかが変わった(または初めて確定した)可能性があるため、
  // 未紐付けのCSV取込データが無いか毎回確認して紐付ける。
  if ("race_date" in data || "track" in data || "race_number" in data) {
    const race = await env.DB.prepare("SELECT race_date, track, race_number FROM races WHERE id = ?").bind(params.id).first();
    if (race) await linkUnregisteredImportsToRace(env.DB, Number(params.id), race.race_date, race.track, race.race_number);
  }

  // 着順(finish_order)または払戻(payouts)が更新された場合、このレースを購入した
  // 「全ユーザーの」tickets.payout を再計算して反映する
  // (races は共有データ、tickets はユーザーごとに分離されたデータであるため、
  //  user_idで絞り込まず該当race_idの全ticketsを対象にする必要がある。
  //  詳細はdocs/DESIGN.md「払戻確定時のticket反映」参照)。
  if ("finish_order" in data || "payouts" in data) {
    const race = await env.DB.prepare("SELECT entries, finish_order, payouts FROM races WHERE id = ?").bind(params.id).first();
    if (race) {
      const entries = race.entries ? JSON.parse(race.entries) : [];
      const finishOrder = race.finish_order ? JSON.parse(race.finish_order) : null;
      const payoutsObj = race.payouts ? JSON.parse(race.payouts) : null;
      await recomputeTicketPayoutsForRace(env.DB, Number(params.id), finishOrder, payoutsObj, entries);
    }
  }

  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { env, params } = context;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "IDが不正です" }, { status: 400 });
  const race = await env.DB.prepare("SELECT id FROM races WHERE id = ?").bind(id).first();
  if (!race) return Response.json({ error: "レースが見つかりません" }, { status: 404 });
  const counts = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM tickets WHERE race_id = ?").bind(id).first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM imported_ticket_groups WHERE race_id = ?").bind(id).first().catch(()=>({c:0})),
    env.DB.prepare("SELECT COUNT(*) AS c FROM races WHERE id = ? AND (finish_order IS NOT NULL OR payouts IS NOT NULL)").bind(id).first(),
  ]);
  const hasRelated = Number(counts[0]?.c || 0) > 0 || Number(counts[1]?.c || 0) > 0;
  const hasResult = Number(counts[2]?.c || 0) > 0;
  const url = new URL(context.request.url);
  const force = url.searchParams.get("force") === "1";
  if ((hasRelated || hasResult) && !force) {
    return Response.json({ error: "購入履歴または結果が紐付いたレースです。削除する場合は明示的に確認してください。", requires_confirmation: true, has_related: hasRelated, has_result: hasResult }, { status: 409 });
  }
  // imported_ticket_groups が参照している imported_tickets(CSV原本)のIDを先に取得しておく。
  // これを削除しないと、レースを消してもCSV原本だけが「孤立した購入履歴」として
  // 一覧に残り続け、しかも同じCSVを再取込する際に重複扱いされて再取込できなくなる。
  const importedSourceRows = (await env.DB.prepare(
    "SELECT source_row_id FROM imported_ticket_groups WHERE race_id = ? AND source_row_id IS NOT NULL"
  ).bind(id).all()).results || [];
  const sourceRowIds = importedSourceRows.map((r) => r.source_row_id).filter((v) => v !== null && v !== undefined);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM prediction_marks WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM prediction_notes WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM imported_ticket_items WHERE race_id = ?").bind(id),
    env.DB.prepare("DELETE FROM imported_ticket_groups WHERE race_id = ?").bind(id),
    ...(sourceRowIds.length
      ? [env.DB.prepare(`DELETE FROM imported_tickets WHERE id IN (${sourceRowIds.map(() => "?").join(",")})`).bind(...sourceRowIds)]
      : []),
    env.DB.prepare("DELETE FROM tickets WHERE race_id = ?").bind(id),
    // race_results は races への ON DELETE CASCADE で連動して削除されるため、
    // 明示的なDELETE文は不要(migration.sqlのrace_resultsテーブル定義を参照)。
    env.DB.prepare("DELETE FROM races WHERE id = ?").bind(id),
  ]);
  return Response.json({ ok: true });
}
