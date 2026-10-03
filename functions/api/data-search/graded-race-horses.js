import {
  jsonError,
  parsePositiveIntId,
  getAllRacesRaw,
  getRaceResultsGroupedByRaceId,
  loadHorseAliasMap,
  applyHorseAliasMap,
  horseAliasKeyOf,
  buildHorseSearchKeys,
  loadGradedRaceMap,
  classifyRace,
  gradedRaceNameKey,
  parseJsonSafe,
  raceSummaryOf,
  runningStyleOf,
  dominantRunningStyle,
  fieldSizeOf,
  addPlacing,
  timeTextToSeconds,
  gradedJockeyKey,
  RAN_STATUSES,
} from "../_shared.js";

// データ検索画面「重賞検索」タブ ②出走馬ごとの詳細。対象レース(races.id)の出走各馬について、
// 取り込み済みの全戦績・持ちタイム・上り最速・着別度数・前走間隔・脚質・騎手成績と、
// horses テーブルにある血統等を返す(horses に行が無い馬は has_master=false。
// 画面側が既存の GET /api/data-search/horse-info を1頭ずつ順に呼んで netkeiba から取得する。
// 18頭ぶんをここでまとめて取得すると Workers の外部アクセス上限〈50回〉を超えるため)。
// 全ユーザー共有データの閲覧のため requireAdmin しない。仕様は docs/design/graded-race-search.md。
//
// D1の読み取り対策:
//   - races は races_cache(getAllRacesRaw)、各レースの頭数・騎手成績は race_stats_cache
//     (getRaceResultsGroupedByRaceId)からメモリ上で引く(races / race_results の全件走査をしない)
//   - race_results は出走各馬の horse_key だけを IN 句で直接引く。キー数は
//     「出走頭数(最大18)×(1 + その馬のエイリアス数)」で実質20〜30件程度。
//     エイリアスが多い馬がいても上限を超えないよう、90件ずつチャンク分割する(CLAUDE.md)
//   - horses も出走頭数ぶん(最大18件)の horse_key を IN 句で引く(同じく90件チャンク)
//   - 書き込みは一切しない

const RECENT_RUNS_FOR_STYLE = 5;
const TRACK_CONDITIONS = ["良", "稍重", "重", "不良"];
const SURFACES = ["芝", "ダート", "障害"];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function daysBetween(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// 前走からの間隔表記。週数 = 日数/7 の四捨五入。1週なら「連闘」、それ以外は「中(週数−1)週」
function intervalLabel(days) {
  if (days == null || days <= 0) return null;
  const weeks = Math.round(days / 7);
  if (weeks <= 1) return "連闘";
  return `中${weeks - 1}週`;
}

function bestRunBy(runs, predicate, valueOf) {
  let best = null;
  let bestValue = null;
  for (const r of runs) {
    if (r.status !== "finished" || !predicate(r)) continue;
    const v = valueOf(r);
    if (v == null || !Number.isFinite(v)) continue;
    if (bestValue == null || v < bestValue) {
      best = r;
      bestValue = v;
    }
  }
  if (!best) return null;
  return {
    value: bestValue,
    time_text: best.time_text,
    final_furlong_time: best.final_furlong_time,
    race_date: best.race_date,
    track: best.track,
    race_name: best.race_name,
    course_type: best.course_type,
    distance: best.distance,
    track_condition: best.track_condition,
    finish_position: best.finish_position,
  };
}

function placingFor(runs, predicate) {
  const counts = [0, 0, 0, 0];
  for (const r of runs) if (predicate(r)) addPlacing(counts, r.status, r.finish_position);
  return counts;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "レースID");
  if (error) return error;

  const allRaces = await getAllRacesRaw(db);
  const target = allRaces.find((r) => Number(r.id) === raceId);
  if (!target) return jsonError("レースが見つかりません", 404);
  const raceById = new Map(allRaces.map((r) => [Number(r.id), r]));

  const entries = (parseJsonSafe(target.entries, []) || []).filter((e) => e && e.horse_name);
  if (!entries.length) return Response.json({ race: raceSummaryOf(target), horses: [] });

  const aliasMap = await loadHorseAliasMap(db);
  const { canonByKey, searchKeyToKey } = buildHorseSearchKeys(
    aliasMap,
    entries.map((e) => e.horse_name)
  );

  // 出走各馬の全戦績(対象レースより前の開催日のもの)。IN句は90件ずつ(上記コメント参照)
  const searchKeys = [...searchKeyToKey.keys()];
  const runsByKey = new Map();
  for (const keys of chunk(searchKeys, 90)) {
    if (!keys.length) continue;
    const ph = keys.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT horse_key, race_id, horse_number, waku_number, sex_age, weight_carried, jockey, status,
                finish_position, time_text, margin, corner_positions, final_furlong_time,
                body_weight, body_weight_change, win_popularity, incident_note
           FROM race_results WHERE horse_key IN (${ph})`
      )
      .bind(...keys)
      .all();
    for (const row of results || []) {
      const key = searchKeyToKey.get(row.horse_key);
      if (!key) continue;
      if (!runsByKey.has(key)) runsByKey.set(key, []);
      runsByKey.get(key).push(row);
    }
  }

  // horses(血統・調教師・馬主・生産牧場)。キー数は出走頭数(最大18)
  const masterKeys = [...canonByKey.keys()];
  const masterByKey = new Map();
  for (const keys of chunk(masterKeys, 90)) {
    if (!keys.length) continue;
    const ph = keys.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT horse_key, sire, dam, dam_sire, trainer, owner, breeder, fetch_error, fetched_at
           FROM horses WHERE horse_key IN (${ph})`
      )
      .bind(...keys)
      .all();
    for (const r of results || []) masterByKey.set(r.horse_key, r);
  }

  const statsByRace = await getRaceResultsGroupedByRaceId(db);
  const gradedMap = await loadGradedRaceMap(db);
  const targetNameKey = gradedRaceNameKey(target.race_name);

  // 騎手の今回コース(場・芝ダ・距離)での成績。対象レースより前の開催分を
  // races_cache × race_stats_cache でメモリ集計する(race_results のあるレースのみ)
  const entryJockeyKeys = new Set(entries.map((e) => gradedJockeyKey(e.jockey)).filter(Boolean));
  const jockeyCourse = new Map();
  for (const r of allRaces) {
    if (
      Number(r.id) === raceId ||
      !(String(r.race_date) < String(target.race_date)) ||
      r.track !== target.track ||
      r.course_type !== target.course_type ||
      Number(r.distance) !== Number(target.distance)
    ) continue;
    for (const row of statsByRace[r.id] || statsByRace[String(r.id)] || []) {
      const jk = gradedJockeyKey(row.jockey);
      if (!entryJockeyKeys.has(jk)) continue;
      if (!jockeyCourse.has(jk)) jockeyCourse.set(jk, [0, 0, 0, 0]);
      addPlacing(jockeyCourse.get(jk), row.status, row.finish_position);
    }
  }

  const out = entries.map((e) => {
    // buildHorseSearchKeys と同じ手順(エイリアス適用→正規化キー)で entry → 正規化キーを引く
    const key = horseAliasKeyOf(applyHorseAliasMap(aliasMap, e.horse_name));
    const runs = (runsByKey.get(key) || [])
      .map((row) => {
        const race = raceById.get(Number(row.race_id));
        if (!race) return null;
        const fieldSize = fieldSizeOf(
          statsByRace[race.id] || statsByRace[String(race.id)],
          (parseJsonSafe(race.entries, []) || []).length || null
        );
        return {
          race_id: race.id,
          race_date: race.race_date,
          track: race.track,
          race_number: race.race_number,
          race_name: race.race_name || null,
          course_type: race.course_type || null,
          distance: race.distance ?? null,
          weather: race.weather || null,
          track_condition: race.track_condition || null,
          field_size: fieldSize,
          horse_number: row.horse_number ?? null,
          waku_number: row.waku_number ?? null,
          win_popularity: row.win_popularity ?? null,
          status: row.status || "finished",
          finish_position: row.finish_position ?? null,
          jockey: row.jockey || null,
          weight_carried: row.weight_carried ?? null,
          time_text: row.time_text || null,
          margin: row.margin || null,
          corner_positions: row.corner_positions || null,
          final_furlong_time: row.final_furlong_time ?? null,
          body_weight: row.body_weight ?? null,
          body_weight_change: row.body_weight_change || null,
          incident_note: row.incident_note || null,
          sex_age: row.sex_age || null,
          running_style: runningStyleOf(row.corner_positions, fieldSize),
          grade: classifyRace(gradedMap, race).grade,
          is_this_race: !!targetNameKey && gradedRaceNameKey(race.race_name) === targetNameKey,
        };
      })
      .filter((r) => r && String(r.race_date) < String(target.race_date))
      .sort((a, b) =>
        a.race_date === b.race_date
          ? (b.race_number || 0) - (a.race_number || 0)
          : String(b.race_date).localeCompare(String(a.race_date))
      );

    const ranRuns = runs.filter((r) => RAN_STATUSES.has(r.status));
    const prev = ranRuns[0] || null;
    const days = prev ? daysBetween(prev.race_date, target.race_date) : null;
    const recentStyles = ranRuns.slice(0, RECENT_RUNS_FOR_STYLE).map((r) => r.running_style);

    const sameSurface = (r) => r.course_type === target.course_type;
    const sameDistance = (r) => sameSurface(r) && Number(r.distance) === Number(target.distance);
    const sameTrack = (r) => sameSurface(r) && r.track === target.track;
    const sameCourse = (r) => sameDistance(r) && r.track === target.track;
    const timeOf = (r) => timeTextToSeconds(r.time_text);
    const l3Of = (r) => (r.final_furlong_time == null ? null : Number(r.final_furlong_time));

    const jk = gradedJockeyKey(e.jockey);
    const master = masterByKey.get(key) || null;

    return {
      horse_number: e.horse_number != null ? Number(e.horse_number) : null,
      horse_name: e.horse_name,
      has_master: !!master,
      master: master
        ? {
            sire: master.sire || null,
            dam: master.dam || null,
            dam_sire: master.dam_sire || null,
            trainer: master.trainer || null,
            owner: master.owner || null,
            breeder: master.breeder || null,
            fetch_error: master.fetch_error || null,
            fetched_at: master.fetched_at || null, // 失敗がいつの取得結果かを画面に出すため(2026-10-03)
          }
        : null,
      runs,
      prev_run: prev
        ? {
            race_date: prev.race_date,
            race_name: prev.race_name,
            track: prev.track,
            status: prev.status,
            finish_position: prev.finish_position,
            field_size: prev.field_size,
            body_weight: prev.body_weight,
            body_weight_change: prev.body_weight_change,
          }
        : null,
      interval_days: days,
      interval_label: intervalLabel(days),
      running_style: dominantRunningStyle(recentStyles),
      best_time_same_distance: bestRunBy(runs, sameDistance, timeOf),
      best_time_same_course: bestRunBy(runs, sameCourse, timeOf),
      best_last3f: bestRunBy(runs, () => true, l3Of),
      best_last3f_same_surface: bestRunBy(runs, sameSurface, l3Of),
      records: [
        { label: "全成績", counts: placingFor(runs, () => true) },
        ...SURFACES.map((s) => ({ label: s, counts: placingFor(runs, (r) => r.course_type === s) })),
        { label: "同距離", counts: placingFor(runs, sameDistance) },
        { label: "同競馬場", counts: placingFor(runs, sameTrack) },
        { label: "同コース", counts: placingFor(runs, sameCourse) },
        ...TRACK_CONDITIONS.map((c) => ({
          label: `馬場:${c}`,
          counts: placingFor(runs, (r) => sameSurface(r) && r.track_condition === c),
        })),
        { label: "重賞", counts: placingFor(runs, (r) => !!r.grade) },
        { label: "この重賞", counts: placingFor(runs, (r) => r.is_this_race) },
      ],
      jockey: e.jockey || null,
      jockey_course: jk ? jockeyCourse.get(jk) || [0, 0, 0, 0] : null,
      jockey_with_horse: jk ? placingFor(runs, (r) => gradedJockeyKey(r.jockey) === jk) : null,
    };
  });

  return Response.json({ race: raceSummaryOf(target), horses: out });
}
