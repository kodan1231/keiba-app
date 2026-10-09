import {
  requireAdmin,
  horseAliasKeyOf,
  loadHorseAliasMap,
  applyHorseAliasMap,
  getHorseNameCounts,
} from "../../_shared.js";

// 管理者向け: 登録馬名の一覧。races.entries ∪ race_results ∪ horse_notes(自分)∪ horse_aliases
// に現れる馬名を、馬名エイリアス正規化キー(horseAliasKeyOf + horse_aliases)で1件に畳んで返す。
// 馬名エイリアス管理画面(admin.html)の 50音行ボタン + 検索ボックスから使う。
// docs/design/horse-aliases.md「登録馬一覧」参照。

const GOJUON_ROWS = {
  "ア": "アイウエオァィゥェォヴ",
  "カ": "カキクケコガギグゲゴヵヶ",
  "サ": "サシスセソザジズゼゾ",
  "タ": "タチツテトダヂヅデドッ",
  "ナ": "ナニヌネノ",
  "ハ": "ハヒフヘホバビブベボパピプペポ",
  "マ": "マミムメモ",
  "ヤ": "ヤユヨャュョ",
  "ラ": "ラリルレロ",
  "ワ": "ワヲンヰヱヮ",
};
const ROW_ORDER = ["ア", "カ", "サ", "タ", "ナ", "ハ", "マ", "ヤ", "ラ", "ワ", "その他"];

function gojuonRow(name) {
  const c = String(name || "").normalize("NFKC").trim().charAt(0);
  if (!c) return "その他";
  for (const [row, chars] of Object.entries(GOJUON_ROWS)) {
    if (chars.includes(c)) return row;
  }
  return "その他";
}

// 表記ごとの「出走表に載ったレース数」「結果に載ったレース数」は馬名のキャッシュ(_lib/horse-names-cache.js)から読む。
// 2026-10-08: 前日に出走表側を SQL の json_each で数える形に変えたところ、展開した出走馬1頭ずつが D1 の読み取り行数に
// 数えられ、1回約10万行(結果側も約5万行)になった。50音の行を押すたびに走り、同日に D1 の1日の読み取り上限を超える
// 原因の一つになった。キャッシュ(races.id の範囲ごと。変わった範囲だけ作り直す)を読む形にした(1回 約20行)。

export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const row = url.searchParams.get("row") || "";
  const q = (url.searchParams.get("q") || "").normalize("NFKC").trim();

  const [aliasMap, counts, notesRes] = await Promise.all([
    loadHorseAliasMap(env.DB),
    getHorseNameCounts(env.DB), // 表記ごとのレース数(全ユーザー共通)
    env.DB.prepare("SELECT horse_name FROM horse_notes WHERE user_id = ? AND memo IS NOT NULL AND memo <> ''").bind(userId).all(),
  ]);

  // key -> 集計オブジェクト
  const byKey = new Map();
  const touch = (rawName) => {
    if (!rawName) return null;
    const canon = applyHorseAliasMap(aliasMap, rawName);
    const key = horseAliasKeyOf(canon);
    if (!key) return null;
    let o = byKey.get(key);
    if (!o) {
      o = { key, display: canon, variants: new Set(), entryRaceCount: 0, resultRaceCount: 0, hasNote: false };
      byKey.set(key, o);
    }
    o.variants.add(rawName);
    // 表示名は「エイリアスで確定した canonical」を優先。未エイリアスなら最初に見た表記。
    if (aliasMap.get(key) && o.display !== aliasMap.get(key)) o.display = aliasMap.get(key);
    return o;
  };

  // 同じ馬の別表記が同じレースに並ぶことは無い前提で、表記ごとのレース数を足し合わせる
  for (const [name, n] of counts.entries) {
    const o = touch(name);
    if (o) o.entryRaceCount += n;
  }
  for (const [name, n] of counts.results) {
    const o = touch(name);
    if (o) o.resultRaceCount += n;
  }
  for (const n of notesRes.results || []) {
    const o = touch(n.horse_name);
    if (o) o.hasNote = true;
  }

  // 全体の 50音行ごとの件数(UI のバッジ用。フィルタ前の全件で数える)
  const rowCounts = {};
  for (const label of ROW_ORDER) rowCounts[label] = 0;
  for (const o of byKey.values()) rowCounts[gojuonRow(o.display)]++;

  // row / q が無ければ一覧は返さず件数だけ(全件返すと重いため)
  let horses = [];
  if (row || q) {
    horses = [...byKey.values()]
      .filter((o) => {
        if (q) return o.display.normalize("NFKC").includes(q) || [...o.variants].some((v) => v.normalize("NFKC").includes(q));
        return gojuonRow(o.display) === row;
      })
      .map((o) => ({
        name: o.display,
        entryRaceCount: o.entryRaceCount,
        resultRaceCount: o.resultRaceCount,
        hasNote: o.hasNote,
        variants: [...o.variants],
        mismatch: o.variants.size > 1,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  return Response.json({ ok: true, rowOrder: ROW_ORDER, rowCounts, horses });
}
