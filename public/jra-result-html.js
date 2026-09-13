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

// root配下の.race_result_unitをすべて解析する(未確定のレースは自然に除外される)。
function jraResultHtmlParsePage(root) {
  const units = Array.from((root || document).querySelectorAll(".race_result_unit"));
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
