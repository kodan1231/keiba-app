// JRA公式サイト「N年 重賞レース一覧」ページ(PDF)から、重賞(G1/G2/G3)レース名・
// グレード・参考情報(競馬場・コース・年齢条件)を抽出する。管理画面「重賞管理」
// (public/admin.js)の重賞マスタ一括インポートで使う。
//
// 【実機未検証】このファイルはユーザー提供のPDF内容(視覚的なレンダリング結果)を
// 元に実装したもので、実ブラウザのPDF.js抽出結果そのものでの検証は済んでいない
// (jra-result-pdf.js冒頭の注記と同じ理由)。特に「グレードバッジ(GⅠ/GⅡ/GⅢ)の
// 抽出順序が各レース行と同じ順序で一致する」という前提が崩れた場合に備え、
// レース行数とグレードバッジ数が一致しない場合はレコードを1件も返さず
// diagnostics.errors に理由を積む(件数不一致のまま誤った組み合わせで登録する
// 事故を避けるため。2026-09-19に発覚した単勝人気誤取得と同種の「見た目とPDF.js
// 抽出結果の位置ズレ」を警戒した設計)。
//
// ページの構造(視覚上の表): 月日 / レース名 / 競馬場 / 性齢 / コース / 優勝馬 / 騎手 /
// 結果(グレードバッジ+「レース結果」ボタン) / 過去成績。PDF化した際、グレードバッジ+
// ボタン列(「結果」列)の内容は各行のテキストとは別に、ページ末尾側へまとめて
// 抽出される(表内レース行がすべて先に並び、その後にグレード表記が同じ並び順で
// 続く)。そのため「レース行を先頭から抽出」「グレード表記を別途抽出」した上で、
// 出現順に1件ずつ対応付ける方式を取る。

const JRA_GRADED_RACES_PARSER_VERSION = "1.0-unverified";

const JRA_GRADED_TRACKS = ["中山", "阪神", "京都", "東京", "中京", "新潟", "福島", "小倉", "函館", "札幌"];

function jraGradedRacesJoinRowItems(items) {
  return jraPdfJoinRowItems(items);
}

const JRA_GRADED_ROW_RE = new RegExp(
  `(\\d{1,2})月(\\d{1,2})日\\s*(?:祝日・)?[月火水木金土日]曜\\s*` +
  `(.+?)\\s+(${JRA_GRADED_TRACKS.join("|")})\\s+` +
  `([\\d歳以上牡牝せんｾﾝ・]+)\\s+(芝|ダート|ダ|障)\\s*([\\d,]+)\\s*メートル`,
  "g"
);
const JRA_GRADED_GRADE_RE = /(J・)?G([ⅠⅡⅢ])/g;

function jraGradedRacesCourseType(raw) {
  if (raw === "芝") return "芝";
  if (raw === "障") return "障害";
  return "ダート";
}

// 1ページ分の行配列(jraGradedRacesExtractPdfPages の pages[i])から、レース行の
// 生マッチ配列とグレード表記の生マッチ配列を別々に取り出す。
// ページ1のみ表ヘッダー(「...過去成績」)が付くため、それより前のタブ見出し等
// (「GⅠレース」等のページ内タブ表記)を誤ってグレード表記として拾わないよう、
// ヘッダーが見つかればそれより後ろだけを対象にする。
function jraGradedRacesScanPage(rows) {
  const flat = rows.map((r) => r.text || "").join("\n").replace(/[\s　]+/g, " ").trim();
  const headerIdx = flat.indexOf("過去成績");
  const scanText = headerIdx >= 0 ? flat.slice(headerIdx + "過去成績".length) : flat;

  const raceMatches = [...scanText.matchAll(JRA_GRADED_ROW_RE)];
  const gradeMatches = [...scanText.matchAll(JRA_GRADED_GRADE_RE)];
  return { raceMatches, gradeMatches };
}

function jraGradedRacesParseExtractedPages(pages) {
  const diagnostics = { pages: pages.length, rows: 0, raceRows: 0, gradeTokens: 0, errors: [] };
  const races = [];
  const grades = [];

  for (const rows of pages) {
    diagnostics.rows += rows.length;
    const { raceMatches, gradeMatches } = jraGradedRacesScanPage(rows);
    for (const m of raceMatches) {
      races.push({
        month: Number(m[1]),
        day: Number(m[2]),
        name: m[3].trim(),
        track: m[4],
        age_condition: m[5],
        course_type: jraGradedRacesCourseType(m[6]),
        distance: Number(String(m[7]).replace(/,/g, "")),
      });
    }
    for (const m of gradeMatches) {
      grades.push({ grade: `G${{ "Ⅰ": "1", "Ⅱ": "2", "Ⅲ": "3" }[m[2]]}`, is_jump: !!m[1] });
    }
  }
  diagnostics.raceRows = races.length;
  diagnostics.gradeTokens = grades.length;

  if (!races.length) {
    diagnostics.errors.push("重賞レースの行を1件も検出できませんでした。");
    return { records: [], diagnostics };
  }
  if (races.length !== grades.length) {
    diagnostics.errors.push(
      `レース行数(${races.length})とグレード表記の数(${grades.length})が一致しません。` +
      `位置の対応付けが信頼できないため、登録候補を1件も生成しません。`
    );
    return { records: [], diagnostics };
  }

  const records = races.map((r, i) => ({
    name: r.name,
    grade: grades[i].grade,
    is_jump: grades[i].is_jump,
    track: r.track,
    course_type: r.course_type,
    distance: r.distance,
    age_condition: r.age_condition,
  }));

  return { records, diagnostics };
}

async function jraGradedRacesExtractPdfPages(file, log = () => {}) {
  if (!window.pdfjsLib) {
    log("PDF.js未読込 → CDNから読み込み開始");
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = () => { log("PDF.js読み込み成功"); resolve(); };
      script.onerror = () => reject(new Error("PDF解析ライブラリの読み込みに失敗しました"));
      document.head.appendChild(script);
    });
  }
  if (!window.pdfjsLib) throw new Error("PDF解析ライブラリを利用できませんでした");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  log("PDF.jsバージョン=" + (window.pdfjsLib.version || "unknown"));
  const buffer = await file.arrayBuffer();
  log("ArrayBuffer取得=" + buffer.byteLength + " bytes");
  const pdf = await window.pdfjsLib.getDocument({ data: buffer, useWorkerFetch: false, isEvalSupported: true }).promise;
  log("PDF読み込み成功 pages=" + pdf.numPages);
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent({ disableCombineTextItems: false });
    const items = content.items.filter((x) => x.str && x.str.trim()).map((x) => ({
      str: jraPdfNormalizeUnit(x.str), x: x.transform[4], y: x.transform[5], w: x.width || 0,
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const item of items) {
      let row = rows.find((r) => Math.abs(r.y - item.y) < 3.0);
      if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
      row.items.push(item);
    }
    pages.push(rows.sort((a, b) => b.y - a.y).map((r) => {
      const sortedItems = r.items.sort((a, b) => a.x - b.x);
      const joined = jraGradedRacesJoinRowItems(sortedItems);
      return { text: joined.text, y: r.y };
    }));
    log(`ページ ${p} 抽出完了 items=${items.length} rows=${rows.length}`);
  }
  return { pages, pdfPages: pdf.numPages };
}
