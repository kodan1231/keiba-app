import {
  jsonError,
  parsePositiveIntId,
  getAllRacesRaw,
  jstYear,
  findRacesByGradedKey,
  raceSummaryOf,
  parseJsonSafe,
  runningStyleOf,
  fieldSizeOf,
  addPlacing,
  timeTextToSeconds,
  RAN_STATUSES,
  gradedRaceNameKey,
} from "../_shared.js";

// データ検索画面「重賞検索」タブ: 重賞1つぶんの
//   ① 今年の出走馬一覧(未発表/出走馬確定/終了の判定)
//   ③ 今年を除く直近10年の成績(全着順・全払戻)と傾向集計
// を返す。②(出走馬ごとの詳細)は graded-race-horses.js。
// 全ユーザー共有データの閲覧のため requireAdmin しない。仕様は docs/design/graded-race-search.md。
//
// D1の読み取り対策:
//   - races は直接SELECTせず races_cache(getAllRacesRaw)をメモリ上で走査し、
//     gradedRaceNameKey(race_name) === graded_races.name_key のレースを拾う
//   - race_results は対象レース(1年1レースに絞るため、今年1+過去10年=最大11件)だけを
//     IN句で取得する(11件 ≪ 100バインド上限。CLAUDE.md の不変条件)
//   - 書き込みは一切しない

const PAST_YEARS = 10;

const POPULARITY_BUCKETS = [
  { label: "1番人気", test: (p) => p === 1 },
  { label: "2番人気", test: (p) => p === 2 },
  { label: "3番人気", test: (p) => p === 3 },
  { label: "4〜6番人気", test: (p) => p >= 4 && p <= 6 },
  { label: "7〜9番人気", test: (p) => p >= 7 && p <= 9 },
  { label: "10番人気以下", test: (p) => p >= 10 },
];
const AGE_BUCKETS = [
  { label: "2歳", test: (a) => a === 2 },
  { label: "3歳", test: (a) => a === 3 },
  { label: "4歳", test: (a) => a === 4 },
  { label: "5歳", test: (a) => a === 5 },
  { label: "6歳", test: (a) => a === 6 },
  { label: "7歳以上", test: (a) => a >= 7 },
];
const SEXES = ["牡", "牝", "セ"];
const STYLES = ["逃げ", "先行", "差し", "追込"];
const TREND_PAYOUT_KEYS = ["tan", "umaren", "sanrentan"];

function newCounts() {
  return [0, 0, 0, 0];
}

function parseSexAge(sexAge) {
  const m = String(sexAge ?? "").normalize("NFKC").match(/^(牡|牝|セ|騸)\s*(\d+)/);
  if (!m) return { sex: null, age: null };
  return { sex: m[1] === "騸" ? "セ" : m[1], age: Number(m[2]) };
}

// payouts の1式別から「そのレースの1値」(同着で複数あれば平均)。race-stats.js と同じ考え方。
function racePayoutValue(payouts, key) {
  const list = payouts && Array.isArray(payouts[key]) ? payouts[key] : null;
  if (!list) return null;
  const rates = list.map((x) => Number(x && x.rate)).filter((n) => Number.isFinite(n) && n > 0);
  return rates.length ? rates.reduce((s, n) => s + n, 0) / rates.length : null;
}

function wakuByHorseNumberOf(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e && e.horse_number != null && e.waku_number != null) map.set(Number(e.horse_number), Number(e.waku_number));
  }
  return map;
}

// race_results 行(1頭)を画面用に整形する。
function resultRowOf(r, fieldSize, wakuMap) {
  const hn = r.horse_number != null ? Number(r.horse_number) : null;
  return {
    horse_number: hn,
    waku_number: r.waku_number ?? (hn != null ? wakuMap.get(hn) ?? null : null),
    horse_name: r.horse_name || null,
    sex_age: r.sex_age || null,
    weight_carried: r.weight_carried ?? null,
    jockey: r.jockey || null,
    status: r.status || "finished",
    finish_position: r.finish_position ?? null,
    time_text: r.time_text || null,
    margin: r.margin || null,
    corner_positions: r.corner_positions || null,
    final_furlong_time: r.final_furlong_time ?? null,
    body_weight: r.body_weight ?? null,
    body_weight_change: r.body_weight_change || null,
    win_popularity: r.win_popularity ?? null,
    incident_note: r.incident_note || null,
    running_style: runningStyleOf(r.corner_positions, fieldSize),
  };
}

function sortResultRows(rows) {
  return rows.sort((a, b) => {
    const pa = a.finish_position ?? 999;
    const pb = b.finish_position ?? 999;
    if (pa !== pb) return pa - pb;
    return (a.horse_number ?? 999) - (b.horse_number ?? 999);
  });
}

// 1レースぶんの「結果」を組み立てる。race_results があればそれ(全着順)、
// 無ければ finish_order(上位3着)+ entries にフォールバックする。
function buildRaceResult(race, rrRows) {
  const entries = parseJsonSafe(race.entries, []) || [];
  const finishOrder = parseJsonSafe(race.finish_order, null);
  const wakuMap = wakuByHorseNumberOf(entries);
  if (rrRows && rrRows.length) {
    const fieldSize = fieldSizeOf(rrRows, entries.length || null);
    return {
      source: "race_results",
      field_size: fieldSize,
      rows: sortResultRows(rrRows.map((r) => resultRowOf(r, fieldSize, wakuMap))),
    };
  }
  if (Array.isArray(finishOrder) && finishOrder.length) {
    const byNumber = new Map(entries.map((e) => [Number(e?.horse_number), e]));
    const rows = finishOrder.slice(0, 3).map((hn, i) => {
      const e = byNumber.get(Number(hn)) || {};
      return {
        horse_number: Number(hn),
        waku_number: e.waku_number ?? null,
        horse_name: e.horse_name || null,
        sex_age: e.sex_age || null,
        weight_carried: e.weight_carried ?? null,
        jockey: e.jockey || null,
        status: "finished",
        finish_position: i + 1,
        time_text: null, margin: null, corner_positions: null, final_furlong_time: null,
        body_weight: null, body_weight_change: null, win_popularity: null, incident_note: null,
        running_style: null,
      };
    });
    return { source: "finish_order", field_size: entries.length || null, rows };
  }
  return null;
}

function sameCourse(a, b) {
  return !!a && !!b && a.track === b.track && a.course_type === b.course_type && Number(a.distance) === Number(b.distance);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const { id, error } = parsePositiveIntId(url.searchParams.get("id"), "重賞ID");
  if (error) return error;

  const master = await db
    .prepare(
      `SELECT id, name, name_key, grade, is_jump, track, course_type, distance, age_condition, schedule_md
         FROM graded_races WHERE id = ?`
    )
    .bind(id)
    .first();
  if (!master) return jsonError("重賞が見つかりません", 404);

  const allRaces = await getAllRacesRaw(db);
  // 保存済みの name_key と、名前から今の正規化で計算し直したキーの両方で拾う(2026-10-06)
  const matches = findRacesByGradedKey(allRaces, new Set([master.name_key, gradedRaceNameKey(master.name)].filter(Boolean)));

  // 年ごとに1レース(同じ年に同名レースが複数ある異常データは、最も新しい日付を採用)
  const byYear = new Map();
  for (const r of matches) {
    const year = Number(String(r.race_date || "").slice(0, 4));
    if (!year) continue;
    const prev = byYear.get(year);
    if (!prev || String(r.race_date) > String(prev.race_date)) byYear.set(year, r);
  }

  const currentYear = jstYear();
  const currentRace = byYear.get(currentYear) || null;
  const pastRaces = [];
  for (let y = currentYear - 1; y >= currentYear - PAST_YEARS; y--) {
    if (byYear.has(y)) pastRaces.push({ year: y, race: byYear.get(y) });
  }

  // 対象レースの race_results をまとめて取得(最大 1 + PAST_YEARS = 11件。100バインド上限に届かない)
  const raceIds = [currentRace, ...pastRaces.map((p) => p.race)].filter(Boolean).map((r) => r.id);
  const rrByRace = new Map();
  if (raceIds.length) {
    const ph = raceIds.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT race_id, horse_number, waku_number, horse_name, sex_age, weight_carried, jockey, status,
                finish_position, time_text, margin, corner_positions, final_furlong_time,
                body_weight, body_weight_change, win_popularity, incident_note
           FROM race_results WHERE race_id IN (${ph})`
      )
      .bind(...raceIds)
      .all();
    for (const r of results || []) {
      if (!rrByRace.has(r.race_id)) rrByRace.set(r.race_id, []);
      rrByRace.get(r.race_id).push(r);
    }
  }

  // ---------- ① 今年 ----------
  let current = { status: "unannounced", race: null, entries: [] };
  if (currentRace) {
    const entries = (parseJsonSafe(currentRace.entries, []) || []).filter((e) => e && e.horse_name);
    if (entries.length) {
      const rrRows = rrByRace.get(currentRace.id) || [];
      const finishOrder = parseJsonSafe(currentRace.finish_order, null);
      const finished = rrRows.length > 0 || (Array.isArray(finishOrder) && finishOrder.length > 0);
      const result = finished ? buildRaceResult(currentRace, rrRows) : null;
      const resultByNumber = new Map((result?.rows || []).map((r) => [r.horse_number, r]));
      current = {
        status: finished ? "finished" : "entries",
        race: raceSummaryOf(currentRace),
        field_size: result?.field_size ?? entries.length,
        entries: entries
          .map((e) => {
            const hn = e.horse_number != null ? Number(e.horse_number) : null;
            const res = hn != null ? resultByNumber.get(hn) : null;
            return {
              horse_number: hn,
              waku_number: e.waku_number ?? null,
              horse_name: e.horse_name,
              sex_age: e.sex_age || null,
              weight_carried: e.weight_carried ?? null,
              jockey: e.jockey || null,
              result: res
                ? {
                    status: res.status,
                    finish_position: res.finish_position,
                    win_popularity: res.win_popularity,
                    time_text: res.time_text,
                    margin: res.margin,
                    final_furlong_time: res.final_furlong_time,
                  }
                : null,
            };
          })
          .sort((a, b) => (a.horse_number ?? 999) - (b.horse_number ?? 999)),
        payouts: finished ? parseJsonSafe(currentRace.payouts, null) : null,
      };
    } else {
      current = { status: "unannounced", race: raceSummaryOf(currentRace), entries: [] };
    }
  }

  // 傾向・開催条件比較の基準(今年のレース。無ければ重賞マスタの参考情報)
  const reference = currentRace
    ? { track: currentRace.track, course_type: currentRace.course_type, distance: currentRace.distance }
    : master.track
      ? { track: master.track, course_type: master.course_type, distance: master.distance }
      : null;

  // ---------- ③ 過去10年 ----------
  const past = [];
  for (const { year, race } of pastRaces) {
    const result = buildRaceResult(race, rrByRace.get(race.id));
    if (!result) continue; // 結果が無い年は出さない
    past.push({
      year,
      race: raceSummaryOf(race),
      field_size: result.field_size,
      results_source: result.source,
      rows: result.rows,
      payouts: parseJsonSafe(race.payouts, null),
      differs_from_reference: reference ? !sameCourse(race, reference) : false,
    });
  }

  // ---------- 傾向集計 ----------
  // 人気別・枠番別・年齢/性別・脚質別は、全着順(race_results)がある年だけで集計する。
  // 配当は払戻がある年すべて、勝ちタイム・上りは基準と同じ競馬場・芝ダ・距離の年のみ。
  const fullYears = past.filter((p) => p.results_source === "race_results");
  const popularity = POPULARITY_BUCKETS.map((b) => ({ label: b.label, counts: newCounts() }));
  const waku = Array.from({ length: 8 }, (_, i) => ({ label: `${i + 1}枠`, counts: newCounts() }));
  const age = AGE_BUCKETS.map((b) => ({ label: b.label, counts: newCounts() }));
  const sex = SEXES.map((s) => ({ label: s, counts: newCounts() }));
  const style = STYLES.map((s) => ({ label: s, counts: newCounts() }));
  for (const p of fullYears) {
    for (const r of p.rows) {
      if (!RAN_STATUSES.has(r.status)) continue;
      const pop = Number(r.win_popularity);
      const pb = POPULARITY_BUCKETS.findIndex((b) => Number.isInteger(pop) && b.test(pop));
      if (pb >= 0) addPlacing(popularity[pb].counts, r.status, r.finish_position);
      const w = Number(r.waku_number);
      if (Number.isInteger(w) && w >= 1 && w <= 8) addPlacing(waku[w - 1].counts, r.status, r.finish_position);
      const sa = parseSexAge(r.sex_age);
      const ab = AGE_BUCKETS.findIndex((b) => sa.age != null && b.test(sa.age));
      if (ab >= 0) addPlacing(age[ab].counts, r.status, r.finish_position);
      const si = SEXES.indexOf(sa.sex);
      if (si >= 0) addPlacing(sex[si].counts, r.status, r.finish_position);
      const st = STYLES.indexOf(r.running_style);
      if (st >= 0) addPlacing(style[st].counts, r.status, r.finish_position);
    }
  }

  const payoutStats = TREND_PAYOUT_KEYS.map((key) => {
    const values = past.map((p) => racePayoutValue(p.payouts, key)).filter((v) => v != null);
    return {
      key,
      years: values.length,
      avg: values.length ? values.reduce((s, n) => s + n, 0) / values.length : null,
      max: values.length ? Math.max(...values) : null,
      min: values.length ? Math.min(...values) : null,
    };
  });

  const winTimes = [];
  const winLast3f = [];
  for (const p of fullYears) {
    if (p.differs_from_reference) continue;
    const winner = p.rows.find((r) => r.status === "finished" && Number(r.finish_position) === 1);
    if (!winner) continue;
    const sec = timeTextToSeconds(winner.time_text);
    if (sec != null) winTimes.push(sec);
    const l3 = Number(winner.final_furlong_time);
    if (winner.final_furlong_time != null && Number.isFinite(l3)) winLast3f.push(l3);
  }
  const avgOf = (arr) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null);

  return Response.json({
    master,
    current_year: currentYear,
    past_years: PAST_YEARS,
    current,
    reference,
    past,
    trends: {
      full_years: fullYears.length,
      payout_years: past.filter((p) => p.payouts).length,
      popularity,
      waku,
      age,
      sex,
      style,
      payouts: payoutStats,
      winning_time: { years: winTimes.length, avg_seconds: avgOf(winTimes) },
      winner_last3f: { years: winLast3f.length, avg: avgOf(winLast3f) },
    },
  });
}
