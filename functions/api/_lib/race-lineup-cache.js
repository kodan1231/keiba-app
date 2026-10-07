// 集計用の小さいキャッシュ(race_lineup_cache。2026-10-07追加)。
// データ検索画面のレース成績タブ・騎手検索タブ向けに、各レースの「日付・競馬場・コース種別・
// 距離・単勝の値・馬連の値・出走した各馬の[馬番, 騎手, 着順]」だけを詰めて持つ。
// 仕様・経緯は docs/design/data-search.md「集計用の小さいキャッシュ」。
//
// 背景: 以前は races_cache(約10MB)と race_stats_cache(約3.8MB)を丸ごと解析して集計しており、
// 2026-10-07に Cloudflare Workers のCPU時間上限超過(exceededResources)で失敗するようになった。
//
// 保存形式(1行=1チャンク。races_cache と同じく CHUNK_MAX_BYTES を超えたら次の行):
//   { "j": [騎手名, ...],   // このチャンク内の騎手名の辞書
//     "r": [[id, race_date, track, course_type, distance, tan, umaren, lineup], ...] }
//   lineup: 出走した馬だけを [馬番(0=不明), 騎手の辞書番号(-1=騎手不明), 着順(1〜3、着外0)] を平らに並べた配列。
//           着順データが取れないレースは null。
//
// 作り直しは races_cache / race_stats_cache を使わず、DB から必要な列だけを読む(重いJSON解析をしない)。
// 作り直しが重いと「CPU時間切れで保存前に打ち切られ、毎回作り直す」を繰り返す恐れがあるため
// (2026-09-12 の races_cache 障害と同じ構図を避ける)。保存の失敗は握りつぶす(best-effort)。
// 無効化は DB トリガー(@STEP: race_lineup_cache)。

const CHUNK_MAX_BYTES = 1_500_000;
const RIDDEN_STATUSES = new Set(["finished", "stopped"]);
const FIELD_SEP = "\u001f"; // group_concat の項目区切り(馬名等に出てこない制御文字)
const ROW_SEP = "\u001e"; // group_concat の馬ごとの区切り

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// キャッシュを読み、レースの配列を返す。
// 各要素: { id, race_date, track, course_type, distance, tan, umaren,
//           lineup: [[horse_number, jockey, pos], ...] | null }
//   lineup は出走した馬だけ。pos は 1/2/3(3着以内)または null(着外)。
export async function getRaceLineups(db) {
  let rows = null;
  try {
    const { results } = await db.prepare("SELECT payload FROM race_lineup_cache ORDER BY chunk_index").all();
    rows = results;
  } catch (e) {
    // テーブルが無い(マイグレーション未適用)等。作り直した結果をそのまま使う(保存も失敗する)。
    console.error("race_lineup_cache: read failed (ignored)", e);
  }
  if (rows && rows.length) {
    try {
      const out = [];
      for (const r of rows) {
        if (!r.payload) throw new Error("race_lineup_cache: empty chunk");
        const { j, r: races } = JSON.parse(r.payload);
        for (const x of races) out.push(expandRace(x, j));
      }
      return out;
    } catch {
      // 壊れていた場合は作り直す
    }
  }
  return recomputeRaceLineupCache(db);
}

function expandRace(x, dict) {
  const [id, race_date, track, course_type, distance, tan, umaren, flat] = x;
  let lineup = null;
  if (Array.isArray(flat)) {
    lineup = [];
    for (let i = 0; i < flat.length; i += 3) {
      const ji = flat[i + 1];
      lineup.push([flat[i] || null, ji >= 0 ? dict[ji] : null, flat[i + 2] || null]);
    }
  }
  return { id, race_date, track, course_type, distance, tan, umaren, lineup };
}

export async function recomputeRaceLineupCache(db) {
  // races: 必要な列だけ。entries 本体は読まず頭数だけ(不正なJSONでSQLが失敗しないよう json_valid で守る)
  // 単勝・馬連の値(同着は平均。rate > 0 のものだけ)もSQL側で計算する(JSの解析を減らすため)。
  const { results: raceRows } = await db.prepare(
    `SELECT id, race_date, track, course_type, distance, finish_order,
            CASE WHEN json_valid(payouts) AND json_type(payouts, '$.tan') = 'array' THEN
              (SELECT AVG(CAST(json_extract(value, '$.rate') AS REAL)) FROM json_each(payouts, '$.tan')
                WHERE CAST(json_extract(value, '$.rate') AS REAL) > 0) END AS tan,
            CASE WHEN json_valid(payouts) AND json_type(payouts, '$.umaren') = 'array' THEN
              (SELECT AVG(CAST(json_extract(value, '$.rate') AS REAL)) FROM json_each(payouts, '$.umaren')
                WHERE CAST(json_extract(value, '$.rate') AS REAL) > 0) END AS umaren,
            CASE WHEN json_valid(entries) THEN json_array_length(entries) ELSE 0 END AS entry_count
       FROM races`
  ).all();

  // race_results: race_id ごとに1行へまとめた文字列
  const { results: rrRows } = await db.prepare(
    `SELECT race_id, COUNT(*) AS n,
            group_concat(IFNULL(horse_number, '') || char(31) || IFNULL(jockey, '') || char(31) ||
                         IFNULL(status, '') || char(31) || IFNULL(finish_position, ''), char(30)) AS packed
       FROM race_results GROUP BY race_id`
  ).all();
  const rrByRace = new Map();
  for (const r of rrRows || []) rrByRace.set(r.race_id, r);

  // race_results が全頭そろっていないレースのうち、finish_order があるものは entries で補う
  // (レース成績タブ「③④⑤ 共通」と同じ規則)。対象レース数はデータ次第で数百に達しうるため90件ずつ読む。
  const needEntries = [];
  for (const race of raceRows || []) {
    const rr = rrByRace.get(race.id);
    const complete = rr && race.entry_count > 0 && rr.n >= race.entry_count;
    if (!complete && race.finish_order && race.entry_count > 0) needEntries.push(race.id);
  }
  const entriesById = new Map();
  for (let i = 0; i < needEntries.length; i += 90) {
    const ids = needEntries.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id, entries FROM races WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    for (const r of results || []) entriesById.set(r.id, parseJson(r.entries, []));
  }

  // レースごとに出走馬の一覧を確定させ、そのまま保存形式(チャンクごとの騎手辞書+平らな配列)に詰める。
  // 2026-10-07: 中間の配列を作ってから詰め直す・レースごとにJSON化してバイト数を数える、をやめて
  // 1回の走査で作る(作り直し自体がCPU時間上限に近づかないように。本番データで約60ms→計測値は
  // docs/design/data-search.md 参照)。バイト数は「文字数×3」(UTF-8の上限)で保守的に見積もる。
  const chunks = []; // 保存する payload 文字列
  const compact = []; // 呼び出し元へ返す用: [item, dict]
  let dict = [], dictIndex = new Map(), itemStrs = [], est = 20;
  const flush = () => {
    chunks.push(`{"j":${JSON.stringify(dict)},"r":[${itemStrs.join(",")}]}`);
    dict = []; dictIndex = new Map(); itemStrs = []; est = 20;
  };
  const numOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "null" : String(Number(v)));
  const pushHorse = (flat, hn, jockey, pos) => {
    let ji = -1;
    if (jockey) {
      ji = dictIndex.get(jockey);
      if (ji === undefined) { ji = dict.length; dictIndex.set(jockey, ji); dict.push(jockey); est += jockey.length * 3 + 3; }
    }
    flat.push(hn > 0 ? hn : 0, ji, pos);
  };
  for (const race of raceRows || []) {
    // 1レース分は数KB以下のため、上限の手前(余裕50KB)で、このレースを処理する前に次のチャンクへ切り替える
    if (itemStrs.length && est > CHUNK_MAX_BYTES - 50_000) flush();
    const rr = rrByRace.get(race.id);
    let flat = null;
    if (rr && race.entry_count > 0 && rr.n >= race.entry_count) {
      flat = [];
      const packed = String(rr.packed || "");
      let start = 0;
      while (start <= packed.length) {
        let end = packed.indexOf(ROW_SEP, start);
        if (end < 0) end = packed.length;
        const f1 = packed.indexOf(FIELD_SEP, start);
        const f2 = packed.indexOf(FIELD_SEP, f1 + 1);
        const f3 = packed.indexOf(FIELD_SEP, f2 + 1);
        const status = packed.slice(f2 + 1, f3) || "finished";
        if (RIDDEN_STATUSES.has(status)) {
          const fp = Number(packed.slice(f3 + 1, end));
          pushHorse(flat, Number(packed.slice(start, f1)) || 0, packed.slice(f1 + 1, f2), fp >= 1 && fp <= 3 ? fp : 0);
        }
        start = end + 1;
      }
    } else if (entriesById.has(race.id)) {
      const finishOrder = parseJson(race.finish_order, null);
      const entries = entriesById.get(race.id);
      if (Array.isArray(finishOrder) && finishOrder.length && Array.isArray(entries) && entries.length) {
        flat = [];
        for (const e of entries) {
          const i = finishOrder.indexOf(e.horse_number);
          pushHorse(flat, Number(e.horse_number) || 0, e.jockey || "", i >= 0 && i < 3 ? i + 1 : 0);
        }
      }
    }
    const tan = race.tan === null || race.tan === undefined ? null : Number(race.tan);
    const umaren = race.umaren === null || race.umaren === undefined ? null : Number(race.umaren);
    const item = [race.id, race.race_date, race.track || null, race.course_type || null, race.distance ?? null, tan, umaren, flat];
    const itemStr = `[${race.id},${JSON.stringify(race.race_date ?? null)},${JSON.stringify(item[2])},${JSON.stringify(item[3])},${numOrNull(item[4])},${numOrNull(tan)},${numOrNull(umaren)},${flat ? `[${flat.join(",")}]` : "null"}]`;
    const itemBytes = itemStr.length * 3 + 1;
    // (チャンクの切り替えはループの先頭で行う。ここで切り替えると、このレースの騎手番号が前のチャンクの辞書を指したままになる)
    itemStrs.push(itemStr);
    est += itemBytes;
    compact.push([item, dict]);
  }
  flush(); // 0件でも1チャンク保存する
  const races = compact.map(([item, d]) => expandRace(item, d));

  const now = new Date().toISOString();
  const stmts = [db.prepare("DELETE FROM race_lineup_cache")];
  chunks.forEach((payload, i) => {
    stmts.push(db.prepare("INSERT INTO race_lineup_cache (chunk_index, payload, updated_at) VALUES (?, ?, ?)").bind(i, payload, now));
  });
  try {
    await db.batch(stmts); // チャンク数は数個(2026-10-07時点で1)なので分割不要
  } catch (e) {
    console.error("race_lineup_cache: failed to persist (ignored)", e);
  }
  return races;
}
