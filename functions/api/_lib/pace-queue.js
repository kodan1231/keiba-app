// 総合推奨馬の比率の「計算待ち」(2026-10-14追加。仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」)。
// 馬番が確定した出馬表を取り込んだ・保存したとき、そのレースのコース(競馬場・芝ダ障・距離)と、当たる重賞を
// 表 pace_recompute_queue に積む。毎晩3時(日本時間)の定時実行(GitHub Actions の scripts/pace-nightly.mjs)が
// 積まれた分を計算して保存し、取り除く(前の計算から7日未満なら計算せず取り除く)。
// 書き込みは「計算待ちに無ければ1行」(INSERT OR IGNORE)。積むのに失敗しても取り込み自体は止めない(best-effort)。
import { runBatchInChunks } from "./http.js";
import { loadGradedRaceMapCached, gradedRaceOf } from "./race-classification.js";

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

// races: [{ id, track, course_type, distance, race_name, class_flags, entries(配列) }]
// 出走馬がいて全頭の馬番が確定しているレースだけ積む
export async function enqueuePaceRecompute(db, races) {
  try {
    const ready = (races || []).filter((r) => Array.isArray(r.entries) && r.entries.length
      && r.entries.every((e) => e && e.horse_number !== null && e.horse_number !== undefined && e.horse_number !== ""));
    if (!ready.length) return;
    const gradedMap = await loadGradedRaceMapCached(db);
    const now = new Date().toISOString();
    const rows = new Map(); // "kind|key" -> [kind, key, race_id]
    for (const r of ready) {
      const ck = courseKeyOf(r);
      if (ck) rows.set(`course|${ck}`, ["course", ck, r.id ?? null]);
      const g = gradedRaceOf(gradedMap, r);
      if (g) rows.set(`graded|${g.id}`, ["graded", String(g.id), r.id ?? null]);
    }
    // 1回の取り込みで積む行は「取り込んだレースのコース数+重賞数」(1開催日で数十)。数百になりうるので分割して送る
    const stmts = [...rows.values()].map(([kind, key, raceId]) =>
      db.prepare("INSERT OR IGNORE INTO pace_recompute_queue (kind, key, race_id, created_at) VALUES (?, ?, ?, ?)").bind(kind, key, raceId, now));
    if (stmts.length) await runBatchInChunks(db, stmts);
  } catch (e) {
    console.error("pace recompute enqueue failed (ignored)", e);
  }
}
