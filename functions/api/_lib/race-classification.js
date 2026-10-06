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

// PDFのテキスト抽出で、通常の漢字の代わりに「CJK部首補助」の字形(見た目は同じ別の文字)が
// 入ることがある(例: 「テレビ⻄日本賞」の ⻄ U+2EC4、「⻘葉賞」の ⻘ U+2EC9)。NFKC では
// 通常の漢字にならないため、重賞名の突き合わせ用に個別に置き換える(2026-10-06)。
const CJK_RADICAL_VARIANTS = new Map([
  ["⻄", "西"], ["⻉", "青"], ["⻑", "長"], ["⻝", "食"], ["⻤", "鬼"],
  ["⻩", "黄"], ["⻨", "麦"], ["⻆", "角"], ["⻏", "邑"], ["⻘", "青"],
]);
function normalizeCjkRadicals(s) {
  return s.replace(/[⺀-⻿]/g, (c) => CJK_RADICAL_VARIANTS.get(c) || c);
}

// 結果・出走馬PDFの正式名 → 重賞一覧(JRA公式の略称)の名前(2026-10-06)。
// 末尾の略記化や冠の除去では吸収できない、名前そのものが異なるもの。
const GRADED_NAME_SYNONYMS = new Map([
  ["東京優駿", "日本ダービー"],
  ["優駿牝馬", "オークス"],
  ["弥生賞ディープインパクト記念", "弥生賞"],
]);

// races.race_name → graded_races.name_key と同じ形へ正規化する。
//   1. raceBaseNameOf() で回次・混入グレードバッジを除去
//   2. CJK部首補助の字形を通常の漢字に置き換え(2026-10-06追加)、全角/半角空白を除去
//   3. 末尾の「ステークス/カップ/トロフィー/ハンデキャップ」を「S/C/T/H」に統一する
//      (重賞一覧ページのレース名は略記、結果・出走馬PDFのレース名は正式表記のため。
//      ハンデキャップ→H は2026-10-06追加。「京成杯オータムハンデキャップ」→「京成杯オータムH」)
//   4. 正式名と通称の対応(GRADED_NAME_SYNONYMS)を当てる(2026-10-06追加)
// 冠(スポンサー名。「産経賞」「読売」等)は、ここでは除去しない(冠と重賞名の区別が名前だけでは
// つかないため)。冠付きの名前は resolveGradedKey() で重賞一覧のキーと照らして判定する。
export function gradedRaceNameKey(rawName) {
  const base = raceBaseNameOf(rawName);
  if (!base) return "";
  let s = normalizeCjkRadicals(base).replace(/[　\s]+/g, "");
  s = s
    .replace(/ステークス$/, "S")
    .replace(/カップ$/, "C")
    .replace(/トロフィー$/, "T")
    .replace(/ハンデキャップ$/, "H");
  return GRADED_NAME_SYNONYMS.get(s) || s;
}

// 冠(スポンサー名)として先頭から外してよい部分の形。「◯◯賞」「◯◯杯」「◯◯賞典」、または「読売」。
// 例: 産経賞セントウルS / サンケイスポーツ杯阪神牝馬S / 農林水産省賞典新潟記念 / 読売マイラーズC
const SPONSOR_PREFIX_RE = /(?:賞|杯|賞典|読売)$/;

// レース名のキー(gradedRaceNameKey の結果)を、重賞一覧のキーへ解決する(2026-10-06追加)。
//   1. そのまま一覧にあればそのキー
//   2. 無ければ、先頭の冠(SPONSOR_PREFIX_RE で終わる部分)を外した残りが一覧にあればそのキー
//      (外す部分が短いものから試す=残りが長い一覧のキーを優先する)
// 単純な後方一致にしないのは、リステッド「白富士S」が重賞「富士S」に誤って一致しないようにするため
// (冠の形で終わる部分を外したときだけ一致とみなす)。
// hasKey: (key) => boolean(重賞一覧にそのキーがあるか)。一致しなければ null。
export function resolveGradedKey(raceKey, hasKey) {
  if (!raceKey) return null;
  if (hasKey(raceKey)) return raceKey;
  for (let i = 2; i <= raceKey.length - 2; i++) {
    const prefix = raceKey.slice(0, i);
    if (!SPONSOR_PREFIX_RE.test(prefix)) continue;
    const rest = GRADED_NAME_SYNONYMS.get(raceKey.slice(i)) || raceKey.slice(i);
    if (hasKey(rest)) return rest;
  }
  return null;
}

// graded_races.schedule_md(開催月日 "MM-DD")の入力値を正規化する(2026-10-02追加。
// docs/design/graded-race-search.md 参照)。"MM-DD" / "M/D" / "M月D日" を受け付ける。
// 空ならnull、解釈できない・存在しない月日なら undefined を返す(呼び出し側で400にする)。
export function normalizeScheduleMd(raw) {
  const s = String(raw ?? "").normalize("NFKC").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\s*(?:-|\/|月)\s*(\d{1,2})\s*日?$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return undefined;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
  // 冠(スポンサー名)付きのレース名も重賞一覧のキーへ解決する(2026-10-06。resolveGradedKey 参照)
  const key = gradedMap ? resolveGradedKey(gradedRaceNameKey(race?.race_name), (k) => gradedMap.has(k)) : null;
  const hit = key ? gradedMap.get(key) : null;
  if (hit) return { category: "graded", grade: hit.grade };
  return { category: "other", grade: null };
}

// 重賞一覧を Map<キー, { grade, is_jump }> で返す。キーは保存済みの name_key に加え、名前から
// 今の gradedRaceNameKey() で計算し直したものも入れる(2026-10-06。正規化ルールを変えた後も、
// 保存済みの name_key の計算し直しを待たずに一致させるため)。
export async function loadGradedRaceMap(db) {
  const { results } = await db.prepare("SELECT name, name_key, grade, is_jump FROM graded_races").all();
  const map = new Map();
  for (const r of results || []) {
    const v = { grade: r.grade, is_jump: !!r.is_jump };
    map.set(r.name_key, v);
    const fresh = gradedRaceNameKey(r.name);
    if (fresh && !map.has(fresh)) map.set(fresh, v);
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
