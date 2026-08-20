// 2026-08-17リファクタリング: この配列は public/utils.js の JRA_CENTRAL_TRACKS と
// 内容が完全に同一だったため、重複定義を解消し共有定数を参照する形に変更した
// (docs/BACKLOG.md「クラスタI」参照)。変数名・参照箇所・挙動はいずれも変更していない。
// utils.js は races.html でこのファイルより先に読み込まれるため、参照時点で
// JRA_CENTRAL_TRACKS は定義済みである。
const JRA_TRACKS = JRA_CENTRAL_TRACKS;

// 「8/2 新潟」「2026年8月2日 新潟」のような行から (開催日, 競馬場) の組を抜き出す。
// 年が書かれていない場合は指定されたyearを使う。あくまで下書き用のベストエフォート解析。
function parseSchedule(text, year) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results = [];
  const seen = new Set();

  for (const line of lines) {
    const track = JRA_TRACKS.find((t) => line.includes(t));
    if (!track) continue;

    let m = line.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
    let y, mo, d;
    if (m) {
      [, y, mo, d] = m;
    } else {
      m = line.match(/(\d{1,2})[-\/月](\d{1,2})/);
      if (!m) continue;
      y = year;
      [, mo, d] = m;
    }

    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const key = `${dateStr}__${track}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ race_date: dateStr, track });
  }

  return results;
}

// netkeibaの出馬表ページをコピーすると、1頭につき複数行にまたがる形式で貼り付けられる。
// 例:
//   1	1
//   ◎
//   コンアフェット
//   牝4	56.0	斎藤	美浦斎藤誠	482(+2)	7.3	4
//   編集
// 「枠番\t馬番」の行を目印に1頭分のブロックを検出し、印(◎○等)行の次を馬名、
// その次のタブ区切り行の3列目(性齢・斤量の次)を騎手として抜き出す。
function parseNetkeibaEntries(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const results = [];
  let i = 0;

  while (i < lines.length) {
    const header = lines[i].match(/^(\d{1,2})\t(\d{1,2})\s*$/) || lines[i].match(/^(\d{1,2})\t(\d{1,2})\t/);
    if (!header) { i++; continue; }

    const waku = Number(header[1]);
    const horseNumber = Number(header[2]);

    let j = i + 1;
    while (j < lines.length && lines[j] === "") j++;
    j++; // 印(◎○✓等)の行をスキップ
    while (j < lines.length && lines[j] === "") j++;
    const name = lines[j] || "";
    j++;
    while (j < lines.length && lines[j] === "") j++;
    const detailLine = lines[j] || "";
    const parts = detailLine.split("\t").map((p) => p.trim()).filter((p) => p !== "");
    const jockey = parts[2] || "";

    if (name && !/^(編集|--)$/.test(name)) {
      results.push({ waku_number: waku <= 8 ? waku : null, horse_number: horseNumber, horse_name: name, jockey });
    }
    i = j + 1;
  }

  return results;
}

// 出走馬情報のテキスト貼り付けを解析する。netkeiba形式をまず試し、検出できなければ
// シンプルな1行1頭形式(馬番・馬名・騎手をタブ/カンマ/連続スペース区切り)にフォールバックする。
function parseEntries(text) {
  const netkeibaResult = parseNetkeibaEntries(text);
  if (netkeibaResult.length > 0) return netkeibaResult;
  return parseEntriesSimple(text);
}

function parseEntriesSimple(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    if (/^(枠|馬番|馬名|騎手)/.test(line)) continue; // ヘッダー行らしきものはスキップ

    const fields = line.split(/\t|,|\s{2,}|　/).map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) continue;

    let waku = null, horseNumber = null, name = "", jockey = "";

    if (/^\d{1,2}$/.test(fields[0]) && fields[1] && /^\d{1,2}$/.test(fields[1]) && Number(fields[0]) <= 8) {
      waku = Number(fields[0]);
      horseNumber = Number(fields[1]);
      name = fields[2] || "";
      jockey = fields[3] || "";
    } else if (/^\d{1,2}$/.test(fields[0])) {
      horseNumber = Number(fields[0]);
      name = fields[1] || "";
      jockey = fields[2] || "";
    } else {
      name = fields[0] || "";
      jockey = fields[1] || "";
    }

    if (!name) continue;
    results.push({ waku_number: waku, horse_number: horseNumber, horse_name: name, jockey });
  }

  return results;
}
