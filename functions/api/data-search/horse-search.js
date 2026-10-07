import { jsonError, loadHorseAliasMap, applyHorseAliasMap, horseAliasKeyOf } from "../_shared.js";

// データ検索画面「馬情報検索」タブの検索候補一覧API(部分一致)。
// races.entries は全ユーザー共有データのため requireAdmin しない
// (GET /api/data-search/race-stats と同じ扱い)。
//
// races.entries の馬名は、入力文字を含むものだけを SQL(json_each + LIKE)で取り出す(2026-10-07〜。
// 以前は races_cache〈_lib/races-cache.js〉を丸ごと解析していた。下記 onRequestGet 内の注記参照)。race_results
// までは見に行かない(出走馬一覧PDF/結果PDFいずれの経路でも races.entries は
// 共通マージルールで埋まる前提のため、entries だけで実用上の検索網羅性は足りる。
// 詳細な出走履歴・調教師/血統等の情報は詳細API側〈GET /api/data-search/horse-info〉で
// horse_key をキーに race_results を直接引く)。
// 詳細は docs/design/data-search.md「馬情報検索タブ」参照。

const MAX_RESULTS = 50;
// 1文字だと該当馬が多すぎて絞り込みの意味がほぼ無いうえ、races全件スキャンの
// コストに見合わないため、クライアント側(data-search.js の HI_SEARCH_MIN_LENGTH)に
// 加えてサーバー側でも検証する(直接APIを叩かれた場合の防御)。
const MIN_QUERY_LENGTH = 2;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").normalize("NFKC").trim();
  if (!q) return Response.json({ query: "", horses: [] });
  if (q.length < MIN_QUERY_LENGTH) return jsonError(`検索キーワードは${MIN_QUERY_LENGTH}文字以上入力してください`, 400);
  if (q.length > 40) return jsonError("検索キーワードが長すぎます", 400);

  const db = env.DB;
  // 2026-10-07: 以前は races_cache(約10MB)を丸ごと解析して全出走馬の馬名を集めており、CPU時間上限超過の
  // 恐れがあった。入力文字を含む馬名だけを SQL(json_each + LIKE)で取り出し、馬名ごとの出走回数も
  // SQL 側で数える(読み取りは races 全件=2026-10-07時点で約3,700行/回。JS側の処理は該当馬名の分だけ)。
  // 出走表の馬名は取込・編集時に馬名エイリアスで正規化済みのため、元の表記での部分一致で足りる。
  // LIKE の特殊文字(% _ \)は入力側でエスケープする。
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [{ results: nameRows }, aliasMap] = await Promise.all([
    db.prepare(
      `SELECT name, COUNT(*) AS n FROM (
         SELECT json_extract(e.value, '$.horse_name') AS name
           FROM races r, json_each(r.entries) e
          WHERE json_valid(r.entries)
       ) WHERE name LIKE ? ESCAPE '\\' GROUP BY name`
    ).bind(like).all(),
    loadHorseAliasMap(db),
  ]);

  const byKey = new Map();
  for (const row of nameRows || []) {
    const raw = row.name;
    if (!raw) continue;
    const canon = applyHorseAliasMap(aliasMap, String(raw));
    const key = horseAliasKeyOf(canon);
    if (!key) continue;
    let o = byKey.get(key);
    if (!o) {
      o = { key, display: canon, raceCount: 0 };
      byKey.set(key, o);
    }
    // 表示名は「エイリアスで確定した正しい馬名」を優先する(admin/horses/index.js と同じ考え方)。
    if (aliasMap.get(key) && o.display !== aliasMap.get(key)) o.display = aliasMap.get(key);
    o.raceCount += Number(row.n) || 0;
  }

  const matches = [...byKey.values()]
    .filter((o) => o.display.normalize("NFKC").includes(q))
    .sort((a, b) => a.display.localeCompare(b.display, "ja"));

  const horses = matches.slice(0, MAX_RESULTS).map((o) => ({ name: o.display, raceCount: o.raceCount }));

  return Response.json({ query: q, horses, truncated: matches.length > MAX_RESULTS });
}
