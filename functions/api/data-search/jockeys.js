import { forEachJockeyRide } from "../_shared.js";
import { JRA_TRACKS } from "../_lib/guest.js";

// データ検索画面「騎手検索」タブの騎手一覧API(2026-10-03追加)。
// 騎手は数百人規模のため、全件を騎乗数の降順で返し、候補の絞り込み(部分一致)は
// 画面側(public/jockey-search.js)で行う(入力のたびにAPIを呼ばない)。
// races / race_results は全ユーザー共有データのため requireAdmin しない。
// 詳細は docs/design/data-search.md「騎手検索タブ」参照。
//
// 中央・地方の区分(2026-10-29 ユーザー要望。候補を「中央」「地方・大井」…に分けて出す):
//   region … "central"(中央)/ "local"(地方)。直近1年の騎乗で、中央の10場と、それ以外のどちらが多いか(同数なら中央)
//   track  … 地方の騎手の競馬場(直近1年でいちばん騎乗の多い地方の競馬場。同数なら名前順で先の方)。中央の騎手は null
//   直近1年に騎乗が無い騎手は全期間で決める。騎手の所属はデータに無いため使わない(所属の取り込みができたら所属を優先する)。
//   中央の騎手が交流重賞で地方を、地方の騎手が中央を走ることがあるため、騎乗の多い方で決める。直近1年なのは、
//   地方から中央へ移った騎手(戸崎騎手の例)が昔の騎乗で前の所属の側に出ないようにするため
const JRA = new Set(JRA_TRACKS);

function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function regionOf(byTrack) {
  let central = 0;
  let local = 0;
  let track = null;
  let trackRides = 0;
  for (const [t, n] of byTrack) {
    if (JRA.has(t)) {
      central += n;
      continue;
    }
    local += n;
    if (t && (n > trackRides || (n === trackRides && track && t.localeCompare(track, "ja") < 0))) {
      track = t;
      trackRides = n;
    }
  }
  return central >= local ? { region: "central", track: null } : { region: "local", track };
}

export async function onRequestGet(context) {
  const today = jstToday();
  const from = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`; // 1年前の同じ日から
  const byKey = new Map(); // key -> { name, rides, all: Map(競馬場 -> 騎乗数), recent: Map(同。直近1年) }
  await forEachJockeyRide(context.env.DB, ({ key, display, race }) => {
    let o = byKey.get(key);
    if (!o) {
      o = { name: display, rides: 0, all: new Map(), recent: new Map() };
      byKey.set(key, o);
    }
    o.rides++;
    const track = String(race.track || "").trim();
    o.all.set(track, (o.all.get(track) || 0) + 1);
    if (String(race.race_date || "") >= from) o.recent.set(track, (o.recent.get(track) || 0) + 1);
  });
  const jockeys = [...byKey.values()]
    .map((o) => ({ name: o.name, rides: o.rides, ...regionOf(o.recent.size ? o.recent : o.all) }))
    .sort((a, b) => b.rides - a.rides || a.name.localeCompare(b.name, "ja"));
  return Response.json({ jockeys });
}
