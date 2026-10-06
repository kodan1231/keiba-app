import {
  requireAdmin,
  readJsonBody,
  jsonError,
  loadHorseAliasMap,
  applyHorseAliasMap,
  horseAliasKeyOf,
  loadTrainerAliasMap,
  resolveTrainerAlias,
  trainerAliasKeyOf,
} from "../../_shared.js";

// 管理者向け: netkeiba馬柱テキストの貼り付けから読み取った血統等を、馬情報マスタ(horses)へ反映する。
// 2026-10-06追加。仕様は docs/design/umabashira-paste.md。
// アプリから netkeiba へは問い合わせない(利用者が貼り付けた内容だけを使う)。
//
// POST { action: "preview" | "apply", horses: [...], choices?: {...} }
//   horses[]: { horse_name, sire, dam, dam_sire, trainer_abbr, affiliation, coat_color }
//   choices : { <horse_name>: { sire|dam|dam_sire: "pasted" | "existing" } }(apply のみ。不一致項目の選択)

const MAX_HORSES = 18; // 1レースの出走頭数の上限。horse_key IN (...) のバインド数もこれで収まる
const PEDIGREE_FIELDS = ["sire", "dam", "dam_sire"]; // 不一致を比較・選択する項目
const FILL_ONLY_FIELDS = ["trainer", "coat_color", "affiliation"]; // 空欄のときだけ埋める項目

const clean = (v) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : null;
};
// 比較用の正規化(NFKC・全空白除去)
const cmpKey = (v) => String(v ?? "").normalize("NFKC").replace(/[　\s]+/g, "");

// 調教師の略称から候補(保存済みの調教師名)を探す。前方一致、または
// 「略称の最後の1文字を除いた部分で始まり、最後の1文字で終わる」(例: 手塚久 → 手塚貴久)。
function trainerCandidates(abbr, knownTrainers) {
  const a = cmpKey(abbr);
  if (!a) return [];
  const head = a.slice(0, -1);
  const tail = a.slice(-1);
  const out = [];
  for (const t of knownTrainers) {
    const k = cmpKey(t);
    if (!k || k === a) continue;
    if (k.startsWith(a) || (a.length >= 3 && k.startsWith(head) && k.endsWith(tail))) out.push(t);
  }
  return [...new Set(out)].slice(0, 5);
}

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;

  const { request, env } = context;
  const db = env.DB;
  const { data: body, error } = await readJsonBody(request);
  if (error) return error;

  const action = body?.action;
  if (action !== "preview" && action !== "apply") return jsonError("action が不正です", 400);
  const input = Array.isArray(body?.horses) ? body.horses : null;
  if (!input || !input.length) return jsonError("馬の情報がありません", 400);
  if (input.length > MAX_HORSES) return jsonError(`一度に取り込めるのは${MAX_HORSES}頭までです`, 400);
  const choices = body?.choices && typeof body.choices === "object" ? body.choices : {};

  const [horseAliasMap, trainerAliasMap] = await Promise.all([loadHorseAliasMap(db), loadTrainerAliasMap(db)]);

  // 貼り付け側の値を整える(馬名は馬名エイリアスで正しい表記へ、調教師はエイリアスで変換)
  const items = [];
  for (const h of input) {
    const rawName = clean(h?.horse_name);
    if (!rawName) continue;
    const name = applyHorseAliasMap(horseAliasMap, rawName) || rawName;
    const key = horseAliasKeyOf(name);
    if (!key) continue;
    const trainerAbbr = clean(h.trainer_abbr);
    const trainerResolved = trainerAbbr ? resolveTrainerAlias(trainerAliasMap, trainerAbbr) : null;
    items.push({
      input_name: rawName,
      horse_name: name,
      key,
      trainer_abbr: trainerAbbr,
      trainer_resolved: trainerResolved,
      pasted: {
        sire: clean(h.sire),
        dam: clean(h.dam),
        dam_sire: clean(h.dam_sire),
        trainer: trainerResolved || trainerAbbr,
        coat_color: clean(h.coat_color),
        affiliation: clean(h.affiliation),
      },
    });
  }
  if (!items.length) return jsonError("馬名が読み取れませんでした", 400);

  // 既存の行(最大18件)をまとめて読む
  const keys = [...new Set(items.map((i) => i.key))];
  const { results: rows } = await db
    .prepare(
      `SELECT horse_key, horse_name, sire, dam, dam_sire, trainer, coat_color, affiliation, data_source, fetch_error
         FROM horses WHERE horse_key IN (${keys.map(() => "?").join(",")})`
    )
    .bind(...keys)
    .all();
  const existingByKey = new Map((rows || []).map((r) => [r.horse_key, r]));

  // 未登録の調教師略称の候補用に、保存済みの調教師名を集める(horses はオンデマンドで小さいため全件で足りる)
  let knownTrainers = [];
  if (items.some((i) => i.trainer_abbr && !i.trainer_resolved)) {
    const { results: tr } = await db.prepare("SELECT DISTINCT trainer FROM horses WHERE trainer IS NOT NULL").all();
    knownTrainers = (tr || []).map((r) => r.trainer).filter(Boolean);
  }

  const now = new Date().toISOString();
  const out = [];
  const statements = [];
  for (const it of items) {
    const ex = existingByKey.get(it.key) || null;
    const isManual = ex && ex.data_source === "manual";
    const next = {};
    const conflicts = [];
    const manualDiffs = [];
    let changed = false;

    for (const f of PEDIGREE_FIELDS) {
      const pv = it.pasted[f];
      const ev = ex ? clean(ex[f]) : null;
      if (!pv) { next[f] = ev; continue; }
      if (!ev) { next[f] = pv; changed = true; continue; }
      if (cmpKey(ev) === cmpKey(pv)) { next[f] = ev; continue; }
      if (isManual) { next[f] = ev; manualDiffs.push(f); continue; }
      conflicts.push(f);
      const choice = choices[it.input_name]?.[f] || choices[it.horse_name]?.[f];
      if (choice === "pasted") { next[f] = pv; changed = true; } else { next[f] = ev; }
    }
    for (const f of FILL_ONLY_FIELDS) {
      const pv = it.pasted[f];
      const ev = ex ? clean(ex[f]) : null;
      if (!ev && pv) { next[f] = pv; changed = true; } else { next[f] = ev; }
    }

    let status;
    if (!ex) status = "new";
    else if (conflicts.length) status = "conflict";
    else if (manualDiffs.length) status = "manual";
    else if (changed) status = "fill";
    else status = "same";

    const result = {
      horse_name: it.horse_name,
      input_name: it.input_name,
      status,
      existing: ex
        ? {
            sire: ex.sire || null, dam: ex.dam || null, dam_sire: ex.dam_sire || null,
            trainer: ex.trainer || null, coat_color: ex.coat_color || null, affiliation: ex.affiliation || null,
            data_source: ex.data_source || null,
          }
        : null,
      pasted: it.pasted,
      conflicts,
      manual_diffs: manualDiffs,
      trainer: {
        abbr: it.trainer_abbr,
        resolved: it.trainer_resolved,
        candidates: it.trainer_abbr && !it.trainer_resolved ? trainerCandidates(it.trainer_abbr, knownTrainers) : [],
      },
    };

    if (action === "apply") {
      if (!ex) {
        statements.push(
          db.prepare(
            `INSERT INTO horses (horse_key, horse_name, sire, dam, dam_sire, trainer, coat_color, affiliation,
                                 data_source, fetch_error, fetched_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?, 'paste', NULL, ?, ?)`
          ).bind(it.key, it.horse_name, next.sire, next.dam, next.dam_sire, next.trainer, next.coat_color, next.affiliation, now, now)
        );
        result.applied = "inserted";
      } else if (changed) {
        // 元々どの値も無かった(取得失敗の)行は出どころを 'paste' にする。値を埋めたら失敗の記録は消す。
        const wasEmpty = !PEDIGREE_FIELDS.some((f) => clean(ex[f])) && !clean(ex.trainer);
        const dataSource = isManual ? "manual" : wasEmpty ? "paste" : ex.data_source;
        statements.push(
          db.prepare(
            `UPDATE horses SET sire=?, dam=?, dam_sire=?, trainer=?, coat_color=?, affiliation=?,
                               data_source=?, fetch_error=NULL, updated_at=? WHERE horse_key=?`
          ).bind(next.sire, next.dam, next.dam_sire, next.trainer, next.coat_color, next.affiliation, dataSource, now, it.key)
        );
        result.applied = "updated";
      } else {
        result.applied = "unchanged";
      }
    }
    out.push(result);
  }

  if (action === "apply" && statements.length) {
    // 最大18文(1レースの出走頭数)のため1回の batch で足りる
    await db.batch(statements);
  }

  return Response.json({ ok: true, action, horses: out });
}
