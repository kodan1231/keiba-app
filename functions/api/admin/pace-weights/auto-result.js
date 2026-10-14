import { requireAdmin, readJsonBody, jsonError, saveAutoPaceResult } from "../../_shared.js";

// 管理者向け(APIトークンでも可): ブラウザ・夜間の定時実行が選んだ比率を保存する(2026-10-14追加)。
// PUT { kind: "graded"|"course", key: <重賞ID | 競馬場|芝ダ障|距離>, result: public/pace-search.js の choosePaceWeights の戻り値 }
// 手で保存した比率(共通・ペース、軸・相手それぞれ)は残す(_lib/pace-score.js の saveAutoPaceResult)。
// 書き込みは1行。仕様は docs/design/screens.md「比率の計算(夜間・今すぐ計算)」。
export async function onRequestPut(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { data, error } = await readJsonBody(context.request);
  if (error) return error;
  const r = await saveAutoPaceResult(context.env.DB, data?.kind, data?.key, data?.result);
  if (r.error) return jsonError(r.error, 400);
  return Response.json(r);
}
