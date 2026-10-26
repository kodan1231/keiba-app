import {
  requireAdmin,
  backfillHorseNamesForRace,
  linkUnregisteredImportsToRace,
  recomputeTicketPayoutsForRaces,
  mergeEntriesByHorseName,
  upsertRaceResultsBulk,
  loadJockeyAliasMap,
  applyJockeyAliasMap,
  loadHorseAliasMap,
  applyHorseAliasMap,
  readJsonBody,
  jsonError,
  raceBaseNameOf,
  changedPairs,
  applyImportedTrainerNames,
  enqueuePaceRecomputeForResults,
  raceCourseTypeOf,
  courseTypeToUpdate,
  addResultRefunds,
} from "../_shared.js";

// 2026-08-30: entries-import.js と同じ理由(Cloudflare Pages Functionsの1リクエスト
// あたりのサブリクエスト数上限に抵触し「一括登録に失敗しました」となる不具合)により、
// レースごとに逐次await(SELECT/INSERT/UPDATE/race_results UPSERT/払戻再計算等)していた
// 実装を、「1回のSELECTでまとめて取得→メモリ上で判定→db.batch()でまとめて書き込む」
// 方式へ書き直した。race_results UPSERT(upsertRaceResultsBulk)・tickets.payout再計算
// (recomputeTicketPayoutsForRaces)はいずれも複数レースをまとめて処理するバルク版を
// functions/api/_shared.js に新設し、そちらを使う(単一レース向けの
// upsertRaceResults()・recomputeTicketPayoutsForRace() は他の呼び出し元
// ([id].js・entries-import.js・tickets/bulk.js)のためにそのまま維持している)。
// 業務ロジック(fill-empty/overwrite/skip-existingの各モード・entries共通マージ・
// 騎手名エイリアス正規化・incident_noteの保護ルール等)自体は変更していない。

const BET_TYPES = ["tan", "fuku", "wakuren", "umaren", "umatan", "wide", "sanrenpuku", "sanrentan"];

function normRaceKey(r) { return `${r.race_date}__${String(r.track || "").trim()}__${Number(r.race_number)}`; }

export async function onRequestPost(context) {
  const deny = requireAdmin(context);
  if (deny) return deny;
  const { request, env } = context;
  const db = env.DB;

  const { data: body, error } = await readJsonBody(request);
  if (error) return error;
  const races = Array.isArray(body?.races) ? body.races : [];
  if (!races.length) return jsonError("インポート対象のレースがありません", 400);

  const aliasMap = await loadJockeyAliasMap(db);
  const horseAliasMap = await loadHorseAliasMap(db);

  const results = [];
  const items = [];

  for (const item of races) {
    if (!item?.race_date || !item?.track || !Number(item?.race_number)) {
      results.push({ status: "invalid", key: normRaceKey(item || {}), message: "開催日・競馬場・レース番号が不足しています" });
      continue;
    }
    const raceNumber = Number(item.race_number);

    const incomingEntries = (Array.isArray(item.entries) ? item.entries : []).map((e) => ({
      horse_name: applyHorseAliasMap(horseAliasMap, e.horse_name),
      waku_number: e.waku_number ?? null,
      horse_number: e.horse_number ?? null,
      jockey: e.jockey ? applyJockeyAliasMap(aliasMap, e.jockey) : null,
      sex_age: e.sex_age || null,
      weight_carried: e.weight_carried ?? null,
    }));
    let finishOrder = Array.isArray(item.finish_order) && item.finish_order.length ? item.finish_order : null;
    const payouts = item.payouts && typeof item.payouts === "object" ? item.payouts : {};
    const raceResultsInput = (Array.isArray(item.race_results) ? item.race_results : []).map((r) => {
      const next = { ...r };
      if (r.horse_name) next.horse_name = applyHorseAliasMap(horseAliasMap, r.horse_name);
      if (r.jockey) next.jockey = applyJockeyAliasMap(aliasMap, r.jockey);
      return next;
    });
    // 出走馬表(entries)の性齢・斤量が空なら、同じ取り込みの各馬の結果(race_results)の値で埋める(2026-10-14)。
    // 読み取り側によって entries に性齢・斤量が入らないことがあり、予想登録画面(entries を表示)に馬齢・斤量が出ない
    // 中央の重賞が続いたため(スワンS・毎日王冠など。race_results には入っていた)。馬番 → 馬名の順で突き合わせる
    fillEntriesFromResults(incomingEntries, raceResultsInput);
    // 着順は各馬の結果から作り直す(2026-10-27): 3着以内に入った馬を、着順 → 馬番の順に全部(同着なら4頭以上になる)。
    // 読み取り側(netkeiba・JRA の4か所)は同じ着順の馬を上書きしており、10/26 大井11R(2着同着 2番・4番)が [9,4,5] になっていた
    const placed = raceResultsInput
      .filter((r) => (r.status || "finished") === "finished" && Number(r.finish_position) >= 1 && Number(r.finish_position) <= 3 && Number(r.horse_number) > 0)
      .sort((a, b) => Number(a.finish_position) - Number(b.finish_position) || Number(a.horse_number) - Number(b.horse_number));
    if (placed.some((r) => Number(r.finish_position) === 1)) finishOrder = placed.map((r) => Number(r.horse_number));
    // 各馬の結果が取消・除外の馬を、払戻の返還の記録に足す(2026-10-23。netkeiba の取り込みは返還の記録を作らないため。_lib/ticket-payout.js)
    const payoutsWithRefunds = addResultRefunds(payouts, raceResultsInput);

    items.push({
      raceDate: item.race_date,
      track: item.track,
      raceNumber,
      key: normRaceKey(item),
      // 芝ダ障は障害レースなら「障害」(2026-10-22。JRA公式は障害を「芝」と書く)。rawCourseType は書き換えの判定用(取り込んだそのままの値)
      item: { ...item, course_type: raceCourseTypeOf(item.course_type, item) },
      rawCourseType: item.course_type || null,
      incomingEntries,
      finishOrder,
      payouts: payoutsWithRefunds,
      raceResultsInput,
    });
  }

  if (!items.length) return Response.json({ ok: true, results });

  // 1) 既存レースをまとめて取得する。
  const uniqueDates = [...new Set(items.map((x) => x.raceDate))];
  const datePlaceholders = uniqueDates.map(() => "?").join(",");
  const { results: existingRaceRows } = await db
    .prepare(`SELECT * FROM races WHERE race_date IN (${datePlaceholders})`)
    .bind(...uniqueDates)
    .all();
  const existingByKey = new Map(
    (existingRaceRows || []).map((r) => [`${r.race_date}__${r.track}__${r.race_number}`, r])
  );

  const toInsert = [];
  const toUpdate = [];

  for (const it of items) {
    const rk = `${it.raceDate}__${it.track}__${it.raceNumber}`;
    const existing = existingByKey.get(rk);

    if (!existing) {
      const { entries } = mergeEntriesByHorseName([], it.incomingEntries);
      toInsert.push({ ...it, entries });
      continue;
    }

    const existingFinish = existing.finish_order ? JSON.parse(existing.finish_order) : null;
    const existingPayouts = existing.payouts ? JSON.parse(existing.payouts) : null;
    const finishDiff = JSON.stringify(existingFinish || null) !== JSON.stringify(it.finishOrder || null);
    const payoutDiff = JSON.stringify(existingPayouts || {}) !== JSON.stringify(it.payouts || {});

    if (body.mode === "skip-existing") {
      results.push({ status: "skipped", id: existing.id, key: it.key, finishDiff, payoutDiff });
      continue;
    }

    let currentEntries = [];
    try { currentEntries = JSON.parse(existing.entries || "[]"); } catch { currentEntries = []; }
    const { entries: mergedEntries } = mergeEntriesByHorseName(currentEntries, it.incomingEntries);

    toUpdate.push({ ...it, existing, existingFinish, existingPayouts, finishDiff, payoutDiff, mergedEntries });
  }

  // 2) 新規レースをまとめてINSERTする。
  if (toInsert.length) {
    const stmts = toInsert.map((it) =>
      db.prepare(
        `INSERT INTO races (race_date, track, race_number, race_name, race_base_name, course_type, distance,
          weight_type, class_flags, course_direction, weather, track_condition, post_time,
          entries, finish_order, payouts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        it.raceDate, it.track, it.raceNumber, it.item.race_name || null, raceBaseNameOf(it.item.race_name),
        it.item.course_type || null,
        it.item.distance ? Number(it.item.distance) : null,
        it.item.weight_type || null, it.item.class_flags || null, it.item.course_direction || null,
        it.item.weather || null, it.item.track_condition || null, it.item.post_time || null,
        JSON.stringify(it.entries),
        it.finishOrder ? JSON.stringify(it.finishOrder) : null,
        Object.keys(it.payouts).length ? JSON.stringify(it.payouts) : null
      )
    );
    const batchResults = await db.batch(stmts);
    batchResults.forEach((res, i) => {
      const id = res.meta.last_row_id;
      toInsert[i].id = id;
      results.push({ status: "created", id, key: toInsert[i].key, race_name: toInsert[i].item.race_name || null });
    });
  }

  // 3) 既存レースをまとめてUPDATEする。各レースごとに、実際にDBへ書き込まれる
  //    finish_order/payoutsの最終値(finalFinishOrder/finalPayoutsObj)も同時に
  //    算出しておき、後段の払戻再計算(recomputeTicketPayoutsForRaces)で
  //    再SELECTせずそのまま使う。
  if (toUpdate.length) {
    const stmts = [];
    for (const it of toUpdate) {
      const fields = [];
      const values = [];
      let finishOrPayoutTouched = false;

      // mode:
      //   "overwrite"   … 取込側に着順/払戻があれば、既存を式別マージせず丸ごと置き換える
      //                   (取込側が空のレースは既存を維持。PDF解析が取れなかった分を消さない)。
      //                   結果PDFインポートのデフォルト。docs/design/results-import.md 参照。
      //   "fill-empty"  … 既存が空のときだけ埋める(旧デフォルト。手動で使い分けたい場合用に残す)。
      //   "skip-existing"… 既存レースには一切触れない(上で continue 済み)。
      const modeOverwrite = body.mode === "overwrite";
      const fromJra = body.source === "jra";

      // 2026-10-16: 列と値の組を作り、今の行と値が違う列だけを更新する(_lib/http.js の changedPairs)。同じ内容の取り込み直しで
      // races の更新が起きると、キャッシュ(レース一覧・集計用)の範囲が消えて作り直しになり、払戻の再計算も走っていたため
      const pairs = [];
      const finishTouch = modeOverwrite ? !!it.finishOrder : !it.existingFinish;
      if (finishTouch) pairs.push(["finish_order", it.finishOrder ? JSON.stringify(it.finishOrder) : null]);
      it.finalFinishOrder = finishTouch ? it.finishOrder : it.existingFinish;

      const payoutTouch = modeOverwrite
        ? Object.keys(it.payouts).length > 0
        : (!it.existingPayouts || Object.keys(it.existingPayouts || {}).length === 0);
      if (payoutTouch) pairs.push(["payouts", Object.keys(it.payouts).length ? JSON.stringify(it.payouts) : null]);
      it.finalPayoutsObj = payoutTouch ? (Object.keys(it.payouts).length ? it.payouts : null) : it.existingPayouts;

      pairs.push(["entries", JSON.stringify(it.mergedEntries)]);
      // レース名・コース・距離・重量種別・条件・コースの向き: JRA公式(body.source === "jra"。PCのブックマークレット・スマホのスクリプト)の
      // 取り込みは値が違えば上書きし、それ以外(netkeiba)は今の値が空のときだけ埋める(2026-10-16。ユーザー確認済み。以前はどれも空のときだけで、
      // 最初に間違った値が入ると JRA公式を取り込んでも直らなかった)。手で直した値も JRA公式の取り込みで公式の値に戻る
      const takeRaceInfo = (col, v) => v && (fromJra || !it.existing[col]);
      if (takeRaceInfo("race_name", it.item.race_name)) {
        pairs.push(["race_name", it.item.race_name], ["race_base_name", raceBaseNameOf(it.item.race_name)]);
      }
      // 芝ダ障: 障害レースなのに障害以外で保存されている行は、取り込み元によらず障害に直す(2026-10-22)
      const courseType = courseTypeToUpdate(it.rawCourseType,
        { race_name: it.item.race_name || it.existing.race_name, class_flags: it.item.class_flags || it.existing.class_flags },
        it.existing, (v) => takeRaceInfo("course_type", v));
      if (courseType) pairs.push(["course_type", courseType]);
      if (takeRaceInfo("distance", it.item.distance)) pairs.push(["distance", Number(it.item.distance)]);
      if (takeRaceInfo("weight_type", it.item.weight_type)) pairs.push(["weight_type", it.item.weight_type]);
      if (takeRaceInfo("class_flags", it.item.class_flags)) pairs.push(["class_flags", it.item.class_flags]);
      if (takeRaceInfo("course_direction", it.item.course_direction)) pairs.push(["course_direction", it.item.course_direction]);
      if (it.item.weather) pairs.push(["weather", it.item.weather]);
      if (it.item.track_condition) pairs.push(["track_condition", it.item.track_condition]);
      if (it.item.post_time) pairs.push(["post_time", it.item.post_time]);

      const changed = changedPairs(it.existing, pairs);
      for (const [col, val] of changed) { fields.push(`${col} = ?`); values.push(val); }
      // 払戻の再計算は着順・払戻が実際に変わったときだけ
      finishOrPayoutTouched = changed.some(([col]) => col === "finish_order" || col === "payouts");

      it.id = it.existing.id;
      it.finishOrPayoutTouched = finishOrPayoutTouched;
      it.fieldsCount = fields.length;

      if (!fields.length) continue; // 何も変わっていなければ更新しない(トリガーも動かない)
      values.push(it.existing.id);
      stmts.push(db.prepare(`UPDATE races SET ${fields.join(", ")} WHERE id = ?`).bind(...values));
    }
    if (stmts.length) await db.batch(stmts);

    toUpdate.forEach((it) => {
      results.push({
        status: it.fieldsCount ? "updated" : "unchanged",
        id: it.id,
        key: it.key,
        finishDiff: it.finishDiff,
        payoutDiff: it.payoutDiff,
      });
    });
  }

  const allProcessed = [...toInsert, ...toUpdate];

  // 4) 未登録レースへのCSV取込データの紐付けをまとめて行う。
  {
    const { results: pendingGroups } = await db
      .prepare(
        `SELECT id, race_date, track, race_number FROM imported_ticket_groups
         WHERE race_id IS NULL AND race_date IN (${datePlaceholders})`
      )
      .bind(...uniqueDates)
      .all();

    const raceIdByKey = new Map(allProcessed.map((it) => [`${it.raceDate}__${it.track}__${it.raceNumber}`, it.id]));
    const groupIdsByRaceId = new Map();
    for (const g of pendingGroups || []) {
      const rid = raceIdByKey.get(`${g.race_date}__${g.track}__${Number(g.race_number)}`);
      if (!rid) continue;
      if (!groupIdsByRaceId.has(rid)) groupIdsByRaceId.set(rid, []);
      groupIdsByRaceId.get(rid).push(g.id);
    }

    if (groupIdsByRaceId.size) {
      const stmts = [];
      for (const [rid, groupIds] of groupIdsByRaceId) {
        const placeholders = groupIds.map(() => "?").join(",");
        stmts.push(
          db.prepare(`UPDATE imported_ticket_groups SET race_id = ? WHERE id IN (${placeholders})`).bind(rid, ...groupIds)
        );
        stmts.push(
          db.prepare(`UPDATE imported_ticket_items SET race_id = ? WHERE group_id IN (${placeholders})`).bind(rid, ...groupIds)
        );
      }
      if (stmts.length) await db.batch(stmts);
    }
  }

  // 5) 馬名・騎手のバックフィルをまとめて行う。
  const raceIdsNeedingBackfill = allProcessed
    .filter((it) => (it.entries || it.mergedEntries || []).some((e) => e.horse_number !== null && e.horse_number !== undefined))
    .map((it) => it.id);

  if (raceIdsNeedingBackfill.length) {
    const nameByRaceId = new Map();
    for (const it of allProcessed) {
      const entries = it.entries || it.mergedEntries || [];
      const m = new Map();
      for (const e of entries) {
        const hn = Number(e.horse_number);
        if (!Number.isInteger(hn)) continue;
        const horse_name = e.horse_name ? String(e.horse_name).trim() : "";
        const jockey = e.jockey ? String(e.jockey).trim() : "";
        if (!horse_name && !jockey) continue;
        m.set(hn, { horse_name: horse_name || null, jockey: jockey || null });
      }
      if (m.size) nameByRaceId.set(it.id, m);
    }

    const idPlaceholders = raceIdsNeedingBackfill.map(() => "?").join(",");
    for (const table of ["imported_ticket_items", "tickets"]) {
      const { results: rows } = await db
        .prepare(`SELECT id, race_id, selections FROM ${table} WHERE race_id IN (${idPlaceholders})`)
        .bind(...raceIdsNeedingBackfill)
        .all();

      const stmts = [];
      for (const row of rows || []) {
        const nameMap = nameByRaceId.get(row.race_id);
        if (!nameMap) continue;
        let selections;
        try { selections = JSON.parse(row.selections || "[]"); } catch { continue; }
        if (!Array.isArray(selections) || !selections.length) continue;

        let changed = false;
        const next = selections.map((s) => {
          const info = nameMap.get(Number(s?.horse_number));
          if (!info) return s;
          const merged = { ...s };
          if (info.horse_name && merged.horse_name !== info.horse_name) { merged.horse_name = info.horse_name; changed = true; }
          if (info.jockey && merged.jockey !== info.jockey) { merged.jockey = info.jockey; changed = true; }
          return merged;
        });

        if (changed) {
          stmts.push(db.prepare(`UPDATE ${table} SET selections = ? WHERE id = ?`).bind(JSON.stringify(next), row.id));
        }
      }
      if (stmts.length) await db.batch(stmts);
    }
  }

  // 6) race_results(全着順・タイム等の詳細記録)をまとめてUPSERTする。
  const raceResultsList = allProcessed
    .filter((it) => it.raceResultsInput && it.raceResultsInput.length)
    .map((it) => ({ raceId: it.id, records: it.raceResultsInput }));
  if (raceResultsList.length) {
    await upsertRaceResultsBulk(db, raceResultsList);
  }

  // 7) 着順・払戻が確定/更新されたレース分の tickets.payout をまとめて再計算する。
  //    新規作成レースはfinish_order/payoutsのいずれかがあれば対象、既存レースは
  //    finishOrPayoutTouchedがtrueのものだけを対象にする。既存レースについては
  //    ステップ3で算出済みの finalFinishOrder/finalPayoutsObj(実際にDBへ書き込まれた
  //    値と同じ)をそのまま使い、UPDATE直後の再SELECTは行わない。
  const recomputeUpdates = [];
  for (const it of toInsert) {
    if (it.finishOrder || Object.keys(it.payouts).length) {
      recomputeUpdates.push({
        raceId: it.id,
        finishOrder: it.finishOrder || null,
        payoutsObj: Object.keys(it.payouts).length ? it.payouts : null,
        entries: it.entries,
      });
    }
  }
  for (const it of toUpdate) {
    if (it.finishOrPayoutTouched) {
      recomputeUpdates.push({
        raceId: it.id,
        finishOrder: it.finalFinishOrder || null,
        payoutsObj: (it.finalPayoutsObj && Object.keys(it.finalPayoutsObj).length) ? it.finalPayoutsObj : null,
        entries: it.mergedEntries,
      });
    }
  }
  if (recomputeUpdates.length) {
    await recomputeTicketPayoutsForRaces(db, recomputeUpdates);
  }

  // 7b) 着順・払戻が入った・変わったレースのコースと重賞を、総合推奨馬の比率の計算待ちに積む(2026-10-18。比率の元になる結果が増えたため。
  //     その夜の GitHub Actions が計算する。_lib/pace-queue.js)。コース等は取り込んだ値、無ければ今の行の値
  const resultRaces = [
    ...toInsert.filter((it) => it.finishOrder || Object.keys(it.payouts).length).map((it) => ({
      id: it.id, track: it.track, course_type: it.item.course_type, distance: it.item.distance, race_name: it.item.race_name, class_flags: it.item.class_flags,
    })),
    ...toUpdate.filter((it) => it.finishOrPayoutTouched).map((it) => {
      const pick = (k) => it.item[k] || it.existing[k] || null;
      return { id: it.id, track: it.existing.track, course_type: raceCourseTypeOf(pick("course_type"), { race_name: pick("race_name"), class_flags: pick("class_flags") }), distance: pick("distance"), race_name: pick("race_name"), class_flags: pick("class_flags") };
    }),
  ];
  if (resultRaces.length) await enqueuePaceRecomputeForResults(db, resultRaces);

  // 8) 馬情報マスタ(horses)の調教師欄への反映(best-effort。docs/design/data-search.md
  //    「馬情報検索タブ」参照)。raceResultsInputは各行が{horse_name, trainer, ...}を
  //    持つ(結果PDF/結果HTMLが調教師名を読み取れた場合のみ)。既にhorses行がある馬だけを
  //    対象にする(内部でIN句をチャンク分割している)。
  await applyImportedTrainerNames(db, items.flatMap((it) => it.raceResultsInput));

  return Response.json({ ok: true, results });
}
// entries の性齢・斤量が空の馬に、race_results(同じレースの取り込み分)の値を入れる。entries・results は同じレースの配列
function fillEntriesFromResults(entries, results) {
  if (!entries.length || !results.length) return;
  const nameKey = (v) => String(v ?? "").replace(/[　\s]+/g, "");
  const byNumber = new Map(), byName = new Map();
  for (const r of results) {
    if (Number.isInteger(Number(r.horse_number)) && r.horse_number !== null) byNumber.set(Number(r.horse_number), r);
    if (r.horse_name) byName.set(nameKey(r.horse_name), r);
  }
  for (const e of entries) {
    const r = (e.horse_number !== null && byNumber.get(Number(e.horse_number))) || byName.get(nameKey(e.horse_name));
    if (!r) continue;
    if (!e.sex_age && r.sex_age) e.sex_age = r.sex_age;
    const w = Number(r.weight_carried);
    if ((e.weight_carried === null || e.weight_carried === undefined) && r.weight_carried != null && Number.isFinite(w) && w > 0) e.weight_carried = w;
  }
}
