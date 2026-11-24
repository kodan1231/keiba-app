// 総合推奨馬の指数と推奨馬の印(◎〇▲☆)の規則(2026-11-24 にまとめた。ES モジュール・依存なし)。
// 予想登録画面(prediction.js が race-factors と一緒に動的 import)、サーバー(_lib/pace-score.js が re-export。
// 馬券購入画面の目印・推奨馬の印の記録〈_lib/race-signals.js〉・推奨馬比較〈_lib/pick-stats.js〉・重賞検索の検証〈gradedPicksOf〉)、
// 夜間の Node(scripts/pace-nightly.mjs 経由)の全部がこの1か所を使う。
// 以前は画面 prediction.js の paceRecommendMarks とサーバーの pickRecommended に同じ規則を2回書いており、
// 規則を変えるたびに2か所を直す必要があった。docs/design/screens.md「推奨馬の印(◎〇▲☆)」

// 8要素(_lib/race-factors.js の FACTOR_KEYS はこれを使う。週目は2026-10-15追加)
export const PACE_FACTOR_KEYS = ["pace", "number", "jockey", "time", "sexage", "weight", "course", "week"];

export const RECOMMEND_MARKS = ["◎", "〇", "▲", "☆"];
// ☆の候補にする補正タイムの点の下限
export const STAR_TIME_MIN = 40;

// 指数 = Σ 比率 × 点 ÷ 比率の合計。factors: { f: { score } }、w: { w_<要素>: 比率 }
export function paceIndexOf(factors, w) {
  const wOf = (f) => Number(w[`w_${f}`] ?? 0);
  const wSum = PACE_FACTOR_KEYS.reduce((a, f) => a + wOf(f), 0) || 1;
  return PACE_FACTOR_KEYS.reduce((a, f) => a + wOf(f) * factors[f].score, 0) / wSum;
}

// 1頭の軸指数・相手指数と、印を選ぶのに使う点。extra = 総合点へ直接足す評価点(間隔。2026-10-15)、
// wa・wp = このレースのペース予想の軸・相手の比率
export function indexedHorse(factors, extra, wa, wp) {
  const add = Number(extra) || 0;
  return {
    axis: paceIndexOf(factors, wa) + add,
    partner: paceIndexOf(factors, wp) + add,
    pace: factors.pace?.score,
    time: factors.time?.score,
    timeMissing: Boolean(factors.time?.missing),
  };
}

// 推奨馬の4頭を選ぶ(2026-10-25 ユーザー要望。2026-10-31 選び方を変更。2026-11-23 ▲を変更)。
// horses: [{ horse_number, axis, partner, pace, time, timeMissing }] → [{ mark: "◎"|"〇"|"▲"|"☆", x: 要素 }](頭数が足りなければ短い)
//   pace・time = 展開・補正タイムの点(評価点を掛けた後。初距離・初競馬場の減点は 2026-11-04 にやめた)、timeMissing = 補正タイムのデータが無い
//   ◎ = 合計(軸指数+相手指数)の1位(同じなら軸指数の高い方)
//   〇 = 残りの軸指数の1位(同じなら相手指数の高い方)
//   ▲ = 残りの「補正タイムの点+軸指数」の1位(同じなら軸指数の高い方)。2026-11-23〜(以前は残りの相手指数の1位。
//       手元の写し約1.45万レースで ▲の複勝圏 中央 31.3%→31.5%・地方 33.2%→39.2%)
//   ☆ = 残りのうち補正タイムの点が STAR_TIME_MIN 以上(データ無しの馬も含める)の馬の展開の点の1位(同じなら合計の高い方)。
//       そういう馬がいなければ、残りの展開の点の1位
//   すべて同じなら馬番の小さい方
// 以前(2026-10-25〜10-31)は「◎〇▲ = 軸指数の1・2・3位、☆ = 残りの相手指数の1位」。それより前(2026-10-14〜10-25)は
// 「軸 = 軸指数1位、相手 = 軸を除いた相手指数の上位3頭」(pickAxisPartners)。
// ☆の物差し(コース巧者・馬場巧者・一発・距離が合う)も試算したが、相手指数1位を上回らなかった(screens.md の同じ節)
export function pickRecommended(horses) {
  const num = (h) => (h.horse_number == null ? 999 : Number(h.horse_number));
  const total = (h) => h.axis + h.partner;
  const byTotal = (a, b) => total(b) - total(a) || b.axis - a.axis || num(a) - num(b);
  const byAxis = (a, b) => b.axis - a.axis || b.partner - a.partner || num(a) - num(b);
  const timeAxis = (h) => (Number(h.time) || 0) + h.axis;
  const byTimeAxis = (a, b) => timeAxis(b) - timeAxis(a) || b.axis - a.axis || num(a) - num(b);
  const byPace = (a, b) => (Number(b.pace) || 0) - (Number(a.pace) || 0) || total(b) - total(a) || num(a) - num(b);
  const used = [];
  const take = (list, cmp) => {
    const x = list.filter((h) => !used.includes(h)).sort(cmp)[0];
    if (x) used.push(x);
  };
  take(horses, byTotal);
  take(horses, byAxis);
  take(horses, byTimeAxis);
  const timeOk = horses.filter((h) => h.timeMissing || Number(h.time) >= STAR_TIME_MIN);
  if (timeOk.some((h) => !used.includes(h))) take(timeOk, byPace);
  else take(horses, byPace);
  return used.map((x, i) => ({ mark: RECOMMEND_MARKS[i], x }));
}
