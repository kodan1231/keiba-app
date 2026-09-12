import { jsonError, getRaceResultsGroupedByRaceId, getAllRacesRaw } from "../_shared.js";

// データ検索画面「レース成績」タブ用の集計API。
// レース確定データ(races.payouts / races.finish_order / races.entries と、あれば race_results)
// を、競馬場・コース種別・距離で絞って横断集計する。races / race_results は全ユーザー共有
// データのため requireAdmin しない(GET /api/races/:id/horse-history と同じ扱い)。
//
// 仕様の詳細は docs/design/data-search.md。実装方針の要点:
//   - レース単位のループで1件ずつ問い合わせない。races は毎回全件ライブ取得(1本。
//     元々軽いテーブル)。race_results 側は毎回読み直さず、race_stats_cache(事前計算
//     キャッシュ。_lib/race-stats-cache.js)から1行読むだけにする(2026-09-12。
//     経緯は docs/design/data-search.md 参照)。
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
  // races_cache(_lib/races-cache.js。2026-09-12追加)から読む。以前は毎回全件
  // SELECTしており、races が育つにつれてD1読み取り上限逼迫リスクがあった。
  const raceRows = await getAllRacesRaw(env.DB);

  // --- race_results は race_stats_cache(事前計算キャッシュ)から読む ---
  // 以前は races と JOIN して WHERE で絞っていたが、JOIN条件が races 側のカラムのため
  // race_results 側の絞り込みが効かず、フィルタの有無によらず race_results をほぼ全件
  // スキャンしてしまい、D1の日次行読み取り上限超過の一因になっていた(2026-09-11)。
  // その後 race_id IN (...) チャンク分割方式に変更したが、フィルタ無しの初期表示では
  // 結局ほぼ全件読むことになるため、2026-09-12に「race_results を race_id でグルーピング
  // したものを1行のJSONとして事前計算・キャッシュする」方式へ変更した。無効化は
  // race_results 側のDBトリガーで自動的に行われる(_lib/race-stats-cache.js 参照)。
  const surfaceOk = (ct) => (surface ? ct === surface : ct == null || SURFACES.has(ct));
  const rrByRace = await getRaceResultsGroupedByRaceId(env.DB);

  const trackOptionSet = new Set();
  const distanceOptionSet = new Set();
  const winValues = [];
  const umarenValues = [];
  const jockeyMap = new Map(); // key -> { display, rides, wins, shows }
  const byHorseNumber = new Map(); // number -> { starts, win, second, third }
  let resultRaceCount = 0;

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
    const lineup = buildRaceLineup(entries, finishOrder, rrByRace[race.id]);
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
