import { jsonError } from "../_shared.js";

// データ検索画面「レース成績」タブ用の集計API。
// レース確定データ(races.payouts / races.finish_order / races.entries と、あれば race_results)
// を、競馬場・コース種別・距離で絞って横断集計する。races / race_results は全ユーザー共有
// データのため requireAdmin しない(GET /api/races/:id/horse-history と同じ扱い)。
//
// 仕様の詳細は docs/design/data-search.md。実装方針の要点:
//   - レース単位のループで1件ずつ問い合わせない。サブリクエストは2本のみ
//     (1: races 全件 / 2: race_results を races と JOIN してフィルタ該当分だけ)。
//   - ① 平均単勝金額・○円以下率 / ② 平均馬連金額 は races.payouts。
//   - ③④⑤(騎手率・馬番別成績)の着順ソースは「race_results が全頭ぶん揃っていれば
//     race_results(最も正)、そうでなければ finish_order(上位3着)+ entries」を
//     レースごとに選ぶ(手入力・CSV・PDF未取込のレースもカバーするため)。

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

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
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

// レース1件について「出走した各馬の {horse_number, jockey, ran, pos}」配列を作る。
// pos は 1/2/3(3着以内)または null(着外)。着順データが取れなければ null を返す。
function buildRaceLineup(entries, finishOrder, rrRows) {
  // 1) race_results が全頭ぶん揃っていれば、それを正のソースにする
  if (Array.isArray(rrRows) && entries.length > 0 && rrRows.length >= entries.length) {
    return rrRows.map((r) => {
      const status = r.status || "finished";
      const fp = r.finish_position;
      return {
        horse_number: r.horse_number,
        jockey: r.jockey,
        ran: RIDDEN_STATUSES.has(status),
        pos: fp != null && fp >= 1 && fp <= 3 ? fp : null,
      };
    });
  }
  // 2) フォールバック: finish_order(上位3着)+ entries(全出走馬)
  if (Array.isArray(finishOrder) && finishOrder.length && entries.length) {
    const posOf = (hn) => {
      const i = finishOrder.indexOf(hn);
      return i >= 0 && i < 3 ? i + 1 : null;
    };
    return entries.map((e) => ({
      horse_number: e.horse_number,
      jockey: e.jockey,
      ran: true, // entries からは取消馬を判別できない
      pos: posOf(e.horse_number),
    }));
  }
  return null;
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
    "SELECT id, track, course_type, distance, payouts, entries, finish_order FROM races"
  ).all();

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

  const rrByRace = new Map();
  for (const row of rrRows || []) {
    let list = rrByRace.get(row.race_id);
    if (!list) {
      list = [];
      rrByRace.set(row.race_id, list);
    }
    list.push(row);
  }

  const trackOptionSet = new Set();
  const distanceOptionSet = new Set();
  const winValues = [];
  const umarenValues = [];
  const jockeyMap = new Map(); // key -> { display, rides, wins, shows }
  const byHorseNumber = new Map(); // number -> { starts, win, second, third }
  let resultRaceCount = 0;

  const surfaceOk = (ct) => (surface ? ct === surface : ct == null || SURFACES.has(ct));

  for (const race of raceRows || []) {
    const ct = race.course_type || null;
    if (race.track) trackOptionSet.add(race.track);

    // 距離セレクトの選択肢: 芝/ダートのレースに実在する距離。競馬場・コース種別の
    // 選択で絞る(距離フィルタ自体は掛けない)。
    if (
      race.distance != null &&
      SURFACES.has(ct) &&
      (!track || race.track === track) &&
      (!surface || ct === surface)
    ) {
      distanceOptionSet.add(race.distance);
    }

    // スコープ(フィルタ)判定
    if (track && race.track !== track) continue;
    if (!surfaceOk(ct)) continue;
    if (distance != null && race.distance !== distance) continue;

    // ①② 払戻
    const payoutsObj = parseJson(race.payouts, null);
    if (payoutsObj) {
      const tanVal = raceRateValue(payoutsObj, "tan");
      if (tanVal != null) winValues.push(tanVal);
      const umaVal = raceRateValue(payoutsObj, "umaren");
      if (umaVal != null) umarenValues.push(umaVal);
    }

    // ③④⑤ 着順集計
    const entries = parseJson(race.entries, []) || [];
    const finishOrder = parseJson(race.finish_order, null);
    const lineup = buildRaceLineup(entries, finishOrder, rrByRace.get(race.id));
    if (!lineup) continue;

    resultRaceCount++;
    for (const h of lineup) {
      if (!h.ran) continue;

      const rawJockey = h.jockey;
      if (rawJockey && String(rawJockey).trim()) {
        const key = jockeyKey(rawJockey);
        if (key) {
          let e = jockeyMap.get(key);
          if (!e) {
            e = { display: jockeyDisplay(rawJockey), rides: 0, wins: 0, shows: 0 };
            jockeyMap.set(key, e);
          }
          e.rides++;
          if (h.pos === 1) e.wins++;
          if (h.pos != null) e.shows++;
        }
      }

      const hn = h.horse_number;
      if (Number.isInteger(hn) && hn >= 1 && hn <= 18) {
        let b = byHorseNumber.get(hn);
        if (!b) {
          b = { starts: 0, win: 0, second: 0, third: 0 };
          byHorseNumber.set(hn, b);
        }
        b.starts++;
        if (h.pos === 1) b.win++;
        else if (h.pos === 2) b.second++;
        else if (h.pos === 3) b.third++;
      }
    }
  }

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
