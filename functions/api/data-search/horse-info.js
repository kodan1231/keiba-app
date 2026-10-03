import {
  requireAdmin,
  readJsonBody,
  jsonError,
  horseAliasKeyOf,
  loadHorseAliasMap,
  applyHorseAliasMap,
  getOrFetchHorseMaster,
  saveManualHorseInfo,
  refetchHorseInfoFromNetkeiba,
} from "../_shared.js";

// データ検索画面「馬情報検索」タブの詳細API。
//   GET  ?name=<馬名>  … 過去全出走履歴(race_results)+ 馬情報マスタ(horses。無ければ
//                        netkeiba取得を試みて保存する)を返す。全ユーザー共有データの
//                        閲覧のため requireAdmin しない。
//   PUT  { name, ...editable fields } または { name, action: "refetch" } … 管理者専用。
//        前者は手動編集(data_source='manual')、後者はnetkeibaからの強制再取得。
//
// 馬名の突き合わせ・read側の設計は GET /api/races/:id/horse-history と同じ考え方
// (horse_key + horse_aliasesの逆引きキー集合をIN句で直接引く。対象は1頭ぶんの
// エイリアス数〈現実的には数件〉なので100バインド上限に抵触しない)。
// 詳細は docs/design/data-search.md「馬情報検索タブ」参照。

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toMasterJson(row) {
  if (!row) return null;
  return {
    sire: row.sire || null,
    dam: row.dam || null,
    damSire: row.dam_sire || null,
    trainer: row.trainer || null,
    owner: row.owner || null,
    breeder: row.breeder || null,
    dataSource: row.data_source || null,
    fetchError: row.fetch_error || null,
    fetchedAt: row.fetched_at || null,
    // この問い合わせでnetkeibaへ取得を試みたか(false=以前の取得結果をそのまま返している)。
    // 画面で「今回失敗した」のか「以前失敗したまま」なのかを区別するため(2026-10-03)。
    fetchedNow: Boolean(row.fetched_now),
    // netkeiba への取得を停止している期限(ISO文字列)。停止中で問い合わせなかった場合
    // (fetchError='paused')と、今回の取得で拒否されて停止を始めた場合に入る(2026-10-04)。
    pausedUntil: row.paused_until || null,
  };
}

async function resolveSearchKeys(db, name) {
  const aliasMap = await loadHorseAliasMap(db);
  const canonicalName = applyHorseAliasMap(aliasMap, name);
  const primaryKey = horseAliasKeyOf(canonicalName);
  if (!primaryKey) return null;
  const searchKeys = new Set([primaryKey]);
  for (const [aliasKey, canon] of aliasMap) {
    if (canon === canonicalName) searchKeys.add(aliasKey);
  }
  return { canonicalName, searchKeys: [...searchKeys] };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) return jsonError("馬名を指定してください", 400);

  const resolved = await resolveSearchKeys(db, name);
  if (!resolved) return jsonError("馬名が不正です", 400);
  const { canonicalName, searchKeys } = resolved;

  const placeholders = searchKeys.map(() => "?").join(",");
  const { results: rows } = await db
    .prepare(
      `SELECT rr.horse_number, rr.status, rr.finish_position, rr.win_popularity, rr.jockey,
              rr.weight_carried, rr.body_weight, rr.body_weight_change, rr.time_text, rr.margin,
              rr.final_furlong_time, rr.sex_age, rr.race_id,
              r.race_date, r.track, r.race_number, r.race_name, r.course_type, r.distance
         FROM race_results rr
         JOIN races r ON r.id = rr.race_id
        WHERE rr.horse_key IN (${placeholders})
        ORDER BY r.race_date DESC, r.race_number DESC`
    )
    .bind(...searchKeys)
    .all();

  const history = rows || [];

  // field_size(出走頭数)は、対象レース(この馬の出走回数ぶん。現実的には数十件程度)
  // だけを一括集計する。IN句は90件ずつチャンク分割する(GET /api/races/:id/horse-history
  // と同じ考え方。1頭の出走回数は構造的に数百に達しうるため念のため分割する)。
  const raceIds = [...new Set(history.map((r) => r.race_id))];
  const fieldSizeByRaceId = new Map();
  for (const idsChunk of chunk(raceIds, 90)) {
    if (!idsChunk.length) continue;
    const ph = idsChunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT race_id, COUNT(*) AS field_size FROM race_results
          WHERE race_id IN (${ph}) AND status IN ('finished','stopped') GROUP BY race_id`
      )
      .bind(...idsChunk)
      .all();
    for (const r of results || []) fieldSizeByRaceId.set(r.race_id, r.field_size);
  }

  // 直近出走時点の性齢を「現在の性別・馬齢」として表示する(去勢等で性別が変わりうる
  // ため、常に最新のレースを正とする。docs/design/data-search.md参照)。
  let sex = null;
  let age = null;
  let expectedBirthYear;
  const latest = history[0];
  if (latest?.sex_age) {
    const m = String(latest.sex_age).match(/^(牡|牝|せん|セ|騸)(\d+)$/);
    if (m) {
      sex = m[1];
      age = Number(m[2]);
      const raceYear = Number(String(latest.race_date || "").slice(0, 4));
      if (Number.isInteger(age) && Number.isInteger(raceYear)) expectedBirthYear = raceYear - age + 1;
    }
  }

  const master = await getOrFetchHorseMaster(db, canonicalName, { expectedBirthYear });

  return Response.json({
    name: canonicalName,
    sex,
    age,
    ageAsOfRaceDate: latest?.race_date ?? null,
    master: toMasterJson(master),
    history: history.map((r) => ({
      race_date: r.race_date,
      track: r.track,
      race_number: r.race_number,
      race_name: r.race_name || null,
      course_type: r.course_type || null,
      distance: r.distance ?? null,
      status: r.status || "finished",
      finish_position: r.finish_position ?? null,
      field_size: fieldSizeByRaceId.get(r.race_id) ?? null,
      jockey: r.jockey || null,
      weight_carried: r.weight_carried ?? null,
      body_weight: r.body_weight ?? null,
      body_weight_change: r.body_weight_change || null,
      time_text: r.time_text || null,
      margin: r.margin || null,
      final_furlong_time: r.final_furlong_time ?? null,
      win_popularity: r.win_popularity ?? null,
    })),
  });
}

const EDITABLE_FIELDS = ["sire", "dam", "dam_sire", "trainer", "owner", "breeder"];

export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const { data: body, error } = await readJsonBody(request);
  if (error) return error;

  const name = String(body?.name || "").trim();
  if (!name) return jsonError("馬名を指定してください", 400);

  if (body.action === "refetch") {
    const row = await refetchHorseInfoFromNetkeiba(env.DB, name);
    // netkeiba への取得を停止中は問い合わせない(2026-10-04)。既存の内容はそのまま返す。
    if (row && row.refetch_paused) {
      return jsonError("netkeiba から取得を拒否されたため、一時的に取得を見合わせています", 409, {
        pausedUntil: row.paused_until,
        master: toMasterJson(row),
      });
    }
    return Response.json({ ok: true, master: toMasterJson(row) });
  }

  const fields = {};
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const v = body[key];
      fields[key] = v === "" || v === null || v === undefined ? null : String(v).trim();
    }
  }
  const row = await saveManualHorseInfo(env.DB, name, fields);
  return Response.json({ ok: true, master: toMasterJson(row) });
}
