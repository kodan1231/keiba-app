import { jsonError, getRaceLineups } from "../_shared.js";

// データ検索画面「レース成績」タブ用の集計API。
// レース確定データ(races.payouts / races.finish_order / races.entries と、あれば race_results)
// を、競馬場・コース種別・距離で絞って横断集計する。races / race_results は全ユーザー共有
// データのため requireAdmin しない(GET /api/races/:id/horse-history と同じ扱い)。
//
// 仕様の詳細は docs/design/data-search.md。実装方針の要点:
//   - レース単位のループで1件ずつ問い合わせない。データは集計用の小さいキャッシュ
//     (race_lineup_cache。_lib/race-lineup-cache.js。2026-10-07)から全レース分を読み、メモリで集計する
//     (それ以前は races_cache + race_stats_cache を丸ごと解析しておりCPU時間上限を超えた)。
//   - ① 単勝金額の中央値・○円以下率 / ② 馬連金額の中央値 は races.payouts 由来。
//   - ③④⑤(騎手率・馬番別成績)の着順ソースは「race_results が全頭ぶん揃っていれば
//     race_results(最も正)、そうでなければ finish_order(上位3着)+ entries」を
//     レースごとに選ぶ(手入力・CSV・PDF未取込のレースもカバーするため)。

const SURFACES = new Set(["芝", "ダート"]);
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

// 中央値(件数が偶数なら真ん中2つの平均)。空なら null。
// 2026-10-03: 単勝・馬連の代表値を平均から中央値に変更(まれな高配当に引っ張られにくくするため)。
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 払戻の1値化(同着は平均)と出走馬の一覧(buildRaceLineup と同じ規則)は、
// 集計用の小さいキャッシュの作り直し時に済ませている(_lib/race-lineup-cache.js。2026-10-07)。

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

  // --- 集計用の小さいキャッシュ(race_lineup_cache)から全レースを読む ---
  // 2026-10-07: 以前は races_cache(約10MB)と race_stats_cache(約3.8MB)を丸ごと解析しており、
  // CPU時間上限超過(exceededResources)で「集計の取得に失敗しました」になった。各レースの
  // 日付・競馬場・コース・距離・単勝/馬連の値・出走馬[馬番,騎手,着順]だけを持つ専用キャッシュに切り替えた
  // (docs/design/data-search.md「集計用の小さいキャッシュ」)。出走馬の一覧の規則(race_results 全頭
  // → 無ければ entries+finish_order)は作り直し時に適用済み。
  // (それ以前の経緯: races と race_results を JOIN して WHERE で絞っていた時期は race_results を
  //  ほぼ全件スキャンし D1日次読み取り上限超過の一因になった〈2026-09-11〉ため、2026-09-12に
  //  事前計算キャッシュ方式へ変更していた)
  const surfaceOk = (ct) => (surface ? ct === surface : ct == null || SURFACES.has(ct));
  const raceRows = await getRaceLineups(env.DB);

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

    // ①② 払戻(同着は平均した1値。キャッシュ作り直し時に計算済み)
    if (race.tan != null) winValues.push(race.tan);
    if (race.umaren != null) umarenValues.push(race.umaren);

    // ③④⑤ 着順集計(lineup は出走した馬だけの [馬番, 騎手, 着順])
    if (!race.lineup) continue;

    resultRaceCount++;
    for (const [horse_number, jockey, pos] of race.lineup) {
      const h = { horse_number, jockey, pos };

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
      median: median(winValues),
      raceCount: winCount,
      under300Rate: rateUnder(300),
      under500Rate: rateUnder(500),
      under1000Rate: rateUnder(1000),
    },
    umaren: {
      median: median(umarenValues),
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
