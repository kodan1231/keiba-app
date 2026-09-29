// netkeiba(db.netkeiba.com)から馬の血統(父/母/母父)・調教師・馬主・生産牧場を取得する。
// データ検索画面「馬情報検索」タブ用(docs/design/data-search.md「馬情報検索タブ」参照)。
// 現行の一括取込(出走馬一覧PDF/結果PDF/結果HTML)では血統・馬主・生産牧場を一切取得
// できないため、この外部サイトから取得する(ユーザー承認済み。2026-09-28)。
//
// 呼び出し元(_lib/horse-master.js)からのみ使う。このファイル自体はDBに触れない
// (取得・パースのみの純粋な関数群)。
//
// ---- EUC-JPエンコーディングについて ----
// db.netkeiba.comはレガシーなEUC-JPサイトで、検索クエリ(word=...)もEUC-JPで
// パーセントエンコードする必要がある(UTF-8のままでは文字化けして0件になる)。
// CloudflareWorkersのTextEncoderはUTF-8固定でEUC-JP出力ができないため、全角カタカナ
// (JIS X 0208の第5行。EUC-JPでは [0xA5, コードポイント - 0x3000] の単純な線形変換になる。
// 2026-09-28に実データで確認済み)だけを手動でエンコードする。JRA登録馬名は全角カタカナ
// (長音「ー」含む)のみという前提のため、それ以外の文字(漢字・ひらがな等)を含む場合は
// エンコード不可としてnullを返し、呼び出し元は取得自体を諦める(手入力にフォールバック)。
// レスポンス側(HTML本文)のEUC-JP→Unicodeデコードは TextDecoder("euc-jp") に依存する
// (WorkersのEncoding Standard実装が対応している前提。wrangler dev実機での確認が必要)。
const NETKEIBA_UA =
  "Mozilla/5.0 (compatible; UmakenchoBot/1.0; personal horse-racing ledger app; contact via app admin)";

function eucJpPercentEncodeKatakana(str) {
  const bytes = [];
  for (const ch of String(str || "")) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) { bytes.push(cp); continue; }
    if (cp >= 0x30a0 && cp <= 0x30ff) { bytes.push(0xa5, cp - 0x3000); continue; }
    return null; // カタカナ以外(漢字・ひらがな等)を含む → エンコード不可
  }
  if (!bytes.length) return null;
  return bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
}

async function fetchEucJpText(url) {
  const res = await fetch(url, { headers: { "User-Agent": NETKEIBA_UA } });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("euc-jp").decode(buf);
  return { res, text };
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// セル(<td>...</td>の中身)から、最初の<a>要素のテキストを取り出す(無ければプレーンテキスト)。
// sire/dam/damSire列は表記上コメントアウトされた旧形式リンクを含むため、
// アンカー検索の前に必ずHTMLコメントを取り除く。
function firstAnchorTextOrPlain(cellHtml) {
  const withoutComments = String(cellHtml || "").replace(/<!--[\s\S]*?-->/g, "");
  const a = withoutComments.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
  const raw = a ? a[1] : withoutComments;
  const text = stripTags(raw);
  return text || null;
}

// 馬個別ページ(db.netkeiba.com/horse/<id>/)の「プロフィール」テーブル(db_prof_table)から
// th要素のラベル文字列に対応するtd要素の中身を取り出す。
function extractProfTableField(pageHtml, label) {
  const re = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`);
  const m = pageHtml.match(re);
  return m ? firstAnchorTextOrPlain(m[1]) : null;
}

// 血統(父/母/母父)を取得する(馬個別ページから読み込まれる非同期ボックスのAPIを直接叩く)。
// レスポンスは常に「父側2行+母側2行」の4行固定(3代の簡易血統表。2026-09-28に実データで
// 確認済み。5代血統表がある専用ページ(/horse/ped/<id>/)は使わない)。
//   row[0] = [父, 父父]      (父はrowspan=2でrow[1]の1列目を兼ねる)
//   row[1] = [父母]
//   row[2] = [母, 母父]      (母はrowspan=2でrow[3]の1列目を兼ねる)
//   row[3] = [母母]
async function fetchPedigreeFromAjax(netkeibaHorseId) {
  const url = `https://db.netkeiba.com/horse/ajax_horse_pedigree.html?input=UTF-8&output=json&id=${encodeURIComponent(netkeibaHorseId)}`;
  const res = await fetch(url, { headers: { "User-Agent": NETKEIBA_UA } });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || json.status !== "OK" || !json.data) return null;
  const rows = [...String(json.data).matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  if (rows.length < 3) return null;
  const cellsOf = (rowHtml) =>
    [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => firstAnchorTextOrPlain(m[1]));
  const row0 = cellsOf(rows[0]); // [父, 父父]
  const row2 = cellsOf(rows[2]); // [母, 母父]
  return {
    sire: row0[0] || null,
    dam: row2[0] || null,
    damSire: row2[1] || null,
  };
}

// 検索結果一覧ページ(db.netkeiba.com/?pid=horse_list&word=...)のテーブル(class=horse_list_table)
// から候補馬を列挙する。列順は固定(2026-09-28に実データで確認済み):
//   0:チェックボックス 1:馬名 2:性 3:生年 4:(血統/掲示板等リンク) 5:厩舎(調教師)
//   6:父 7:母 8:母父 9:馬主 10:生産者 11:総賞金
function parseHorseListCandidates(listHtml) {
  const tableMatch = listHtml.match(/<table[^>]*class="[^"]*horse_list_table[^"]*"[\s\S]*?<\/table>/);
  if (!tableMatch) return [];
  const rowsHtml = [...tableMatch[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const out = [];
  for (const rowHtml of rowsHtml) {
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 11) continue; // ヘッダ行(th)・崩れた行を除外
    const idMatch = cells[1].match(/\/horse\/(\d+)\//);
    if (!idMatch) continue;
    const birthYearText = stripTags(cells[3]);
    out.push({
      netkeibaHorseId: idMatch[1],
      name: firstAnchorTextOrPlain(cells[1]),
      birthYear: /^\d{4}$/.test(birthYearText) ? Number(birthYearText) : null,
      trainer: firstAnchorTextOrPlain(cells[5]),
      sire: firstAnchorTextOrPlain(cells[6]),
      dam: firstAnchorTextOrPlain(cells[7]),
      damSire: firstAnchorTextOrPlain(cells[8]),
      owner: firstAnchorTextOrPlain(cells[9]),
      breeder: firstAnchorTextOrPlain(cells[10]),
    });
  }
  return out;
}

/**
 * 馬名からnetkeibaの情報を取得する。
 * @param {string} displayName - 検索する馬名(自アプリ側の正しい表記)
 * @param {{ expectedBirthYear?: number }} [opts] - 同名馬が複数ヒットした場合の絞り込みヒント
 *   (自アプリの出走履歴から推定した生年。無ければ先頭候補を採用する)
 * @returns {Promise<
 *   { ok: true, netkeibaHorseId: string, sire: string|null, dam: string|null, damSire: string|null,
 *     trainer: string|null, owner: string|null, breeder: string|null, ambiguous?: boolean }
 *   | { ok: false, error: "encoding_unsupported"|"network_error"|"not_found"|"parse_error" }
 * >}
 */
export async function fetchNetkeibaHorseInfo(displayName, opts = {}) {
  const encodedQuery = eucJpPercentEncodeKatakana(displayName);
  if (encodedQuery == null) return { ok: false, error: "encoding_unsupported" };

  let searchRes, searchText;
  try {
    const r = await fetchEucJpText(`https://db.netkeiba.com/?pid=horse_list&word=${encodedQuery}`);
    searchRes = r.res;
    searchText = r.text;
  } catch {
    return { ok: false, error: "network_error" };
  }

  try {
    // 完全一致1件のみの場合、netkeibaは馬個別ページへ302リダイレクトする
    // (このときのレスポンス本文は既に馬個別ページそのもの)。
    const redirectMatch = searchRes.url.match(/\/horse\/(\d+)\/?(?:$|[?#])/);
    if (redirectMatch) {
      const netkeibaHorseId = redirectMatch[1];
      const [pedigree] = await Promise.all([fetchPedigreeFromAjax(netkeibaHorseId)]);
      return {
        ok: true,
        netkeibaHorseId,
        sire: pedigree?.sire ?? null,
        dam: pedigree?.dam ?? null,
        damSire: pedigree?.damSire ?? null,
        trainer: extractProfTableField(searchText, "調教師"),
        owner: extractProfTableField(searchText, "馬主"),
        breeder: extractProfTableField(searchText, "生産者"),
      };
    }

    // リダイレクトされなかった(該当0件、または同名馬が複数存在)→ 検索結果一覧をパースする。
    const candidates = parseHorseListCandidates(searchText).filter((c) => c.name === displayName);
    if (!candidates.length) return { ok: false, error: "not_found" };

    let best = candidates[0];
    if (candidates.length > 1 && Number.isInteger(opts.expectedBirthYear)) {
      best = candidates.reduce((a, b) => {
        const da = Math.abs((a.birthYear ?? -9999) - opts.expectedBirthYear);
        const db_ = Math.abs((b.birthYear ?? -9999) - opts.expectedBirthYear);
        return da <= db_ ? a : b;
      });
    }
    return {
      ok: true,
      netkeibaHorseId: best.netkeibaHorseId,
      sire: best.sire,
      dam: best.dam,
      damSire: best.damSire,
      trainer: best.trainer,
      owner: best.owner,
      breeder: best.breeder,
      ambiguous: candidates.length > 1,
    };
  } catch {
    return { ok: false, error: "parse_error" };
  }
}
