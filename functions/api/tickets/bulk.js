import { recomputeTicketPayoutsForRaces } from "../_shared.js";

const VALID_BET_TYPES = [
  "tan", "fuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan",
];
const VALID_METHODS = ["normal", "box", "nagashi", "axis1", "axis2", "multi", "axis2_multi", "formation"];

// db.batch()に一度に積む文の数の上限(安全のためのチャンク分割)。
// db.batch()自体は1回のサブリクエストにまとまるため、通常のカゴ購入(数十〜百点程度)
// なら分割せず1回で収まるが、想定外に大量の買い目が一度に送られてきた場合に備えて
// 分割する(1回のdb.batch()呼び出しごとに1サブリクエストを消費するため、分割しすぎると
// かえってサブリクエスト数上限に近づく点に注意。目安として超えることがまず無い
// 200件をチャンクサイズとした)。
const BATCH_CHUNK_SIZE = 200;

async function runBatchInChunks(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
  }
}

// 1グループ分の必須項目・組み合わせの形式を検証する。問題があればエラーメッセージ
// (文字列)を返し、問題なければnullを返す。
function validateGroup(g) {
  if (!g || typeof g !== "object") return "リクエストが不正です";
  if (!g.race_id || !g.race_date || !g.track || !g.race_number || !g.bet_type) {
    return "必須項目が不足しています";
  }
  if (!Array.isArray(g.combos) || g.combos.length === 0) {
    return "組み合わせが生成されていません";
  }
  if (!VALID_BET_TYPES.includes(g.bet_type)) return "馬券種類が不正です";
  if (g.method && !VALID_METHODS.includes(g.method)) return "購入方式が不正です";
  if (g.combos.some((c) => !c.amount || !Array.isArray(c.selections))) return "組み合わせごとの金額が不正です";
  return null;
}

// 馬券かご機能(docs/ROADMAP.md クラスタF)対応: 複数レース・複数式別の買い目を
// 1回のリクエストでまとめて購入できるようにする(2026-09-06拡張。以前は1レース・
// 1式別分のcombos配列のみを受け付ける単一グループ形式だったが、カゴから
// チェック済みの買い目をまとめて送信できるよう、グループの配列を受け付ける形へ
// 破壊的に変更した。呼び出し元はpublic/buy-purchase-modal.js・public/cart.jsの
// みのため、旧形式との後方互換は持たせていない)。
//
// リクエスト形式:
//   { groups: [{ client_key, race_id, race_date, track, race_number, race_name,
//       bet_type, method, memo, combos: [{selections, amount}, ...] }, ...] }
// client_key は呼び出し側(カゴUI)が任意に付与する相関キー(内容は解釈しない)。
// レスポンスの results[].client_key と突き合わせることで、どのグループが
// 成功(created)/検証エラー(invalid)/レース不存在(skipped)だったかをUI側で
// 判定できるようにする(カゴから、成功した分だけ削除するために使う)。
//
// Cloudflare Pages Functionsの1リクエストあたりのサブリクエスト数上限に抵触しない
// よう、レース情報の取得は1回のSELECT(IN句)にまとめ、全グループのINSERT文を
// 配列化してdb.batch()で一括実行する(過去にCSV/PDFインポートで同種の問題が
// 発生した教訓。docs/DESIGN.md「実装上の注意(サブリクエスト数対策)」参照)。
export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;

  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const groups = Array.isArray(data?.groups) ? data.groups : null;
  if (!groups || groups.length === 0) {
    return Response.json({ error: "購入対象の買い目がありません" }, { status: 400 });
  }

  const results = [];
  const validGroups = [];

  for (const g of groups) {
    const error = validateGroup(g);
    if (error) {
      results.push({ client_key: g?.client_key ?? null, status: "invalid", error });
      continue;
    }
    validGroups.push(g);
  }

  if (validGroups.length === 0) {
    return Response.json({ ok: true, results });
  }

  // 対象レースをまとめて1回のSELECTで取得する(存在確認と、既に確定済みのレースへの
  // 払戻即時反映の両方に使う)。レースごとの個別SELECTはサブリクエスト数上限対策のため
  // 避ける。
  const uniqueRaceIds = [...new Set(validGroups.map((g) => Number(g.race_id)))];
  const placeholders = uniqueRaceIds.map(() => "?").join(",");
  const { results: raceRows } = await env.DB
    .prepare(`SELECT id, entries, finish_order, payouts FROM races WHERE id IN (${placeholders})`)
    .bind(...uniqueRaceIds)
    .all();
  const raceById = new Map((raceRows || []).map((r) => [r.id, r]));

  const statements = [];
  const touchedRaceIds = new Set();

  for (const g of validGroups) {
    const race = raceById.get(Number(g.race_id));
    if (!race) {
      results.push({ client_key: g.client_key ?? null, status: "skipped", error: "レースが見つかりません" });
      continue;
    }

    const groupId = crypto.randomUUID();
    for (const c of g.combos) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO tickets
            (user_id, group_id, race_id, race_date, track, race_number, race_name, bet_type, method, selections, amount, memo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          userId,
          groupId,
          g.race_id,
          g.race_date,
          g.track,
          g.race_number,
          g.race_name || null,
          g.bet_type,
          g.method || "normal",
          JSON.stringify(c.selections),
          c.amount,
          g.memo || null
        )
      );
    }

    touchedRaceIds.add(Number(g.race_id));
    results.push({ client_key: g.client_key ?? null, status: "created", group_id: groupId, count: g.combos.length });
  }

  if (statements.length > 0) {
    await runBatchInChunks(env.DB, statements);
  }

  // 2026-08-16に導入した「既に着順・払戻が確定済みのレースへ後から購入した場合、
  // 購入直後に払戻を即時反映する」仕様(docs/DESIGN.md「払戻確定時のticket反映」参照)を、
  // 複数レースをまとめて処理するバルク版(recomputeTicketPayoutsForRaces)で維持する。
  // 既に確定済みのレース(finish_orderまたはpayoutsがあるレース)のみを対象にする
  // (未確定レースを含めても実質何もしないため、対象を絞って無駄な処理を避ける)。
  try {
    const updates = [];
    for (const raceId of touchedRaceIds) {
      const race = raceById.get(raceId);
      if (!race || !(race.finish_order || race.payouts)) continue;
      updates.push({
        raceId,
        finishOrder: race.finish_order ? JSON.parse(race.finish_order) : null,
        payoutsObj: race.payouts ? JSON.parse(race.payouts) : null,
        entries: race.entries ? JSON.parse(race.entries) : [],
      });
    }
    if (updates.length) await recomputeTicketPayoutsForRaces(env.DB, updates);
  } catch (e) {
    // 払戻の即時反映に失敗しても、購入自体(履歴の記録)は既に成功しているため、
    // ここでのエラーは購入処理全体を失敗させない。ログのみ残す。
    console.error("recomputeTicketPayoutsForRaces after cart checkout failed", e);
  }

  return Response.json({ ok: true, results });
}
