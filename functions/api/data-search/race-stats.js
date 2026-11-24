import { jsonError, getRaceLineups } from "../_shared.js";
import { STYLE_CODE_LABELS } from "../_lib/race-lineup-cache.js";
import { jockeyAliasKeyOf } from "../_lib/jockey-alias.js";
import { jockeyDisplayName } from "../_lib/race-lineup.js";
import { emptyRideCounts, addRide, finalizeRideCounts } from "../_lib/jockey-stats.js";

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
// 騎手名の名寄せキーは jockeyAliasKeyOf(先頭の見習い減量記号と空白を除く)、表示名は jockeyDisplayName(記号を除き空白を1つに)。
// 2026-11-24 にこのファイルの書き写し(jockeyKey・jockeyDisplay)から共通の関数に置き換えた(中身は同じ)

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
  // 年(2026-11-13。"2025" 等。空なら全期間)。過去の重賞を取り込んだ年が混ざるのを年で分けて見られるように
  const year = (url.searchParams.get("year") || "").trim();
  if (year && !/^\d{4}$/.test(year)) {
    return jsonError("yearが不正です", 400);
  }

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
  const yearOptionSet = new Set();
  const distanceOptionSet = new Set();
  const winValues = [];
  const umarenValues = [];
  const jockeyMap = new Map(); // key -> { display, rides, wins, shows }
  const byHorseNumber = new Map(); // number -> emptyRideCounts()(騎手検索タブと同じ数え方。_lib/jockey-stats.js)
  // 脚質別(2026-11-23)。lineup の7つ目〈1=逃げ・2=先行・3=差し・4=追込、0=不明〉ごと
  const byStyle = new Map(); // code -> emptyRideCounts()
  const addPlacing = (map, k, pos) => {
    if (!map.has(k)) map.set(k, emptyRideCounts());
    addRide(map.get(k), pos);
  };
  let resultRaceCount = 0;

  for (const race of raceRows || []) {
    const ct = race.course_type || null;
    const raceYear = race.race_date ? String(race.race_date).slice(0, 4) : "";
    if (raceYear) yearOptionSet.add(raceYear);
    if (year && raceYear !== year) continue;
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
    for (const [horse_number, jockey, pos, , , , styleCode] of race.lineup) {
      addPlacing(byStyle, styleCode || 0, pos);
      const h = { horse_number, jockey, pos };

      const rawJockey = h.jockey;
      if (rawJockey && String(rawJockey).trim()) {
        const key = jockeyAliasKeyOf(rawJockey);
        if (key) {
          let e = jockeyMap.get(key);
          if (!e) {
            e = { display: jockeyDisplayName(rawJockey), rides: 0, wins: 0, shows: 0 };
            jockeyMap.set(key, e);
          }
          e.rides++;
          if (h.pos === 1) e.wins++;
          if (h.pos != null) e.shows++;
        }
      }

      const hn = h.horse_number;
      if (Number.isInteger(hn) && hn >= 1 && hn <= 18) addPlacing(byHorseNumber, hn, h.pos);
    }
  }

  const minRides = Math.min(50, Math.max(5, Math.ceil(resultRaceCount * 0.05)));
  const jockeyEntries = [...jockeyMap.values()];

  const winCount = winValues.length;
  const rateUnder = (limit) =>
    winCount ? winValues.filter((v) => v <= limit).length / winCount : null;

  // 応答の形(starts・win 等)は以前のまま
  const placingOut = (c) => {
    const f = finalizeRideCounts(c);
    return { starts: f.rides, win: f.first, second: f.second, third: f.third, winRate: f.winRate, quinellaRate: f.quinellaRate, showRate: f.showRate };
  };
  const byHorseNumberOut = [...byHorseNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([horseNumber, b]) => ({ horseNumber, ...placingOut(b) }));
  // 並びは 逃げ → 先行 → 差し → 追込 → 不明(騎手検索タブの脚質別と同じ)
  const byStyleOut = [1, 2, 3, 4, 0]
    .filter((code) => byStyle.has(code))
    .map((code) => ({ style: STYLE_CODE_LABELS[code], ...placingOut(byStyle.get(code)) }));

  return Response.json({
    filters: { track, course_type: surface, distance, year },
    trackOptions: [...trackOptionSet],
    yearOptions: [...yearOptionSet].sort((a, b) => b.localeCompare(a)),
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
    byStyle: byStyleOut,
  });
}
