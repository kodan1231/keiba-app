import {
  requireAdmin,
  horseAliasKeyOf,
  loadHorseAliasMap,
  applyHorseAliasMap,
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

export async function onRequestGet(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const row = url.searchParams.get("row") || "";
  const q = (url.searchParams.get("q") || "").normalize("NFKC").trim();

  const aliasMap = await loadHorseAliasMap(env.DB);

  // 2026-10-07: 以前は races.entries を全件 JSON 解析し、race_results も (レース, 馬名) の組を全件受け取って
  // JS 側でレース数を数えていた(CPU時間上限超過の恐れ)。馬名ごとのレース数は SQL 側で数える。
  // 同じ馬の別表記が同じレースに並ぶことは無い前提で、表記ごとのレース数を足し合わせる。
  const [racesRes, rrRes, notesRes] = await Promise.all([
    env.DB.prepare(
      `SELECT json_extract(e.value, '$.horse_name') AS horse_name, COUNT(DISTINCT r.id) AS n
         FROM races r, json_each(r.entries) e
        WHERE json_valid(r.entries)
        GROUP BY horse_name`
    ).all(),
    env.DB.prepare("SELECT horse_name, COUNT(DISTINCT race_id) AS n FROM race_results WHERE horse_name IS NOT NULL AND horse_name <> '' GROUP BY horse_name").all(),
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

  for (const r of racesRes.results || []) {
    const o = touch(r.horse_name);
    if (o) o.entryRaceCount += Number(r.n) || 0;
  }
  for (const rr of rrRes.results || []) {
    const o = touch(rr.horse_name);
    if (o) o.resultRaceCount += Number(rr.n) || 0;
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
