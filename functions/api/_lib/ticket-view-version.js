// 購入履歴の読み取りAPI(GET /api/tickets・GET /api/ticket-imports)で、前回から何も変わっていなければ
// 中身を作らずに「変更なし(304)」だけを返すための仕組み(2026-10-07追加)。
//
// 背景: 購入履歴画面・集計画面は開くたびに全購入履歴(数千件)を読み直しており、D1の読み取り
// (7日間で約320万行)・CPU時間・利用者の通信量の大半を占めていた。
//
// 仕組み:
//   - data_versions テーブルの 'ticket_views' 行の version を、DBトリガーで「購入履歴の表示に
//     関わる表(tickets / imported_ticket_groups / imported_ticket_items / imported_tickets /
//     races / graded_races)のどれかが変わるたびに +1」する(schema.sql「data_versions」参照)。
//   - 応答に ETag(ユーザーID+version+TICKET_VIEW_SHAPE)を付け、Cache-Control: private, no-cache で
//     ブラウザに保存させる。次回ブラウザが If-None-Match で送ってきた値が今の ETag と同じなら、
//     重い問い合わせをせずに 304 を返す(画面側のコード変更は不要。ブラウザが保存済みの中身を使う)。
//   - data_versions が無い(マイグレーション未適用)・読めない場合は ETag を付けず、従来どおり毎回返す。
//
// 注意: 応答の作り方(返す項目・重賞判定のルール等)を変えたときは TICKET_VIEW_SHAPE を変えること。
// 変えないと、データに変更が無い利用者には古い形の応答(ブラウザ保存分)が使われ続ける。
export const TICKET_VIEW_SHAPE = "1";

// 今の ETag を返す。取れなければ null(ETag を使わない)。
export async function ticketViewEtag(db, userId) {
  try {
    const row = await db.prepare("SELECT version FROM data_versions WHERE name = 'ticket_views'").first();
    if (!row) return null;
    return `W/"tv${TICKET_VIEW_SHAPE}-u${userId}-v${row.version}"`;
  } catch (e) {
    return null;
  }
}

const CACHE_HEADERS = { "Cache-Control": "private, no-cache" };

// ブラウザが送ってきた If-None-Match が今の ETag と同じなら 304 の応答を返す。違えば null。
export function notModifiedResponse(request, etag) {
  if (!etag) return null;
  const sent = request.headers.get("If-None-Match") || "";
  if (!sent.split(",").some((v) => v.trim() === etag)) return null;
  return new Response(null, { status: 304, headers: { ...CACHE_HEADERS, ETag: etag } });
}

// JSON 応答に ETag を付ける(etag が null なら付けない)。
export function jsonWithEtag(body, etag) {
  return Response.json(body, etag ? { headers: { ...CACHE_HEADERS, ETag: etag } } : undefined);
}
