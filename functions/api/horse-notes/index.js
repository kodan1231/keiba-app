import {
  readJsonBody,
  parsePositiveIntId,
  jsonError,
  horseAliasKeyOf,
  loadHorseAliasMap,
  loadHorseAliasMapCached,
  applyHorseAliasMap,
  notModifiedResponse,
  jsonWithEtag,
  textFingerprint,
} from "../_shared.js";

const normalizeName = (v) => String(v ?? "").replace(/[　\s]+/g, " ").trim();

// 「変更なし(304)」のための ETag(2026-11-18。@STEP: horse_notes_versions)。
// 馬メモの一覧は1人約300件あり、馬券購入画面・予想登録画面を開くたびに全件を読んでいた(7日で約600回・約17万行)。
// 利用者ごとの馬メモの版(user_note_versions)と馬名エイリアスの版(data_versions の 'horse_aliases')を DB トリガーで上げ、
// どちらも前回と同じなら中身を作らずに 304 を返す(読むのは主キーで2行)。表が無い(マイグレーション前)ときは ETag を付けない。
// 応答の形を変えたら NOTES_SHAPE を変える。
const NOTES_SHAPE = "1";
async function notesEtag(db, userId, extra = "") {
  try {
    const row = await db
      .prepare("SELECT (SELECT version FROM user_note_versions WHERE user_id = ?) AS u, (SELECT version FROM data_versions WHERE name = 'horse_aliases') AS a")
      .bind(Number(userId))
      .first();
    if (!row || row.a === null || row.a === undefined) return null;
    return `W/"hn${NOTES_SHAPE}-u${userId}-n${row.u ?? 0}-a${row.a}${extra ? `-${extra}` : ""}"`;
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);

  // race_id を指定しないリクエストは、購入画面のレース一覧(buy.js)が
  // 「メモ登録済みの馬が出走しているか」をまとめて判定するための一覧取得モード。
  // 空でないメモを持つ馬名を(馬名エイリアスで正規化して)返す。
  if (!url.searchParams.has("race_id")) {
    const etag = await notesEtag(env.DB, userId, "names");
    const notModified = notModifiedResponse(request, etag);
    if (notModified) return notModified;
    // 表示用の読み取りなので短時間使い回す版(2026-10-07。_lib/memo-cache.js)。保存(POST)側は毎回読む版のまま。
    const aliasMap = await loadHorseAliasMapCached(env.DB);
    const result = await env.DB.prepare(
      "SELECT horse_name FROM horse_notes WHERE user_id = ? AND memo IS NOT NULL AND memo <> ''"
    ).bind(userId).all();
    const names = [...new Set((result.results || []).map((r) => applyHorseAliasMap(aliasMap, r.horse_name)))];
    return jsonWithEtag({ names }, etag);
  }

  const { id: raceId, error } = parsePositiveIntId(url.searchParams.get("race_id"), "race_id");
  if (error) return error;
  const race = await env.DB.prepare("SELECT entries FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return jsonError("レースが見つかりません", 404);
  // 1レース分は出走馬表(馬名)でも中身が変わるので、出走馬表の指紋も ETag に入れる
  const etag = await notesEtag(env.DB, userId, `r${raceId}.${textFingerprint(race.entries)}`);
  const notModified = notModifiedResponse(request, etag);
  if (notModified) return notModified;
  const aliasMap = await loadHorseAliasMapCached(env.DB);
  let entries = [];
  try { entries = JSON.parse(race.entries || "[]"); } catch {}

  // 出走各馬を「馬名エイリアス正規化 → 突き合わせキー(horseAliasKeyOf)」に変換する。
  // レスポンスのキーはクライアント(prediction.js の normalizeHorseName)が引ける形。
  const keyToDisplay = new Map();
  for (const e of entries) {
    const canon = applyHorseAliasMap(aliasMap, e?.horse_name);
    const k = horseAliasKeyOf(canon);
    if (k && !keyToDisplay.has(k)) keyToDisplay.set(k, normalizeName(canon));
  }
  if (!keyToDisplay.size) return Response.json({});

  // 馬メモは1ユーザー分なので件数が小さい。全件取得してキーで突き合わせる
  // (バックフィル前で「表記ゆれ名のメモ」と「正しい名のメモ」が混在していても拾える)。
  const { results } = await env.DB.prepare(
    "SELECT horse_name, memo, updated_at FROM horse_notes WHERE user_id = ? AND memo IS NOT NULL AND memo <> ''"
  ).bind(userId).all();
  const out = {};
  for (const row of results || []) {
    const k = horseAliasKeyOf(applyHorseAliasMap(aliasMap, row.horse_name));
    const disp = k && keyToDisplay.get(k);
    if (!disp) continue;
    const prev = out[disp];
    if (!prev || String(row.updated_at || "") > String(prev.updated_at || "")) {
      out[disp] = { memo: row.memo || "", updated_at: row.updated_at || null };
    }
  }
  return jsonWithEtag(out, etag);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const { data, error } = await readJsonBody(request);
  if (error) return error;

  const rawName = normalizeName(data?.horse_name);
  const memo = String(data?.memo || "").trim();
  if (!rawName) return jsonError("horse_nameが必要です", 400);
  if (rawName.length > 200) return jsonError("馬名が長すぎます", 400);
  if (memo.length > 5000) return jsonError("メモは5000文字以内です", 400);

  // 保存時に馬名エイリアスで正しい馬名へ寄せる(以後この馬のメモは正しい名に集約される)。
  const aliasMap = await loadHorseAliasMap(env.DB);
  const horseName = applyHorseAliasMap(aliasMap, rawName);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO horse_notes (horse_name, user_id, memo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(horse_name, user_id) DO UPDATE SET memo = excluded.memo, updated_at = excluded.updated_at`
  ).bind(horseName, userId, memo, now, now).run();
  return Response.json({ ok: true, horse_name: horseName, memo, updated_at: now });
}
