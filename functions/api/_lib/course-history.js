// 総合推奨馬の「同コース」「展開」の物差し(2026-11-07 ユーザー要望・仕様確認済み。docs/design/screens.md「全要素の点を過去の結果の物差しで出す」第2段)。
// 夜間の計算(scripts/pace-nightly.mjs の 2a)が、距離の換算の比のために読む結果の表(約19.5万行)から Node で数え、
// POST /api/cron/course-history で app_settings の1行(key = course_history)に保存する。採点(_lib/race-factors.js)はその1行を読む
// (10分使い回し)。行の大きさはコースの数で決まり、結果が増えても育たない(約400コース × 十数個の数 ≒ 100KB 未満)。
//   同コース(s): 過去にそのコースを走った馬を「その時点までの同コースの合計(5着以内+1・6着以下−1。完走だけ)」の組
//     (未出走 "n"、−2以下〜+3以上に丸める)に分け、組ごとの騎乗・3着内・1着
//   展開(p): その時点で予想したペース(各馬の前走の脚質から predictPace。採点と同じ規則)と、各馬の予想の脚質の組
//     (前走の最初のコーナーから。1=逃げ・先行、2=差し・追込)ごとの騎乗・3着内・1着。"ペース|組" と全部のペース "a|組"
//   上がり(l3): そのコースの勝ち馬の上がり3Fの平均・標準偏差・レース数(スローの展開の時計の物差し)
//   段: コース("競馬場|芝ダ障|距離")・同場("競馬場|芝ダ障"。展開だけ)・全場(芝ダ障)
// 全期間で数える(過去の年の採点では、わずかに先の結果が混ざる。補正値・平均勝ちタイムと同じ扱い)
import { runningStyleOf, firstCornerPosition } from "./graded-race-search.js";
import { predictPace, courseSumGroupOf } from "./race-factors.js";
import { styleGroupOf } from "./race-lineup-cache.js";
import { memoized } from "./memo-cache.js";

export const COURSE_HISTORY_KEY = "course_history";
const BOARD_POSITION = 5;

const add = (m, k, pos) => {
  let c = m.get(k);
  if (!c) m.set(k, (c = [0, 0, 0]));
  c[0]++;
  if (pos >= 1 && pos <= 3) c[1]++;
  if (pos === 1) c[2]++;
};
const getMap = (m, k) => {
  let x = m.get(k);
  if (!x) m.set(k, (x = new Map()));
  return x;
};
const pack = (m) => [...m.entries()].map(([k, c]) => [k, ...c]);

// results: [{ horse_key, race_id, status, finish_position, corner_positions, final_furlong_time }]、
// races: Map<race_id, { race_date, race_number, track, course_type, distance }>
// 戻り値: { v: 1, courses: { "競馬場|芝ダ障|距離": { s, p, l3 } }, tracks: { "競馬場|芝ダ障": { p } }, all: { 芝ダ障: { s, p } } }
//   s・p: [[組, 騎乗, 3着内, 1着], ...]、l3: [平均, 標準偏差, レース数] | null
export function computeCourseHistory(results, races) {
  const byRace = new Map();
  for (const x of results) {
    if (!x.horse_key || x.status === "scratched" || x.status === "excluded") continue;
    const r = races.get(x.race_id);
    if (!r || !r.track || !r.course_type || !(Number(r.distance) > 0)) continue;
    if (!byRace.has(x.race_id)) byRace.set(x.race_id, []);
    byRace.get(x.race_id).push(x);
  }
  const order = [...byRace.keys()].sort((a, b) => {
    const ra = races.get(a), rb = races.get(b);
    return String(ra.race_date).localeCompare(String(rb.race_date)) || (Number(ra.race_number) || 0) - (Number(rb.race_number) || 0) || a - b;
  });
  // 馬ごとの状態(このレースより前): 前走の脚質(取消・除外を除く。predictPace 用)、最初のコーナーのある前走の脚質(中止も除く。予想の脚質の組)、
  // コースごとの合計
  const horse = new Map();
  const cs = new Map(), cp = new Map(), tp = new Map(), as = new Map(), ap = new Map(), l3 = new Map();
  for (const id of order) {
    const r = races.get(id);
    const rows = byRace.get(id);
    const ck = `${r.track}|${r.course_type}|${Number(r.distance)}`, tk = `${r.track}|${r.course_type}`, ct = r.course_type;
    const n = rows.length;
    const pace = predictPace(rows.map((x) => horse.get(x.horse_key)?.last ?? null), n);
    for (const x of rows) {
      const h = horse.get(x.horse_key);
      const pos = x.status === "finished" ? Number(x.finish_position) || 0 : 0;
      const sum = h?.sums.get(ck);
      const g = courseSumGroupOf(sum != null, sum ?? 0);
      add(getMap(cs, ck), g, pos);
      add(getMap(as, ct), g, pos);
      const sg = styleGroupOf(h?.posStyle ?? null);
      if (sg) {
        for (const [m, k] of [[cp, ck], [tp, tk], [ap, ct]]) {
          const mm = getMap(m, k);
          add(mm, `${pace}|${sg}`, pos);
          add(mm, `a|${sg}`, pos);
        }
      }
      if (pos === 1 && Number(x.final_furlong_time) > 0) {
        if (!l3.has(ck)) l3.set(ck, []);
        l3.get(ck).push(Number(x.final_furlong_time));
      }
    }
    // このレースの結果で各馬の状態を進める
    for (const x of rows) {
      let h = horse.get(x.horse_key);
      if (!h) horse.set(x.horse_key, (h = { last: null, posStyle: null, sums: new Map() }));
      const style = runningStyleOf(x.corner_positions, n);
      h.last = style;
      if (x.status !== "stopped" && firstCornerPosition(x.corner_positions)) h.posStyle = style;
      if (x.status === "finished" && Number(x.finish_position) > 0) {
        h.sums.set(ck, (h.sums.get(ck) || 0) + (Number(x.finish_position) <= BOARD_POSITION ? 1 : -1));
      }
    }
  }
  const stat = (vals) => {
    if (!vals || vals.length < 2) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    return [Math.round(mean * 1000) / 1000, Math.round(sd * 1000) / 1000, vals.length];
  };
  const courses = {};
  for (const k of new Set([...cs.keys(), ...cp.keys()])) courses[k] = { s: pack(cs.get(k) || new Map()), p: pack(cp.get(k) || new Map()), l3: stat(l3.get(k)) };
  const tracks = {};
  for (const [k, m] of tp) tracks[k] = { p: pack(m) };
  const all = {};
  for (const k of new Set([...as.keys(), ...ap.keys()])) all[k] = { s: pack(as.get(k) || new Map()), p: pack(ap.get(k) || new Map()) };
  return { v: 1, courses, tracks, all };
}

// 保存(POST /api/cron/course-history から)。app_settings の1行
export async function saveCourseHistory(db, { marker = null, history }) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(COURSE_HISTORY_KEY, JSON.stringify({ computed_at: now, marker, ...history }), now).run();
  return { computed_at: now };
}

// 読み取り(主キーで1行。10分使い回し)。採点しやすい形にする: { courses: Map(k -> { s: Map, p: Map, l3 }), tracks: Map(k -> { p: Map }), all: Map(ct -> { s, p }) }。
// 無ければ null(採点は以前の方式に戻る)
export async function getCourseHistory(db, { fresh = false } = {}) {
  const load = async () => {
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(COURSE_HISTORY_KEY).first();
    if (!row) return null;
    try { return toCourseHistory(JSON.parse(row.value)); } catch { return null; }
  };
  return fresh ? load() : memoized("course_history", load, 10 * 60 * 1000);
}

// 保存した形(computeCourseHistory の戻り値)→ 採点で使う形
export function toCourseHistory(o) {
  if (!o || o.v !== 1) return null;
  const counts = (arr) => new Map((arr || []).map(([k, rides, show, first]) => [String(k), { rides, show, first }]));
  const level = (obj) => new Map(Object.entries(obj || {}).map(([k, v]) => [k, { s: counts(v.s), p: counts(v.p), l3: v.l3 ? { mean: v.l3[0], sd: v.l3[1], n: v.l3[2] } : null }]));
  return { courses: level(o.courses), tracks: level(o.tracks), all: level(o.all) };
}
