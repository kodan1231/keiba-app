// JRA公式サイトの「出走馬一覧」PDF(枠番・馬番確定前/確定後 共通)を解析し、
// レース情報・出走馬(馬名・騎手・枠番・馬番)を一括登録するインポーター。
//
// 木曜(枠番・馬番未確定)/金曜(確定後)のいずれの状態のPDFも同じ形式のため、
// 同じ解析ロジック・同じインポート機能で対応する。枠番・馬番が印字されていない
// 場合はnullのままサーバーに送信し、サーバー側(functions/api/races/entries-import.js)
// で既存の出走馬情報と馬名をキーにマージする(詳細はdocs/DESIGN.md「出走馬一覧PDF
// インポート」参照)。
//
// 実装方針は既存の public/jra-result-pdf.js (レース結果PDFインポート) を踏襲するが、
// 実機未検証の結果PDFパーサーには手を入れず、独立ファイルとして新規作成している。
//
// 【既知の未検証事項→検証済み(2026-08-08)】枠番・馬番確定後の実PDFで検証した結果、
// **枠番は確定後PDFでも色付きアイコン表示のみでテキストとしては取得できない**ことが
// 判明した(JRAレース結果PDFと同様の制約。docs/JRA_RESULT_PDF_IMPORT_PAYOUT_ISSUE_
// INVESTIGATION.md の同種の記述を参照)。行頭に「枠番→馬番」の2つの数字が並ぶという
// 当初の推測(jraEntriesParseHorseRow内の numPrefix2)は実際には発生しないが、
// 万一将来のPDF形式変更で現れた場合のフォールバックとして処理自体は残してある。
// 馬番は単独の数字として取得できる。
// また、負担重量・オッズが発表された状態のPDFでは行末に単勝オッズ(小数)が付加される
// ため、調教師名との境界を誤らないよう除去してから解析する。
// さらに、ブリンカー(B)等のバッジが付く馬は、実PDFのテキスト抽出時に馬番だけが
// 単独行になり、馬名以降が次の行に分離することが確認されている
// (jraEntriesParseExtractedPages側の「馬番だけの行を次行と結合する」処理で対応)。
// 調教師名は常に「姓 名」の2トークンという前提で騎手名との境界を判定している
// (外国人騎手のような1トークン名は騎手側で許容している)。この前提が崩れる表記が
// 実機で見つかった場合も同様に調整が必要。
//
// 2026-08-11追加: 性齢(sex_age)・負担重量(weight_carried)を抽出し、entriesへ含めて
// サーバーへ送信するようにした(docs/DESIGN.md「races.entriesへの性齢・負担重量の追加」
// 参照)。抽出済みの正規表現マッチ結果(牡/牝/せん/セ/騸 + 年齢 + kg)をそのまま流用する。

const JRA_ENTRIES_TRACKS = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];

function jraEntriesNormalizeUnit(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\u00a0|\u202F/g, " ")
    .replace(/[︓﹕]/g, ":")
    .replace(/[﹣－−―–—]/g, "-");
}
// 2026-08-09修正: 以前はここで `\s+` → 半角スペース1つ、という一律変換をしており、
// jraEntriesJoinRowItems が実測ギャップから慎重に判定した「タブ(列区切り)」の情報が
// この時点で握りつぶされていた。タブは騎手名/調教師名の境界を判定する重要な signal
// (jraEntriesParseHorseRow参照)のため、タブと半角スペースは別々に保ったまま
// 連続分だけを1文字に圧縮する。
function jraEntriesNormalizeLine(s) {
  return jraEntriesNormalizeUnit(s).replace(/ +/g, " ").replace(/\t+/g, "\t").trim();
}

// 行内テキストの連結。既存 public/jra-result-pdf.js の jraResultJoinRowItems と同じ
// 考え方(直前要素との実測ギャップにより連結/スペース/タブを判定する)。本パーサーの
// 正規表現はスペース・タブいずれも \s として扱うため、区別自体の重要性は低いが、
// 単語内部に余計な区切りが入って正規表現が不一致になる事故を防ぐために踏襲する。
//
// 2026-08-09: 特定の騎手(複数レースに繰り返し登場する乗り鞍の多い騎手)でのみ、
// 騎手名と調教師名の間の区切りが検出できず連結してしまう不具合が実機で報告された。
// PDF内で同一文字列(騎手名リンク)が繰り返し使われる場合、PDF側が描画データを
// 使い回す(キャッシュする)ことがあり、これによりPDF.jsが報告する文字幅(prev.w)が
// 実際の見た目と異なる値になり、幅に比例するしきい値計算が異常値に引きずられて
// 本来検出すべき区切りを見逃す可能性が考えられる(未確証・実機の実測値による
// 検証が必要)。保険として、幅に比例する側のしきい値に上限を設け、
// 万一prev.wが異常に大きく報告された場合でもしきい値が際限なく大きくならないようにする。
const JRA_E_GAP_SPACE_RATIO = 0.3;
const JRA_E_GAP_TAB_RATIO = 1.2;
const JRA_E_GAP_SPACE_MIN = 1.0;
const JRA_E_GAP_TAB_MIN = 6.0;
const JRA_E_GAP_SPACE_MAX = 3.5; // これを超える幅比例しきい値は採用しない(保険)
const JRA_E_GAP_TAB_MAX = 14.0;

function jraEntriesJoinRowItems(items) {
  let text = "";
  const gaps = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = item.x - (prev.x + (prev.w || 0));
      const spaceThreshold = Math.min(Math.max((prev.w || 0) * JRA_E_GAP_SPACE_RATIO, JRA_E_GAP_SPACE_MIN), JRA_E_GAP_SPACE_MAX);
      const tabThreshold = Math.min(Math.max((prev.w || 0) * JRA_E_GAP_TAB_RATIO, JRA_E_GAP_TAB_MIN), JRA_E_GAP_TAB_MAX);
      let sep = "";
      if (gap > tabThreshold) sep = "\t";
      else if (gap > spaceThreshold) sep = " ";
      text += sep;
      gaps.push({ gap: Math.round(gap * 100) / 100, sep: sep === "\t" ? "TAB" : (sep === " " ? "SPACE" : "連結"), prevWidth: Math.round((prev.w || 0) * 100) / 100, prevStr: prev.str, curStr: item.str });
    }
    text += item.str;
  }
  return { text, gaps };
}

function jraEntriesFindMeeting(text) {
  const s = jraEntriesNormalizeUnit(text);
  const m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日.*?(\d+)\s*回\s*(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d+)\s*日/);
  if (!m) return null;
  return { date: `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`, track: m[5] };
}
function jraEntriesFindMeetingLoose(text) {
  const s = jraEntriesNormalizeUnit(text);
  const meeting = s.match(/(\d+)\s*回\s*(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d+)\s*日/);
  const dateM = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const date = dateM ? `${dateM[1]}-${String(dateM[2]).padStart(2, "0")}-${String(dateM[3]).padStart(2, "0")}` : null;
  if (!meeting && !date) return null;
  return { date, track: meeting ? meeting[2] : null };
}
function jraEntriesFindStartTime(text) {
  const s = jraEntriesNormalizeUnit(text);
  const m = s.match(/発\s*走\s*時\s*刻\s*[:：]?\s*(\d{1,2})\s*時\s*(\d{1,2})\s*分/);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}
function jraEntriesParseCourse(text) {
  const s = jraEntriesNormalizeUnit(text).replace(/\s+/g, " ");
  const m = s.match(/コ\s*ー\s*ス\s*[:：]?\s*([0-9,]+)\s*メ\s*ー\s*ト\s*ル\s*[（(]?\s*(芝|ダート|障害)/);
  return m ? { course_type: m[2], distance: Number(m[1].replace(/,/g, "")) } : { course_type: null, distance: null };
}

// レース条件詳細(斤量区分・条件フラグ・回り)の抽出(2026-08-11追加)。
// 例: "2歳 未勝利（混合）［指定］ 馬齢 コース：1,600メートル（芝・左）"
//   → weight_type="馬齢", class_flags="未勝利（混合）［指定］", course_direction="左"
function jraEntriesParseConditions(text) {
  const s = jraEntriesNormalizeUnit(text).replace(/\s+/g, " ");
  let weight_type = null;
  const wt = s.match(/(馬齢|定量|別定|ハンデ)/);
  if (wt) weight_type = wt[1];

  let course_direction = null;
  const dir = s.match(/[（(]\s*(芝|ダート|障害)\s*[・･]\s*(左|右)\s*[)）]/);
  if (dir) course_direction = dir[2];

  // class_flags: 年齢条件〜斤量区分の手前までの生テキスト(コース情報を除く)。
  // 例: "2歳 未勝利（混合）［指定］" の部分だけを取り出す。
  let class_flags = null;
  const cf = s.match(/^\s*(\S.*?)\s*(?:馬齢|定量|別定|ハンデ)\s*コース/);
  if (cf) class_flags = cf[1].trim() || null;

  return { weight_type, class_flags, course_direction };
}

// 天候・馬場状態の抽出(2026-08-11追加)。結果PDFにのみ出現する行:
// 例: "天候 晴 ダート 良" → weather="晴", track_condition="良"
function jraEntriesParseWeather(text) {
  const s = jraEntriesNormalizeUnit(text).replace(/\s+/g, " ");
  const m = s.match(/天候\s*([^\s]+)\s*(芝|ダート|障害)\s*([^\s]+)/);
  if (!m) return { weather: null, track_condition: null };
  return { weather: m[1] || null, track_condition: m[3] || null };
}

// 出走馬1行を解析する。
// 例(枠番・馬番未確定): "アルデバローズ 牝3 55.0kg 横山 琉人 矢野 英一"
// 例(見習い減量記号)  : "ジーティービキニ 牝3 54.0kg ☆舟山 瑠泉 松下 武士"
// 例(外国人騎手)      : "アブキールベイ 牝4 55.5kg J.コレット 坂口 智史"
// 例(枠番・馬番確定後・未検証の想定形式): "1 3 アルデバローズ 牝3 55.0kg 横山 琉人 矢野 英一"
//
// 2026-08-09修正: 以前は先頭で `.replace(/\t/g, " ")` によりタブ(列区切りの情報)を
// 早期に握りつぶしていたため、後段の騎手名/調教師名の境界判定がトークン数だけに
// 頼った「推測」になっていた(特定の騎手で区切りを誤検出する不具合の一因)。
// タブは jraEntriesJoinRowItems が実測ギャップから「列の区切り」と判定した信頼度の
// 高い情報のため、優先的に利用する(タブが無い場合のみトークン数ヒューリスティックへ
// フォールバックする)。
//
// 2026-08-11追加: 性齢(sex_age)・負担重量(weight_carried)も戻り値に含める。
function jraEntriesParseHorseRow(rawLine) {
  const s = jraEntriesNormalizeLine(rawLine);
  if (!s) return null;

  let wakuNumber = null;
  let horseNumber = null;
  let rest = s;

  // 行頭の「枠番 馬番」を試みる(未検証の想定形式。上記コメント参照)。
  const numPrefix2 = rest.match(/^([1-8])\s+(\d{1,2})\s+(.+)$/);
  if (numPrefix2 && /^(.+?)\s+(牡|牝|せん|セ|騸)\s*\d{1,2}\s+[\d.]+\s*kg/.test(numPrefix2[3])) {
    wakuNumber = Number(numPrefix2[1]);
    horseNumber = Number(numPrefix2[2]);
    rest = numPrefix2[3];
  } else {
    // 馬番のみが先頭にあるケースも一応許容する。
    const numPrefix1 = rest.match(/^(\d{1,2})\s+(.+)$/);
    if (numPrefix1 && /^(.+?)\s+(牡|牝|せん|セ|騸)\s*\d{1,2}\s+[\d.]+\s*kg/.test(numPrefix1[2])) {
      horseNumber = Number(numPrefix1[1]);
      rest = numPrefix1[2];
    }
  }

  const m = rest.match(/^(.+?)\s+(牡|牝|せん|セ|騸)\s*(\d{1,2})\s+([\d.]+)\s*kg\s+(.+)$/);
  if (!m) return null;

  const horseName = m[1].trim();
  const sexAge = `${m[2]}${m[3]}`;
  const weightCarried = Number(m[4]);
  let tail = m[5].trim();

  // 見習い減量記号(☆▲△★◇)。以前はここで除去して捨てていたが、JRA表記に合わせて
  // 騎手名の先頭に残すよう変更する(2026-08-09〜)。
  const markMatch = tail.match(/^([☆▲△★◇])\s*(.+)$/);
  const apprenticeMark = markMatch ? markMatch[1] : "";
  if (markMatch) tail = markMatch[2].trim();

  // 末尾の単勝オッズ(小数。例: "15.9")が付いている場合は取り除く。オッズが発表された
  // 状態のPDF(枠番・馬番確定後によく見られる)では「騎手名 調教師名 単勝オッズ」の
  // 順で並ぶため、これを除去せずに末尾2トークンを調教師名とすると、調教師名の一部が
  // 騎手名側に押し出されてしまう不具合があった(2026-08-08修正)。単勝オッズ自体は
  // 保存しない方針(docs/DESIGN.md参照)のため、ここでは境界判定のためだけに除去する。
  tail = tail.replace(/\s+[\d,]+\.\d+\s*$/, "");

  let jockey, trainer;

  // 最優先: タブ(列区切り)が残っていれば、それを騎手名/調教師名/(オッズ)の境界として使う。
  if (tail.includes("\t")) {
    const tabParts = tail.split("\t").map((p) => p.trim()).filter(Boolean);
    while (tabParts.length > 2 && /^[\d,]+\.\d+$/.test(tabParts[tabParts.length - 1])) tabParts.pop();
    if (tabParts.length >= 2) {
      jockey = tabParts[0];
      trainer = tabParts.slice(1).join(" ");
    }
  }

  // タブが無い(または不十分な)場合は、トークン数から推測する(以前からのフォールバック)。
  if (!jockey || !trainer) {
    const tokens = tail.replace(/\t/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null; // 騎手・調教師のいずれかが読み取れない

    // 調教師名は通常「姓 名」の2トークンだが、PDF内のスペース幅が僅かで検出できず
    // 1トークンに結合されるケースが実PDFで確認されている(例: "浜中 俊 谷潔" → 本来は
    // 騎手名「浜中 俊」・調教師名「谷潔」。2026-08-08確認)。一方、外国人騎手名
    // (例: "J.コレット")のようにピリオドを含む1トークンの場合は騎手側が1トークンで
    // 調教師側が2トークンという逆パターンになる。トークン数だけでは一意に決まらないため、
    // 先頭トークンにピリオドを含むかどうかで判定する。
    if (tokens.length >= 4) {
      trainer = tokens.slice(-2).join(" ");
      jockey = tokens.slice(0, -2).join(" ");
    } else if (tokens.length === 3) {
      if (/[.．]/.test(tokens[0])) {
        jockey = tokens[0];
        trainer = `${tokens[1]} ${tokens[2]}`;
      } else {
        jockey = `${tokens[0]} ${tokens[1]}`;
        trainer = tokens[2];
      }
    } else {
      jockey = tokens[0];
      trainer = tokens[1];
    }
  }

  if (!horseName || !jockey) return null;

  return {
    horse_name: horseName,
    jockey: apprenticeMark ? `${apprenticeMark}${jockey}` : jockey,
    trainer, // 保存対象外(entries-import.js側で無視される。docs/BACKLOG.md参照)
    waku_number: wakuNumber,
    horse_number: horseNumber,
    sex_age: sexAge,
    weight_carried: Number.isFinite(weightCarried) ? weightCarried : null,
  };
}

const JRA_ENTRIES_PARSER_VERSION = "1.2.0-sexage-weight-conditions";

function jraEntriesParseExtractedPages(pages) {
  const lines = [];
  pages.forEach((page, pageIndex) => {
    page.forEach((row, rowIndex) => {
      const raw = typeof row === "string" ? row : (row?.text || "");
      const text = jraEntriesNormalizeLine(raw);
      if (text) lines.push({ text, page: pageIndex + 1, row: rowIndex + 1 });
    });
  });

  const diagnostics = {
    parserVersion: JRA_ENTRIES_PARSER_VERSION,
    pages: pages.length,
    rows: lines.length,
    meetingCandidates: 0,
    startTimeCandidates: 0,
    raceHeaders: 0,
    horseRowsDetected: 0,
    horseRowsFailed: 0,
    records: 0,
    errors: [],
    raceDiagnostics: [],
  };

  const headerCandidates = [];
  let ctxDate = null, ctxTrack = null;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].text;
    const meeting = jraEntriesFindMeeting(s) || jraEntriesFindMeetingLoose(s);
    if (meeting) {
      diagnostics.meetingCandidates++;
      if (meeting.date) ctxDate = meeting.date;
      if (meeting.track) ctxTrack = meeting.track;
    }
    const time = jraEntriesFindStartTime(s);
    if (time) {
      diagnostics.startTimeCandidates++;
      headerCandidates.push({ index: i, date: ctxDate, track: ctxTrack });
    }
  }
  diagnostics.raceHeaders = headerCandidates.filter((h) => h.date && h.track).length;

  const records = [];
  const counters = new Map();

  for (let hIndex = 0; hIndex < headerCandidates.length; hIndex++) {
    const h = headerCandidates[hIndex];
    if (!h.date || !h.track) continue;
    const next = headerCandidates[hIndex + 1];
    const end = next ? next.index : lines.length;
    const block = lines.slice(h.index, end);
    const key = `${h.date}__${h.track}`;
    const number = (counters.get(key) || 0) + 1;
    counters.set(key, number);

    const raceDiag = { key: `${h.date} ${h.track} ${number}R`, entries: 0, errors: [] };

    // レース名・コースは「出走馬表(枠 馬番 馬名…)」の見出し行より前にしか現れないため、
    // 探索範囲をその行までに限定する(以前は固定で先頭15行を見ていたため、開催情報の行数が
    // 少ないレースで出走馬の行を誤ってレース名として拾ってしまう不具合があった)。
    const tableHeaderIndex = block.findIndex((l) => /^枠\s*馬番\s*馬名/.test(l.text));
    const metaScanEnd = tableHeaderIndex >= 0 ? tableHeaderIndex : Math.min(block.length, 15);
    let raceName = null, courseType = null, distance = null;
    let weightType = null, classFlags = null, courseDirection = null;
    for (let i = 1; i < metaScanEnd; i++) {
      const s = block[i].text;
      const course = jraEntriesParseCourse(s);
      if (course.course_type && !courseType) { courseType = course.course_type; distance = course.distance; }
      if (/コ\s*ー\s*ス\s*[:：]/.test(s) || /メートル/.test(s)) {
        const cond = jraEntriesParseConditions(s);
        if (cond.weight_type && !weightType) weightType = cond.weight_type;
        if (cond.class_flags && !classFlags) classFlags = cond.class_flags;
        if (cond.course_direction && !courseDirection) courseDirection = cond.course_direction;
      }
      // 「3歳未勝利」「2歳新馬」のように数字+歳で始まるレース名は多いため、
      // 「◯歳」始まりであること自体では除外しない。条件行(例: 「3歳 未勝利牝［指定］
      // 馬齢 コース：1,700メートル…」)は「メートル」を含むため、そちらの除外だけで十分。
      if (
        !raceName && s.length >= 2 && s.length <= 60 &&
        !/^(本賞金|枠\s*馬番|馬名|コース|発走)/.test(s) &&
        !/^\d{4}年/.test(s) && !jraEntriesFindStartTime(s) &&
        !/メートル/.test(s) &&
        !jraEntriesParseHorseRow(s) // 出走馬の行を誤ってレース名としない
      ) {
        raceName = s;
      }
    }

    const entries = [];
    let inTable = false;
    // ブリンカー(B)等のバッジが付く馬は、実PDFのテキスト抽出時に馬番だけが単独行になり、
    // 馬名以降が次の行に分離することが確認されている(2026-08-08確認)。単独の数字だけの
    // 行が来たら「保留中の馬番」として記憶しておき、次の行と結合してから解析する。
    let pendingHorseNumber = null;
    for (let i = 0; i < block.length; i++) {
      const line = block[i].text;
      if (/^枠\s*馬番\s*馬名/.test(line)) { inTable = true; continue; }
      if (!inTable) continue;
      if (/ページトップへ戻る/.test(line) || jraEntriesFindStartTime(line)) { inTable = false; pendingHorseNumber = null; continue; }
      if (!line) continue;
      // ページをまたぐレースの場合、次ページのフッター/ヘッダー行(URL・タイムスタンプ等)が
      // inTable=trueの間に紛れ込むことがある。これらは馬名行として解析されず失敗カウントに
      // 計上されるだけで実害はないが、診断情報のノイズになるため事前に除外する。
      if (/^https?:\/\//.test(line) || /出走馬一覧\s*JRA$/.test(line) || /^\d{4}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}/.test(line)) continue;

      const bareNumber = line.match(/^(\d{1,2})$/);
      if (bareNumber) { pendingHorseNumber = Number(bareNumber[1]); continue; }

      const lineToParse = pendingHorseNumber !== null ? `${pendingHorseNumber} ${line}` : line;
      const horse = jraEntriesParseHorseRow(lineToParse);
      pendingHorseNumber = null;
      if (horse) {
        entries.push(horse);
        diagnostics.horseRowsDetected++;
      } else {
        diagnostics.horseRowsFailed++;
      }
    }

    raceDiag.entries = entries.length;
    raceDiag.raceName = raceName;
    if (!entries.length) raceDiag.errors.push("出走馬情報を取得できませんでした");

    if (entries.length) {
      records.push({
        race_date: h.date, track: h.track, race_number: number,
        race_name: raceName, course_type: courseType, distance,
        weight_type: weightType, class_flags: classFlags, course_direction: courseDirection,
        entries: entries.map(({ trainer, ...rest }) => rest), // trainerは今回のフェーズでは送信しない(BACKLOG参照)
      });
    }
    diagnostics.raceDiagnostics.push(raceDiag);
  }

  diagnostics.records = records.length;
  if (!diagnostics.raceHeaders) {
    diagnostics.errors.push("レース開始(発走時刻)を1件も検出できませんでした。");
  }

  return { records, diagnostics };
}

async function jraEntriesExtractPdfPages(file, log = () => {}) {
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
    log(`ページ ${p}/${pdf.numPages} 抽出開始`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent({ disableCombineTextItems: false });
    const items = content.items.filter((x) => x.str && x.str.trim()).map((x) => ({
      str: jraEntriesNormalizeUnit(x.str), x: x.transform[4], y: x.transform[5], w: x.width || 0,
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
      return { text: jraEntriesJoinRowItems(sortedItems).text, y: r.y };
    }));
    log(`ページ ${p} 抽出完了 items=${items.length} rows=${rows.length}`);
  }
  return { pages, pdfPages: pdf.numPages };
}

function jraEntriesRenderDiagnostics(d) {
  const raceRows = (d.raceDiagnostics || []).map((r) => {
    const err = r.errors?.length ? `<ul>${r.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "なし";
    return `<tr><td>${escapeHtml(r.key)}</td><td>${escapeHtml(r.raceName || "")}</td><td>${r.entries}</td><td>${err}</td></tr>`;
  }).join("");
  return `<details open style="margin-top:10px"><summary>解析診断情報（出走馬一覧 Parser ${JRA_ENTRIES_PARSER_VERSION}）</summary>
  <div class="picker-hint">
  PDFページ数: ${d.pages}<br>
  抽出行数: ${d.rows}<br>
  開催情報候補: ${d.meetingCandidates}<br>
  発走時刻候補: ${d.startTimeCandidates}<br>
  レース開始検出: ${d.raceHeaders}<br>
  出走馬行 検出: ${d.horseRowsDetected} / 解析失敗: ${d.horseRowsFailed}<br>
  有効レース: ${d.records}
  </div>
  ${d.errors?.length ? `<details open><summary>解析エラー・警告 (${d.errors.length})</summary><ul>${d.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></details>` : ""}
  <details><summary>レース別解析結果 (${(d.raceDiagnostics || []).length})</summary>
    <div style="overflow:auto"><table><thead><tr><th>レース</th><th>レース名</th><th>出走馬数</th><th>問題</th></tr></thead><tbody>${raceRows || "<tr><td colspan='4'>解析結果なし</td></tr>"}</tbody></table></div>
  </details>
  </details>`;
}

const jraEntriesImportModal = document.getElementById("jra-entries-import-modal");
const jraEntriesImportFile = document.getElementById("jra-entries-pdf-file");
const jraEntriesImportPreview = document.getElementById("jra-entries-import-preview");
const jraEntriesImportSubmit = document.getElementById("jra-entries-import-submit-btn");
const jraEntriesImportMessage = document.getElementById("jra-entries-import-message");
let jraEntriesParsedRecords = [];

document.getElementById("jra-entries-import-btn")?.addEventListener("click", () => {
  jraEntriesImportFile.value = "";
  jraEntriesImportPreview.innerHTML = "";
  jraEntriesImportMessage.hidden = true;
  jraEntriesImportSubmit.disabled = true;
  jraEntriesParsedRecords = [];
  jraEntriesImportModal.hidden = false;
});
document.getElementById("jra-entries-import-cancel-btn")?.addEventListener("click", () => { jraEntriesImportModal.hidden = true; });
jraEntriesImportModal?.addEventListener("click", (e) => { if (e.target === jraEntriesImportModal) jraEntriesImportModal.hidden = true; });

jraEntriesImportFile?.addEventListener("change", () => {
  jraEntriesImportPreview.innerHTML = "";
  jraEntriesImportMessage.hidden = true;
  jraEntriesImportSubmit.disabled = true;
  jraEntriesParsedRecords = [];
});

document.getElementById("jra-entries-parse-btn")?.addEventListener("click", async () => {
  const file = jraEntriesImportFile.files?.[0];
  if (!file) { alert("PDFファイルを選択してください"); return; }
  jraEntriesImportSubmit.disabled = true;
  jraEntriesImportPreview.innerHTML = `<p>解析中です…<br>解析エンジン: ${JRA_ENTRIES_PARSER_VERSION}</p>`;
  const logs = [];
  const log = (message) => {
    logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
    console.log("[JRA Entries PDF]", message);
  };
  try {
    log(`START file=${file.name} size=${file.size}`);
    const extracted = await jraEntriesExtractPdfPages(file, log);
    log(`EXTRACT DONE pages=${extracted.pdfPages}`);
    const parsed = jraEntriesParseExtractedPages(extracted.pages);
    log(`PARSE DONE headers=${parsed.diagnostics.raceHeaders} records=${parsed.records.length}`);
    jraEntriesParsedRecords = parsed.records;

    const totalHorses = jraEntriesParsedRecords.reduce((s, r) => s + r.entries.length, 0);
    const confirmedCount = jraEntriesParsedRecords.reduce((s, r) => s + r.entries.filter((e) => e.horse_number !== null).length, 0);
    const logHtml = logs.map((x) => `<li>${escapeHtml(x)}</li>`).join("");

    jraEntriesImportPreview.innerHTML = `<p>解析結果：<strong>${jraEntriesParsedRecords.length}レース</strong>（出走馬 計${totalHorses}頭、うち枠番・馬番確定済み ${confirmedCount}頭）</p>
    ${jraEntriesRenderDiagnostics(parsed.diagnostics)}
    <details><summary>実行ログ (${logs.length})</summary><pre style="white-space:pre-wrap">${escapeHtml(logs.join("\n"))}</pre></details>
    <div class="import-preview-list">${jraEntriesParsedRecords.map((r) => {
      return `<div class="import-preview-row"><strong>${escapeHtml(r.race_date)} ${escapeHtml(r.track)} ${r.race_number}R</strong> ${escapeHtml(r.race_name || "")} <span>出走馬 ${r.entries.length}頭 / 枠番・馬番${r.entries.some((e) => e.horse_number !== null) ? "あり" : "なし"}</span></div>`;
    }).join("")}</div>`;
    jraEntriesImportSubmit.disabled = jraEntriesParsedRecords.length === 0;
  } catch (e) {
    console.error("[JRA Entries PDF] import failed", e);
    jraEntriesImportPreview.innerHTML = `<p class="error-text">解析中にエラーが発生しました: ${escapeHtml(e.message || String(e))}</p><details open><summary>実行ログ</summary><pre style="white-space:pre-wrap">${escapeHtml(logs.join("\n"))}</pre></details>`;
  }
});

jraEntriesImportSubmit?.addEventListener("click", async () => {
  if (!jraEntriesParsedRecords.length) return;
  if (!confirm(`${jraEntriesParsedRecords.length}レースの出走馬情報を登録します。既存レースは馬名をキーにマージされます。実行しますか？`)) return;
  jraEntriesImportSubmit.disabled = true;
  jraEntriesImportMessage.hidden = false;
  jraEntriesImportMessage.textContent = "登録中です…";
  try {
    const res = await authedFetch("/api/races/entries-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ races: jraEntriesParsedRecords }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "一括登録に失敗しました");

    const created = (data.results || []).filter((x) => x.status === "created").length;
    const updated = (data.results || []).filter((x) => x.status === "updated").length;
    const allConflicts = (data.results || []).flatMap((x) => (x.conflicts || []).map((c) => ({ key: x.key, ...c })));

    let message = `出走馬一覧を登録しました。\n新規登録：${created}レース\n既存更新：${updated}レース`;
    if (allConflicts.length) {
      const lines = allConflicts.map((c) =>
        `  ${c.key} / ${c.horse_name}: 既存${c.field === "waku_number" ? "枠番" : "馬番"}=${c.existing} → 取込値=${c.incoming}(競合のため更新していません)`
      );
      message += `\n\n⚠️ ${allConflicts.length}件の枠番・馬番の競合がありました(自動更新していません。手動確認してください)：\n${lines.join("\n")}`;
    }
    alert(message);
    jraEntriesImportModal.hidden = true;
    await loadRaces();
  } catch (e) {
    console.error("[JRA Entries PDF] registration failed", e);
    alert(e.message || String(e));
    jraEntriesImportSubmit.disabled = false;
  }
});
