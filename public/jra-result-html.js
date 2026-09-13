// JRAレース結果ページ(HTML)から、public/jra-result-pdf.js が生成するものと同じ
// レコード形式を組み立てるパーサー。docs/design/results-import.md
// 「ユーザースクリプトによるHTML取込み」参照。
//
// PDFテキスト抽出(ギャップ実測による行・列復元、全角文字の部首正規化)と異なり、
// JRA公式サイトの結果ページは列の意味を表すクラス名(place/num/horse/jockey等)が
// 付いた素直な<table>構造になっているため、DOMを直接読むだけで済む。
//
// このファイルはブラウザ(Tampermonkey等のユーザースクリプト実行環境)で動作する
// ことを前提とし、DOM APIのみを使う(PDF.js等の外部ライブラリ非依存)。
// public/jra-result-importer.user.js から @require で読み込まれる。

const JRA_RESULT_HTML_BET_TYPE_BY_CLASS = {
  win: "tan",
  place: "fuku",
  wakuren: "wakuren",
  wide: "wide",
  umaren: "umaren",
  umatan: "umatan",
  trio: "sanrenpuku",
  tierce: "sanrentan",
};

const JRA_RESULT_HTML_STATUS_BY_PLACE_TEXT = { 取消: "scratched", 除外: "excluded", 中止: "stopped" };

function jraResultHtmlText(el) {
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
}

// 例: "2026年9月13日（日曜） 4回中山4日" → { race_date: "2026-09-13", track: "中山" }
function jraResultHtmlParseDateTrack(dateText) {
  const m = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[^0-9]*(\d+)回(\D+?)(\d+)日/);
  if (!m) return { race_date: null, track: null };
  const [, y, mo, d, , track] = m;
  return {
    race_date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    track: track.trim(),
  };
}

// 例: "発走時刻：10時35分" → "10:35"
function jraResultHtmlParsePostTime(timeText) {
  const m = timeText.match(/(\d{1,2})時(\d{1,2})分/);
  return m ? `${String(m[1]).padStart(2, "0")}:${String(m[2]).padStart(2, "0")}` : null;
}

// 例: "コース：2,000メートル（芝・右）" → { distance:2000, course_type:"芝", course_direction:"右" }
function jraResultHtmlParseCourse(courseText) {
  const m = courseText.match(/([0-9,]+)\s*メートル[（(]?\s*(芝|ダート|障害)\s*[・･]?\s*(左|右)?/);
  if (!m) return { distance: null, course_type: null, course_direction: null };
  return {
    distance: Number(m[1].replace(/,/g, "")),
    course_type: m[2],
    course_direction: m[3] || null,
  };
}

function jraResultHtmlParseWeather(babaEl) {
  if (!babaEl) return { weather: null, track_condition: null };
  const weatherEl = babaEl.querySelector("li.weather .txt");
  const condEl = babaEl.querySelector("li:not(.weather) .txt");
  return {
    weather: weatherEl ? jraResultHtmlText(weatherEl) : null,
    track_condition: condEl ? jraResultHtmlText(condEl) : null,
  };
}

// 馬体重セル("490(-4)"のように増減がネストしたspan内にある)から本体と増減を分離する。
function jraResultHtmlParseBodyWeight(cellText) {
  const m = cellText.match(/^(\d+)\s*[（(]([^)）]*)[)）]/);
  if (m) return { body_weight: Number(m[1]), body_weight_change: m[2] || null };
  const n = Number(cellText);
  return { body_weight: cellText && Number.isFinite(n) ? n : null, body_weight_change: null };
}

function jraResultHtmlParseWakuNumber(imgEl) {
  const alt = imgEl?.getAttribute("alt") || "";
  const m = alt.match(/枠(\d+)/);
  return m ? Number(m[1]) : null;
}

// 1頭分の<tr>を解析する。見出し崩れ等で馬番が取れない場合はnull。
function jraResultHtmlParseRow(tr) {
  const placeText = jraResultHtmlText(tr.querySelector("td.place"));
  const horseNumber = Number(jraResultHtmlText(tr.querySelector("td.num")));
  if (!Number.isInteger(horseNumber)) return null;

  const horseNameEl = tr.querySelector("td.horse a");
  const jockeyEl = tr.querySelector("td.jockey a");
  const wakuImg = tr.querySelector("td.waku img");
  const horseName = horseNameEl ? jraResultHtmlText(horseNameEl) : null;
  const jockey = jockeyEl ? jraResultHtmlText(jockeyEl) : null;
  const sexAge = jraResultHtmlText(tr.querySelector("td.age")) || null;
  const weightCarriedNum = Number(jraResultHtmlText(tr.querySelector("td.weight")));
  const weightCarried = Number.isFinite(weightCarriedNum) ? weightCarriedNum : null;

  const status = JRA_RESULT_HTML_STATUS_BY_PLACE_TEXT[placeText] || "finished";
  const finishPosition = status === "finished" && /^\d+$/.test(placeText) ? Number(placeText) : null;

  const cornerPositions = Array.from(tr.querySelectorAll("td.corner .corner_list li"))
    .map((li) => jraResultHtmlText(li))
    .filter(Boolean);
  const finalFurlong = Number(jraResultHtmlText(tr.querySelector("td.f_time")));
  const { body_weight, body_weight_change } = jraResultHtmlParseBodyWeight(
    jraResultHtmlText(tr.querySelector("td.h_weight"))
  );
  const popText = jraResultHtmlText(tr.querySelector("td.pop"));
  const winPopularity = popText && /^\d+$/.test(popText) ? Number(popText) : null;

  return {
    finishPosition,
    entry: {
      horse_number: horseNumber,
      waku_number: jraResultHtmlParseWakuNumber(wakuImg),
      horse_name: horseName,
      jockey,
      sex_age: sexAge,
      weight_carried: weightCarried,
    },
    raceResult: {
      horse_number: horseNumber,
      horse_name: horseName,
      sex_age: sexAge,
      weight_carried: weightCarried,
      jockey,
      status,
      finish_position: finishPosition,
      time_text: jraResultHtmlText(tr.querySelector("td.time")) || null,
      margin: jraResultHtmlText(tr.querySelector("td.margin")) || null,
      corner_positions: cornerPositions.length ? cornerPositions.join("-") : null,
      final_furlong_time: Number.isFinite(finalFurlong) ? finalFurlong : null,
      body_weight,
      body_weight_change,
      win_popularity: winPopularity,
    },
  };
}

function jraResultHtmlParsePayouts(refundAreaEl) {
  const payouts = {};
  if (!refundAreaEl) return payouts;
  refundAreaEl.querySelectorAll("dl").forEach((dl) => {
    const li = dl.closest("li");
    const cls = Array.from(li?.classList || []).find((c) => JRA_RESULT_HTML_BET_TYPE_BY_CLASS[c]);
    const type = cls ? JRA_RESULT_HTML_BET_TYPE_BY_CLASS[cls] : null;
    if (!type) return;
    dl.querySelectorAll(".line").forEach((line) => {
      const comboText = jraResultHtmlText(line.querySelector(".num"));
      const yenText = jraResultHtmlText(line.querySelector(".yen"));
      let combo = comboText.split("-").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 18);
      if (type === "tan" || type === "fuku") combo = combo.slice(0, 1);
      const rate = Number(yenText.replace(/[,円]/g, ""));
      if (!combo.length || !Number.isFinite(rate)) return;
      if (!payouts[type]) payouts[type] = [];
      payouts[type].push({ combo, rate });
    });
  });
  return payouts;
}

// 1レース分(.race_result_unit)を解析する。着順が1件も取れない場合はnullを返す
// (まだ確定していないレース、または想定外のDOM構造)。
function jraResultHtmlParseRaceUnit(unitEl) {
  const idMatch = (unitEl.id || "").match(/race_result_(\d+)R/);
  if (!idMatch) return null;
  const raceNumber = Number(idMatch[1]);

  const dateText = jraResultHtmlText(unitEl.querySelector(".date_line .cell.date"));
  const { race_date, track } = jraResultHtmlParseDateTrack(dateText);
  if (!race_date || !track) return null;

  const post_time = jraResultHtmlParsePostTime(jraResultHtmlText(unitEl.querySelector(".date_line .cell.time")));
  const { weather, track_condition } = jraResultHtmlParseWeather(unitEl.querySelector(".date_line .cell.baba"));

  const race_name = jraResultHtmlText(unitEl.querySelector(".race_title .race_name")) || null;
  const category = jraResultHtmlText(unitEl.querySelector(".type .category"));
  const klass = jraResultHtmlText(unitEl.querySelector(".type .class"));
  const rule = jraResultHtmlText(unitEl.querySelector(".type .rule"));
  const weightTypeCellText = jraResultHtmlText(unitEl.querySelector(".type .weight"));
  const weight_type = /^(馬齢|定量|別定|ハンデ)$/.test(weightTypeCellText) ? weightTypeCellText : null;
  const class_flags = [category, klass, rule].filter(Boolean).join(" ") || null;
  const { distance, course_type, course_direction } = jraResultHtmlParseCourse(
    jraResultHtmlText(unitEl.querySelector(".type .course"))
  );

  const entries = [];
  const race_results = [];
  const finishOrderSparse = [];

  unitEl.querySelectorAll(":scope > table.basic > tbody > tr").forEach((tr) => {
    const parsed = jraResultHtmlParseRow(tr);
    if (!parsed) return;
    entries.push(parsed.entry);
    race_results.push(parsed.raceResult);
    if (Number.isInteger(parsed.finishPosition)) {
      finishOrderSparse[parsed.finishPosition - 1] = parsed.entry.horse_number;
    }
  });

  if (!race_results.length) return null;

  // races.finish_order は的中判定に使う上位3着までのみ保持する
  // (public/jra-result-pdf.js の既存挙動に合わせる。docs/design/race-results.md参照)。
  const finish_order = finishOrderSparse.filter((v) => v !== undefined).slice(0, 3);
  const payouts = jraResultHtmlParsePayouts(unitEl.querySelector(".refund_area"));

  return {
    race_date,
    track,
    race_number: raceNumber,
    race_name,
    course_type,
    distance,
    weight_type,
    class_flags,
    course_direction,
    weather,
    track_condition,
    post_time,
    entries,
    finish_order,
    payouts,
    race_results,
  };
}

// ============================================================
// スマホ版(sp.jra.jp)向けパーサー(2026-09-13追加)。
// PC版(www.jra.go.jp)とはHTML構造が全く異なる(列の意味を表すクラス名を持つ
// 素直な<table>ではなく、着順以外の情報がumaTd列1つに<span>で詰め込まれた
// 4列構成)ため、専用の解析ロジックを別に用意している。レースの見出し情報
// (発走時刻・レース名・コース等)は<div id="kekkaRaceInfo_NR">に、着順表・
// 払戻表はその後に続く独立した<table>群(順に「レース結果」「タイム」「払戻金」)に
// 分かれている。詳細はdocs/design/results-import.md参照。
// ============================================================

const JRA_RESULT_HTML_MOBILE_BET_TYPE_BY_LABEL = {
  単勝: "tan",
  複勝: "fuku",
  枠連: "wakuren",
  馬連: "umaren",
  馬単: "umatan",
  ワイド: "wide",
  "3連複": "sanrenpuku",
  "3連単": "sanrentan",
};

// 例: "コース 1800m ダート・右発走9:45"(<br>はDOM上ではテキストに変換されないため
// 区切り文字が無く隣接テキストと連結されることがある) → distance/course_type/course_direction
function jraResultHtmlMobileParseCourse(text) {
  const distanceMatch = text.match(/(\d[\d,]*)\s*m\b/i);
  const typeMatch = text.match(/(芝|ダート|障害)/);
  const dirMatch = text.match(/[・･](左|右)/);
  return {
    distance: distanceMatch ? Number(distanceMatch[1].replace(/,/g, "")) : null,
    course_type: typeMatch ? typeMatch[1] : null,
    course_direction: dirMatch ? dirMatch[1] : null,
  };
}

// 例: "…発走9:45…" → "09:45"(PC版の「10時35分」と異なりコロン区切り表記)
function jraResultHtmlMobileParsePostTime(text) {
  const m = text.match(/発走(\d{1,2}):(\d{2})/);
  return m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : null;
}

// 例: "天候:曇ダート:不良"(区切り文字が無いため既知の値の閉集合でマッチさせる)
function jraResultHtmlMobileParseWeather(text) {
  const weatherMatch = text.match(/天候[:：](晴|曇|雨|小雨|雪|小雪|暴風雨|大雨)/);
  const condMatch = text.match(/(?:芝|ダート|障害)[:：](良|稍重|重|不良)/);
  return {
    weather: weatherMatch ? weatherMatch[1] : null,
    track_condition: condMatch ? condMatch[1] : null,
  };
}

// weight_type(馬齢/定量/別定/ハンデ)と、その手前のブラケット表記(例:"[指定]")をclass_flagsとして返す。
function jraResultHtmlMobileParseConditions(text) {
  const weightMatch = text.match(/(馬齢|定量|別定|ハンデ)/);
  const flagsMatch = text.match(/^\s*([^\d]*?)\s*(?:馬齢|定量|別定|ハンデ)/);
  return {
    weight_type: weightMatch ? weightMatch[1] : null,
    class_flags: flagsMatch && flagsMatch[1].trim() ? flagsMatch[1].trim() : null,
  };
}

// 1頭分の<tr>(td.tyakuTd/wakuTd/ubanTd/umaTd)を解析する。
function jraResultHtmlMobileParseRow(tr) {
  const placeText = jraResultHtmlText(tr.querySelector("td.tyakuTd"));
  const ubanMatch = jraResultHtmlText(tr.querySelector("td.ubanTd")).match(/\d+/);
  const horseNumber = ubanMatch ? Number(ubanMatch[0]) : NaN;
  if (!Number.isInteger(horseNumber)) return null;

  const wakuClass = tr.querySelector("td.wakuTd")?.className || "";
  const wakuMatch = wakuClass.match(/waku(\d+)/);
  const wakuNumber = wakuMatch ? Number(wakuMatch[1]) : null;

  const umaTd = tr.querySelector("td.umaTd");
  const horseName = umaTd ? jraResultHtmlText(umaTd.querySelector(".bamei")) || null : null;
  const ninkiText = umaTd ? jraResultHtmlText(umaTd.querySelector(".ninki")) : "";
  const winPopMatch = ninkiText.match(/(\d+)番人気/);

  // umaTd直下は [馬名a, span.ninki, br, span(性齢/馬体重), br, span(騎手/調教師), br, span(タイム)] の並び。
  // .ninki以外のspanを順番に取得する(除外行等はタイムのspanが無く2個になる)。
  const spans = umaTd ? Array.from(umaTd.querySelectorAll(":scope > span:not(.ninki)")) : [];
  const ageWeightText = spans[0] ? jraResultHtmlText(spans[0]) : "";
  const jockeyTrainerSpan = spans[1] || null;
  const timeText = spans[2] ? jraResultHtmlText(spans[2]) : "";

  const sexAgeMatch = ageWeightText.match(/(牡|牝|せん|セ|騸)\d+/);
  const bodyWeightMatch = ageWeightText.match(/(\d+)kg\s*[（(]([^)）]*)[)）]/);

  const jockeyAnchors = jockeyTrainerSpan ? Array.from(jockeyTrainerSpan.querySelectorAll("a")) : [];
  const jockeyLink = jockeyAnchors[0] || null;
  let jockeyMark = "";
  if (jockeyLink && jockeyLink.previousSibling && jockeyLink.previousSibling.nodeType === Node.TEXT_NODE) {
    jockeyMark = jockeyLink.previousSibling.textContent.trim();
  }
  const jockey = jockeyLink ? `${jockeyMark}${jraResultHtmlText(jockeyLink)}` : null;
  const weightCarriedMatch = jockeyTrainerSpan
    ? jraResultHtmlText(jockeyTrainerSpan).match(/\((\d+(?:\.\d+)?)\)/)
    : null;

  const status = JRA_RESULT_HTML_STATUS_BY_PLACE_TEXT[placeText] || "finished";
  const finishPosition = status === "finished" && /^\d+$/.test(placeText) ? Number(placeText) : null;

  // 例: "1:54.5(２)/39.8" → time="1:54.5" margin="２" furlong=39.8。1着は括弧無しで "1:54.2/39.6"。
  const timeMatch = timeText
    .replace(/ /g, " ")
    .match(/^([\d:.]+)\s*(?:[（(]([^)）]*)[)）])?\s*\/\s*([\d.]+)/);

  return {
    finishPosition,
    entry: {
      horse_number: horseNumber,
      waku_number: wakuNumber,
      horse_name: horseName,
      jockey,
      sex_age: sexAgeMatch ? sexAgeMatch[0] : null,
      weight_carried: weightCarriedMatch ? Number(weightCarriedMatch[1]) : null,
    },
    raceResult: {
      horse_number: horseNumber,
      horse_name: horseName,
      sex_age: sexAgeMatch ? sexAgeMatch[0] : null,
      weight_carried: weightCarriedMatch ? Number(weightCarriedMatch[1]) : null,
      jockey,
      status,
      finish_position: finishPosition,
      time_text: timeMatch ? timeMatch[1] : null,
      margin: timeMatch && timeMatch[2] ? timeMatch[2] : null,
      corner_positions: null, // スマホ版のレース結果表にはコーナー通過順位が無い
      final_furlong_time: timeMatch ? Number(timeMatch[3]) : null,
      body_weight: bodyWeightMatch ? Number(bodyWeightMatch[1]) : null,
      body_weight_change: bodyWeightMatch ? bodyWeightMatch[2] || null : null,
      win_popularity: winPopMatch ? Number(winPopMatch[1]) : null,
    },
  };
}

// 払戻金テーブル(th.scope=rowで式別、複勝/ワイドは3行にまたがりth省略)を解析する。
function jraResultHtmlMobileParsePayouts(payoutTable) {
  const payouts = {};
  if (!payoutTable) return payouts;
  let currentType = null;
  payoutTable.querySelectorAll("tbody > tr").forEach((tr) => {
    const th = tr.querySelector("th");
    if (th) currentType = JRA_RESULT_HTML_MOBILE_BET_TYPE_BY_LABEL[jraResultHtmlText(th)] || null;
    if (!currentType) return;
    const comboText = jraResultHtmlText(tr.querySelector(".horseNum"));
    const yenText = jraResultHtmlText(tr.querySelector(".dividend"));
    let combo = comboText.split("-").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 18);
    if (currentType === "tan" || currentType === "fuku") combo = combo.slice(0, 1);
    const rate = Number(yenText.replace(/[,円]/g, ""));
    if (!combo.length || !Number.isFinite(rate)) return;
    if (!payouts[currentType]) payouts[currentType] = [];
    payouts[currentType].push({ combo, rate });
  });
  return payouts;
}

// キャプション文字列が完全一致する<table>を探す。
function jraResultHtmlFindTableByCaption(tables, captionText) {
  return tables.find((t) => jraResultHtmlText(t.querySelector("caption")) === captionText);
}

// 1レース分(<div id="kekkaRaceInfo_NR">と、それに対応する結果/タイム/払戻の3テーブル)を解析する。
function jraResultHtmlMobileParseRaceUnit(headerDiv, allTables, dateTrack) {
  const idMatch = (headerDiv.id || "").match(/kekkaRaceInfo_(\d+)R/);
  if (!idMatch) return null;
  const raceNumber = Number(idMatch[1]);
  if (!dateTrack.race_date || !dateTrack.track) return null;

  const race_name = jraResultHtmlText(headerDiv.querySelector(".titleRaceNameNormal")) || null;
  const jokenText = jraResultHtmlText(headerDiv.querySelector(".kekkaRaceJoken"));
  const { weight_type, class_flags } = jraResultHtmlMobileParseConditions(jokenText);
  const { distance, course_type, course_direction } = jraResultHtmlMobileParseCourse(jokenText);
  const { weather, track_condition } = jraResultHtmlMobileParseWeather(jokenText);
  const post_time = jraResultHtmlMobileParsePostTime(jokenText);

  const resultTable = jraResultHtmlFindTableByCaption(allTables, `レース結果 ${raceNumber}レース`);
  if (!resultTable) return null;
  const resultIdx = allTables.indexOf(resultTable);
  // レースごとに「レース結果」「タイム」「払戻金」の3テーブルが連続して並ぶ固定構成。
  const payoutTable = allTables[resultIdx + 2];
  const isPayoutTable = payoutTable && jraResultHtmlText(payoutTable.querySelector("caption")) === "払戻金";

  const entries = [];
  const race_results = [];
  const finishOrderSparse = [];

  resultTable.querySelectorAll("tbody > tr").forEach((tr) => {
    if (!tr.querySelector("td.tyakuTd")) return; // ヘッダー行(th)をスキップ
    const parsed = jraResultHtmlMobileParseRow(tr);
    if (!parsed) return;
    entries.push(parsed.entry);
    race_results.push(parsed.raceResult);
    if (Number.isInteger(parsed.finishPosition)) {
      finishOrderSparse[parsed.finishPosition - 1] = parsed.entry.horse_number;
    }
  });

  if (!race_results.length) return null;

  const finish_order = finishOrderSparse.filter((v) => v !== undefined).slice(0, 3);
  const payouts = isPayoutTable ? jraResultHtmlMobileParsePayouts(payoutTable) : {};

  return {
    race_date: dateTrack.race_date,
    track: dateTrack.track,
    race_number: raceNumber,
    race_name,
    course_type,
    distance,
    weight_type,
    class_flags,
    course_direction,
    weather,
    track_condition,
    post_time,
    entries,
    finish_order,
    payouts,
    race_results,
  };
}

// root配下のスマホ版レース結果ページを解析する。
function jraResultHtmlParseMobilePage(root) {
  const scope = root || document;
  const allTables = Array.from(scope.querySelectorAll("table"));
  const records = [];
  const errors = [];
  let dateTrack = { race_date: null, track: null };
  const nodes = Array.from(scope.querySelectorAll("h2.subTitle, div[id^='kekkaRaceInfo_']"));

  nodes.forEach((node) => {
    if (node.tagName === "H2") {
      dateTrack = jraResultHtmlParseDateTrack(jraResultHtmlText(node));
      return;
    }
    try {
      const record = jraResultHtmlMobileParseRaceUnit(node, allTables, dateTrack);
      if (record) records.push(record);
    } catch (e) {
      errors.push({ id: node.id, message: String(e?.message || e) });
    }
  });

  const unitsFound = nodes.filter((n) => n.tagName !== "H2").length;
  return { records, diagnostics: { unitsFound, recordsParsed: records.length, errors } };
}

// root配下のJRAレース結果ページを解析する(未確定のレースは自然に除外される)。
// PC版(.race_result_unit)・スマホ版(div[id^="kekkaRaceInfo_"])のどちらの構造かを
// 自動判別して振り分ける。
function jraResultHtmlParsePage(root) {
  const scope = root || document;

  if (scope.querySelectorAll(".race_result_unit").length) {
    const units = Array.from(scope.querySelectorAll(".race_result_unit"));
    const records = [];
    const errors = [];
    units.forEach((unit) => {
      try {
        const record = jraResultHtmlParseRaceUnit(unit);
        if (record) records.push(record);
      } catch (e) {
        errors.push({ id: unit.id, message: String(e?.message || e) });
      }
    });
    return { records, diagnostics: { unitsFound: units.length, recordsParsed: records.length, errors } };
  }

  if (scope.querySelectorAll("div[id^='kekkaRaceInfo_']").length) {
    return jraResultHtmlParseMobilePage(scope);
  }

  return { records: [], diagnostics: { unitsFound: 0, recordsParsed: 0, errors: [] } };
}
