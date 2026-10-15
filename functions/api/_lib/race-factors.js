// 総合推奨馬の4要素(展開・馬番・騎手・補正タイム)の点数付け(2026-10-13追加)。
// 予想登録画面「展開・時計」タブ(GET /api/data-search/race-factors)と、重賞の比率の自動算出(_lib/pace-score.js の過去の年の採点)の
// 両方がこの1か所を使う(以前は画面〈prediction.js〉とサーバーに同じ規則を二重に持っていた)。仕様は docs/design/screens.md「総合推奨馬」。
//
// 規則(ユーザー確認済み。2026-10-13):
//   - 点は偏差値(2026-10-14 ユーザー要望で変更): 要素ごとに、データのある馬の元の値から 50 + 10 ×(値 − 平均)÷ 標準偏差。
//     全頭が同じ値なら全員50。データの無い馬は設定の点(既定40。管理画面で変更。_lib/pace-settings.js)。
//     元の値: 展開=ハイは補正タイム・スローは上がり3F(速いほど高い)・ミドルは両方の偏差値の平均、補正タイム=速いほど高い、
//     馬番・性齢・馬体重=帯の複勝率、騎手=平均に寄せた複勝率、同コース=掲示板内+1・外−1の合計。順位(rank)は表示用に残す。
//     以前(〜2026-10-14)は順位を100(1位)〜0(最下位)の等間隔にした点で、データ無しは25点(さらに前は50点)だった
//   - タイム(補正タイム): このレースより前の完走した走を、次の順で探して一番近い段の中の最速を使う
//       ①同じ芝ダ障・同じ距離 ②同じ芝ダ障・±200m ③同じ芝ダ障・全距離 ④芝⇔ダートの違い(障害は除く)
//     換算: 元のタイム − 走った競馬場の補正値 − 走った日の馬場の補正値(その走の芝ダ・距離の値)→ 距離が違えば
//       「今回の芝ダ・距離の平均勝ちタイム ÷ 走った芝ダ・距離の平均勝ちタイム」を掛ける(平均が出せなければ距離の比)
//       → 今回の競馬場の補正値を足す(_lib/track-trends.js)
//       → 斤量の補正(2026-10-15追加。ユーザー要望・仕様確認済み): (今回の斤量 − その走の斤量)× 1kgあたりの秒数(距離に関係なく一定。
//         既定0.1秒。管理画面で変更。_lib/pace-settings.js の weight_sec_per_kg)を足す(重くなれば遅く、軽くなれば速く)。
//         どちらかの斤量が分からなければ補正しない。斤量の補正込みのタイムで最速の走を選ぶ(weightAdjOf)
//   - 上がり3F: 同じ順で探し、一番近い段の中の最速(換算はしない。競馬場別の補正は今後)
//   - 展開: 前走の脚質でペースを予想(predictPace)し、ハイ=タイム順、スロー=上がり3F順、ミドル=両方の順位の合計順(両方ある馬)
//     2026-10-15 変更(ユーザー要望・仕様確認済み): ハイは「差し・追込」、スローは「逃げ・先行」を**必ず上**にし、その組の中を
//     タイム(スローは上がり3F)の速い順、有利でない組(脚質が分からない馬を含む)はその下で同じく速い順(paceFavoredRank)。
//     脚質は、取消・除外・中止を除きコーナーの通過順がある一番新しい走の最初のコーナー(runningStyleOf。前走が中止・直線なら遡る)。
//     ミドルは変えない。タイム(上がり)が無い馬は従来どおりデータ無し
//   - 馬番: 同コース(競馬場・芝ダ障・距離)の馬番帯別の複勝率順。その馬番帯の騎乗が20回未満なら、同じ競馬場・芝ダ障の全距離、
//     それも20回未満なら全競馬場の同じ芝ダ障。馬番帯は3頭ずつ(1-3, 4-6, 7-9, 10-12, 13-15, 16-18。numberGroupOf)。
//     2026-10-14 ユーザー要望で馬番ごと→馬番帯に変更(馬番ごとでは騎乗が少なく揺れが大きいため。枠番は頭数で
//     同じ馬番でも枠が変わる〈8番が8枠になる等〉ので使わない)。同じ馬番帯の馬は同じ順位・同じ点になる
//   - 騎手: 同コースの複勝率を、騎乗が少ないほどそのコースの平均に寄せた値(10騎乗分の平均を足して割る)の順。
//     同コースで騎乗が無ければ同じ競馬場・芝ダ障、それも無ければ全成績で同じように出す
//   以下3つは 2026-10-14 追加(ユーザー確認済み):
//   - 性齢: 同コースの性齢(牝3・牡4 等。そのレースの時点の年齢)別の複勝率順。今回の馬の性齢は出走馬表(過去の年の採点は結果)の値。
//     騎乗が20回未満なら同場→全場(馬番と同じ)
//   - 馬体重: 前走(体重のある一番新しい走)の馬体重を20kg刻みの体重帯(〜439, 440-459, … 520〜)にし、同コースの体重帯別の
//     複勝率順(騎乗が20回未満なら同場→全場)。今回の馬体重は発走前に無いため前走を使う
//   - 同コース: その馬の同コース(競馬場・芝ダ障・距離)の過去の走ごとに、5着以内(掲示板)なら+1、6着以下なら−1 の合計の順。
//     同コースを走っていない馬は0(データ無しにはしない)。完走した走だけ数える
//   - 週目(week。2026-10-15追加。ユーザー要望・仕様確認済み): 開幕から何週目かで前有利・差し有利が変わるのを、過去の結果から数える。
//     週目は日付から推定する: 同じ競馬場で前の開催日から MEETING_GAP_DAYS(14日)以上空いたら開幕とみなし、開幕日からの日数 ÷ 7 で週を数える
//     (連続する開催〈4回東京→5回東京〉は続けて数える = 芝の傷みが続く「連続開催の何週目」)。週は2週ずつの帯にまとめる
//     (1-2週=1、3-4週=2、5-6週=3、7週〜=4。weekBandOf)。その馬の脚質の組(展開と同じ走の脚質。逃げ・先行=1/差し・追込=2)について、
//     同じ競馬場・芝ダ障の「今回と同じ週の帯」の複勝率 ÷ 「全部の週」の複勝率(1より大きいほど、この週はその脚質が普段より有利)。
//     同じ週の帯の騎乗が20回未満なら全競馬場の同じ芝ダ障で数える。脚質の分からない馬はデータ無し。過去の各馬の脚質は集計用キャッシュの
//     6つ目(脚質の組。_lib/race-lineup-cache.js の v5)
// 「このレースより前」: 戦績・同コース/同場の成績は日付で絞る。全競馬場の成績(馬番・騎手の最後の段)と補正値・平均勝ちタイムは
//   全期間(過去の年の採点ではわずかに先の情報が混ざる。年ごとに出し直すと重いため)。
import { runningStyleOf, firstCornerPosition, timeTextToSeconds } from "./graded-race-search.js";
import { buildTrackTrends, trackTimeOffsets, TREND_MIN_RACES } from "./track-trends.js";
import { normalizeTrackConditionText, sexAgeCodeOf, sexAgeLabelOf, weightBandOf, WEIGHT_BAND_LABELS, LINEUP_STRIDE, styleGroupOf, STYLE_GROUP_LABELS } from "./race-lineup-cache.js";
import { applyJockeyAliasMap, jockeyAliasKeyOf } from "./jockey-alias.js";

// 2026-10-14: sexage(性齢)・weight(馬体重)・course(同コース)を追加。2026-10-15: week(週目)を追加
export const FACTOR_KEYS = ["pace", "number", "jockey", "time", "sexage", "weight", "course", "week"];
// 週目(2026-10-15)
const MEETING_GAP_DAYS = 14;
export const WEEK_BAND_LABELS = ["", "開幕1-2週", "3-4週", "5-6週", "7週〜"];
const DAY_MS = 86400000;
const dayNumOf = (iso) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / DAY_MS);
// 開幕日(日の通し番号)と対象日から週の帯(1〜4)
export function weekBandFrom(startDay, day) {
  const week = Math.floor((day - startDay) / 7) + 1;
  return Math.min(4, Math.max(1, Math.ceil(week / 2)));
}
const BOARD_POSITION = 5; // 同コース: 掲示板(5着以内)
export const DEFAULT_MISSING_SCORE = 40;
export const DEFAULT_WEIGHT_SEC_PER_KG = 0.1; // 斤量1kgあたりの補正の秒数の既定値(2026-10-15)

// 斤量の補正(秒)。今回・その走の斤量のどちらかが無ければ0
export function weightAdjOf(todayKg, runKg, secPerKg = DEFAULT_WEIGHT_SEC_PER_KG) {
  const a = Number(todayKg), b = Number(runKg);
  if (!(a > 0) || !(b > 0) || !Number.isFinite(Number(secPerKg))) return 0;
  return Math.round((a - b) * Number(secPerKg) * 100) / 100;
} // データの無い馬の点(偏差値)の既定値。実際の値は設定(_lib/pace-settings.js)
// 評価点(2026-10-14 ユーザー要望。仕様は docs/design/screens.md「評価点(初距離・初競馬場・継続騎乗)」):
//   - 初距離(first_distance): タイムの点から引く。今回と同じ芝ダ障・同じ距離を完走したことが無い馬
//     (他の距離・芝ダの走を換算すると、馬場・距離の補正が大きくずれることがある。例: 不良と記録された速い決着の1600mを
//      1800mへ換算し、実力より2秒速く出た)
//   - 初競馬場(first_track): タイムの点から引く。今回と同じ競馬場・同じ芝ダ障を完走したことが無い馬
//   - 継続騎乗(same_jockey): 騎手の点に足す。今回の騎手が、その馬に過去1回でも乗ったことがある(取消・除外の走は数えない)
//   - 前年の同レース(prev_board / prev_win。2026-10-14追加): 「同コース」の点に足す。重賞で、前年の同じ重賞を1着なら prev_win、
//     2〜5着(掲示板)なら prev_board(どちらか一方)。前年の同じ重賞のレースは呼び出し側が opts.prevRaceId で渡す(無ければ掛けない)
//   - 位置取り(position)は 2026-10-15 に追加した後、同日に展開の点へ脚質を入れたため削除した(ユーザー判断。二重になるため)
//   - 間隔(layoff。2026-10-15 ユーザー要望・仕様確認済み): 前走(取消・除外を除く一番新しい走。中止は含む)の6か月後の同じ日以降のレース
//     (例: 前走 4/20 → 10/20 以降。月末は短い月に合わせる)なら、**総合点(軸指数・相手指数)から直接**引く。どの要素の点も変えない。
//     **全レース共通**の値だけ(管理画面「評価点の既定値」。重賞・コースごとには持たない = GLOBAL_ADJUST_KEYS)。初出走の馬には掛けない。印 lo は 1/0
//   いずれもその要素のデータがある馬だけ(データ無しの点の馬には掛けない)。値は偏差値の点。重賞・コースごとに自動で選ぶか管理者が入力し、
//   無ければ管理画面の既定値(_lib/pace-settings.js)。どれを使うかは _lib/pace-score.js の getPaceWeights(adjust)
export const ADJUST_KEYS = ["first_distance", "first_track", "same_jockey", "prev_board", "prev_win", "layoff"];
export const DEFAULT_ADJUST = { first_distance: 10, first_track: 5, same_jockey: 5, prev_board: 5, prev_win: 10, layoff: 5 };
// 全レース共通の評価点(重賞・コースごとの評価点には持たない。設定の既定値だけ使う)
export const GLOBAL_ADJUST_KEYS = ["layoff"];
const ADJUST_LABEL = { first_distance: "初距離", first_track: "初競馬場", same_jockey: "継続騎乗", prev_board: "前年掲示板", prev_win: "前年1着", layoff: "間隔" };
const LAYOFF_MONTHS = 6;

// "YYYY-MM-DD" の months か月後の同じ日(無い日は月末)
export function addMonthsIso(iso, months) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const total = Number(m[1]) * 12 + Number(m[2]) - 1 + months;
  const y = Math.floor(total / 12), mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(Number(m[3]), last);
  return `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// 総合点から直接足し引きする評価点(間隔)。flags: { lo }、adjust: 評価点。戻り値 { value(足す点。減点は負), note }
export function totalAdjustOf(flags, adjust) {
  const v = Number(adjust?.layoff) || 0;
  if (!flags?.lo || !v) return { value: 0, note: "" };
  return { value: -v, note: `${ADJUST_LABEL.layoff}−${v}` };
}

// 展開に有利な脚質か(ハイ=差し・追込、スロー=逃げ・先行。ミドル・脚質不明は false)
export function isFavoredStyle(paceType, style) {
  if (paceType === "high") return style === "差し" || style === "追込";
  if (paceType === "slow") return style === "逃げ" || style === "先行";
  return false;
}

// 有利な脚質を必ず上にし、組の中は速い順に並べる。list の各要素に fav(有利か)と t(小さいほど速い)。
// 戻り値は各要素に rank と v(大きいほど良い。偏差値の元の値)を付けたもの。v は「速さの偏差値 + 有利なら速さの幅より大きい底上げ」で、
// 有利な組の最下位が有利でない組の最上位より必ず上になる
export function paceFavoredRank(list) {
  if (!list.length) return [];
  const dev = deviations(list.map((x) => -x.t));
  const lift = Math.max(...dev) - Math.min(...dev) + 1;
  const withV = list.map((x, i) => ({ ...x, v: dev[i] + (x.fav ? lift : 0) }));
  return rankBy(withV, (x) => -x.v);
}

// 1頭の要素の点に評価点を掛ける。factors: { f: { score, missing, value, ... } }、flags: { fd, ft, cj, pb, pw }(0/1)、
// adjust: { first_distance, …, prev_win }(足りない項目は0)。戻り値は新しい factors(pace・time・jockey・course だけ作り直す)
export function applyAdjust(factors, flags, adjust) {
  if (!adjust || !flags) return factors;
  const out = { ...factors };
  const mod = (f, parts) => {
    const x = factors[f];
    if (!x || x.missing) return;
    let d = 0;
    const notes = [];
    for (const [k, sign, on] of parts) {
      const v = Number(adjust[k]) || 0;
      if (!on || !v) continue;
      d += sign * v;
      notes.push(`${ADJUST_LABEL[k]}${sign > 0 ? "+" : "−"}${v}`);
    }
    if (d) out[f] = { ...x, score: x.score + d, value: `${x.value || ""} ${notes.join(" ")}`.trim() };
  };
  mod("time", [["first_distance", -1, flags.fd], ["first_track", -1, flags.ft]]);
  mod("jockey", [["same_jockey", 1, flags.cj]]);
  mod("course", [["prev_board", 1, flags.pb], ["prev_win", 1, flags.pw]]);
  return out;
}

// 値(大きいほど良い)の配列 → 偏差値の配列。全員同じ・1頭だけなら50
function deviations(vals) {
  const n = vals.length;
  if (!n) return [];
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return vals.map((v) => (sd > 1e-9 ? 50 + (10 * (v - mean)) / sd : 50));
}
const NUMBER_MIN_RIDES = 20;
const JOCKEY_PRIOR_RIDES = 10;
const NEAR_DISTANCE = 200;
const NUMBER_GROUP_SIZE = 3;

// 馬番 → 馬番帯(1-3 → 1, 4-6 → 2, … 16-18 → 6)
export function numberGroupOf(hn) {
  return Math.ceil(Number(hn) / NUMBER_GROUP_SIZE);
}
const numberGroupLabel = (g) => `${(g - 1) * NUMBER_GROUP_SIZE + 1}-${g * NUMBER_GROUP_SIZE}番`;

export function predictPace(styles, fieldSize) {
  let nige = 0, senko = 0;
  for (const s of styles) {
    if (s === "逃げ") nige++;
    else if (s === "先行") senko++;
  }
  const front = nige + senko;
  return nige >= 2 || front >= fieldSize / 2 ? "high" : nige <= 1 && front <= fieldSize / 4 ? "slow" : "middle";
}

// 小さい順に並べて同値同順位
export function rankBy(list, valueOf) {
  const sorted = [...list].sort((a, b) => valueOf(a) - valueOf(b));
  let rank = 0;
  return sorted.map((x, i) => {
    if (i === 0 || valueOf(x) !== valueOf(sorted[i - 1])) rank = i + 1;
    return { ...x, rank };
  });
}

// ---- 共通の下ごしらえ(集計用キャッシュ・勝ちタイムのキャッシュから。同じ配列なら使い回す) ----

const contextCache = new WeakMap(); // lineups 配列 -> { raceTimes, ctx }

function newCounts() {
  return { rides: 0, first: 0, show: 0 };
}
function addRide(m, k, pos) {
  let c = m.get(k);
  if (!c) m.set(k, (c = newCounts()));
  c.rides++;
  if (pos === 1) c.first++;
  if (pos >= 1 && pos <= 3) c.show++;
}

// lineups: getRaceLineups()、raceTimes: getRaceTimes()、aliasMap: 騎手名エイリアス(loadJockeyAliasMap 等)。
// 3つとも同じもの(使い回し中の同じ配列・Map)なら、前回の下ごしらえを使う(CPU時間対策)
export function createFactorContext(lineups, raceTimes, aliasMap) {
  const hit = contextCache.get(lineups);
  if (hit && hit.raceTimes === raceTimes && hit.aliasMap === aliasMap) return hit.ctx;
  const jockeyKeyOf = (name) => jockeyAliasKeyOf(applyJockeyAliasMap(aliasMap, name));

  // 2026-10-14 CPU時間対策: lineup を展開せず、集計用キャッシュの平らな配列(flat。LINEUP_STRIDE ずつ)のまま数える。
  // 騎手は範囲ごとの辞書(dict)の番号なので、辞書ごとに騎手キーの配列を1回だけ作る。
  const jockeyKey = new Map(); // 生の騎手名 -> キー
  const keyOf = (name) => {
    if (!name) return "";
    let k = jockeyKey.get(name);
    if (k === undefined) jockeyKey.set(name, (k = jockeyKeyOf(name)));
    return k;
  };
  const dictKeys = new Map(); // dict 配列 -> 騎手キーの配列
  const keysOfDict = (dict) => {
    let a = dictKeys.get(dict);
    if (!a) dictKeys.set(dict, (a = dict.map(keyOf)));
    return a;
  };
  // 週目(2026-10-15): 競馬場ごとの開催日(日の通し番号。昇順)と、各開催日の開幕日。前の開催日から MEETING_GAP_DAYS 未満なら同じ開催
  const daysByTrack = new Map(); // 競馬場 -> { days: [...], starts: [...] }
  {
    const sets = new Map();
    for (const r of lineups) {
      if (!r.track || !r.race_date) continue;
      if (!sets.has(r.track)) sets.set(r.track, new Set());
      sets.get(r.track).add(dayNumOf(r.race_date));
    }
    for (const [t, set] of sets) {
      const days = [...set].filter(Number.isFinite).sort((a, b) => a - b);
      const starts = [];
      days.forEach((d, i) => starts.push(i > 0 && d - days[i - 1] < MEETING_GAP_DAYS ? starts[i - 1] : d));
      daysByTrack.set(t, { days, starts });
    }
  }
  const weekMemo = new Map();
  // 競馬場・日付 → 週の帯(1〜4)。結果の無い今後の日付は、その前の開催日から続いていればその開催の週
  const weekBandOf = (track, iso) => {
    const mk = `${track}|${iso}`;
    let v = weekMemo.get(mk);
    if (v !== undefined) return v;
    const d = dayNumOf(iso);
    const t = daysByTrack.get(track);
    let start = d;
    if (t && Number.isFinite(d)) {
      let lo = 0, hi = t.days.length - 1, j = -1; // 最後の「d 以下」の開催日
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (t.days[mid] <= d) { j = mid; lo = mid + 1; } else hi = mid - 1; }
      if (j >= 0 && (t.days[j] === d || d - t.days[j] < MEETING_GAP_DAYS)) start = t.starts[j];
    }
    v = Number.isFinite(d) ? weekBandFrom(start, d) : 0;
    weekMemo.set(mk, v);
    return v;
  };
  const fieldSizeByRace = new Map();
  const byTrackCt = new Map(); // "競馬場|芝ダ障" -> [{ race_date, distance, flat, jk, week }]
  for (const r of lineups) {
    if (!r.flat) continue;
    fieldSizeByRace.set(Number(r.id), r.size);
    const g = `${r.track}|${r.course_type}`;
    if (!byTrackCt.has(g)) byTrackCt.set(g, []);
    byTrackCt.get(g).push({ race_date: String(r.race_date), distance: Number(r.distance), flat: r.flat, jk: keysOfDict(r.dict), week: weekBandOf(r.track, String(r.race_date)) });
  }
  // 全競馬場の成績(全期間)。同コース・同場に記録が無いときの最後の補いにしか使わないため、初めて必要になったときに
  // 種類ごとに数える(2026-10-14: 4種類まとめて数えると本番の6.3万騎乗で約14ミリ秒かかったため、要る種類だけにした)。
  //   numberAllByCt / sexAllByCt / weightAllByCt: 芝ダ障 -> Map(馬番帯 / 性齢コード / 体重帯 -> counts)、jockeyAll: 騎手キー -> counts
  //   weekAllByCt(2026-10-15): 芝ダ障 -> Map("週の帯|脚質の組" と "a|脚質の組"〈全部の週〉 -> counts)
  const allCounts = {};
  const allOf = (kind) => {
    if (allCounts[kind]) return allCounts[kind];
    const out = new Map();
    const S = LINEUP_STRIDE;
    for (const r of lineups) {
      const flat = r.flat;
      if (!flat) continue;
      if (kind === "jockeyAll") {
        const jk = keysOfDict(r.dict);
        for (let i = 0; i < flat.length; i += S) {
          const ji = flat[i + 1];
          if (ji >= 0 && jk[ji]) addRide(out, jk[ji], flat[i + 2]);
        }
        continue;
      }
      let m = out.get(r.course_type);
      if (!m) out.set(r.course_type, (m = new Map()));
      if (kind === "weekAllByCt") {
        const wk = weekBandOf(r.track, String(r.race_date));
        for (let i = 0; i < flat.length; i += S) {
          const sg = flat[i + 5];
          if (!sg) continue;
          addRide(m, `a|${sg}`, flat[i + 2]);
          if (wk) addRide(m, `${wk}|${sg}`, flat[i + 2]);
        }
        continue;
      }
      for (let i = 0; i < flat.length; i += S) {
        const k = kind === "numberAllByCt" ? (flat[i] > 0 ? numberGroupOf(flat[i]) : 0) : kind === "sexAllByCt" ? flat[i + 3] : flat[i + 4];
        if (k) addRide(m, k, flat[i + 2]);
      }
    }
    return (allCounts[kind] = out);
  };

  // 芝ダ障・距離ごとの勝ちタイム(補正値と平均)
  const timesByCourse = new Map();
  for (const t of raceTimes) {
    const k = `${t.course_type}|${Number(t.distance)}`;
    if (!timesByCourse.has(k)) timesByCourse.set(k, []);
    timesByCourse.get(k).push(t);
  }
  const courseInfo = new Map();
  const courseOf = (ct, d) => {
    const k = `${ct}|${Number(d)}`;
    let v = courseInfo.get(k);
    if (!v) {
      const trends = buildTrackTrends(timesByCourse.get(k) || [], { courseType: ct, distance: d });
      const ov = trends.overall;
      const avg = ov["良"].n >= TREND_MIN_RACES ? ov["良"].avg : ov.all.n >= TREND_MIN_RACES ? ov.all.avg : null;
      v = { offsets: trackTimeOffsets(trends), avg };
      courseInfo.set(k, v);
    }
    return v;
  };

  const ctx = { fieldSizeByRace, byTrackCt, allOf, keyOf, courseOf, weekBandOf };
  contextCache.set(lineups, { raceTimes, aliasMap, ctx });
  return ctx;
}

// ---- 1レース分の採点 ----

const fmtSec = (sec) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, "0")}` : s.toFixed(1);
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const TIER_LABEL = { 1: "", 2: "±200m換算", 3: "距離換算", 4: "芝ダ換算" };
const SCOPE_LABEL = { course: "同コース", track: "同場", all: "全場" };

// 走の段(1〜4。対象外は 0)
function tierOf(run, race) {
  if (run.course_type === race.course_type) {
    const diff = Math.abs(Number(run.distance) - Number(race.distance));
    return diff === 0 ? 1 : diff <= NEAR_DISTANCE ? 2 : 3;
  }
  const flat = (ct) => ct === "芝" || ct === "ダート";
  return flat(run.course_type) && flat(race.course_type) ? 4 : 0;
}

// 走のタイムを今回の競馬場・良馬場・芝ダ・距離に換算する
function convertTime(ctx, sec, run, race) {
  const src = ctx.courseOf(run.course_type, run.distance);
  const off = (m, k) => (k != null && m.get(k) != null ? m.get(k) : 0);
  let base = sec - off(src.offsets.trackOff, run.track) - off(src.offsets.condOff, normalizeTrackConditionText(run.track_condition));
  const tgt = ctx.courseOf(race.course_type, race.distance);
  if (run.course_type !== race.course_type || Number(run.distance) !== Number(race.distance)) {
    base *= src.avg && tgt.avg ? tgt.avg / src.avg : Number(race.distance) / Number(run.distance);
  }
  return base + off(tgt.offsets.trackOff, race.track);
}

// race: { id, race_date, track, course_type, distance }
// runners: [{ key, horse_number, jockey, sex_age, weight_carried }](key は馬の名寄せキー。runsByHorse のキーと同じ。weight_carried は今回の斤量〈2026-10-15〉)
// runsByHorse: Map(key -> [{ race_id, race_date, race_number, status, finish_position, corner_positions, time_text, final_furlong_time,
//   body_weight, track, course_type, distance, track_condition }])(日付はここで「このレースより前」に絞る)
// 戻り値: { pace_type, counts: { nige, senko, unknown, n }, factors: { pace|number|jockey|time: Map(key -> {score, rank, value, missing}) } }
// opts.missingScore: データの無い馬の点(偏差値。設定 getPaceScoreSettings の missing_score。省略時は既定40)
// opts.adjust: 評価点 { first_distance, …, prev_win }(null なら掛けない。過去の採点〈比率の計算の材料〉は掛けずに flags を渡す)
// opts.prevRaceId: 前年の同じ重賞のレースID(重賞でなければ・前年が無ければ null)
// 戻り値の flags: Map(key -> { fd, ft, cj, pb, pw, po, lo })(評価点の印。その要素のデータがある馬だけ 1〈po は ±1〉。runsByHorse の各走に jockey が要る)
// 戻り値の totalAdjust: Map(key -> { value, note })(総合点へ直接足す点。間隔。adjust があるときだけ)
// opts.weightSecPerKg: 斤量1kgあたりの補正の秒数(設定 getPaceScoreSettings の weight_sec_per_kg。省略時は既定0.1)。runsByHorse の各走に weight_carried が要る
export function computeRaceFactors(ctx, race, runners, runsByHorse, { missingScore = DEFAULT_MISSING_SCORE, adjust = null, prevRaceId = null, weightSecPerKg = DEFAULT_WEIGHT_SEC_PER_KG } = {}) {
  const date = String(race.race_date);
  const n = runners.length;

  // 戦績: 脚質・タイム・上がり
  const styles = [];
  const horses = runners.map((h) => {
    const runs = (runsByHorse.get(h.key) || [])
      .filter((x) => String(x.race_date) < date)
      .sort((a, b) => String(b.race_date).localeCompare(String(a.race_date)) || b.race_number - a.race_number);
    const last = runs.find((x) => x.status !== "scratched" && x.status !== "excluded");
    styles.push(last ? runningStyleOf(last.corner_positions, ctx.fieldSizeByRace.get(Number(last.race_id))) : null);
    // 展開の脚質(2026-10-15): 取消・除外・中止を除き、通過順のある一番新しい走の最初のコーナー
    const posRun = runs.find((x) => x.status !== "scratched" && x.status !== "excluded" && x.status !== "stopped" && firstCornerPosition(x.corner_positions));
    const paceStyle = posRun ? runningStyleOf(posRun.corner_positions, ctx.fieldSizeByRace.get(Number(posRun.race_id))) : null;
    // 間隔の評価点(2026-10-15): 前走(中止を含む)の6か月後の同じ日以降
    const layoffFrom = last ? addMonthsIso(last.race_date, LAYOFF_MONTHS) : null;
    const layoff = Boolean(layoffFrom && layoffFrom <= date);
    let time = null, timeTier = 9, timeRun = null, timeKgAdj = 0, l3 = null, l3Tier = 9;
    // 前走の馬体重(体重のある一番新しい走)と、同コースの掲示板(5着以内)の数
    const weightRun = runs.find((x) => x.status !== "scratched" && x.status !== "excluded" && Number(x.body_weight) > 0);
    let boardIn = 0, boardOut = 0;
    // 評価点の印(2026-10-14): 同じ芝ダ障・距離 / 同じ競馬場・芝ダ障を完走したか、今回の騎手が乗ったことがあるか
    let ranDistance = false, ranTrack = false, rodeBefore = false, prevPos = null;
    const jkNow = ctx.keyOf(h.jockey);
    for (const x of runs) {
      if (jkNow && x.status !== "scratched" && x.status !== "excluded" && x.jockey && ctx.keyOf(x.jockey) === jkNow) rodeBefore = true;
      if (x.status !== "finished") continue;
      if (prevRaceId && Number(x.race_id) === Number(prevRaceId) && Number(x.finish_position) > 0) prevPos = Number(x.finish_position);
      if (x.course_type === race.course_type) {
        if (Number(x.distance) === Number(race.distance)) ranDistance = true;
        if (x.track === race.track) ranTrack = true;
      }
      if (x.track === race.track && x.course_type === race.course_type && Number(x.distance) === Number(race.distance) && Number(x.finish_position) > 0) {
        if (Number(x.finish_position) <= BOARD_POSITION) boardIn++;
        else boardOut++;
      }
      const tier = tierOf(x, race);
      if (!tier) continue;
      const sec = timeTextToSeconds(x.time_text);
      if (sec != null && tier <= timeTier) {
        const kgAdj = weightAdjOf(h.weight_carried, x.weight_carried, weightSecPerKg);
        const c = convertTime(ctx, sec, x, race) + kgAdj;
        if (tier < timeTier || c < time) { time = c; timeTier = tier; timeRun = x; timeKgAdj = kgAdj; }
      }
      const f = Number(x.final_furlong_time);
      if (x.final_furlong_time != null && f > 0 && tier <= l3Tier && (tier < l3Tier || f < l3)) { l3 = f; l3Tier = tier; }
    }
    return { key: h.key, h, time, timeTier, timeRun, l3, l3Tier, bodyWeight: weightRun ? Number(weightRun.body_weight) : null, boardIn, boardOut, ranDistance, ranTrack, rodeBefore, prevPos, paceStyle, layoff, timeKgAdj };
  });
  let nige = 0, senko = 0, unknown = 0;
  for (const s of styles) {
    if (!s) unknown++;
    else if (s === "逃げ") nige++;
    else if (s === "先行") senko++;
  }
  const paceType = predictPace(styles, n);
  const kgText = (x) => (x.timeKgAdj ? ` 斤量${x.timeKgAdj > 0 ? "+" : "−"}${Math.abs(x.timeKgAdj).toFixed(1)}` : "");
  const timeText = (x) => `補${fmtSec(x.time)}${TIER_LABEL[x.timeTier] ? `(${x.timeRun.course_type}${x.timeRun.distance}m・${TIER_LABEL[x.timeTier]})` : ""}${kgText(x)}`;
  const l3Text = (x) => `上${x.l3.toFixed(1)}${TIER_LABEL[x.l3Tier] ? "(他距離)" : ""}`;

  // 馬番・騎手: 同コース・同場(芝ダ障が同じ)の成績(このレースより前)
  // 騎手は今回乗る騎手だけ数え、平均用に全騎乗の合計を別に数える(2026-10-14 CPU時間対策。結果は同じ)
  const numCourse = new Map(), numTrack = new Map(), jkCourse = new Map(), jkTrack = new Map();
  const sexCourse = new Map(), sexTrack = new Map(), wtCourse = new Map(), wtTrack = new Map();
  // 週目(2026-10-15): 今回の週の帯と、同じ競馬場・芝ダ障の脚質の組ごとの成績(今回と同じ週の帯 / 全部の週)
  const weekBand = ctx.weekBandOf(race.track, date);
  const weekSame = new Map(), weekAll = new Map();
  const runnerJk = new Set(runners.map((h) => ctx.keyOf(h.jockey)).filter(Boolean));
  const jkTotal = { course: newCounts(), track: newCounts() };
  const addTotal = (c, pos) => { c.rides++; if (pos === 1) c.first++; if (pos >= 1 && pos <= 3) c.show++; };
  const S = LINEUP_STRIDE;
  for (const r of ctx.byTrackCt.get(`${race.track}|${race.course_type}`) || []) {
    if (r.race_date >= date) continue;
    const same = r.distance === Number(race.distance);
    const flat = r.flat;
    for (let i = 0; i < flat.length; i += S) {
      const hn = flat[i], ji = flat[i + 1], pos = flat[i + 2], sa = flat[i + 3], wb = flat[i + 4], sg = flat[i + 5];
      if (sg) {
        addRide(weekAll, sg, pos);
        if (r.week === weekBand) addRide(weekSame, sg, pos);
      }
      if (hn > 0) {
        const g = numberGroupOf(hn);
        addRide(numTrack, g, pos);
        if (same) addRide(numCourse, g, pos);
      }
      if (sa) {
        addRide(sexTrack, sa, pos);
        if (same) addRide(sexCourse, sa, pos);
      }
      if (wb) {
        addRide(wtTrack, wb, pos);
        if (same) addRide(wtCourse, wb, pos);
      }
      const jk = ji >= 0 ? r.jk[ji] : "";
      if (jk) {
        addTotal(jkTotal.track, pos);
        if (same) addTotal(jkTotal.course, pos);
        if (runnerJk.has(jk)) {
          addRide(jkTrack, jk, pos);
          if (same) addRide(jkCourse, jk, pos);
        }
      }
    }
  }
  // 馬番帯・性齢・体重帯: 同コース → 同場 → 全場(騎乗が NUMBER_MIN_RIDES 未満なら次の段)の複勝率
  const groupRate = (k, course, track, allKey) => {
    let c = course.get(k), scope = "course";
    if (!c || c.rides < NUMBER_MIN_RIDES) { c = track.get(k); scope = "track"; }
    if (!c || c.rides < NUMBER_MIN_RIDES) { c = (ctx.allOf(allKey).get(race.course_type) || new Map()).get(k); scope = "all"; }
    return c && c.rides ? { show: c.show / c.rides, win: c.first / c.rides, rides: c.rides, scope } : null;
  };
  const numberList = [], sexList = [], weightList = [], weekList = [];
  // 週目: 同じ週の帯の複勝率 ÷ 全部の週の複勝率(同場で同じ週の帯の騎乗が NUMBER_MIN_RIDES 未満なら全場)
  const rateOf = (c) => (c && c.rides ? c.show / c.rides : null);
  for (const x of horses) {
    const sg = styleGroupOf(x.paceStyle);
    if (!sg || !weekBand) continue;
    let same = weekSame.get(sg), all = weekAll.get(sg), scope = "track";
    if (!same || same.rides < NUMBER_MIN_RIDES || !rateOf(all)) {
      const m = ctx.allOf("weekAllByCt").get(race.course_type) || new Map();
      same = m.get(`${weekBand}|${sg}`); all = m.get(`a|${sg}`); scope = "all";
    }
    const rs = rateOf(same), ra = rateOf(all);
    if (rs == null || !ra) continue;
    weekList.push({ key: x.key, sg, show: rs, base: ra, ratio: rs / ra, rides: same.rides, scope });
  }
  for (const h of runners) {
    const hn = Number(h.horse_number);
    if (!(hn > 0)) continue;
    const g = numberGroupOf(hn);
    const r = groupRate(g, numCourse, numTrack, "numberAllByCt");
    if (r) numberList.push({ key: h.key, ...r, group: g });
  }
  for (const h of runners) {
    const sa = sexAgeCodeOf(h.sex_age);
    if (!sa) continue;
    const r = groupRate(sa, sexCourse, sexTrack, "sexAllByCt");
    if (r) sexList.push({ key: h.key, ...r, sa });
  }
  for (const x of horses) {
    const wb = weightBandOf(x.bodyWeight);
    if (!wb) continue;
    const r = groupRate(wb, wtCourse, wtTrack, "weightAllByCt");
    if (r) weightList.push({ key: x.key, ...r, wb, kg: x.bodyWeight });
  }
  // 騎手: 段ごとの平均(そのコース等の全騎乗の複勝率・単勝率)に、騎乗が少ないほど寄せる
  const avgOf = (c) => ({ show: c.rides ? c.show / c.rides : 0, win: c.rides ? c.first / c.rides : 0 });
  const jkAvg = { course: avgOf(jkTotal.course), track: avgOf(jkTotal.track) };
  const jkAllAvg = () => {
    if (jkAvg.all) return jkAvg.all;
    const t = newCounts();
    for (const c of ctx.allOf("jockeyAll").values()) { t.rides += c.rides; t.show += c.show; t.first += c.first; }
    return (jkAvg.all = avgOf(t));
  };
  const jockeyList = [];
  for (const h of runners) {
    const jk = ctx.keyOf(h.jockey);
    if (!jk) continue;
    let c = jkCourse.get(jk), scope = "course";
    if (!c || !c.rides) { c = jkTrack.get(jk); scope = "track"; }
    if (!c || !c.rides) { c = ctx.allOf("jockeyAll").get(jk); scope = "all"; }
    if (!c || !c.rides) continue;
    const a = scope === "all" ? jkAllAvg() : jkAvg[scope], K = JOCKEY_PRIOR_RIDES;
    jockeyList.push({
      key: h.key, rides: c.rides, scope, rawShow: c.show / c.rides,
      show: (c.show + K * a.show) / (c.rides + K), win: (c.first + K * a.win) / (c.rides + K),
    });
  }
  const rateRank = (list) => {
    const sorted = [...list].sort((a, b) => b.show - a.show || b.win - a.win || b.rides - a.rides);
    let rank = 0;
    return sorted.map((x, i) => {
      const p = sorted[i - 1];
      if (i === 0 || x.show !== p.show || x.win !== p.win) rank = i + 1;
      return { ...x, rank };
    });
  };

  // 並び(rank は表示用)と偏差値の元の値 v(大きいほど良い。2026-10-14〜)
  const withTime = horses.filter((x) => x.time != null);
  const withL3 = horses.filter((x) => x.l3 != null);
  let paceRanked;
  // ハイ・スロー: 有利な脚質の組が必ず上、組の中は速い順(2026-10-15。paceFavoredRank)
  const styleText = (x) => x.paceStyle || "脚質不明";
  if (paceType === "high") {
    paceRanked = paceFavoredRank(withTime.map((x) => ({ ...x, t: x.time, fav: isFavoredStyle("high", x.paceStyle) })))
      .map((x) => ({ ...x, value: `${styleText(x)} ${timeText(x)}` }));
  } else if (paceType === "slow") {
    paceRanked = paceFavoredRank(withL3.map((x) => ({ ...x, t: x.l3, fav: isFavoredStyle("slow", x.paceStyle) })))
      .map((x) => ({ ...x, value: `${styleText(x)} ${l3Text(x)}` }));
  } else {
    // ミドル: 補正タイムと上がり3Fそれぞれの偏差値の平均(両方ある馬)
    const both = horses.filter((x) => x.time != null && x.l3 != null);
    const dt = deviations(both.map((x) => -x.time)), dl = deviations(both.map((x) => -x.l3));
    paceRanked = rankBy(both.map((x, i) => ({ ...x, v: (dt[i] + dl[i]) / 2, direct: true })), (x) => -x.v)
      .map((x) => ({ ...x, value: `${timeText(x)} ${l3Text(x)}` }));
  }
  const ranked = {
    pace: paceRanked,
    time: rankBy(withTime, (x) => x.time).map((x) => ({ ...x, v: -x.time, value: timeText(x) })),
    number: rateRank(numberList).map((x) => ({ ...x, v: x.show, value: `${numberGroupLabel(x.group)} 複${pct(x.show)} 単${pct(x.win)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    jockey: rateRank(jockeyList).map((x) => ({ ...x, v: x.show, value: `複${pct(x.rawShow)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    sexage: rateRank(sexList).map((x) => ({ ...x, v: x.show, value: `${sexAgeLabelOf(x.sa)} 複${pct(x.show)} 単${pct(x.win)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    week: rankBy(weekList, (x) => -x.ratio).map((x) => ({
      ...x, v: x.ratio,
      value: `${WEEK_BAND_LABELS[weekBand]} ${STYLE_GROUP_LABELS[x.sg]} 複${pct(x.show)}(全週${pct(x.base)}・${x.rides}騎乗・${SCOPE_LABEL[x.scope]})`,
    })),
    weight: rateRank(weightList).map((x) => ({ ...x, v: x.show, value: `前走${x.kg}kg(${WEIGHT_BAND_LABELS[x.wb]}) 複${pct(x.show)} 単${pct(x.win)}(${x.rides}騎乗・${SCOPE_LABEL[x.scope]})` })),
    // 同コース: 全頭を並べる(走っていない馬は0)。多い順
    course: rankBy(horses.map((x) => ({ ...x, sum: x.boardIn - x.boardOut })), (x) => -x.sum).map((x) => ({
      ...x,
      v: x.sum,
      value: x.boardIn || x.boardOut ? `同コース 5着以内${x.boardIn}回・6着以下${x.boardOut}回(${x.sum > 0 ? "+" : ""}${x.sum})` : "同コース未出走(0)",
    })),
  };
  const factors = {};
  for (const f of FACTOR_KEYS) {
    const list = ranked[f];
    // direct: 値がすでに偏差値(ミドルの展開)
    const dev = list.length && list[0].direct ? list.map((x) => x.v) : deviations(list.map((x) => x.v));
    const map = new Map();
    list.forEach((x, i) => map.set(x.key, { score: dev[i], rank: x.rank, value: x.value, missing: false }));
    for (const h of runners) if (!map.has(h.key)) map.set(h.key, { score: missingScore, rank: null, value: null, missing: true });
    factors[f] = map;
  }
  // 評価点の印(データのある要素だけ)
  const flags = new Map();
  for (const x of horses) {
    const timeOk = !factors.time.get(x.key)?.missing, jkOk = !factors.jockey.get(x.key)?.missing;
    flags.set(x.key, {
      fd: timeOk && !x.ranDistance ? 1 : 0, ft: timeOk && !x.ranTrack ? 1 : 0, cj: jkOk && x.rodeBefore ? 1 : 0,
      pw: x.prevPos === 1 ? 1 : 0, pb: x.prevPos >= 2 && x.prevPos <= BOARD_POSITION ? 1 : 0,
      lo: x.layoff ? 1 : 0,
    });
  }
  const ADJUSTED = ["pace", "time", "jockey", "course"];
  if (adjust) {
    for (const x of horses) {
      const one = applyAdjust(Object.fromEntries(ADJUSTED.map((f) => [f, factors[f].get(x.key)])), flags.get(x.key), adjust);
      for (const f of ADJUSTED) factors[f].set(x.key, one[f]);
    }
    // 評価点を足した後の点の順に順位を付け直す(画面の推奨馬の「騎手」等の一覧は順位で並べるため)。同じ点は同じ順位
    for (const f of ADJUSTED) {
      const sorted = [...factors[f].values()].filter((v) => !v.missing).sort((a, b) => b.score - a.score);
      sorted.forEach((v, i) => { v.rank = i > 0 && v.score === sorted[i - 1].score ? sorted[i - 1].rank : i + 1; });
    }
  }
  // 総合点から直接足し引きする評価点(間隔。2026-10-15)。adjust が無ければ空
  const totalAdjust = new Map();
  if (adjust) for (const x of horses) totalAdjust.set(x.key, totalAdjustOf(flags.get(x.key), adjust));
  return { pace_type: paceType, counts: { nige, senko, unknown, n }, factors, flags, totalAdjust };
}
