// 馬情報マスタ(horsesテーブル)。データ検索画面「馬情報検索」タブ・予想登録画面の馬柱(父母)・重賞検索の出走馬詳細用
// (docs/design/data-search.md「馬情報検索タブ」参照)。
//
// 2026-10-08〜: netkeiba への自動取得をやめた。血統(父/母/母父)・調教師・毛色・所属は、レース管理画面で netkeiba の
// 馬柱(5走)をブックマークレット/貼り付けで取り込んだとき(POST /api/admin/horses/paste-import。
// docs/design/umabashira-paste.md・docs/design/netkeiba-bookmarklet.md)と、管理者の手入力(saveManualHorseInfo)で登録する。
// 以前は馬情報検索で初めて開いた馬について、サーバー(Cloudflare)から netkeiba(db.netkeiba.com)へ取得しに行っていたが
// (getOrFetchHorseMaster・refetchHorseInfoFromNetkeiba。_lib/netkeiba.js)、2026-10-03以降 netkeiba から繰り返し拒否され
// (取得の一時停止の仕組みも設けた)、馬柱の取り込みで全頭分を一度に登録できるようになったため廃止した。
// 調教師は出走馬一覧PDF/結果PDF/結果HTMLの取込の副産物(applyImportedTrainerNames)からも上書きされ得る。
//   - 取込時の調教師の反映は、既にhorses行がある馬だけを対象にする(無ければ新規作成しない)。
//   - data_source=manual(管理者が編集フォームで補正済み)の行は、取込側の調教師反映では上書きしない。
import { horseAliasKeyOf } from "./horse-alias.js";
import { runBatchInChunks } from "./http.js";

export async function getHorseMasterRow(db, horseKey) {
  if (!horseKey) return null;
  return db.prepare("SELECT * FROM horses WHERE horse_key = ?").bind(horseKey).first();
}

// 管理者による手動編集(送られたフィールドだけ上書き。undefinedは既存値を保持)。
export async function saveManualHorseInfo(db, horseName, fields) {
  const horseKey = horseAliasKeyOf(horseName);
  if (!horseKey) return null;
  const now = new Date().toISOString();
  const existing = await getHorseMasterRow(db, horseKey);
  const merged = {
    sire: fields.sire !== undefined ? fields.sire : existing?.sire ?? null,
    dam: fields.dam !== undefined ? fields.dam : existing?.dam ?? null,
    dam_sire: fields.dam_sire !== undefined ? fields.dam_sire : existing?.dam_sire ?? null,
    trainer: fields.trainer !== undefined ? fields.trainer : existing?.trainer ?? null,
    owner: fields.owner !== undefined ? fields.owner : existing?.owner ?? null,
    breeder: fields.breeder !== undefined ? fields.breeder : existing?.breeder ?? null,
  };
  if (existing) {
    await db
      .prepare(
        `UPDATE horses SET sire=?, dam=?, dam_sire=?, trainer=?, owner=?, breeder=?,
                            data_source='manual', fetch_error=NULL, updated_at=?
         WHERE horse_key=?`
      )
      .bind(merged.sire, merged.dam, merged.dam_sire, merged.trainer, merged.owner, merged.breeder, now, horseKey)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO horses (horse_key, horse_name, sire, dam, dam_sire, trainer, owner, breeder,
                              data_source, fetch_error, fetched_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'manual', NULL, NULL, ?)`
      )
      .bind(horseKey, horseName, merged.sire, merged.dam, merged.dam_sire, merged.trainer, merged.owner, merged.breeder, now)
      .run();
  }
  return getHorseMasterRow(db, horseKey);
}

// 出走馬一覧PDF/結果PDF/結果HTMLの取込で調教師名が読み取れた場合の反映(best-effort)。
// entries: [{horse_name, trainer}, ...] (1回の取込リクエストに含まれる全レース・全出走馬)。
// 呼び出し元が渡す配列は「1回の取込PDFに含まれる全レース×出走馬」規模になり得るが、
// 対象は「既にhorses行がある馬」だけ(このIN句は、その中で重複を除いた件数。取込1回に
// 含まれるユニーク馬数は現実的な取込PDFの規模〈1開催4場×12R×最大18頭≒800頭程度〉でも
// 90件を超え得るため、100バインド上限に備えてチャンク分割する)。
export async function applyImportedTrainerNames(db, entries) {
  const byKey = new Map();
  for (const e of entries || []) {
    const name = e?.horse_name;
    const trainer = e?.trainer;
    if (!name || !trainer) continue;
    const key = horseAliasKeyOf(name);
    if (!key) continue;
    byKey.set(key, trainer);
  }
  if (!byKey.size) return;

  const allKeys = [...byKey.keys()];
  try {
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < allKeys.length; i += 90) {
      const keysChunk = allKeys.slice(i, i + 90);
      const placeholders = keysChunk.map(() => "?").join(",");
      const { results } = await db
        .prepare(`SELECT horse_key FROM horses WHERE horse_key IN (${placeholders}) AND data_source <> 'manual'`)
        .bind(...keysChunk)
        .all();
      for (const r of results || []) {
        stmts.push(
          db
            .prepare("UPDATE horses SET trainer=?, data_source='import', fetch_error=NULL, fetched_at=?, updated_at=? WHERE horse_key=?")
            .bind(byKey.get(r.horse_key), now, now, r.horse_key)
        );
      }
    }
    if (stmts.length) await runBatchInChunks(db, stmts);
  } catch (e) {
    // 読み取り高速化キャッシュと同様、外部連携の副産物である本処理の失敗が
    // 取込本体(races/race_results等の保存)に波及してはならない。
    console.error("horses: failed to apply imported trainer names (ignored)", e);
  }
}
