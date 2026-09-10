import { jsonError } from "../_shared.js";

// データ検索画面「レース成績」タブ用の集計API。
// race_results(馬単位の確定結果)と races.payouts(払戻)を、競馬場・コース種別・距離で
// 絞って横断集計する。race_results / races は全ユーザー共有データのため requireAdmin しない
// (GET /api/races/:id/horse-history と同じ扱い)。
//
// 仕様の詳細は docs/design/data-search.md。実装方針の要点:
//   - レース単位のループで1件ずつ問い合わせない。サブリクエストは2本のみ
//     (1: races 全件 / 2: race_results を races と JOIN して条件で WHERE)。
//   - ① 平均単勝金額・○円以下率 / ② 平均馬連金額 は races.payouts が分母。
//     ③④ 騎手率 / ⑤ 馬番別成績 は race_results が分母(分母が別々になる)。

const SURFACES = new Set(["芝", "ダート"]);
const RIDDEN_STATUSES = new Set(["finished", "stopped"]);
const JOCKEY_MARK_RE = /^[☆▲△★◇]/;

// 騎手名の名寄せキー: 先頭の見習い減量記号を除去し、空白(全角/半角)を畳み込む
// (jockey_aliases の alias_key と同じ考え方)。
function jockeyKey(name) {
  return String(name ?? "").replace(JOCKEY_MARK_RE, "").replace(/[　\s]+/g, "").trim();
}
// 表示名: 記号を除いて空白は1つに畳む。
function jockeyDisplay(name) {
  return String(name ?? "").replace(JOCKEY_MARK_RE, "").replace(/[　\s]+/g, " ").trim();
}

function avg(arr) {
  return arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null;
}

// payouts JSON の 1 式別(tan / umaren)の rate 群から「そのレースの1値」を返す。
// 同着で複数エントリがある場合は平均。有効な rate が無ければ null。
function raceRateValue(payoutsObj, key) {
  const list = payoutsObj && Array.isArray(payoutsObj[key]) ? payoutsObj[key] : null;
  if (!list) return null;
  const rates = list
    .map((x) => Number(x && x.rate))
    .filter((n) => Number.isFinite(n) && n > 0);
  return rates.length ? avg(rates) : null;
}

// 率ランキング上位N(5位同率は全員含める)。
function topByRate(entries, minRides, countKey, n) {
  const rows = entries
    .filter((e) => e.rides >= minRides)
    .map((e) => ({
      name: e.display,
      rides: e.rides,
      count: e[countKey],
      rate: e.rides > 0 ? e[countKey] / e.rides : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.rides - a.rides);
  if (rows.length <= n) return rows;
  const cutRate = rows[n - 1].rate;
  return rows.filter((r, i) => i < n || r.rate === cutRate);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const track = (url.searchParams.get("track") || "").trim();
  const surface = (url.searchParams.get("course_type") || "").trim();
  const distanceRaw = (url.searchParams.get("distance") || "").trim();

  if (surface && !SURFACES.has(surface)) {
    return jsonError("course_typeが不正です", 400);
  }
  let distance = null;
  if (distanceRaw) {
    distance = Number(distanceRaw);
    if (!Number.isInteger(distance) || distance <= 0) {
      return jsonError("distanceが不正です", 400);
    }
  }

  // --- クエリ1: races 全件(track/course_type/distance フィルタはメモリ側で適用) ---
  const { results: raceRows } = await env.DB.prepare(
    "SELECT track, course_type, distance, payouts FROM races"
  ).all();

  const trackOptionSet = new Set();
  const distanceOptionSet = new Set();
  const winValues = [];
  const umarenValues = [];

  const surfaceOk = (ct) => (surface ? ct === surface : ct == null || SURFACES.has(ct));

  for (const row of raceRows || []) {
    const ct = row.course_type || null;
    if (row.track) trackOptionSet.add(row.track);

    // 距離セレクトの選択肢: 芝/ダートのレースに実在する距離。競馬場・コース種別の
    // 選択で絞る(距離フィルタ自体は掛けない)。
    if (
      row.distance != null &&
      SURFACES.has(ct) &&
      (!track || row.track === track) &&
      (!surface || ct === surface)
    ) {
      distanceOptionSet.add(row.distance);
    }

    // ①② 払戻集計の対象レース
    if (track && row.track !== track) continue;
    if (!surfaceOk(ct)) continue;
    if (distance != null && row.distance !== distance) continue;

    let payoutsObj = null;
    try {
      payoutsObj = row.payouts ? JSON.parse(row.payouts) : null;
    } catch {
      payoutsObj = null;
    }
    if (!payoutsObj) continue;
    const tanVal = raceRateValue(payoutsObj, "tan");
    if (tanVal != null) winValues.push(tanVal);
    const umaVal = raceRateValue(payoutsObj, "umaren");
    if (umaVal != null) umarenValues.push(umaVal);
  }

  // --- クエリ2: race_results を races と JOIN(races 側の条件で WHERE) ---
  const where = [];
  const binds = [];
  if (track) {
    where.push("r.track = ?");
    binds.push(track);
  }
  if (surface) {
    where.push("r.course_type = ?");
    binds.push(surface);
  } else {
    where.push("(r.course_type IS NULL OR r.course_type IN ('芝','ダート'))");
  }
  if (distance != null) {
    where.push("r.distance = ?");
    binds.push(distance);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const { results: rrRows } = await env.DB.prepare(
    `SELECT rr.race_id, rr.horse_number, rr.jockey, rr.status, rr.finish_position
       FROM race_results rr
       JOIN races r ON r.id = rr.race_id
       ${whereSql}`
  )
    .bind(...binds)
    .all();

  const jockeyMap = new Map(); // key -> { display, rides, wins, shows }
  const resultRaceIds = new Set();
  const byHorseNumber = new Map(); // number -> { starts, win, second, third }

  for (const row of rrRows || []) {
    resultRaceIds.add(row.race_id);
    const status = row.status || "finished";
    const pos = row.finish_position;

    // 騎手集計(取消・除外は騎乗回数に数えない)
    const rawJockey = row.jockey;
    if (rawJockey && String(rawJockey).trim() && RIDDEN_STATUSES.has(status)) {
      const key = jockeyKey(rawJockey);
      if (key) {
        let e = jockeyMap.get(key);
        if (!e) {
          e = { display: jockeyDisplay(rawJockey), rides: 0, wins: 0, shows: 0 };
          jockeyMap.set(key, e);
        }
        e.rides++;
        if (pos === 1) e.wins++;
        if (pos != null && pos <= 3) e.shows++;
      }
    }

    // 馬番別成績(取消・除外は出走数に数えない)
    const hn = row.horse_number;
    if (Number.isInteger(hn) && hn >= 1 && hn <= 18 && status !== "scratched" && status !== "excluded") {
      let b = byHorseNumber.get(hn);
      if (!b) {
        b = { starts: 0, win: 0, second: 0, third: 0 };
        byHorseNumber.set(hn, b);
      }
      b.starts++;
      if (pos === 1) b.win++;
      else if (pos === 2) b.second++;
      else if (pos === 3) b.third++;
    }
  }

  const resultRaceCount = resultRaceIds.size;
  const minRides = Math.min(50, Math.max(5, Math.ceil(resultRaceCount * 0.05)));
  const jockeyEntries = [...jockeyMap.values()];

  const winCount = winValues.length;
  const rateUnder = (limit) =>
    winCount ? winValues.filter((v) => v <= limit).length / winCount : null;

  const byHorseNumberOut = [...byHorseNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([horseNumber, b]) => ({
      horseNumber,
      starts: b.starts,
      win: b.win,
      second: b.second,
      third: b.third,
      winRate: b.starts ? b.win / b.starts : 0,
      quinellaRate: b.starts ? (b.win + b.second) / b.starts : 0,
      showRate: b.starts ? (b.win + b.second + b.third) / b.starts : 0,
    }));

  return Response.json({
    filters: { track, course_type: surface, distance },
    trackOptions: [...trackOptionSet],
    distanceOptions: [...distanceOptionSet].sort((a, b) => a - b),
    win: {
      avg: avg(winValues),
      raceCount: winCount,
      under300Rate: rateUnder(300),
      under500Rate: rateUnder(500),
      under1000Rate: rateUnder(1000),
    },
    umaren: {
      avg: avg(umarenValues),
      raceCount: umarenValues.length,
    },
    jockeys: {
      resultRaceCount,
      minRides,
      topWin: topByRate(jockeyEntries, minRides, "wins", 5),
      topShow: topByRate(jockeyEntries, minRides, "shows", 5),
    },
    byHorseNumber: byHorseNumberOut,
  });
}
