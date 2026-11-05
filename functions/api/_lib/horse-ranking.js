// 馬情報検索タブの「出走回数トップ10」「勝利回数トップ10」(2026-11-05 ユーザー要望)。
// 仕様は docs/design/data-search.md「出走回数・勝利回数のトップ10」。
// 夜間の計算(scripts/pace-nightly.mjs の 2a)が、距離の換算の比のために読む結果の表(約19.5万行)から Node で数え、
// POST /api/cron/horse-ranking で app_settings の1行(key = horse_ranking)に保存する。画面(GET /api/data-search/horse-ranking)は
// その1行を読むだけ(結果の表を数えると1回約19.5万行の読み取りになるため、画面を開くたびには数えない)。
// 取り込んだ結果は次の晩に反映する。
//   対象: 取り込んである結果の全期間。中央(JRA_TRACKS の10場)と地方を別々に数える(中央・地方の両方を走った馬は、それぞれに数える)
//   出走: 結果の状態が完走・競走中止(取消・除外は数えない)。勝利: 完走で1着
//   同数: 10位と同じ数の馬は全部出す(最大 RANKING_MAX 頭)。出走の同数は勝利の多い順、勝利の同数は出走の少ない順(勝率の高い順)、その次は馬名順
//   馬は horse_key(名寄せキー)で数え、表示名は馬名エイリアスを通した最後の出走の表記
import { JRA_TRACKS } from "./guest.js";
import { applyHorseAliasMap } from "./horse-alias.js";

export const HORSE_RANKING_KEY = "horse_ranking";
export const RANKING_TOP = 10;
export const RANKING_MAX = 50;

// results: [{ horse_key, horse_name, race_id, status, finish_position }]、races: Map<race_id, { track, race_date }>
// 戻り値: { jra: { starts: [...], wins: [...] }, local: { starts: [...], wins: [...] } }
//   各要素: [馬名, 出走, 勝利](順位は画面で付ける)
export function computeHorseRanking(results, races, aliasMap) {
  const groups = { jra: new Map(), local: new Map() };
  for (const x of results) {
    if (!x.horse_key || (x.status !== "finished" && x.status !== "stopped")) continue;
    const r = races.get(x.race_id);
    const track = String(r?.track || "").trim();
    if (!track) continue;
    const m = JRA_TRACKS.includes(track) ? groups.jra : groups.local;
    let o = m.get(x.horse_key);
    if (!o) m.set(x.horse_key, (o = { name: "", date: "", starts: 0, wins: 0 }));
    o.starts++;
    if (x.status === "finished" && Number(x.finish_position) === 1) o.wins++;
    const date = String(r.race_date || "");
    if (x.horse_name && date >= o.date) { o.date = date; o.name = String(x.horse_name); }
  }
  const out = {};
  for (const [kind, m] of Object.entries(groups)) {
    const list = [...m.values()].map((o) => ({ ...o, name: applyHorseAliasMap(aliasMap, o.name) || o.name }));
    const byName = (a, b) => a.name.localeCompare(b.name, "ja");
    out[kind] = {
      starts: topWithTies(list, "starts", (a, b) => b.starts - a.starts || b.wins - a.wins || byName(a, b)),
      wins: topWithTies(list.filter((o) => o.wins > 0), "wins", (a, b) => b.wins - a.wins || a.starts - b.starts || byName(a, b)),
    };
  }
  return out;
}

// 上位 RANKING_TOP 頭と、10位と同じ数の馬(最大 RANKING_MAX 頭)
function topWithTies(list, field, cmp) {
  const sorted = list.sort(cmp);
  if (sorted.length <= RANKING_TOP) return sorted.map(rowOf);
  const edge = sorted[RANKING_TOP - 1][field];
  const out = [];
  for (const o of sorted) {
    if (out.length >= RANKING_TOP && o[field] !== edge) break;
    if (out.length >= RANKING_MAX) break;
    out.push(rowOf(o));
  }
  return out;
}
const rowOf = (o) => [o.name, o.starts, o.wins];

// 保存(POST /api/cron/horse-ranking から)。app_settings の1行
export async function saveHorseRanking(db, { marker = null, ranking }) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(HORSE_RANKING_KEY, JSON.stringify({ computed_at: now, marker, ...ranking }), now).run();
  return { computed_at: now };
}

// 読み取り(主キーで1行)。無ければ null
export async function loadHorseRanking(db) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(HORSE_RANKING_KEY).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
