// 小さな設定表(騎手名・馬名エイリアス、重賞一覧)の読み込み結果を、同じ実行環境(isolate)の中で
// 短い時間だけ使い回す(2026-10-07追加)。
//
// 背景: これらの表は数十〜数百行しかないが、ほぼすべての読み取りAPIが毎回全件を読み直しており、
// 7日間で約4,800回・約31万行の読み取りになっていた(wrangler d1 insights で確認)。
//
// 使い分け(重要):
//   - 画面表示のための読み取りAPI(購入履歴・集計・予想登録・データ検索など)は *Cached 版を使う。
//   - DBへ書き込む処理(PDF/CSV取込・出走馬編集・一括補正など)は、従来どおり毎回読み直す版
//     (loadJockeyAliasMap 等)を使う。古いエイリアスで正規化した値をDBへ保存しないため。
// 管理画面でエイリアス・重賞を変更したときは invalidateMemo() でその実行環境の分を捨てる。
// 別の実行環境に残っている分は MEMO_TTL_MS で自然に切れる(反映まで最大その時間の遅れが出る)。
//
// Promise ではなく読み終えた値を持つ(Workers では、別リクエストで始めたD1の問い合わせを
// 待つことが許されないため)。同時に来たリクエストはそれぞれ読み込む(結果は同じ)。

export const MEMO_TTL_MS = 2 * 60 * 1000;

const memo = new Map(); // name -> { at, value }

export async function memoized(name, loader, ttlMs = MEMO_TTL_MS) {
  const hit = memo.get(name);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  memo.set(name, { at: Date.now(), value });
  return value;
}

export function invalidateMemo(...names) {
  for (const n of names) memo.delete(n);
}

// memoized() に渡す名前(書き込み側の invalidateMemo() と揃えるため定数にしておく)
export const MEMO_JOCKEY_ALIASES = "jockey_aliases";
export const MEMO_HORSE_ALIASES = "horse_aliases";
export const MEMO_GRADED_RACES = "graded_races";
