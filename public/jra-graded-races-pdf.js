// JRA公式サイト「N年 重賞レース一覧」ページ(PDF)から、重賞(G1/G2/G3)レース名・
// グレード・参考情報(競馬場・コース・年齢条件)を抽出する。管理画面「重賞管理」
// (public/admin.js)の重賞マスタ一括インポートで使う。
//
// 2026-09-19: 実機のPDF.js抽出結果で検証済み(下記の行構造は実際の抽出結果を
// 確認して確定した)。当初は「グレードバッジがページ末尾に別集約される」という
// 誤った想定で実装しており、レース行を1件も検出できない不具合が実機で発生した。
//
// 実際の行構造(タブ区切り。1レースにつき3行1組で抽出される):
//   行1: [月日]                [コース種別+距離(例:"芝2,000")] [任意:結果ボタン文言]
//   行2: [グレード+レース名(例:"GⅢ 中山金杯")] [競馬場] [年齢条件] [任意:優勝馬] [任意:優勝騎手]
//   行3: [曜日]                [メートル(コース列の折り返し)]
// 月日・曜日、コース種別+距離・メートルは、それぞれ表側で2行に折り返されているセルの
// 上段・下段にあたる(単独行の競馬場・年齢条件・レース名等のセルは、この2行の中間の
// Y座標で抽出されるため、行1→行2→行3の順で並ぶ)。優勝馬・優勝騎手は今回の用途
// (レース名・グレードの分類マスタ)には不要なため解析しない。
//
// この構造により、グレード判定は「レース名を含む行2自身」から直接取り出すため、
// 旧実装で警戒していた「別々に抽出した2つの配列を出現順で対応付ける」リスクは
// 発生しない(行2の正規表現マッチ自体にグレードとレース名が両方含まれる)。

const JRA_GRADED_RACES_PARSER_VERSION = "2.0-verified";

const JRA_GRADED_DATE_RE = /^(\d{1,2})月(\d{1,2})日$/;
const JRA_GRADED_COURSE_RE = /^(芝|ダート|ダ|障)([\d,]+)$/;
const JRA_GRADED_NAME_ROW_RE = /^(J・)?G([ⅠⅡⅢ])\s*(.+)$/;

function jraGradedRacesJoinRowItems(items) {
  return jraPdfJoinRowItems(items);
}

function jraGradedRacesCourseType(raw) {
  if (raw === "芝") return "芝";
  if (raw === "障") return "障害";
  return "ダート";
}

// 行1(月日+コース)・行2(グレード+レース名+競馬場+年齢条件)の組から1レース分の
// レコードを組み立てる。行の並びがこの2行連続のパターンに一致しない場合は
// null を返す(該当レースを静かにスキップする。誤った組み合わせで登録するより
// 安全なため)。
function jraGradedRacesMatchPair(row1Text, row2Text) {
  const cols1 = String(row1Text || "").split("\t").map((s) => s.trim());
  const dateMatch = cols1[0] && cols1[0].match(JRA_GRADED_DATE_RE);
  if (!dateMatch) return null;
  const courseMatch = cols1[1] && cols1[1].match(JRA_GRADED_COURSE_RE);
  if (!courseMatch) return null;

  const cols2 = String(row2Text || "").split("\t").map((s) => s.trim());
  const nameMatch = cols2[0] && cols2[0].match(JRA_GRADED_NAME_ROW_RE);
  if (!nameMatch) return null;

  return {
    name: nameMatch[3].trim(),
    grade: `G${{ "Ⅰ": "1", "Ⅱ": "2", "Ⅲ": "3" }[nameMatch[2]]}`,
    is_jump: !!nameMatch[1],
    track: cols2[1] || null,
    age_condition: cols2[2] || null,
    course_type: jraGradedRacesCourseType(courseMatch[1]),
    distance: Number(courseMatch[2].replace(/,/g, "")),
  };
}

function jraGradedRacesParseExtractedPages(pages) {
  const diagnostics = { pages: pages.length, rows: 0, raceRows: 0, errors: [], rawText: "" };

  // 実機での不一致原因調査用に、抽出された生テキストをそのまま残す。
  diagnostics.rawText = pages
    .map((rows, i) => `===== PAGE ${i + 1} =====\n${rows.map((r) => r.text || "").join("\n")}`)
    .join("\n\n");

  const records = [];
  for (const rows of pages) {
    diagnostics.rows += rows.length;
    for (let i = 0; i < rows.length - 1; i++) {
      const record = jraGradedRacesMatchPair(rows[i].text, rows[i + 1].text);
      if (record) records.push(record);
    }
  }
  diagnostics.raceRows = records.length;

  if (!records.length) {
    diagnostics.errors.push("重賞レースの行を1件も検出できませんでした。");
    return { records: [], diagnostics };
  }

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
