// 総合推奨馬の比率の「計算待ち」(2026-10-14追加。仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」「比率の選び方の見直し」)。
// そのレースのコース(競馬場・芝ダ障・距離)と、当たる重賞を表 pace_recompute_queue に積む。毎晩3時(日本時間)の
// GitHub Actions(scripts/pace-nightly.mjs)が積まれた分を総当たりで計算して保存し、取り除く(手で保存した比率は計算せず取り除く)。
// 積むきっかけ(2026-10-18 変更。ユーザー確認済み):
//   - 結果(着順・払戻)を取り込んだ・保存したとき(enqueuePaceRecomputeForResults): 比率の元になる結果が増えたので必ず積む。
//     同じ条件は1晩に1回だけ計算される(計算待ちは重ねて積まない)。以前の「前の計算から7日未満なら計算しない」はやめた
//   - 馬番が確定した出馬表を取り込んだ・保存したとき(enqueuePaceRecompute): まだ比率を自動で計算していない条件か、
//     古い方式(public/pace-search.js の METHOD_VERSION が違う)で計算した条件だけ積む(結果は増えていないため)
// 書き込みは「計算待ちに無ければ1行」(INSERT OR IGNORE)。積むのに失敗しても取り込み自体は止めない(best-effort)。
import { runBatchInChunks } from "./http.js";
import { loadGradedRaceMapCached, gradedRaceOf } from "./race-classification.js";
import { METHOD_VERSION } from "../../../public/pace-search.js";

// コースのキー "競馬場|芝ダ障|距離"(どれか欠けていれば null)
export function courseKeyOf(race) {
  const track = String(race?.track || "").trim();
  const ct = String(race?.course_type || "").trim();
  const dist = Number(race?.distance);
  return track && ct && dist > 0 ? `${track}|${ct}|${dist}` : null;
}

export function parseCourseKey(key) {
  const [track, course_type, d] = String(key || "").split("|");
  const distance = Number(d);
  return track && course_type && distance > 0 ? { track, course_type, distance } : null;
}

// レースからコース・重賞の行を作る。戻り値: Map("kind|key" -> [kind, key, race_id])
async function queueRowsOf(db, races) {
  const gradedMap = await loadGradedRaceMapCached(db);
  const rows = new Map();
  for (const r of races) {
    const ck = courseKeyOf(r);
    if (ck) rows.set(`course|${ck}`, ["course", ck, r.id ?? null]);
    const g = gradedRaceOf(gradedMap, r);
    if (g) rows.set(`graded|${g.id}`, ["graded", String(g.id), r.id ?? null]);
  }
  return rows;
}

async function insertRows(db, rows) {
  const now = new Date().toISOString();
  // 1回の取り込みで積む行は「取り込んだレースのコース数+重賞数」(1開催日で数十)。数百になりうるので分割して送る
  const stmts = [...rows.values()].map(([kind, key, raceId]) =>
    db.prepare("INSERT OR IGNORE INTO pace_recompute_queue (kind, key, race_id, created_at) VALUES (?, ?, ?, ?)").bind(kind, key, raceId, now));
  if (stmts.length) await runBatchInChunks(db, stmts);
}

// 結果(着順・払戻)を取り込んだ・保存したレース。races: [{ id, track, course_type, distance, race_name, class_flags }]
export async function enqueuePaceRecomputeForResults(db, races) {
  try {
    const ready = (races || []).filter((r) => r && courseKeyOf(r));
    if (!ready.length) return;
    await insertRows(db, await queueRowsOf(db, ready));
  } catch (e) {
    console.error("pace recompute enqueue (results) failed (ignored)", e);
  }
}

// 馬番が確定した出馬表を取り込んだ・保存したレース。races: [{ id, track, course_type, distance, race_name, class_flags, entries(配列) }]
// まだ自動で計算していない・古い方式で計算した条件だけ積む(手で保存した比率の条件は積まない)。
// D1: 条件ごとに比率の行を主キーで1行(1開催日で数十行)
export async function enqueuePaceRecompute(db, races) {
  try {
    const ready = (races || []).filter((r) => Array.isArray(r.entries) && r.entries.length
      && r.entries.every((e) => e && e.horse_number !== null && e.horse_number !== undefined && e.horse_number !== ""));
    if (!ready.length) return;
    const rows = await queueRowsOf(db, ready);
    if (!rows.size) return;
    const list = [...rows.values()];
    const checks = list.map(([kind, key]) => {
      if (kind === "graded") {
        return db.prepare("SELECT source, json_extract(detail, '$.version') AS v FROM pace_weights WHERE graded_race_id = ?").bind(Number(key));
      }
      const c = parseCourseKey(key);
      return db.prepare("SELECT source, json_extract(detail, '$.version') AS v FROM course_pace_weights WHERE track = ? AND course_type = ? AND distance = ?")
        .bind(c.track, c.course_type, c.distance);
    });
    // 1回の取り込みの条件の数(1開催日で数十、多い取り込みで百前後)。結果が要るので90件ずつ自前で分けて読む
    const res = [];
    for (let i = 0; i < checks.length; i += 90) res.push(...(await db.batch(checks.slice(i, i + 90))));
    const need = new Map();
    list.forEach(([kind, key, raceId], i) => {
      const row = res?.[i]?.results?.[0] || null;
      if (row && row.source === "manual") return; // 手で決めた比率は自動で計算しない
      if (row && row.source === "auto" && Number(row.v) === METHOD_VERSION) return; // 今の方式で計算済み(結果が入れば積まれる)
      need.set(`${kind}|${key}`, [kind, key, raceId]);
    });
    if (need.size) await insertRows(db, need);
  } catch (e) {
    console.error("pace recompute enqueue failed (ignored)", e);
  }
}
