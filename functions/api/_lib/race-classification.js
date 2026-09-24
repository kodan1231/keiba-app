// レースを「重賞／条件戦／その他」に分類するための共通ロジック。
// 集計画面(stats.html)の「総合成績」「レース別」タブの「すべて／重賞のみ／条件戦のみ」
// フィルタで使う。詳細・経緯は docs/design/graded-races.md 参照。
//
// 判定方針(2026-09-19):
//   - 条件戦: races.class_flags に「新馬」「未勝利」「1勝クラス」のいずれかを含む
//     (メイクデビュー系のレースもclass_flagsは「新馬」表記になるため自動的に含まれる)。
//     2勝クラス以上・オープン(特別・重賞含む)は対象外(「すべて」にのみ表示される)。
//   - 重賞: races.race_name を graded_races マスタ(name_key)と突き合わせて判定する。
//     条件戦の判定を先に行うため、条件戦とグレードマスタの両方に一致することは
//     実質発生しない。
//   - どちらにも該当しないレース(特別・無名の2勝クラス以上等)は「other」とし、
//     「すべて」にのみ表示される(「重賞のみ」「条件戦のみ」には出てこない)。

import { runBatchInChunks } from "./http.js";

const CONDITION_KEYWORDS = ["新馬", "未勝利", "1勝クラス"];

// races.race_name から「回次(第N回)」表記を除いたベース名を計算する。
// races.race_base_name 列に保存し、将来のレース名検索(同じレースの年をまたいだ
// 過去履歴一覧化。docs/design/data-model.md「races.race_base_name」参照)で使う。
// gradedRaceNameKey() と異なり、末尾の「ステークス/カップ/トロフィー」略記化は
// しない(表示・検索用になるべく正式表記を保つため)。
//
// 先頭に誤って混入したグレードバッジ表記(「GⅠ」「J・GⅢ」等)も除去する
// (2026-09-19以前にインポートされた一部のrace_nameに、結果PDF解析のズレで
// グレードバッジが誤って先頭に付いたまま保存されているケースがある。これにより、
// race_base_nameは既に混入済みの過去データに対しても正しいベース名を返せる)。
export function raceBaseNameOf(rawName) {
  let s = String(rawName ?? "").normalize("NFKC").trim();
  if (!s) return null;
  // 回次・混入グレードバッジのどちらが先に来ても(あるいは両方あっても)確実に
  // 除去できるよう、どちらにもマッチしなくなるまで繰り返し剥がす。
  // NFKC正規化でローマ数字(Ⅰ/Ⅱ/Ⅲ)がI/II/IIIへ分解された後の形も許容する。
  let prev;
  do {
    prev = s;
    s = s.replace(/^第\d+回\s*/, "");
    s = s.replace(/^(?:J・)?G(?:[ⅠⅡⅢ]|I{1,3})\s*/, "");
    s = s.trim();
  } while (s !== prev && s);
  return s || null;
}

// races.race_name → graded_races.name_key と同じ形へ正規化する。
//   1. raceBaseNameOf() で回次・混入グレードバッジを除去
//   2. 残りの全角/半角空白を除去
//   3. 末尾の「ステークス/カップ/トロフィー」を「S/C/T」に統一する
//      (重賞一覧ページのレース名は略記、結果・出走馬PDFのレース名は正式表記のため)
export function gradedRaceNameKey(rawName) {
  const base = raceBaseNameOf(rawName);
  if (!base) return "";
  let s = base.replace(/[　\s]+/g, "");
  s = s
    .replace(/ステークス$/, "S")
    .replace(/カップ$/, "C")
    .replace(/トロフィー$/, "T");
  return s;
}

export function isConditionRace(classFlags) {
  const s = String(classFlags ?? "");
  return CONDITION_KEYWORDS.some((k) => s.includes(k));
}

// gradedMap: Map<name_key, { grade, is_jump }>(loadGradedRaceMap() の戻り値)
// race: { race_name, class_flags }
// 戻り値: { category: "condition"|"graded"|"other", grade: "G1"|"G2"|"G3"|null }
export function classifyRace(gradedMap, race) {
  if (isConditionRace(race?.class_flags)) return { category: "condition", grade: null };
  const key = gradedRaceNameKey(race?.race_name);
  const hit = key && gradedMap ? gradedMap.get(key) : null;
  if (hit) return { category: "graded", grade: hit.grade };
  return { category: "other", grade: null };
}

export async function loadGradedRaceMap(db) {
  const { results } = await db.prepare("SELECT name_key, grade, is_jump FROM graded_races").all();
  const map = new Map();
  for (const r of results || []) {
    map.set(r.name_key, { grade: r.grade, is_jump: !!r.is_jump });
  }
  return map;
}

// races全件のrace_base_nameを再計算する一括補正(管理画面「重賞管理」の
// 「レースのベース名を再計算する」ボタンから呼び出す)。race_base_name列追加時の
// 初回バックフィル、および将来raceBaseNameOf()の正規化ルールを変更した際の
// 再計算に使う。1回のSELECTで全件取得→メモリ上で判定→変更行だけdb.batch()
// (runBatchInChunks)でまとめてUPDATEする、他の一括補正(jockey-alias.js等)と
// 同じ方式。何度実行しても安全(冪等)。
export async function recomputeAllRaceBaseNames(db) {
  const { results } = await db.prepare("SELECT id, race_name, race_base_name FROM races").all();
  const statements = [];
  for (const row of results || []) {
    const next = raceBaseNameOf(row.race_name);
    if (next !== (row.race_base_name ?? null)) {
      statements.push(db.prepare("UPDATE races SET race_base_name = ? WHERE id = ?").bind(next, row.id));
    }
  }
  if (statements.length) await runBatchInChunks(db, statements);
  return { updated: statements.length };
}
