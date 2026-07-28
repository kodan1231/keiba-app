const ALLOWED_MARKS = new Set(["◎", "○", "▲", "△", "☆"]);

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeMarks(marks) {
  if (!Array.isArray(marks)) return null;
  const seen = new Set();
  const normalized = [];

  for (const item of marks) {
    const horseNumber = Number(item?.horse_number);
    const mark = String(item?.mark || "");

    if (!Number.isInteger(horseNumber) || horseNumber < 1) {
      return null;
    }
    if (!ALLOWED_MARKS.has(mark)) {
      return null;
    }
    const key = `${horseNumber}:${mark}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ horse_number: horseNumber, mark });
  }

  return normalized;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const raceId = Number(url.searchParams.get("race_id"));

  if (!Number.isInteger(raceId) || raceId <= 0) {
    return jsonError("race_idが必要です");
  }

  const race = await env.DB.prepare(
    "SELECT id, entries FROM races WHERE id = ?"
  ).bind(raceId).first();

  if (!race) {
    return jsonError("レースが見つかりません", 404);
  }

  const [note, marksResult] = await Promise.all([
    env.DB.prepare(
      "SELECT memo, created_at, updated_at FROM prediction_notes WHERE race_id = ?"
    ).bind(raceId).first(),
    env.DB.prepare(
      "SELECT horse_number, mark, created_at, updated_at FROM prediction_marks WHERE race_id = ? ORDER BY horse_number"
    ).bind(raceId).all(),
  ]);

  return Response.json({
    race_id: raceId,
    memo: note?.memo || "",
    marks: marksResult.results || [],
    updated_at: note?.updated_at || null,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return jsonError("リクエストが不正です");
  }

  const raceId = Number(data?.race_id);
  const marks = normalizeMarks(data?.marks);
  const memo = typeof data?.memo === "string" ? data.memo.trim() : "";

  if (!Number.isInteger(raceId) || raceId <= 0) {
    return jsonError("race_idが不正です");
  }
  if (!marks) {
    return jsonError("予想印の形式が不正です");
  }
  if (memo.length > 5000) {
    return jsonError("予想メモは5000文字以内で入力してください");
  }

  const race = await env.DB.prepare(
    "SELECT id, entries FROM races WHERE id = ?"
  ).bind(raceId).first();

  if (!race) {
    return jsonError("レースが見つかりません", 404);
  }

  let entries;
  try {
    entries = JSON.parse(race.entries || "[]");
  } catch {
    return jsonError("レースの出走馬データが不正です", 500);
  }

  const validHorseNumbers = new Set(
    entries
      .map((entry) => Number(entry?.horse_number))
      .filter((n) => Number.isInteger(n) && n > 0)
  );

  if (marks.some((item) => !validHorseNumbers.has(item.horse_number))) {
    return jsonError("登録されていない馬番に予想印が付いています");
  }

  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare("DELETE FROM prediction_marks WHERE race_id = ?").bind(raceId),
    env.DB.prepare(
      `INSERT INTO prediction_notes (race_id, memo, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(race_id) DO UPDATE SET memo = excluded.memo, updated_at = excluded.updated_at`
    ).bind(raceId, memo || null, now, now),
  ];

  for (const item of marks) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO prediction_marks (race_id, horse_number, mark, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(raceId, item.horse_number, item.mark, now, now)
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (e) {
    console.error("prediction save error", e);
    return jsonError("予想の保存に失敗しました", 500);
  }

  return Response.json({
    ok: true,
    race_id: raceId,
    marks,
    memo,
    updated_at: now,
  });
}
