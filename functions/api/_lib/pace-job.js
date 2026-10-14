// 総合推奨馬の比率の計算を「1歩ずつ」進める(2026-10-14追加。Cloudflare の定時起動 workers/pace-cron から呼ぶ)。
// 仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」。
// サーバーの1回の処理のCPU上限(無料枠10ミリ秒)に収まるよう、1回の呼び出しでは次のどれか1つだけ行う:
//   - 計算待ち(pace_recompute_queue)の先頭を作業(pace_jobs)にする(7日未満・手で保存した比率なら計算せず計算待ちから外す)
//   - 採点を6レースぶん進めて作業に足す(_lib/pace-score.js の backtestChunk)
//   - 比率選びを1段進める(public/pace-search.js の stepPaceSearch。ブラウザ・Node と同じ計算)。最後の段で保存して作業と計算待ちを消す
// 作業の途中の状態は表 pace_jobs に置く(1作業1行。採点した数十レースの JSON で数十KB)。
// D1: 1回あたり作業1行の読み書き+(採点のとき)約1,500行の読み取り。
import { backtestChunk, saveAutoPaceResult } from "./pace-score.js";
import { getPaceScoreSettings } from "./pace-settings.js";
import { parseCourseKey } from "./pace-queue.js";
import { startPaceSearch, stepPaceSearch } from "../../../public/pace-search.js";

const SKIP_DAYS = 7;

async function lastComputed(db, kind, key) {
  if (kind === "graded") return db.prepare("SELECT updated_at, source FROM pace_weights WHERE graded_race_id = ?").bind(Number(key)).first();
  const c = parseCourseKey(key);
  return c ? db.prepare("SELECT updated_at, source FROM course_pace_weights WHERE track = ? AND course_type = ? AND distance = ?").bind(c.track, c.course_type, c.distance).first() : null;
}

const dropQueue = (db, kind, key) => db.prepare("DELETE FROM pace_recompute_queue WHERE kind = ? AND key = ?").bind(kind, key).run();
const dropJob = (db, kind, key) => db.prepare("DELETE FROM pace_jobs WHERE kind = ? AND key = ?").bind(kind, key).run();

// 1歩進める。戻り値: { idle: true }(やることが無い)か { did: "..." }
export async function paceJobStep(db) {
  let job = await db.prepare("SELECT kind, key, phase, offset, total, races, state, missing_score FROM pace_jobs ORDER BY updated_at LIMIT 1").first();
  const now = new Date().toISOString();

  if (!job) {
    const item = await db.prepare("SELECT kind, key FROM pace_recompute_queue ORDER BY created_at LIMIT 1").first();
    if (!item) return { idle: true };
    const row = await lastComputed(db, item.kind, item.key);
    if (row?.source === "manual" || (row?.source === "auto" && row.updated_at && Date.now() - Date.parse(row.updated_at) < SKIP_DAYS * 86400000)) {
      await dropQueue(db, item.kind, item.key);
      return { did: `skip ${item.kind} ${item.key}` };
    }
    const { missing_score } = await getPaceScoreSettings(db);
    await db.prepare(
      `INSERT OR REPLACE INTO pace_jobs (kind, key, phase, offset, total, races, state, missing_score, updated_at) VALUES (?, ?, 'score', 0, NULL, '[]', NULL, ?, ?)`
    ).bind(item.kind, item.key, missing_score, now).run();
    return { did: `start ${item.kind} ${item.key}` };
  }

  // 計算待ちから消えていれば(管理者のブラウザで計算し終えた等)作業も消す
  const still = await db.prepare("SELECT 1 AS x FROM pace_recompute_queue WHERE kind = ? AND key = ?").bind(job.kind, job.key).first();
  if (!still) {
    await dropJob(db, job.kind, job.key);
    return { did: `drop ${job.kind} ${job.key}` };
  }

  let races = [];
  try { races = JSON.parse(job.races || "[]"); } catch { races = []; }

  if (job.phase === "score") {
    const chunk = await backtestChunk(db, job.kind, job.key, job.offset, 6, job.missing_score);
    if (chunk.error) {
      await dropJob(db, job.kind, job.key);
      await dropQueue(db, job.kind, job.key);
      return { did: `error ${job.kind} ${job.key}: ${chunk.error}` };
    }
    races.push(...chunk.races);
    const offset = job.offset + Math.max(chunk.races.length, 1);
    const finished = offset >= chunk.total || !chunk.races.length;
    let phase = "score", state = null;
    if (finished) {
      const s = startPaceSearch(races);
      if (s.error) {
        await dropJob(db, job.kind, job.key);
        await dropQueue(db, job.kind, job.key);
        return { did: `none ${job.kind} ${job.key}: ${s.error}` };
      }
      phase = "search";
      state = JSON.stringify(s);
    }
    await db.prepare("UPDATE pace_jobs SET phase = ?, offset = ?, total = ?, races = ?, state = ?, updated_at = ? WHERE kind = ? AND key = ?")
      .bind(phase, offset, chunk.total, JSON.stringify(races), state, now, job.kind, job.key).run();
    return { did: `score ${job.kind} ${job.key} ${Math.min(offset, chunk.total)}/${chunk.total}` };
  }

  // 比率選びを1段
  let state = null;
  try { state = JSON.parse(job.state || "null"); } catch { state = null; }
  if (!state) state = startPaceSearch(races);
  const r = stepPaceSearch(races, state);
  if (!r.done) {
    await db.prepare("UPDATE pace_jobs SET state = ?, updated_at = ? WHERE kind = ? AND key = ?").bind(JSON.stringify(r.state), now, job.kind, job.key).run();
    return { did: `search ${job.kind} ${job.key} ${r.state.stage}/${r.state.stages.length}` };
  }
  if (!r.result.error) {
    r.result.detail.missing_score = job.missing_score;
    await saveAutoPaceResult(db, job.kind, job.key, r.result);
  }
  await dropJob(db, job.kind, job.key);
  await dropQueue(db, job.kind, job.key);
  return { did: `saved ${job.kind} ${job.key}` };
}
