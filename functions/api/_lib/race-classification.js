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

const CONDITION_KEYWORDS = ["新馬", "未勝利", "1勝クラス"];

// races.race_name → graded_races.name_key と同じ形へ正規化する。
//   1. NFKC正規化 + 全空白除去
//   2. 先頭の「第N回」を除去(重賞一覧ページのレース名には回次表記が無いため)
//   3. 先頭に誤って混入したグレードバッジ表記(「GⅠ」「J・GⅢ」等)を除去
//      (2026-09-19以前にインポートされた一部のrace_nameに、結果PDF解析の
//      ズレでグレードバッジが誤って先頭に付いたまま保存されているケースがある)
//   4. 末尾の「ステークス/カップ/トロフィー」を「S/C/T」に統一する
//      (重賞一覧ページのレース名は略記、結果・出走馬PDFのレース名は正式表記のため)
export function gradedRaceNameKey(rawName) {
  let s = String(rawName ?? "").normalize("NFKC").replace(/[　\s]+/g, "");
  if (!s) return "";
  s = s.replace(/^第\d+回/, "");
  // NFKC正規化でローマ数字(Ⅰ/Ⅱ/Ⅲ)がI/II/IIIへ分解された後の形も許容する。
  s = s.replace(/^(?:J・)?G(?:[ⅠⅡⅢ]|I{1,3})/, "");
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
