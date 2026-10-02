// レース1件の「出走した各馬と着順」配列を作る共通処理。
// 2026-10-03: データ検索画面「騎手検索」タブ追加に伴い、レース成績タブ
// (functions/api/data-search/race-stats.js)の内部関数から切り出して共用にした。
// 着順ソースの選び方は docs/design/data-search.md「③④⑤ 共通: 着順データの取り方」参照。

// 騎乗した(出走した)とみなす race_results.status。取消(scratched)・除外(excluded)は含めない。
const RIDDEN_STATUSES = new Set(["finished", "stopped"]);

// レース1件について「出走した各馬の {horse_number, jockey, ran, pos}」配列を作る。
// pos は 1/2/3(3着以内)または null(着外)。着順データが取れなければ null を返す。
//   1) race_results が全頭ぶん揃っていれば、それを正のソースにする
//   2) そうでなければ finish_order(上位3着)+ entries(全出走馬)で補う
//      (entries からは取消馬を判別できないため ran は常に true)
export function buildRaceLineup(entries, finishOrder, rrRows) {
  if (Array.isArray(rrRows) && entries.length > 0 && rrRows.length >= entries.length) {
    return rrRows.map((r) => {
      const status = r.status || "finished";
      const fp = r.finish_position;
      return {
        horse_number: r.horse_number,
        jockey: r.jockey,
        ran: RIDDEN_STATUSES.has(status),
        pos: fp != null && fp >= 1 && fp <= 3 ? fp : null,
      };
    });
  }
  if (Array.isArray(finishOrder) && finishOrder.length && entries.length) {
    const posOf = (hn) => {
      const i = finishOrder.indexOf(hn);
      return i >= 0 && i < 3 ? i + 1 : null;
    };
    return entries.map((e) => ({
      horse_number: e.horse_number,
      jockey: e.jockey,
      ran: true,
      pos: posOf(e.horse_number),
    }));
  }
  return null;
}

// 騎手名の表示用の形: 先頭の見習い減量記号(☆▲△★◇)を除き、空白を1つに畳む。
export function jockeyDisplayName(name) {
  return String(name ?? "").replace(/^[☆▲△★◇]/, "").replace(/[　\s]+/g, " ").trim();
}
