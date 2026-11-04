// 同じ競馬場の中での距離の換算の比(同じ馬の組から出す。2026-10-16追加。ユーザー要望・仕様確認済み)。
// 仕様は docs/design/screens.md「同じ競馬場の ±200m の走も使う」。
//
// 何を出すか: 同じ競馬場・同じ芝ダで、距離 A と距離 B(差が200m以内)の両方を走ったことがある馬について、
//   「その馬の B の平均タイム ÷ A の平均タイム」を集め、競馬場・芝ダ・A→B ごとに組数と平均を出す。
//   加速区間・坂・コーナーの数など、その競馬場のその2つの距離の違いがそのまま比に入る(距離の比や勝ちタイムの平均の比より実態に合う。
//   川崎ダ1400→1500 は 129組で ×1.0636。勝ちタイムの平均の比は ×1.0517、距離の比は ×1.0714 だった)。
//   1頭の極端な比(体調・展開等)を除くため、距離の比から ±10% を外れる組は数えない。
// 使い方: 組が DISTANCE_RATIO_MIN_PAIRS 以上ならこの比、足りなければ従来の比(その競馬場の勝ちタイムの平均の比。2026-10-16〜10-18 は
//   距離の比との平均だった。_lib/track-trends.js の sameTrackDistanceRatio)。補正タイム順位(horse-best)と総合推奨馬の補正タイム(_lib/race-factors.js)。
//
// 保存: app_settings の key='distance_ratios' に JSON 1行 { computed_at, marker, pairs: [[競馬場, 芝ダ, A(短), B(長), 組数, 比], ...] }。
//   長→短は読み込みのときに逆数にする。組み合わせは「競馬場 × 芝ダ × 200m以内の距離の組」で、データが増えても競馬場と距離の数で頭打ち
//   (2026-10-16 の本番で79件)なので1行で足りる。
// 計算(2026-10-16): 結果の表を馬名(horse_key)の順に CHUNK_ROWS 走ずつ読み、その馬たちの組の比を JS で足し上げる。途中の状態は
//   表 pace_jobs の1行(kind='distance')に置き、夜間の定時実行(_lib/pace-job.js)が比率の計算待ちの無いときに1歩ずつ進める。
//   前回から結果が増えていれば(race_results の最大 id)始める。管理画面の「今すぐ計算」は同じ1歩を画面から繰り返し呼ぶ。
//   当初は D1 の問い合わせ1本で集計まで行ったが、並べ替え・まとめの一時表の読み取りも数えられ、本番で1回57万〜104万行になったためやめた。
// D1: 1回の計算全体で、結果の行+レースを主キーで引く分(約15万行。2026-10-18〜11-04 は週1回。11-04〜 夜間は Node が毎晩)。1歩は約2,000走+その分のレースで約4,000行。
//   2026-10-18 の初回(夜間)は38歩・149,696行で、3:00 の起動から 3:10 の起動の途中で終わった(着順の確定した行は約7.6万。
//   結果の最大 id 136,341 から約70歩と見込んでいたが、id には欠番・取消などの行も入っている)。
//   読み込みは app_settings の1行(同じ実行環境で10分使い回す)。
//
// 換算の組み合わせごとの直し(2026-11-04。ユーザー要望・仕様確認済み。docs/design/screens.md「換算の組み合わせごとの直し」):
//   補正タイムの換算(_lib/race-factors.js の convertTime)は、換算元のコース(競馬場・芝ダ・距離)と今回のコースの組み合わせごとに偏る
//   (船橋ダ1800 へは浦和ダ2000・船橋ダ1500 等から約2秒速すぎ、浦和ダ2000 へは船橋ダ1800 等から約3秒遅すぎ)。
//   同じ馬が両方のコースを走った組(換算元の走は今回の走の1年以内・同じ芝ダ)で「換算したタイム − 今回の実際のタイム(馬場の補正のみ)」を集め、
//   組み合わせごとの中央値を偏りとして保存し、換算のときに差し引く(BIAS_MIN_PAIRS 組以上の組み合わせだけ)。
//   計算は夜間の GitHub Actions の Node(scripts/pace-nightly.mjs。computeConversionTables)で、距離の比と同じ読み取りの中で行い、
//   POST /api/cron/conversion で保存する(saveConversionTables)。Cloudflare 側の1歩ずつの計算(distanceRatiosStep)は CPU 時間の上限
//   (10ミリ秒)に収まらないため偏りは出さず、管理画面の「今すぐ計算」の距離の比だけに使う。
//   保存: app_settings の key='course_pair_bias:<今回の競馬場>' に競馬場ごとの JSON 1行 { computed_at, pairs: [[元の競馬場, 芝ダ, 元の距離, 今回の距離, 組数, 偏り秒], ...] }
//   (組み合わせは競馬場×距離の組で頭打ち。1競馬場あたり数百件・数十KB)。読み込みは getDistanceRatios の Map の pairBias に付ける。
import { memoized, invalidateMemo } from "./memo-cache.js";

export const DISTANCE_RATIO_MIN_PAIRS = 20;
export const BIAS_MIN_PAIRS = 20;
const BIAS_WINDOW_DAYS = 365;
const BIAS_KEY_PREFIX = "course_pair_bias:";
const SETTINGS_KEY = "distance_ratios";
const MEMO_KEY = "distance_ratios";
const MEMO_TTL_MS = 10 * 60 * 1000;
const NEAR = 200;
const CHUNK_ROWS = 2000;
// 夜間に計算し直す間隔(2026-11-04 に週1回 → 毎晩。夜間は 22:17・0:47・3:17 の3回起動するので、1晩に1回だけになるよう20時間)
const RECOMPUTE_HOURS = 20;
const JOB_KIND = "distance";
const JOB_KEY = "ratios";

// 換算の組み合わせのキー(換算元 → 今回)。芝ダは同じものどうしだけ
export function pairBiasKey(srcTrack, courseType, srcDist, dstTrack, dstDist) {
  return `${srcTrack}|${courseType}|${Number(srcDist)}>${dstTrack}|${Number(dstDist)}`;
}

// 保存した距離の比の配列 → Map("競馬場|芝ダ|A|B" -> { ratio, pairs })(短→長と、その逆数の長→短)
export function distanceRatioMapOf(pairs) {
  const map = new Map();
  for (const p of pairs || []) {
    const [track, ct, a, b, n, ratio] = p;
    if (!(track && ct && Number(a) > 0 && Number(b) > 0 && Number(ratio) > 0)) continue;
    map.set(`${track}|${ct}|${Number(a)}|${Number(b)}`, { ratio: Number(ratio), pairs: Number(n) });
    map.set(`${track}|${ct}|${Number(b)}|${Number(a)}`, { ratio: 1 / Number(ratio), pairs: Number(n) });
  }
  return map;
}

// 読み込み: Map("競馬場|芝ダ|A|B" -> { ratio, pairs })。表が無い・読めないときは空の Map。
// map.pairBias: Map(pairBiasKey -> 偏り秒)(2026-11-04。換算の組み合わせごとの直し。無ければ空)
export function getDistanceRatios(db) {
  return memoized(MEMO_KEY, async () => {
    let map = new Map();
    try {
      const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SETTINGS_KEY).first();
      const v = row ? JSON.parse(row.value) : null;
      // 保存は短→長だけ。長→短はその逆数
      map = distanceRatioMapOf(v?.pairs);
      map.computedAt = v?.computed_at || null;
    } catch (e) {
      console.error("distance ratios read failed (ignored)", e);
    }
    map.pairBias = new Map();
    try {
      // 主キーの範囲で引く(競馬場の数 約30行。LIKE は索引が効かないことがあるため範囲にする)
      const { results } = await db.prepare("SELECT value FROM app_settings WHERE key >= ? AND key < ?")
        .bind(BIAS_KEY_PREFIX, `${BIAS_KEY_PREFIX}￿`).all();
      for (const r of results || []) {
        let v = null;
        try { v = JSON.parse(r.value); } catch { continue; }
        for (const [st, ct, sd, dd, n, bias] of v?.pairs || []) {
          if (v.track && Number(n) >= BIAS_MIN_PAIRS && Number.isFinite(Number(bias))) map.pairBias.set(pairBiasKey(st, ct, sd, v.track, dd), Number(bias));
        }
      }
    } catch (e) {
      console.error("course pair bias read failed (ignored)", e);
    }
    return map;
  }, MEMO_TTL_MS);
}

// 換算の組み合わせの偏り(秒)。無ければ 0。run・race: { track, course_type, distance }
export function pairBiasOf(map, run, race) {
  const pb = map?.pairBias;
  if (!pb || !pb.size || run.course_type !== race.course_type) return 0;
  if (run.track === race.track && Number(run.distance) === Number(race.distance)) return 0;
  return pb.get(pairBiasKey(run.track, run.course_type, run.distance, race.track, race.distance)) ?? 0;
}

// ---- 夜間の Node で、距離の比と換算の組み合わせの偏りをまとめて出す(2026-11-04) ----
// runsByHorse: Map(馬 -> [{ t, ct, d, sec, date, rn, cond }])(完走した芝・ダートの走。並びは問わない)
// convert(sec, run, dst, ratiosMap): 走のタイムを dst のコースへ換算する関数(_lib/race-factors.js の convertTime を包んだもの。偏りは掛けない)
// 戻り値: { pairs(距離の比。保存の形), bias: Map(今回の競馬場 -> [[元の競馬場, 芝ダ, 元の距離, 今回の距離, 組数, 偏り秒], ...]) }
export function computeConversionTables(runsByHorse, convert) {
  const sums = {};
  for (const runs of runsByHorse.values()) if (runs.length > 1) addHorsePairs(runs, sums);
  const pairs = Object.entries(sums).map(([k, [n, sum]]) => {
    const [t, ct, a, b] = k.split("|");
    return [t, ct, Number(a), Number(b), n, Math.round((sum / n) * 100000) / 100000];
  });
  const ratios = distanceRatioMapOf(pairs);
  const errs = new Map(); // pairBiasKey -> [換算 − 実際]
  const dayMs = 86400000;
  for (const runs of runsByHorse.values()) {
    if (runs.length < 2) continue;
    const sorted = [...runs].sort((a, b) => a.date.localeCompare(b.date) || a.rn - b.rn);
    for (let i = 1; i < sorted.length; i++) {
      const t = sorted[i];
      const dst = { track: t.t, course_type: t.ct, distance: t.d };
      let actual = null;
      for (let j = i - 1; j >= 0; j--) {
        const s = sorted[j];
        if (Date.parse(t.date) - Date.parse(s.date) > BIAS_WINDOW_DAYS * dayMs) break;
        if (s.date >= t.date || s.ct !== t.ct || (s.t === t.t && s.d === t.d)) continue;
        if (actual === null) actual = convert(t.sec, { track: t.t, course_type: t.ct, distance: t.d, track_condition: t.cond }, dst, ratios);
        const e = convert(s.sec, { track: s.t, course_type: s.ct, distance: s.d, track_condition: s.cond }, dst, ratios) - actual;
        if (!Number.isFinite(e)) continue;
        const k = pairBiasKey(s.t, s.ct, s.d, t.t, t.d);
        (errs.get(k) || errs.set(k, []).get(k)).push(e);
      }
    }
  }
  const bias = new Map();
  for (const [k, xs] of errs) {
    if (xs.length < BIAS_MIN_PAIRS) continue;
    xs.sort((a, b) => a - b);
    const med = xs[Math.floor(xs.length / 2)];
    const [src, dstPart] = k.split(">");
    const [st, ct, sd] = src.split("|");
    const [dt, dd] = dstPart.split("|");
    if (!bias.has(dt)) bias.set(dt, []);
    bias.get(dt).push([st, ct, Number(sd), Number(dd), xs.length, Math.round(med * 100) / 100]);
  }
  return { pairs, bias };
}

// 保存(POST /api/cron/conversion から)。距離の比の1行と、今回の競馬場ごとの偏りの行。もう無い競馬場の偏りの行は消す。
// bias: { 競馬場: [[元の競馬場, 芝ダ, 元の距離, 今回の距離, 組数, 偏り秒], ...] }
export async function saveConversionTables(db, { marker = null, pairs, bias }) {
  const now = new Date().toISOString();
  const upsert = (key, value) => db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, JSON.stringify(value), now);
  const stmts = [
    upsert(SETTINGS_KEY, { computed_at: now, marker, pairs, source: "nightly" }),
    db.prepare("DELETE FROM app_settings WHERE key >= ? AND key < ?").bind(BIAS_KEY_PREFIX, `${BIAS_KEY_PREFIX}￿`),
  ];
  // 競馬場の数(約30)+2文。1回の batch で足りる
  for (const [track, list] of Object.entries(bias || {})) stmts.push(upsert(`${BIAS_KEY_PREFIX}${track}`, { computed_at: now, track, pairs: list }));
  await db.batch(stmts);
  invalidateMemo(MEMO_KEY);
  return { computed_at: now, ratios: pairs.length, bias_tracks: Object.keys(bias || {}).length, bias_pairs: Object.values(bias || {}).reduce((s, l) => s + l.length, 0) };
}

// 同じ馬の組の比(組が DISTANCE_RATIO_MIN_PAIRS 以上のときだけ)。無ければ null
export function pairDistanceRatioOf(map, track, courseType, fromDist, toDist) {
  if (!map || !track || !courseType) return null;
  const x = map.get(`${track}|${courseType}|${Number(fromDist)}|${Number(toDist)}`);
  return x && x.pairs >= DISTANCE_RATIO_MIN_PAIRS ? x.ratio : null;
}

// 計算の状態: { computed_at, marker, count, usable, current_marker, stale, running, progress }
export async function distanceRatiosState(db) {
  const [row, max, job] = await Promise.all([
    db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SETTINGS_KEY).first().catch(() => null),
    db.prepare("SELECT MAX(id) AS m FROM race_results").first().catch(() => null), // 主キーで1行
    db.prepare("SELECT offset, total FROM pace_jobs WHERE kind = ? AND key = ?").bind(JOB_KIND, JOB_KEY).first().catch(() => null),
  ]);
  let v = null;
  try { v = row ? JSON.parse(row.value) : null; } catch { v = null; }
  const current = Number(max?.m || 0);
  const newer = !v || Number(v.marker) !== current;
  // 夜間に計算し直すのは、新しい結果があり、前回から RECOMPUTE_HOURS 時間たったときだけ。管理画面の「今すぐ計算」(force)はいつでも動く。
  // 2026-10-18〜11-04 は週1回(計算1回で約15万行読むため)。2026-11-04 から毎晩(ユーザー要望。換算の組み合わせの偏りと一緒に、
  // 夜間の Node が1回の読み取り〈約21万行〉で出す。scripts/pace-nightly.mjs)
  const age = v?.computed_at ? Date.now() - Date.parse(v.computed_at) : Infinity;
  const waitMs = RECOMPUTE_HOURS * 3600000;
  return {
    computed_at: v?.computed_at || null,
    marker: v?.marker ?? null,
    count: (v?.pairs || []).length,
    usable: (v?.pairs || []).filter((p) => Number(p[4]) >= DISTANCE_RATIO_MIN_PAIRS).length,
    current_marker: current,
    newer,
    stale: newer && !(age < waitMs),
    next_after: v?.computed_at && newer && age < waitMs
      ? new Date(Date.parse(v.computed_at) + waitMs).toISOString() : null,
    running: Boolean(job),
    progress: job ? Number(job.offset || 0) : null, // 読んだ走の数
  };
}

// タイム("1:33.9" / "58.3")→ 秒。読めなければ null
function secOf(text) {
  const s = String(text || "").trim();
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// 1頭分の走(同じ馬)から組の比を sums へ足す。runs: [{ t, ct, d, sec }]
function addHorsePairs(runs, sums) {
  const byCourse = new Map(); // "競馬場|芝ダ" -> Map(距離 -> [合計, 数])
  for (const r of runs) {
    const k = `${r.t}|${r.ct}`;
    if (!byCourse.has(k)) byCourse.set(k, new Map());
    const m = byCourse.get(k);
    const x = m.get(r.d) || [0, 0];
    x[0] += r.sec; x[1]++;
    m.set(r.d, x);
  }
  for (const [k, m] of byCourse) {
    if (m.size < 2) continue;
    const ds = [...m.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length && ds[j] - ds[i] <= NEAR; j++) {
        const a = ds[i], b = ds[j];
        const r = (m.get(b)[0] / m.get(b)[1]) / (m.get(a)[0] / m.get(a)[1]);
        const dr = b / a;
        if (!(r >= dr * 0.9 && r <= dr * 1.1)) continue;
        const key = `${k}|${a}|${b}`;
        const s = sums[key] || (sums[key] = [0, 0]);
        s[0]++; s[1] += r;
      }
    }
  }
}

// 1歩進める。force: 前回から結果が増えていなくても始める(管理画面の「今すぐ計算」)。
// 戻り値: { idle: true }(やることが無い)/ { did: "start" | "scan", read } / { did: "done", count, usable }
export async function distanceRatiosStep(db, { force = false } = {}) {
  const job = await db.prepare("SELECT offset, races, state FROM pace_jobs WHERE kind = ? AND key = ?").bind(JOB_KIND, JOB_KEY).first();
  const now = new Date().toISOString();
  if (!job) {
    const st = await distanceRatiosState(db);
    if (!force && !st.stale) return { idle: true };
    const state = { cursor: "", sums: {}, marker: st.current_marker };
    await db.prepare(
      `INSERT OR REPLACE INTO pace_jobs (kind, key, phase, offset, total, races, state, missing_score, updated_at) VALUES (?, ?, 'scan', 0, NULL, '[]', ?, NULL, ?)`
    ).bind(JOB_KIND, JOB_KEY, JSON.stringify(state), now).run();
    return { did: "start" };
  }
  let state;
  try { state = JSON.parse(job.state || "{}"); } catch { state = {}; }
  const sums = state.sums || {};
  // 馬名の順に次の CHUNK_ROWS 走(horse_key のインデックスを順に読む。並べ替え・一時表なし)。
  // 最後の馬は途中で切れているかもしれないので、次の歩でその馬から読み直す(1頭の走は CHUNK_ROWS より十分少ない)
  const { results } = await db.prepare(
    `SELECT rr.horse_key AS h, rr.time_text AS tt, r.track AS t, r.course_type AS ct, r.distance AS d
       FROM race_results rr JOIN races r ON r.id = rr.race_id
      WHERE rr.horse_key >= ? AND rr.status = 'finished'
      ORDER BY rr.horse_key
      LIMIT ${CHUNK_ROWS}`
  ).bind(state.cursor || "").all();
  const rows = results || [];
  const full = rows.length >= CHUNK_ROWS;
  const lastKey = full ? rows[rows.length - 1].h : null;
  let horse = null, runs = [];
  const flush = () => { if (runs.length > 1) addHorsePairs(runs, sums); runs = []; };
  for (const x of rows) {
    if (full && x.h === lastKey) break; // 途中で切れているかもしれない最後の馬は次の歩で
    if (x.h !== horse) { flush(); horse = x.h; }
    const sec = secOf(x.tt);
    if (sec && x.t && (x.ct === "芝" || x.ct === "ダート") && Number(x.d) > 0) runs.push({ t: x.t, ct: x.ct, d: Number(x.d), sec });
  }
  flush();
  const read = Number(job.offset || 0) + rows.length;
  if (full && lastKey !== (state.cursor || "")) {
    await db.prepare("UPDATE pace_jobs SET offset = ?, state = ?, updated_at = ? WHERE kind = ? AND key = ?")
      .bind(read, JSON.stringify({ ...state, cursor: lastKey, sums }), now, JOB_KIND, JOB_KEY).run();
    return { did: "scan", read };
  }
  // 読み終わり: 保存して作業を消す
  const pairs = Object.entries(sums).map(([k, [n, sum]]) => {
    const [t, ct, a, b] = k.split("|");
    return [t, ct, Number(a), Number(b), n, Math.round((sum / n) * 100000) / 100000];
  });
  await db.batch([
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(SETTINGS_KEY, JSON.stringify({ computed_at: now, marker: state.marker ?? null, pairs }), now),
    db.prepare("DELETE FROM pace_jobs WHERE kind = ? AND key = ?").bind(JOB_KIND, JOB_KEY),
  ]);
  invalidateMemo(MEMO_KEY);
  return { did: "done", read, count: pairs.length, usable: pairs.filter((p) => p[4] >= DISTANCE_RATIO_MIN_PAIRS).length };
}
