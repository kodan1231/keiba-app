// 予想登録画面「展開・時計」タブの点数(GET /api/data-search/race-factors)の計算と、馬券購入画面のレース一覧の目印「複」「ワ」(2026-11-01)。
// 仕様は docs/design/screens.md「総合推奨馬」「レース一覧の目印(複・ワ)」。
import { parseJsonSafe } from "./graded-race-search.js";
import { loadHorseAliasMapCached, buildHorseSearchKeys, applyHorseAliasMap, horseAliasKeyOf } from "./horse-alias.js";
import { loadJockeyAliasMapCached } from "./jockey-alias.js";
import { getRaceLineups } from "./race-lineup-cache.js";
import { getRaceTimes } from "./race-time-cache.js";
import { createFactorContext, computeRaceFactors, FACTOR_KEYS, GLOBAL_ADJUST_KEYS, isLocalRace } from "./race-factors.js";
import { getDistanceRatios } from "./distance-ratios.js";
import { getCourseHistory } from "./course-history.js";
import { getPaceScoreSettings } from "./pace-settings.js";
import { getPaceWeights, gradedPastOf, paceIndexOf, pickRecommended } from "./pace-score.js";
import { loadGradedRaceMapCached, gradedRaceOf } from "./race-classification.js";
import { memoizedKeyed, textFingerprint } from "./memo-cache.js";

// 呼び出し側が読む races の列(race-factors・race-signal・race-signals で同じ)
export const RACE_FACTOR_COLUMNS = "id, race_date, track, course_type, distance, race_name, class_flags, entries";

// 出走取消の印(entries[].scratched。2026-10-15)の馬は採点・ペース予想から外す
export function raceFactorEntries(race) {
  return (parseJsonSafe(race.entries, []) || []).filter((e) => e && e.horse_name && !e.scratched);
}

// 点数を出せるレースか(出走馬・コース・距離・日付がある)
export function canScoreRace(race) {
  return Boolean(raceFactorEntries(race).length && race.course_type && race.distance && race.race_date);
}

// race-factors の応答の本体。同じ実行環境で60秒、同じレース・同じ出走馬表の結果を使い回す(2026-10-16。D1 の負荷軽減)。週末は同じレースを
// 何人も(ゲストを含む)開き、1回あたり数百行の戦績を読んでいた。出走馬表やコースが変われば名前が変わるので、
// 出馬表の取り込み直しはすぐ反映される。他のレースの結果の取り込み・比率の変更は最大60秒遅れる。
// 2026-11-01: レース一覧の目印(race-signal)と同じ使い回しにするため、race-factors.js からここへ移した
export async function getRaceFactorsBody(db, race) {
  const entries = raceFactorEntries(race);
  if (!entries.length || !race.course_type || !race.distance || !race.race_date) return { pace_type: null, counts: null, horses: [] };
  const memoName = `race_factors:${race.id}:${race.race_date}|${race.track}|${race.course_type}|${race.distance}|${race.race_name}|${race.class_flags}:${textFingerprint(race.entries)}`;
  return memoizedKeyed(memoName, () => computeRaceFactorsBody(db, race, entries), 60 * 1000);
}

async function computeRaceFactorsBody(db, race, entries) {
  const [horseAliasMap, jockeyAliasMap, lineups, raceTimes, scoreSettings, gradedMap, distanceRatios, courseHistory] = await Promise.all([
    loadHorseAliasMapCached(db),
    loadJockeyAliasMapCached(db),
    getRaceLineups(db),
    getRaceTimes(db),
    getPaceScoreSettings(db), // データ無しの点・評価点の既定値(2026-10-14。app_settings 1行。2分使い回し)
    loadGradedRaceMapCached(db),
    getDistanceRatios(db), // 同じ馬の組から出した距離の比(2026-10-16。app_settings 1行。10分使い回し)
    getCourseHistory(db).catch(() => null), // 展開・同コースの物差し(2026-11-07。app_settings 1行。10分使い回し)
  ]);
  const graded = gradedRaceOf(gradedMap, race);
  const [weights, past] = await Promise.all([
    getPaceWeights(db, graded ? graded.id : 0, race),
    graded ? gradedPastOf(db, graded.id, race) : null,
  ]);
  const prevRaceId = past?.prevId ?? null;
  // 重賞・コースの評価点に無い項目(後から足した前年の同レース等)は設定の既定値
  // 間隔(2026-10-15)など全レース共通の項目は、いつも設定の既定値
  const adjust = { ...scoreSettings.adjust, ...(weights.adjust || {}) };
  for (const k of GLOBAL_ADJUST_KEYS) adjust[k] = scoreSettings.adjust[k];
  const { searchKeyToKey } = buildHorseSearchKeys(horseAliasMap, entries.map((e) => e.horse_name));
  const searchKeys = [...searchKeyToKey.keys()];
  const runsByHorse = new Map();
  // IN句のキー数: 出走馬の馬名+逆引きエイリアス。重賞の特別登録を手で入れると頭数に上限が無く(2026-10-15)、
  // 100バインドを超えうるため90件ずつ(+日付1)に分ける
  for (let i = 0; i < searchKeys.length; i += 90) {
    const keys = searchKeys.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT rr.horse_key, rr.race_id, rr.status, rr.finish_position, rr.corner_positions, rr.time_text, rr.final_furlong_time,
                rr.body_weight, rr.jockey, rr.weight_carried, r.race_date, r.race_number, r.track, r.course_type, r.distance, r.track_condition
           FROM race_results rr JOIN races r ON r.id = rr.race_id
          WHERE rr.horse_key IN (${keys.map(() => "?").join(",")}) AND r.race_date < ?`
      )
      .bind(...keys, race.race_date)
      .all();
    for (const row of results || []) {
      const key = searchKeyToKey.get(row.horse_key);
      if (!key) continue;
      if (!runsByHorse.has(key)) runsByHorse.set(key, []);
      runsByHorse.get(key).push(row);
    }
  }

  const keyOfEntry = (e) => horseAliasKeyOf(applyHorseAliasMap(horseAliasMap, e.horse_name));
  const runners = entries.map((e) => ({ key: keyOfEntry(e), horse_number: e.horse_number ?? null, jockey: e.jockey || null, sex_age: e.sex_age || null, weight_carried: e.weight_carried ?? null }));
  const ctx = createFactorContext(lineups, raceTimes, jockeyAliasMap);
  const rf = computeRaceFactors(ctx, race, runners, runsByHorse, { missingScore: scoreSettings.missing_score, adjust, prevRaceId, gradedPastIds: past?.pastIds || null, weightSecPerKg: scoreSettings.weight_sec_per_kg, distanceRatios, courseHistory });

  const horses = entries.map((e, i) => {
    const key = runners[i].key;
    const factors = {};
    for (const f of FACTOR_KEYS) {
      const v = rf.factors[f].get(key);
      factors[f] = { score: Math.round(v.score * 10) / 10, rank: v.rank, value: v.value, missing: v.missing };
    }
    // total_adjust: 総合点(軸指数・相手指数)へ直接足す点と内訳(間隔。2026-10-15。無ければ value 0)
    const ta = rf.totalAdjust.get(key) || { value: 0, note: "" };
    return { horse_name: e.horse_name, horse_number: e.horse_number ?? null, waku_number: e.waku_number ?? null, jockey: e.jockey || null, factors, total_adjust: ta };
  });
  return { pace_type: rf.pace_type, counts: rf.counts, horses, data_shortage: dataShortageOf(race, rf, runners) };
}

// データ不足の注記(2026-11-04 ユーザー要望・仕様確認済み。docs/design/screens.md「データ不足の注記」)。地方のレースだけ。
// 初競馬場かつ初距離(その競馬場の同じ芝ダも、その距離も走ったことがない。評価点の印 fd・ft)の馬と、補正タイムのデータが無い馬が
// 出走馬の DATA_SHORTAGE_SHARE 以上なら flagged。補正タイムが当てになりにくい(南関東の試算: 補正タイム1位の3着内 58.7% → 51.1%)。
// 中央は換算が多くても当たりが落ちないため出さない(null)。印・複・ワは変えず、予想登録画面に注記を出すだけ
export const DATA_SHORTAGE_SHARE = 0.2;
function dataShortageOf(race, rf, runners) {
  if (!isLocalRace(race) || !runners.length) return null;
  let count = 0;
  for (const r of runners) {
    const f = rf.flags.get(r.key);
    if (rf.factors.time.get(r.key)?.missing || (f?.fd && f?.ft)) count++;
  }
  return { count, total: runners.length, flagged: count / runners.length >= DATA_SHORTAGE_SHARE };
}

// ---- レース一覧の目印(2026-11-01 ユーザー要望。試算は docs/design/screens.md「レース一覧の目印(複・ワ)」) ----
// 合計 = 軸指数+相手指数(予想登録画面の総合推奨馬の表と同じ計算)。◎〇は推奨馬の印(pickRecommended)
//   (以前〈〜2026-11-07〉: 複 = ◎の合計125以上で合計2位と10点以上の差、ワ = ◎〇の合計がどちらも120以上でほかの馬は全部10点以上下)
//   両方を満たせば両方。出走が SIGNAL_MIN_RUNNERS 頭未満のレースは出さない(試算の対象外)
// 2026-11-07〜(ユーザー要望・仕様確認済み): 合計の数値の条件(◎125以上・◎〇120以上)をやめ、差だけにした
//   複: 合計1位 − 合計2位 ≥ SIGNAL_FUKU_GAP、ワ: 合計2位 − 合計3位 ≥ SIGNAL_WIDE_GAP(以前は ◎〇 で見ていた。合計の1位・2位にした)
export const SIGNAL_FUKU_GAP = 8;
export const SIGNAL_WIDE_GAP = 6;
export const SIGNAL_MIN_RUNNERS = 5;
// 規則を変えたら上げる(保存済みの目印の指紋が変わり、全部計算し直しになる)。
// 3(2026-11-10): 推奨馬の印(列 marks)も保存するようにしたので、保存済みの行に印を入れるため計算し直す
const SIGNAL_RULE_VERSION = 3;

// 総合推奨馬の表と同じ軸指数・相手指数(body: getRaceFactorsBody の戻り値、weights: getPaceWeights の戻り値)
function indexedHorses(body, weights) {
  const pick = (d) => (body.pace_type && d.paces?.[body.pace_type]) || d;
  const wa = pick(weights), wp = pick(weights.partner || weights);
  const extra = (h) => Number(h.total_adjust?.value) || 0;
  return body.horses.map((h) => ({
    horse_number: h.horse_number,
    horse_name: h.horse_name,
    axis: paceIndexOf(h.factors, wa) + extra(h),
    partner: paceIndexOf(h.factors, wp) + extra(h),
    pace: h.factors.pace?.score, time: h.factors.time?.score, timeMissing: Boolean(h.factors.time?.missing),
  }));
}

// 推奨馬の印(◎〇▲☆。予想登録画面と同じ pickRecommended)→ [[印, 馬番(未確定は null), 馬名], ...](2026-11-10。推奨馬比較タブの記録用)。
// 点数を出せないレースは []
export function racePicksOf(body, weights) {
  if (!body.pace_type || !body.horses.length) return [];
  return pickRecommended(indexedHorses(body, weights)).map((p) => [p.mark, p.x.horse_number ?? null, p.x.horse_name || ""]);
}

// body: getRaceFactorsBody の戻り値、weights: getPaceWeights の戻り値 → "" | "複" | "ワ" | "複ワ"
export function raceSignalsOf(body, weights) {
  if (!body.pace_type || body.horses.length < SIGNAL_MIN_RUNNERS) return "";
  const horses = indexedHorses(body, weights);
  const total = (x) => x.axis + x.partner;
  // 合計の高い順(1位は ◎ と同じ。pickRecommended の byTotal と同じ並び)
  const num = (h) => (h.horse_number == null ? 999 : Number(h.horse_number));
  const sorted = [...horses].sort((a, b) => total(b) - total(a) || b.axis - a.axis || num(a) - num(b));
  if (sorted.length < 3) return "";
  const [t1, t2, t3] = sorted.slice(0, 3).map(total);
  let out = "";
  if (t1 - t2 >= SIGNAL_FUKU_GAP) out += "複";
  if (t2 - t3 >= SIGNAL_WIDE_GAP) out += "ワ";
  return out;
}

export const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 保存した目印が今のレースに合うかを見る指紋(出走馬表・コース・レース名・条件)
export function raceSignalFingerprint(race) {
  return textFingerprint(`r${SIGNAL_RULE_VERSION}|${race.race_date}|${race.track}|${race.course_type}|${race.distance}|${race.race_name}|${race.class_flags}|${race.entries}`);
}

// 保存した目印を計算し直すか。出走馬表等が変わった、または今日以降のレースで今日より前に計算した(比率・ほかのレースの結果が
// 夜のうちに変わるため、1日1回は計算し直す)。過去のレースは出走馬表が変わったときだけ
export function raceSignalStale(race, saved, today = todayJst()) {
  if (!saved || saved.fp !== raceSignalFingerprint(race)) return true;
  return race.race_date >= today && saved.computed_on < today;
}

// body(getRaceFactorsBody の戻り値)から目印と推奨馬の印を出す。比率は主キーで最大3行。
// 戻り値: { signals: "" | "複" | …, marks: JSON 文字列(racePicksOf。点数を出せなければ "") }
async function signalsOfBody(db, race, body) {
  if (!body.pace_type) return { signals: "", marks: "" };
  const gradedMap = await loadGradedRaceMapCached(db);
  const graded = gradedRaceOf(gradedMap, race);
  const weights = await getPaceWeights(db, graded ? graded.id : 0, race);
  const picks = racePicksOf(body, weights);
  return { signals: raceSignalsOf(body, weights), marks: picks.length ? JSON.stringify(picks) : "" };
}

// 推奨馬の印(列 marks。2026-11-10 @STEP: race_pick_records)も保存する。列がまだ無ければ(マイグレーション前)以前の形で保存する
async function saveRaceSignal(db, race, { signals, marks }) {
  const args = [Number(race.id), race.race_date, raceSignalFingerprint(race), signals, todayJst()];
  try {
    await db
      .prepare(
        `INSERT INTO race_signals (race_id, race_date, fp, signals, computed_on, marks) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(race_id) DO UPDATE SET race_date = excluded.race_date, fp = excluded.fp, signals = excluded.signals, computed_on = excluded.computed_on,
           marks = excluded.marks`
      )
      .bind(...args, marks || null)
      .run();
  } catch (e) {
    if (!/no column|no such column|has no column/i.test(String(e?.message || e))) throw e;
    await db
      .prepare(
        `INSERT INTO race_signals (race_id, race_date, fp, signals, computed_on) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(race_id) DO UPDATE SET race_date = excluded.race_date, fp = excluded.fp, signals = excluded.signals, computed_on = excluded.computed_on`
      )
      .bind(...args)
      .run();
  }
}

// 1レースの目印を計算して保存する。保存は best-effort(失敗しても目印は返す)
export async function computeAndSaveRaceSignal(db, race) {
  const out = await signalsOfBody(db, race, await getRaceFactorsBody(db, race));
  try {
    await saveRaceSignal(db, race, out);
  } catch (e) {
    console.error("race_signals save failed (ignored)", e);
  }
  return out.signals;
}

// 比率・点数の設定を保存したとき、影響する今日以降のレースの保存済みの目印に「計算し直しが要る」印を付ける(2026-11-04)。
// 目印はここでは計算しない。計算日(computed_on)を空にするだけで、一覧を次に開いたときに raceSignalStale が拾い、2件ずつ計算し直される。
// scope: { all: true }(標準の比率・点数の設定)| { gradedId }(重賞の比率)| { course: { track, course_type, distance } }(コースの比率。
//   重賞のレースもコースのペースの比率を混ぜて使うので、そのコースのレースは全部)。
// 読み取り: 今日以降の races(race_date の索引。2〜3日分で約200行)+ 印を付ける race_signals(主キー。最大その件数)。
//   夜間の計算は比率を1件ずつ保存するので、1晩に数百回呼ばれても読み取りは数万行。
// 書き込み: まだ印の無い目印だけ(1日に今日以降のレースの数〈約200行〉まで)。失敗は無視
export async function markRaceSignalsStale(db, scope) {
  try {
    const { results } = await db
      .prepare("SELECT id, race_date, track, course_type, distance, race_name, class_flags FROM races WHERE race_date >= ?")
      .bind(todayJst())
      .all();
    let races = results || [];
    if (scope?.course) {
      const c = scope.course;
      // コースのキーは races の値から作る(_lib/pace-queue.js の courseKeyOf。前後の空白を除く)ので、同じ形にして比べる
      races = races.filter((r) => String(r.track || "").trim() === c.track && String(r.course_type || "").trim() === c.course_type && Number(r.distance) === Number(c.distance));
    } else if (scope?.gradedId) {
      const gradedMap = await loadGradedRaceMapCached(db);
      races = races.filter((r) => gradedRaceOf(gradedMap, r)?.id === Number(scope.gradedId));
    } else if (!scope?.all) {
      return;
    }
    const ids = races.map((r) => Number(r.id));
    // IN に渡す数: 今日以降のレース(2〜3日分で約200。取り込み次第でさらに増えうる)ので90件ずつ
    const stmts = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      stmts.push(db.prepare(`UPDATE race_signals SET computed_on = '' WHERE computed_on <> '' AND race_id IN (${part.map(() => "?").join(",")})`).bind(...part));
    }
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    console.error("race_signals mark stale failed (ignored)", e);
  }
}

// 展開・時計タブ(race-factors)を開いたとき、そのレースの目印を今の点数で確かめ、保存した目印・指紋と違えば保存し直す(2026-11-04)。
// 騎手エイリアスの一括補正・比率の変更等で表の合計が変わっても、一覧の目印が当日中は古いまま残っていたため。
// 読み取り: 保存済みの目印1行(主キー)+ 比率(主キーで最大3行)。書き込みは違ったときだけ1行。失敗は無視(表が無い等)
export async function syncRaceSignal(db, race, body) {
  try {
    // 推奨馬の印(marks。2026-11-10)も比べる。列がまだ無ければ(マイグレーション前)saved.marks は undefined で、目印だけ比べる
    const [out, saved] = await Promise.all([
      signalsOfBody(db, race, body),
      db.prepare("SELECT * FROM race_signals WHERE race_id = ?").bind(Number(race.id)).first(),
    ]);
    const sameMarks = !saved || !("marks" in saved) || (saved.marks || "") === out.marks;
    if (saved && saved.signals === out.signals && sameMarks && saved.fp === raceSignalFingerprint(race)) return;
    await saveRaceSignal(db, race, out);
  } catch (e) {
    console.error("race_signals sync failed (ignored)", e);
  }
}
