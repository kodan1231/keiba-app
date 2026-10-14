// 総合推奨馬の点数の設定(2026-10-14追加)。管理画面「総合推奨馬の比率」で変更する。
// app_settings の key='pace_score' に JSON で保存: { missing_score, adjust }
//   missing_score: データの無い馬の点(偏差値。既定40)
//   adjust: 評価点の既定値 { first_distance(初距離の減点), first_track(初競馬場の減点), same_jockey(継続騎乗の加点) }(偏差値の点。
//     2026-10-14追加。重賞・コースごとの評価点〈自動・手動〉が無いときに使う。_lib/race-factors.js の DEFAULT_ADJUST が初期値)
// 仕様は docs/design/screens.md「総合推奨馬」の「点数を偏差値に変更」「評価点(初距離・初競馬場・継続騎乗)」。
import { memoized, invalidateMemo } from "./memo-cache.js";
import { DEFAULT_MISSING_SCORE, DEFAULT_ADJUST, ADJUST_KEYS } from "./race-factors.js";

const PACE_SCORE_KEY = "pace_score";
const MEMO_PACE_SCORE = "pace_score_settings";
export const ADJUST_MAX = 50; // 評価点の上限(偏差値の点)

const clampNum = (raw, def, max) => {
  const v = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v * 10) / 10)) : def;
};

// 評価点の入力を検証する(0〜ADJUST_MAX の数。足りない項目は def から)。不正なら null
export function normalizeAdjust(raw, def = DEFAULT_ADJUST) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of ADJUST_KEYS) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") { out[k] = def[k]; continue; }
    const v = Number(raw[k]);
    if (!Number.isFinite(v) || v < 0 || v > ADJUST_MAX) return null;
    out[k] = Math.round(v * 10) / 10;
  }
  return out;
}

function normalize(raw) {
  return {
    missing_score: clampNum(raw?.missing_score, DEFAULT_MISSING_SCORE, 100),
    adjust: normalizeAdjust(raw?.adjust) || { ...DEFAULT_ADJUST },
  };
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

// 入力を検証して保存する(送られた項目だけ変え、他は今の値のまま)。不正なら null。
export async function savePaceScoreSettings(db, input) {
  const cur = await getPaceScoreSettings(db, { fresh: true });
  const next = { ...cur };
  if (input?.missing_score !== undefined) {
    const v = Number(input.missing_score);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
    next.missing_score = v;
  }
  if (input?.adjust !== undefined) {
    const a = normalizeAdjust(input.adjust, cur.adjust);
    if (!a) return null;
    next.adjust = a;
  }
  const s = normalize(next);
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
