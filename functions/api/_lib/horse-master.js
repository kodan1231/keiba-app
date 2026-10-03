// 馬情報マスタ(horsesテーブル)。データ検索画面「馬情報検索」タブ用
// (docs/design/data-search.md「馬情報検索タブ」参照)。
//
// 血統(父/母/母父)・馬主・生産牧場はnetkeiba(_lib/netkeiba.js)から取得してキャッシュする。
// 調教師は同じくnetkeiba経由に加え、2026-09-28以降に取り込む出走馬一覧PDF/結果PDF/結果HTMLの
// 副産物(applyImportedTrainerNames)からも上書きされ得る。
//
// 「オンデマンドキャッシュ」の設計:
//   - 検索されて初めて(=horsesに行が無い馬について)netkeiba取得を試みる。
//     成功・失敗いずれの場合も行を作る(fetch_errorに理由を残す)ことで、以後は
//     管理者の明示的な「netkeibaから再取得」操作が無い限り、同じ馬への自動取得は
//     二度と行わない(検索のたびにnetkeibaへ問い合わせるのを防ぐ)。
//   - 出走馬一覧PDF等の取込時のtrainer反映(applyImportedTrainerNames)は、既にhorses行が
//     ある馬だけを対象にする(無ければ新規作成しない)。取込のたびに全出走馬ぶんの行を
//     先回りで作ると、検索されたことのない馬まで肥大化するため。
//   - data_source='manual'(管理者が編集フォームで補正済み)の行は、netkeiba再取得
//     以外では上書きしない(取込側のtrainer反映もスキップする)。
//   - netkeiba から取得を拒否されたら、管理画面で設定した時間(既定6時間)は問い合わせない
//     (2026-10-04追加。下記「netkeiba への取得の一時停止」)。
import { horseAliasKeyOf } from "./horse-alias.js";
import { runBatchInChunks } from "./http.js";
import { fetchNetkeibaHorseInfo } from "./netkeiba.js";

export async function getHorseMasterRow(db, horseKey) {
  if (!horseKey) return null;
  return db.prepare("SELECT * FROM horses WHERE horse_key = ?").bind(horseKey).first();
}

// ---- netkeiba への取得の一時停止(2026-10-04追加) ----
// netkeiba から取得を拒否された(HTTP 400 等)ら、一定時間は netkeiba へ問い合わせない。
// 制限中に問い合わせを重ねて解除を遅らせないため(2026-10-03〜04に、短時間の
// 連続取得の後で数時間単位の拒否が2回発生した。docs/design/data-search.md「netkeiba連携」)。
// 止める時間は管理画面で設定する(external_fetch_pause.pause_hours。未設定なら既定値)。
// 状態は external_fetch_pause テーブル(service='netkeiba' の1行)に持つ。テーブルが無い
// (マイグレーション未適用)・読み書きに失敗した場合は「止めない」扱いにして、取得自体は従来どおり
// 動くようにする(読み書きとも best-effort)。
export const NETKEIBA_PAUSE_HOURS_DEFAULT = 6;
export const NETKEIBA_PAUSE_HOURS_MIN = 1;
export const NETKEIBA_PAUSE_HOURS_MAX = 72;
const NETKEIBA_SERVICE = "netkeiba";

// 管理画面用: 設定(止める時間)と現在の停止状態。テーブルが無い場合は tableMissing: true。
export async function getNetkeibaPauseSettings(db) {
  try {
    const row = await db
      .prepare("SELECT pause_hours, paused_until, reason, updated_at FROM external_fetch_pause WHERE service = ?")
      .bind(NETKEIBA_SERVICE)
      .first();
    const until = row && row.paused_until;
    return {
      tableMissing: false,
      pauseHours: Number.isInteger(row?.pause_hours) ? row.pause_hours : NETKEIBA_PAUSE_HOURS_DEFAULT,
      pauseHoursIsDefault: !Number.isInteger(row?.pause_hours),
      pausedUntil: until && new Date(until).getTime() > Date.now() ? until : null,
      lastReason: row?.reason || null,
    };
  } catch (e) {
    return { tableMissing: true, pauseHours: NETKEIBA_PAUSE_HOURS_DEFAULT, pauseHoursIsDefault: true, pausedUntil: null, lastReason: null };
  }
}

// 管理画面用: 止める時間を保存する(停止期限・理由は変えない)。範囲外は呼び出し元で弾く。
export async function setNetkeibaPauseHours(db, hours) {
  await db
    .prepare(
      `INSERT INTO external_fetch_pause (service, pause_hours, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET pause_hours=excluded.pause_hours, updated_at=excluded.updated_at`
    )
    .bind(NETKEIBA_SERVICE, hours, new Date().toISOString())
    .run();
}

// 拒否・制限とみなす取得失敗コード(_lib/netkeiba.js の fetchNetkeibaHorseInfo の error/partialError)。
// not_found(該当馬なし)・encoding_unsupported(馬名が検索不可)は相手の制限とは無関係なので含めない。
function isNetkeibaBlockError(code) {
  return /^http_\d+$/.test(code || "") || /^pedigree_http_\d+$/.test(code || "") || code === "unexpected_page";
}

// 停止中なら停止期限(ISO文字列)、停止していなければ null。
export async function getNetkeibaPausedUntil(db) {
  try {
    const row = await db
      .prepare("SELECT paused_until FROM external_fetch_pause WHERE service = ?")
      .bind(NETKEIBA_SERVICE)
      .first();
    if (row && row.paused_until && new Date(row.paused_until).getTime() > Date.now()) return row.paused_until;
  } catch (e) {
    console.error("external_fetch_pause: read failed (ignored)", e);
  }
  return null;
}

// 停止期限を今から設定時間(pause_hours。未設定なら既定値)後に設定し、その期限を返す。保存に失敗した
// (テーブル未作成等)場合は実際には止まらないため null を返す(画面に「見合わせ中」と出さない)。
// 止める時間の列(pause_hours)は上書きしない。
async function pauseNetkeiba(db, reason) {
  try {
    const { pauseHours } = await getNetkeibaPauseSettings(db);
    const until = new Date(Date.now() + pauseHours * 3600 * 1000).toISOString();
    await db
      .prepare(
        `INSERT INTO external_fetch_pause (service, paused_until, reason, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(service) DO UPDATE SET paused_until=excluded.paused_until,
           reason=excluded.reason, updated_at=excluded.updated_at`
      )
      .bind(NETKEIBA_SERVICE, until, reason || null, new Date().toISOString())
      .run();
    return until;
  } catch (e) {
    console.error("external_fetch_pause: write failed (ignored)", e);
    return null;
  }
}

// 取得結果が拒否・制限なら停止を始め、その期限を返す(該当しなければ null)。
async function pauseIfBlocked(db, result) {
  const code = result.ok ? result.partialError : result.error;
  return isNetkeibaBlockError(code) ? pauseNetkeiba(db, code) : null;
}

// 無ければnetkeiba取得を試みて保存し、その結果(既存行 or 新規作成した行)を返す。
// expectedBirthYear: 呼び出し元(自アプリの出走履歴)から推定できる場合に渡す
// (同名馬が複数存在するケースの絞り込みヒント。無くても動く)。
// netkeiba への取得を停止中なら問い合わせず、行も作らずに fetch_error='paused' の仮の行を返す
// (問い合わせていないので失敗として記録しない。停止が明けた後にこの馬が開かれれば自動で取得される)。
export async function getOrFetchHorseMaster(db, horseName, { expectedBirthYear } = {}) {
  const horseKey = horseAliasKeyOf(horseName);
  if (!horseKey) return null;

  const existing = await getHorseMasterRow(db, horseKey);
  if (existing) return existing;

  const pausedUntil = await getNetkeibaPausedUntil(db);
  if (pausedUntil) {
    return {
      horse_key: horseKey, horse_name: horseName,
      sire: null, dam: null, dam_sire: null, trainer: null, owner: null, breeder: null,
      data_source: null, fetch_error: "paused", fetched_at: null, paused_until: pausedUntil,
    };
  }

  const result = await fetchNetkeibaHorseInfo(horseName, { expectedBirthYear }).catch(() => ({
    ok: false,
    error: "unexpected_error",
  }));
  const pausedUntilNow = await pauseIfBlocked(db, result);
  const now = new Date().toISOString();
  const row = {
    horse_key: horseKey,
    horse_name: horseName,
    sire: result.ok ? result.sire : null,
    dam: result.ok ? result.dam : null,
    dam_sire: result.ok ? result.damSire : null,
    trainer: result.ok ? result.trainer : null,
    owner: result.ok ? result.owner : null,
    breeder: result.ok ? result.breeder : null,
    netkeiba_horse_id: result.ok ? result.netkeibaHorseId : null,
    data_source: "netkeiba",
    fetch_error: result.ok ? result.partialError || null : result.error,
    fetched_at: now,
    updated_at: now,
  };
  // 保存はbest-effort(取得自体は成功しているので、保存に失敗してもこの行を
  // そのまま呼び出し元へ返す。CLAUDE.md「キャッシュ書き込みはbest-effort」と同じ考え方。
  // ここは読み取り高速化キャッシュではなく外部取得結果の永続化だが、保存失敗時に
  // 応答自体を失敗させない方針は共通する)。
  try {
    await db
      .prepare(
        `INSERT INTO horses (horse_key, horse_name, sire, dam, dam_sire, trainer, owner, breeder,
                              netkeiba_horse_id, data_source, fetch_error, fetched_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        row.horse_key, row.horse_name, row.sire, row.dam, row.dam_sire, row.trainer, row.owner,
        row.breeder, row.netkeiba_horse_id, row.data_source, row.fetch_error, row.fetched_at, row.updated_at
      )
      .run();
  } catch (e) {
    console.error("horses: failed to persist fetched info (ignored)", e);
  }
  // fetched_now: この呼び出しでnetkeibaへ取得を試みた行であることの目印(DBには保存しない)。
  // 画面で「今回の取得結果」と「以前の取得結果をそのまま表示」を区別するため(2026-10-03)。
  return { ...row, fetched_now: true, paused_until: pausedUntilNow };
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

// 管理者による明示的な「netkeibaから再取得」。既存の内容(手動編集済みでも)を問答無用で
// 上書きする(この操作自体が管理者の明示的な意思表示のため)。
// netkeiba への取得を停止中は問い合わせず、既存の行を変更しないまま
// { ...既存行, refetch_paused: true, paused_until } を返す(呼び出し元が「見合わせ中」を表示する)。
export async function refetchHorseInfoFromNetkeiba(db, horseName, { expectedBirthYear } = {}) {
  const horseKey = horseAliasKeyOf(horseName);
  if (!horseKey) return null;
  const pausedUntil = await getNetkeibaPausedUntil(db);
  if (pausedUntil) {
    const current = await getHorseMasterRow(db, horseKey);
    return { ...(current || { horse_key: horseKey, horse_name: horseName }), refetch_paused: true, paused_until: pausedUntil };
  }
  const result = await fetchNetkeibaHorseInfo(horseName, { expectedBirthYear }).catch(() => ({
    ok: false,
    error: "unexpected_error",
  }));
  const pausedUntilNow = await pauseIfBlocked(db, result);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO horses (horse_key, horse_name, sire, dam, dam_sire, trainer, owner, breeder,
                            netkeiba_horse_id, data_source, fetch_error, fetched_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(horse_key) DO UPDATE SET
         horse_name=excluded.horse_name, sire=excluded.sire, dam=excluded.dam, dam_sire=excluded.dam_sire,
         trainer=excluded.trainer, owner=excluded.owner, breeder=excluded.breeder,
         netkeiba_horse_id=excluded.netkeiba_horse_id, data_source=excluded.data_source,
         fetch_error=excluded.fetch_error, fetched_at=excluded.fetched_at, updated_at=excluded.updated_at`
    )
    .bind(
      horseKey,
      horseName,
      result.ok ? result.sire : null,
      result.ok ? result.dam : null,
      result.ok ? result.damSire : null,
      result.ok ? result.trainer : null,
      result.ok ? result.owner : null,
      result.ok ? result.breeder : null,
      result.ok ? result.netkeibaHorseId : null,
      "netkeiba",
      result.ok ? result.partialError || null : result.error,
      now,
      now
    )
    .run();
  const saved = await getHorseMasterRow(db, horseKey);
  return saved ? { ...saved, fetched_now: true, paused_until: pausedUntilNow } : null; // 再取得はこの呼び出しで取得を試みた(fetched_now)
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
