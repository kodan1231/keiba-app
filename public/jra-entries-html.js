// JRA公式サイトの出走馬一覧(出馬表)ページ(PC版 www.jra.go.jp/JRADB/accessD.html)の HTML を読み取る(2026-10-10追加)。
// 仕様は docs/design/netkeiba-bookmarklet.md「JRA公式ページ」。
//
// ブックマークレットでレース管理画面へ渡されたページを読み、出走馬一覧の取込API(POST /api/races/entries-import。
// 出走馬一覧PDFインポートと同じ)へ送るレコードにする。1ページに1開催日・1競馬場の全レースが入っている。
// 開催日・競馬場・コース・発走時刻の読み取りは、同じ作りの結果ページ用の public/jra-result-html.js の関数を使う。
//
// ページの構成(2026-10-10 に実物で確認): レースごとに <li id="syutsuba_11R"> があり、中に
//   .race_header(.date_line .cell.date「2026年10月10日（土曜） 4回京都3日」・.cell.time「発走時刻：9時50分」、
//   .race_title .race_name、.type .category/.class/.rule/.weight/.course)と、出走馬の表
//   (td.waku〈画像 alt「枠1白」〉/ td.num / td.horse / td.age / td.weight / td.jockey〈見習いの減量記号は span.mark〉/
//    td.trainer)がある。枠順確定前は td.waku・td.num が空。騎手・調教師はフルネーム。

function jraEntriesHtmlIsPage(doc) {
  return Boolean(doc.querySelector('li[id^="syutsuba_"]'));
}

function jraEntriesHtmlParseRow(tr) {
  const horseName = jraResultHtmlText(tr.querySelector("td.horse a")) || jraResultHtmlText(tr.querySelector("td.horse"));
  if (!horseName) return null;
  const numText = jraResultHtmlText(tr.querySelector("td.num")).match(/\d+/);
  const horseNumber = numText ? Number(numText[0]) : null;
  const jockeyTd = tr.querySelector("td.jockey");
  const mark = jraResultHtmlText(jockeyTd?.querySelector(".mark"));
  const jockeyName = jraResultHtmlText(jockeyTd?.querySelector("a")) ||
    jraResultHtmlText(jockeyTd).replace(mark, "").trim();
  const weight = Number((jraResultHtmlText(tr.querySelector("td.weight")).match(/\d+(?:\.\d+)?/) || [])[0]);
  return {
    horse_name: horseName,
    waku_number: jraResultHtmlParseWakuNumber(tr.querySelector("td.waku img")),
    horse_number: Number.isInteger(horseNumber) && horseNumber > 0 ? horseNumber : null,
    jockey: jockeyName ? `${mark}${jockeyName}` : null, // 見習いの減量記号は残す(出走馬一覧PDFと同じ表記)
    sex_age: jraResultHtmlText(tr.querySelector("td.age")) || null,
    weight_carried: Number.isFinite(weight) && weight > 0 ? weight : null,
    trainer: jraResultHtmlText(tr.querySelector("td.trainer a")) || jraResultHtmlText(tr.querySelector("td.trainer")) || null,
  };
}

// 戻り値: { records: [出走馬一覧の取込APIへ送るレコード], errors: [文字列] }
function jraEntriesHtmlParsePage(doc) {
  const records = [];
  const errors = [];
  doc.querySelectorAll('li[id^="syutsuba_"]').forEach((li) => {
    const m = (li.id || "").match(/syutsuba_(\d+)R/);
    if (!m) return;
    const raceNumber = Number(m[1]);
    const { race_date, track } = jraResultHtmlParseDateTrack(jraResultHtmlText(li.querySelector(".date_line .cell.date")));
    if (!race_date || !track) { errors.push(`${raceNumber}R: 開催日・競馬場を読み取れませんでした`); return; }
    const category = jraResultHtmlText(li.querySelector(".type .category"));
    const klass = jraResultHtmlText(li.querySelector(".type .class"));
    const rule = jraResultHtmlText(li.querySelector(".type .rule"));
    const weightText = jraResultHtmlText(li.querySelector(".type .weight"));
    const { distance, course_type, course_direction } = jraResultHtmlParseCourse(jraResultHtmlText(li.querySelector(".type .course")));
    const entries = [];
    li.querySelectorAll("table tbody tr").forEach((tr) => {
      const e = jraEntriesHtmlParseRow(tr);
      if (e) entries.push(e);
    });
    if (!entries.length) { errors.push(`${raceNumber}R: 出走馬を読み取れませんでした`); return; }
    records.push({
      race_date,
      track,
      race_number: raceNumber,
      race_name: jraResultHtmlText(li.querySelector(".race_title .race_name")) || null,
      course_type,
      distance,
      course_direction,
      weight_type: /^(馬齢|定量|別定|ハンデ)$/.test(weightText) ? weightText : null,
      class_flags: [category, klass, rule].filter(Boolean).join(" ") || null,
      post_time: jraResultHtmlParsePostTime(jraResultHtmlText(li.querySelector(".date_line .cell.time"))),
      entries,
    });
  });
  return { records, errors };
}
