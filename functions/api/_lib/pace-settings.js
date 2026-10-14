// 総合推奨馬の点数の設定(2026-10-14追加)。管理画面「総合推奨馬の比率」で変更する。
// app_settings の key='pace_score' に JSON で保存: { missing_score }(データの無い馬の点〈偏差値〉。既定40)。
// 仕様は docs/design/screens.md「総合推奨馬」の「点数を偏差値に変更」。
import { memoized, invalidateMemo } from "./memo-cache.js";
import { DEFAULT_MISSING_SCORE } from "./race-factors.js";

const PACE_SCORE_KEY = "pace_score";
const MEMO_PACE_SCORE = "pace_score_settings";

function normalize(raw) {
  const v = Number(raw?.missing_score);
  return { missing_score: Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 10) / 10)) : DEFAULT_MISSING_SCORE };
}

// 設定を読む(表が無い・読めないときは既定値)。fresh=false なら同じ実行環境で2分使い回す。
export async function getPaceScoreSettings(db, { fresh = false } = {}) {
  const load = async () => {
    try {
      const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(PACE_SCORE_KEY).first();
      return normalize(row ? JSON.parse(row.value) : null);
    } catch {
      return normalize(null);
    }
  };
  return fresh ? load() : memoized(MEMO_PACE_SCORE, load);
}

// 入力を検証して保存する。不正なら null。
export async function savePaceScoreSettings(db, input) {
  const v = Number(input?.missing_score);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  const s = normalize({ missing_score: v });
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(PACE_SCORE_KEY, JSON.stringify(s), new Date().toISOString())
    .run();
  invalidateMemo(MEMO_PACE_SCORE);
  return s;
}
