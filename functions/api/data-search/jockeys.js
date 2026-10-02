import { forEachJockeyRide } from "../_shared.js";

// データ検索画面「騎手検索」タブの騎手一覧API(2026-10-03追加)。
// 騎手は数百人規模のため、全件を騎乗数の降順で返し、候補の絞り込み(部分一致)は
// 画面側(public/jockey-search.js)で行う(入力のたびにAPIを呼ばない)。
// races / race_results は全ユーザー共有データのため requireAdmin しない。
// 詳細は docs/design/data-search.md「騎手検索タブ」参照。
export async function onRequestGet(context) {
  const byKey = new Map(); // key -> { name, rides }
  await forEachJockeyRide(context.env.DB, ({ key, display }) => {
    let o = byKey.get(key);
    if (!o) {
      o = { name: display, rides: 0 };
      byKey.set(key, o);
    }
    o.rides++;
  });
  const jockeys = [...byKey.values()].sort(
    (a, b) => b.rides - a.rides || a.name.localeCompare(b.name, "ja")
  );
  return Response.json({ jockeys });
}
