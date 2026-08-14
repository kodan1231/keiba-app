const JRA_RESULT_PDF_TRACKS = ["札幌","函館","福島","新潟","東京","中山","中京","京都","阪神","小倉"];
const JRA_RESULT_BET_MAP = {
  "単勝": "tan", "複勝": "fuku", "枠連": "wakuren", "馬連": "umaren", "馬単": "umatan",
  "ワイド": "wide", "3連複": "sanrenpuku", "3連単": "sanrentan"
};

function jraResultNormalizeUnit(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\u00a0|\u2000-\u200B|\u202F/g, " ")
    .replace(/[︓﹕]/g, ":")
    .replace(/[︵]/g, "(").replace(/[︶]/g, ")")
    .replace(/[﹣－−―–—]/g, "-");
}

function jraResultNormalizeLine(s) {
  return jraResultNormalizeUnit(s).replace(/\s+/g, " ").trim();
}

// ---------- 行内テキストの連結 ----------
// PDF.jsが返す各テキスト断片は、見た目の間隔(スペースの有無)と1対1で対応しない。
// 断片を間隔の大小を見ずに一律タブで連結すると、「発」と「走」の間、「２０２６」と
// 「年」の間のように、本来隙間なく続く1つの単語の途中にもタブが挿入されてしまい、
// 「文字同士が隙間なく連続している」ことを前提とする正規表現(発走時刻・年月日・
// 開催回など)が軒並み不一致になる。
// 直前の要素の右端から今回の要素の左端までの実際の隙間(gap)を計測し、
//   - 隙間がごく小さい(同一単語内の文字とみなせる) → 連結(区切り文字なし)
//   - 隙間が単語区切り相当           → 半角スペースで連結
//   - 隙間が列区切り相当(表組みのセル間など) → タブで連結(表構造の解析に必要)
// の3段階に振り分ける。
const JRA_GAP_SPACE_RATIO = 0.3; // 直前文字幅に対し、これを超える隙間はスペース区切りとみなす
const JRA_GAP_TAB_RATIO = 1.2;   // 直前文字幅に対し、これを超える隙間は列(タブ)区切りとみなす
const JRA_GAP_SPACE_MIN = 1.0;   // 直前文字幅が極小(記号1文字等)の場合の、スペース判定の最低基準(pt)
const JRA_GAP_TAB_MIN = 6.0;     // 同上、タブ判定の最低基準(pt)

function jraResultJoinRowItems(items) {
  let text = "";
  const gaps = []; // 閾値調整・診断用: 各要素間の実測ギャップと判定結果
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = item.x - (prev.x + (prev.w || 0));
      const spaceThreshold = Math.max((prev.w || 0) * JRA_GAP_SPACE_RATIO, JRA_GAP_SPACE_MIN);
      const tabThreshold = Math.max((prev.w || 0) * JRA_GAP_TAB_RATIO, JRA_GAP_TAB_MIN);
      let sep = "";
      if (gap > tabThreshold) sep = "\t";
      else if (gap > spaceThreshold) sep = " ";
      text += sep;
      gaps.push({ gap: Math.round(gap * 100) / 100, sep: sep === "\t" ? "TAB" : (sep === " " ? "SPACE" : "連結") });
    }
    text += item.str;
  }
  return { text, gaps };
}

function jraResultParseDate(text) {
  const m = jraResultNormalizeUnit(text).match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return m ? `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}` : null;
}

function jraResultParseTrack(text) {
  const s = jraResultNormalizeUnit(text);
  return JRA_RESULT_PDF_TRACKS.find(t => s.includes(t)) || null;
}

function jraResultParseCourse(text) {
  const s = jraResultNormalizeUnit(text);
  const m = s.match(/コ\s*ー\s*ス\s*[:：]?\s*([0-9,]+)\s*メ\s*ー\s*ト\s*ル\s*[（(]\s*(芝|ダート|障害)/);
  return m ? { course_type: m[2], distance: Number(m[1].replace(/,/g,"")) } : {course_type:null,distance:null};
}

// レース条件詳細(斤量区分・条件フラグ・回り)の抽出(2026-08-11追加)。
// 例: "3歳 未勝利（混合）［指定］ 馬齢 コース：1,400メートル（ダート・右）"
//   → weight_type="馬齢", class_flags="3歳 未勝利（混合）［指定］", course_direction="右"
// public/jra-entries-pdf.js の jraEntriesParseConditions と同じ考え方(実装は
// グローバル名の衝突を避けるためこのファイル内に独立して持つ)。
function jraResultParseConditions(text) {
  const s = jraResultNormalizeUnit(text).replace(/\s+/g, " ");
  let weight_type = null;
  const wt = s.match(/(馬齢|定量|別定|ハンデ)/);
  if (wt) weight_type = wt[1];

  let course_direction = null;
  const dir = s.match(/[（(]\s*(芝|ダート|障害)\s*[・･]\s*(左|右)\s*[)）]/);
  if (dir) course_direction = dir[2];

  let class_flags = null;
  const cf = s.match(/^\s*(\S.*?)\s*(?:馬齢|定量|別定|ハンデ)\s*コース/);
  if (cf) class_flags = cf[1].trim() || null;

  return { weight_type, class_flags, course_direction };
}

// 天候・馬場状態の抽出(2026-08-11追加)。結果PDFにのみ出現する行:
// 例: "天候 晴 ダート 良" → weather="晴", track_condition="良"
function jraResultParseWeather(text) {
  const s = jraResultNormalizeUnit(text).replace(/\s+/g, " ");
  const m = s.match(/天候\s*([^\s]+)\s*(芝|ダート|障害)\s*([^\s]+)/);
  if (!m) return { weather: null, track_condition: null };
  return { weather: m[1] || null, track_condition: m[3] || null };
}

function jraResultParseNumberList(raw) {
  return String(raw).split(/[-,、]/).map(x => Number(x.trim())).filter(Number.isInteger);
}

function jraResultCreateRace(date, track, number) {
  return {
    race_date: date, track, race_number: number,
    race_name: null, course_type: null, distance: null,
    weight_type: null, class_flags: null, course_direction: null,
    weather: null, track_condition: null,
    entries: [], finish_order: [], payouts: {}, refunds: [],
    race_results: [], // 2026-08-11追加: 馬単位の確定結果(全着順・タイム・馬体重等)
  };
}

function jraResultPayoutTypeAt(text, pos) {
  const labels = [
    ["sanrentan","3連単"],["sanrenpuku","3連複"],["umatan","馬単"],
    ["umaren","馬連"],["wakuren","枠連"],["wide","ワイド"],
    ["fuku","複勝"],["tan","単勝"]
  ];
  let best = null;
  for (const [type,label] of labels) {
    const idx = text.indexOf(label, pos);
    if (idx >= 0 && (!best || idx < best.index)) best = {type,label,index:idx};
  }
  return best;
}

function jraResultAddPayout(r, type, label, rate) {
  if (!r || !type || !Number.isFinite(rate)) return;
  const nums = String(label).split(/[-,、]/).map(Number).filter(Number.isInteger);
  if (!nums.length || nums.some(n => n < 1 || n > 18)) return;
  const combo = (type === "tan" || type === "fuku") ? [nums[0]] : nums;
  (r.payouts[type] ||= []).push({label:String(label), combo, rate});
}

// 払戻表の式別と組み合わせの頭数(1頭/2頭/3頭)の対応。
// ラベルの無い継続データがどの式別に属するかを判定する際に使う。
const JRA_PAYOUT_TYPE_COMBO_SIZE = { tan:1, fuku:1, wakuren:2, wide:2, umaren:2, umatan:2, sanrenpuku:3, sanrentan:3 };

// 払戻表は「単勝/複勝」「枠連/ワイド」「馬連/馬単/3連複/3連単」の3列レイアウトの
// グリッド構造になっており、複勝・ワイドのように複数行にまたがる式別は、2行目
// 以降にラベルが再印字されない(例: 複勝の2・3件目は先頭に馬番・金額だけが続き、
// 「複勝」という文字は無い)。単一の「直前の式別」だけでは、1行の中に複数の列の
// 継続データ(例: 複勝の3件目と、ワイドの2件目)が同時に現れる行を区別できないため、
// ラベルの無い継続データは「組み合わせの頭数(1頭/2頭/3頭)」で直前の式別を引き継ぐ
// 方式にする。単勝・馬連・馬単・3連複・3連単は基本的に1行で完結する(継続行を
// 持たない)ため、同じ頭数でもラベル無しの継続データは実質的に複勝・枠連・
// ワイドのいずれかにしかならない。
// carryState: {1: 直前の1頭式別, 2: 直前の2頭式別, 3: 直前の3頭式別}
function jraResultParsePayoutLine(r, rawLine, carryState) {
  const state = { 1: carryState?.[1] ?? null, 2: carryState?.[2] ?? null, 3: carryState?.[3] ?? null };
  const text = jraResultNormalizeLine(rawLine);
  if (!text) return { count: 0, carryState: state };

  const labels = [
    ["3連単","sanrentan"],["3連複","sanrenpuku"],["単勝","tan"],["複勝","fuku"],
    ["枠連","wakuren"],["馬連","umaren"],["馬単","umatan"],["ワイド","wide"]
  ];
  const found = [];
  for (const [label,type] of labels) {
    let p = text.indexOf(label);
    while (p >= 0) { found.push({label,type,index:p}); p=text.indexOf(label,p+label.length); }
  }
  found.sort((a,b)=>a.index-b.index);

  const hasYen = /円/.test(text);
  let count = 0;

  // ラベルが分からない区間: 組み合わせの頭数から直前の式別を引き継いで判定する。
  const extractBySize = (segment) => {
    if (!hasYen) return;
    const matches=[...segment.matchAll(/(\d+(?:\s*[-,、]\s*\d+){0,2})\s+([0-9,]+)\s*円/g)];
    for (const m of matches) {
      const nums = m[1].replace(/\s+/g,'').split(/[-,、]/).filter(Boolean);
      const type = state[nums.length];
      if (!type) continue; // 該当する頭数の式別がまだ判明していない場合は無視(誤爆防止)
      jraResultAddPayout(r, type, m[1].replace(/\s+/g,''), Number(m[2].replace(/,/g,'')));
      count++;
    }
  };

  // ラベルが分かっている区間: その式別で抽出し、carryStateも更新する。
  const extractForType = (segment, type) => {
    const size = JRA_PAYOUT_TYPE_COMBO_SIZE[type];
    if (size) state[size] = type;
    if (!hasYen) return;
    const matches=[...segment.matchAll(/(\d+(?:\s*[-,、]\s*\d+){0,2})\s+([0-9,]+)\s*円/g)];
    for (const m of matches) {
      jraResultAddPayout(r, type, m[1].replace(/\s+/g,''), Number(m[2].replace(/,/g,'')));
      count++;
    }
  };

  if (found.length === 0) {
    // この行にラベルが1つも無い(継続行)。
    extractBySize(text);
    return { count, carryState: state };
  }

  // 最初のラベルより前にある内容(ラベル無しの継続データ)。
  const leading = text.slice(0, found[0].index);
  extractBySize(leading);

  for (let i=0;i<found.length;i++) {
    const cur=found[i], next=found[i+1];
    const segment=text.slice(cur.index+cur.label.length, next ? next.index : text.length);
    extractForType(segment, cur.type);
  }
  return { count, carryState: state };
}

function jraResultParseRefund(r, rawLine) {
  const text=jraResultNormalizeLine(rawLine);
  if (!/返還/.test(text)) return;
  const nums=[...text.matchAll(/(\d+)番/g)].map(m=>Number(m[1]));
  const frames=[...text.matchAll(/(\d+)枠/g)].map(m=>Number(m[1]));
  if(nums.length||frames.length) r.refunds.push({horse_numbers:nums,waku_numbers:frames});
}

// 騎手名の見習い印(▲△☆◇)。
// 2026-08-11方針変更: 以前は除去していたが、出走馬一覧PDFインポート側の表記
// (記号を先頭に残す)と揃えるため、除去せずそのまま残すよう変更した
// (docs/DESIGN.md「JRAレース結果PDFインポート」解析ロジックの要点 参照)。
function jraResultCleanJockeyName(raw) {
  const s = String(raw ?? "").trim();
  return s || null;
}

function jraResultParseHorseFromResultLine(text) {
  const s=jraResultNormalizeLine(text);

  // 基本形式:
  //   馬番 馬名 性齢 負担重量 騎手名 タイム 着差 ...
  //   例: "8 クールストラッチン 牝2 55.0 菊沢 一樹 0:57.2 ハナ ..."
  // 枠番は結果表の数字としては現れないことが多い(JRAが枠番を色付きアイコンで
  // 表現しているため、テキスト抽出できない)。騎手名は「姓 名」の間にスペースが
  // 入り、見習い印(▲△☆◇)が付くことがあるため、負担重量の直後・タイム
  // (M:SS.s形式)の直前という位置関係で切り出すのが最も確実。
  let m=s.match(/^(\d{1,2})\s+(.+?)\s+(牡|牝|せん|セ|騸)\s*(\d+)\s+[\d.]+\s+(.+?)\s+\d+:\d{2}\.\d/);
  if(m) return {horse_number:Number(m[1]),horse_name:m[2].trim()||null,jockey:jraResultCleanJockeyName(m[5])};

  // 枠番も数字として現れる形式(PDFの版によっては枠番も文字で抽出できる場合が
  // あるため、フォールバックとして維持)。
  m=s.match(/^(\d{1,2})\s+(\d{1,2})\s+(.+?)\s+(牡|牝|せん|セ|騸)\s*(\d+)\s+[\d.]+\s+(.+?)\s+\d+:\d{2}\.\d/);
  if(m) return {waku_number:Number(m[1]),horse_number:Number(m[2]),horse_name:m[3].trim()||null,jockey:jraResultCleanJockeyName(m[6])};

  // タイムが取得できない場合の簡易フォールバック(騎手名までは取得しない)。
  // 枠番・馬番・馬名・性齢
  m=s.match(/^(\d{1,2})\s+(\d{1,2})\s+(.+?)\s+(牡|牝|せん|セ|騸)\s*(\d+)\b/);
  if(m) return {waku_number:Number(m[1]),horse_number:Number(m[2]),horse_name:m[3].trim()||null};
  // 枠番・馬番・性齢（馬名欠落）
  m=s.match(/^(\d{1,2})\s+(\d{1,2})\s+(牡|牝|せん|セ|騸)\s*(\d+)\b/);
  if(m) return {waku_number:Number(m[1]),horse_number:Number(m[2]),horse_name:null};
  // 通常形式: 馬番・馬名・性齢
  m=s.match(/^(\d{1,2})\s+(.+?)\s+(牡|牝|せん|セ|騸)\s*(\d+)\b/);
  if(m) return {horse_number:Number(m[1]),horse_name:m[2].trim()||null};
  // 馬番・性齢（馬名欠落）
  m=s.match(/^(\d{1,2})\s+(牡|牝|せん|セ|騸)\s*(\d+)\b/);
  if(m) return {horse_number:Number(m[1]),horse_name:null};
  return null;
}

// ---------- 全着順・タイム・着差・馬体重等の詳細抽出(2026-08-11追加) ----------
// race_results(馬単位の確定結果を1頭1行で記録する新テーブル)へ送信するレコードを
// 組み立てる。既存の jraResultParseHorseFromResultLine (entries/finish_order用の
// 簡易パーサー)とは独立して動作し、失敗しても既存のentries/finish_order抽出には
// 影響しない(フォールバック関係にはせず、それぞれ独立に試みる)。
//
// 実データ(pdftotext -layout でのテキスト抽出)による検証は済んでいるが、実ブラウザの
// PDF.js(ギャップ実測による行連結)を通した際の間隔の付き方までは未検証のため、
// 「実機未検証」の扱いとする(docs/DESIGN.md参照)。

const JRA_RESULT_ROW_HEAD_RE = /^(\d{1,2})\s+(.*?)\s*(牡|牝|せん|セ|騸)\s*(\d{1,2})\s+([\d.]+)\s+(.+?)\s+(\d+:\d{2}\.\d)\s+(.*)$/;
const JRA_RESULT_ROW_TAIL_RE = /^(.*?)\s*([\d.]+)\s+(\d+)\s*[（(]([^）)]*)[）)]\s+(.+?)\s+(\d+)\s*$/;
const JRA_RESULT_MARGIN_WORDS = ["クビ", "アタマ", "ハナ", "大差"];

// 着差とコーナー通過順位が混在した文字列(数字のみで区切り文字が無い)を分離する。
// 1着(rank===1)は着差が存在しないため、全トークンをコーナー通過順位として扱う。
// それ以外の着順では、先頭トークンが着差(クビ/アタマ/ハナ/大差等の語、単純な数字、
// または分数表記「１ 1/4」)であるという前提で切り出す。実際のJRA表記は着差が
// 必ず存在するため、この前提はおおむね妥当だが、表記ゆれがあれば誤判定しうる点に注意。
function jraResultSplitMarginAndCorners(blob, rank) {
  const tokens = String(blob || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return { margin: null, corners: [] };
  if (Number(rank) === 1) return { margin: null, corners: tokens };
  const first = tokens[0];
  if (JRA_RESULT_MARGIN_WORDS.includes(first) || /^\d+$/.test(first) || /\//.test(first)) {
    if (tokens.length > 1 && /^\d+\/\d+$/.test(tokens[1])) {
      return { margin: `${first} ${tokens[1]}`, corners: tokens.slice(2) };
    }
    return { margin: first, corners: tokens.slice(1) };
  }
  return { margin: null, corners: tokens };
}

// 通常の完走馬1行(着順が確定済み)から、race_results用の詳細レコードを組み立てる。
// restAfterRank: 着順(rank)の数字を除いた残りの文字列(先頭は馬番から始まる)。
function jraResultParseFullResultRow(restAfterRank, rank) {
  const m = restAfterRank.match(JRA_RESULT_ROW_HEAD_RE);
  if (!m) return null;
  const [, horseNumberStr, horseName, sex, age, weightStr, jockeyRaw, time, tailBlob] = m;
  const t = tailBlob.match(JRA_RESULT_ROW_TAIL_RE);
  if (!t) return null;
  const [, middle, finalFurlongStr, bodyWeightStr, change, trainer, popularityStr] = t;
  const { margin, corners } = jraResultSplitMarginAndCorners(middle, rank);

  const weightCarried = Number(weightStr);
  const finalFurlong = Number(finalFurlongStr);
  const bodyWeight = Number(bodyWeightStr);

  return {
    horse_number: Number(horseNumberStr),
    horse_name: horseName.trim() || null,
    sex_age: `${sex}${age}`,
    weight_carried: Number.isFinite(weightCarried) ? weightCarried : null,
    jockey: jraResultCleanJockeyName(jockeyRaw),
    status: "finished",
    finish_position: Number(rank),
    time_text: time,
    margin: margin,
    corner_positions: corners.length ? corners.join("-") : null,
    final_furlong_time: Number.isFinite(finalFurlong) ? finalFurlong : null,
    body_weight: Number.isFinite(bodyWeight) ? bodyWeight : null,
    body_weight_change: change || null,
    _trainer: trainer, // 保存対象外(APIへは送らない。docs/DESIGN.md参照)
    win_popularity: Number.isInteger(Number(popularityStr)) ? Number(popularityStr) : null,
  };
}

// 「取消」「除外」で始まる特殊行から race_results 用レコードを組み立てる。
// 取消(発走前・体重測定前)は馬体重列が無く、除外(体重測定後)は馬体重列がある。
const JRA_RESULT_SCRATCH_HEAD_RE = /^(取消|除外)\s+(\d{1,2})\s+(.*?)\s*(牡|牝|せん|セ|騸)\s*(\d{1,2})\s+([\d.]+)\s+(.+)$/;

function jraResultParseScratchRow(rawLine) {
  const s = jraResultNormalizeLine(rawLine);
  const m = s.match(JRA_RESULT_SCRATCH_HEAD_RE);
  if (!m) return null;
  const [, statusLabel, horseNumberStr, horseName, sex, age, weightStr, tail] = m;
  const status = statusLabel === "取消" ? "scratched" : "excluded";

  let jockeyRaw = null, bodyWeight = null, change = null;
  const withWeight = tail.match(/^(.+?)\s+(\d+)\s*[（(]([^）)]*)[）)]\s+(.+)$/);
  if (withWeight) {
    jockeyRaw = withWeight[1];
    bodyWeight = Number(withWeight[2]);
    change = withWeight[3];
  } else {
    // 馬体重列が無い(取消は測定前のため)。トークン数から騎手・調教師を推測する
    // (public/jra-entries-pdf.js の同種ロジックを踏襲)。
    const tokens = tail.replace(/^[▲△☆◇]/, (mm) => mm).split(/\s+/).filter(Boolean);
    if (tokens.length >= 4) {
      jockeyRaw = tokens.slice(0, -2).join(" ");
    } else if (tokens.length === 3) {
      jockeyRaw = tokens[0];
    } else {
      jockeyRaw = tokens[0] || null;
    }
  }

  const weightCarried = Number(weightStr);
  return {
    horse_number: Number(horseNumberStr),
    horse_name: horseName.trim() || null,
    sex_age: `${sex}${age}`,
    weight_carried: Number.isFinite(weightCarried) ? weightCarried : null,
    jockey: jraResultCleanJockeyName(jockeyRaw),
    status,
    finish_position: null,
    time_text: null,
    margin: null,
    corner_positions: null,
    final_furlong_time: null,
    body_weight: Number.isFinite(bodyWeight) ? bodyWeight : null,
    body_weight_change: change,
    win_popularity: null,
  };
}

// 「競走中の出来事等」の箇条書きから、該当馬名(「◯◯号」の「号」を除いた部分)を
// キーに注記本文を集める。セクションの開始/終了を厳密に検出せず、
// 「・◯◯号は、」というパターンに一致する行だけを対象にすることで、
// 誤検出のリスクを抑える(2026-08-11追加)。
function jraResultParseIncidentNotes(blockLines) {
  const map = new Map();
  for (const line of blockLines) {
    const text = typeof line === "string" ? line : line.text;
    const m = text.match(/^[・\s]*(\S+?)号は、.+$/);
    if (m) {
      const name = m[1].trim();
      map.set(name, text.replace(/^[・\s]*/, "").trim());
    }
  }
  return map;
}


const JRA_RESULT_PDF_PARSER_VERSION = "9.0.0-race-results-conditions";

function jraResultFindMeeting(text) {
  const s = jraResultNormalizeUnit(text);
  const m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日.*?(\d+)\s*回\s*(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d+)\s*日/);
  if (!m) return null;
  return {
    date: `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`,
    track: m[5],
    meetingText: `${m[4]}回${m[5]}${m[6]}日`
  };
}

function jraResultFindMeetingLoose(text) {
  const s = jraResultNormalizeUnit(text);
  const meeting = s.match(/(\d+)\s*回\s*(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d+)\s*日/);
  const date = jraResultParseDate(s);
  return meeting ? {
    date,
    track: meeting[2],
    meetingText: meeting[0]
  } : (date ? {date,track:null,meetingText:null} : null);
}

function jraResultFindStartTime(text) {
  const s = jraResultNormalizeUnit(text);
  const m = s.match(/(\d{1,2})\s*時\s*(\d{1,2})\s*分/);
  return m ? {hour:Number(m[1]), minute:Number(m[2]), text:m[0]} : null;
}

function jraResultIsStartLabel(text) {
  const s=jraResultNormalizeUnit(text);
  // 「発走時刻を11時55分に変更」「発走時刻2分遅延」などの注記は
  // 新しいレース開始ではないため除外する。
  if(/発\s*走\s*時\s*刻\s*を/.test(s)) return false;
  if(/発\s*走\s*時\s*刻\s*\d+\s*分/.test(s)) return false;
  return /発\s*走\s*時\s*刻/.test(s);
}

function jraResultParseCourseLoose(text) {
  const s = jraResultNormalizeUnit(text).replace(/\s+/g," ");
  let m = s.match(/コ\s*ー\s*ス\s*[:：]?\s*([0-9,]+)\s*メ\s*ー\s*ト\s*ル\s*[（(]?\s*(芝|ダート|障害)/);
  if (m) return {course_type:m[2],distance:Number(m[1].replace(/,/g,""))};
  m = s.match(/([0-9,]+)\s*メ\s*ー\s*ト\s*ル\s*[（(]?\s*(芝|ダート|障害)/);
  return m ? {course_type:m[2],distance:Number(m[1].replace(/,/g,""))} : {course_type:null,distance:null};
}

function jraResultParseExtractedPages(pages) {
  const lines = [];
  pages.forEach((page,pageIndex)=>{
    page.forEach((row,rowIndex)=>{
      const raw = typeof row === "string" ? row : (row?.text || "");
      const text = jraResultNormalizeLine(raw);
      if (text) lines.push({
        text, raw,
        page:pageIndex+1,
        row:rowIndex+1,
        y:typeof row === "object" ? row.y : null,
        items:typeof row === "object" ? (row.items||[]) : [],
        gaps:typeof row === "object" ? (row.gaps||[]) : []
      });
    });
  });

  const diagnostics = {
    parserVersion:JRA_RESULT_PDF_PARSER_VERSION,
    pages:pages.length,
    rows:lines.length,
    rawChars:lines.reduce((n,x)=>n+x.raw.length,0),
    normalizedChars:lines.reduce((n,x)=>n+x.text.length,0),
    meetingCandidates:0,
    dateCandidates:0,
    startLabelCandidates:0,
    startTimeCandidates:0,
    timeBasedHeaderCandidates:0,
    rejectedStartTimeCandidates:0,
    raceHeaders:0,
    resultRows:0,
    finishRanks:0,
    fullResultRowsDetected:0,
    fullResultRowsFailed:0,
    scratchedRowsDetected:0,
    payoutLines:0,
    payoutItems:0,
    refundLines:0,
    records:0,
    validRecords:0,
    racesWithEntries:0,
    racesWithFinish:0,
    racesWithPayouts:0,
    errors:[],
    headerCandidates:[],
    rawSamples:[],
    gapSamples:[] // 行内文字間隔の実測サンプル(連結閾値の調整用の診断情報)
  };

  // 解析前の実データを診断できるよう、各ページ先頭と「発走/日付/開催」候補を保存。
  const pushSample=(obj)=>{
    if(diagnostics.rawSamples.length<120) diagnostics.rawSamples.push(obj);
  };

  const contexts = [];
  let ctxDate = null, ctxTrack = null;
  for(let i=0;i<lines.length;i++){
    const s=lines[i].text;

    // 行内文字間隔サンプル(閾値調整用)。全行ではなく先頭付近から一定数だけ収集する。
    if (diagnostics.gapSamples.length < 25 && lines[i].gaps && lines[i].gaps.length) {
      diagnostics.gapSamples.push({
        page: lines[i].page, row: lines[i].row,
        text: lines[i].text.slice(0, 60),
        gaps: lines[i].gaps
      });
    }

    const meeting=jraResultFindMeeting(s);
    const looseMeeting=jraResultFindMeetingLoose(s);
    if(meeting || looseMeeting?.track){
      diagnostics.meetingCandidates++;
      const m=meeting || looseMeeting;
      if(m.date) ctxDate=m.date;
      if(m.track) ctxTrack=m.track;
    } else if(jraResultParseDate(s) && !/生\b/.test(s)) {
      diagnostics.dateCandidates++;
      ctxDate=jraResultParseDate(s);
    }
    contexts[i]={date:ctxDate,track:ctxTrack};
    if(jraResultIsStartLabel(s)){
      diagnostics.startLabelCandidates++;
      pushSample({type:"start-label",page:lines[i].page,row:lines[i].row,text:s});
    }
    if(jraResultFindStartTime(s)){
      diagnostics.startTimeCandidates++;
      pushSample({type:"start-time",page:lines[i].page,row:lines[i].row,text:s});
    }
    if((meeting||jraResultParseDate(s)) && diagnostics.headerCandidates.length<80){
      pushSample({type:meeting?"meeting":"date",page:lines[i].page,row:lines[i].row,text:s});
    }
  }

  // 発走ラベルと時刻が同一行でない場合に備えて、最大4行先まで探す。
  const headerCandidates=[];
  const usedHeaderIndices=new Set();
  for(let i=0;i<lines.length;i++){
    if(!jraResultIsStartLabel(lines[i].text)) continue;
    let time=null,timeIndex=i;
    for(let j=i;j<=Math.min(lines.length-1,i+4);j++){
      const t=jraResultFindStartTime(lines[j].text);
      if(t){time=t;timeIndex=j;break;}
    }
    if(!time) continue;
    if(usedHeaderIndices.has(i)) continue;
    const near=[];
    for(let j=Math.max(0,i-8);j<=Math.min(lines.length-1,timeIndex+3);j++){
      const m=jraResultFindMeeting(lines[j].text);
      if(m) near.push(m);
    }
    let date=null,track=null;
    const exact=near.find(x=>x.date&&x.track);
    if(exact){date=exact.date;track=exact.track;}
    if(!date) date=contexts[i]?.date||contexts[timeIndex]?.date||null;
    if(!track) track=contexts[i]?.track||contexts[timeIndex]?.track||null;
    if(!date||!track){
      // 近傍の開催情報を最後の救済として検索。
      for(let j=Math.max(0,i-12);j<=Math.min(lines.length-1,timeIndex+5);j++){
        const m=jraResultFindMeetingLoose(lines[j].text);
        if(m?.date&&!date)date=m.date;
        if(m?.track&&!track)track=m.track;
      }
    }
    const candidate={index:i,timeIndex,date,track,time, label:lines[i].text};
    headerCandidates.push(candidate);
    usedHeaderIndices.add(i);
    if(diagnostics.headerCandidates.length<80){
      diagnostics.headerCandidates.push({
        page:lines[i].page,row:lines[i].row,date,track,time:`${time.hour}:${String(time.minute).padStart(2,"0")}`,
        label:lines[i].text,
        timeSource:lines[timeIndex].text
      });
    }
  }

  // PDF.jsでは「発走時刻：」と「9時50分」が別の行になり、
  // さらに「発走時刻」自体が別テキストアイテムとして行復元から漏れることがある。
  // その場合でも「時刻候補」を起点にレースヘッダーを復元する。
  // ただし「発走時刻を11時55分に変更」「発走時刻2分遅延」などの結果ページ内注記は、
  // 直後にコース情報が存在しないため候補から除外する。
  for(let i=0;i<lines.length;i++){
    const time=jraResultFindStartTime(lines[i].text);
    if(!time) continue;

    // 既にラベル起点で検出済みのヘッダーに対応する時刻は重複登録しない。
    if(headerCandidates.some(h=>Math.abs(h.timeIndex-i)<=1)) continue;

    const before=Math.max(0,i-12);
    const after=Math.min(lines.length-1,i+12);
    let date=contexts[i]?.date||null;
    let track=contexts[i]?.track||null;

    // 直前12行の開催情報を検索。日付と競馬場が別行でも復元する。
    for(let j=before;j<=after;j++){
      const m=jraResultFindMeeting(lines[j].text);
      if(m?.date) date=m.date;
      if(m?.track) track=m.track;
      const loose=jraResultFindMeetingLoose(lines[j].text);
      if(loose?.date && !date) date=loose.date;
      if(loose?.track && !track) track=loose.track;
    }

    // この時刻の後ろに「コース」または「本賞金」があるか確認。
    // 実レースヘッダーは発走時刻の直後にレース情報が続くが、
    // 「発走時刻変更」「遅延」の注記には通常存在しない。
    const forward=lines.slice(i+1,Math.min(lines.length,i+10));
    const hasCourse=forward.some(x=>/コ\s*ー\s*ス\s*[:：]?/.test(x.text));
    const hasPrize=forward.some(x=>/本\s*賞\s*金/.test(x.text));
    const hasRaceInfo=hasCourse||hasPrize;

    // 注記由来の時刻を明示的に除外。
    const nearbyText=lines.slice(Math.max(0,i-3),Math.min(lines.length,i+4))
      .map(x=>x.text).join(" ");
    const isChangeNote=/発\s*走\s*時\s*刻\s*を\s*\d{1,2}\s*時\s*\d{1,2}\s*分\s*(?:に)?\s*変更/.test(nearbyText)
      || /発\s*走\s*時\s*刻\s*\d{1,2}\s*分\s*遅延/.test(nearbyText);

    if(isChangeNote || !hasRaceInfo){
      diagnostics.rejectedStartTimeCandidates++;
      pushSample({
        type:"rejected-start-time",
        page:lines[i].page,row:lines[i].row,
        date,track,
        time:`${time.hour}:${String(time.minute).padStart(2,"0")}`,
        reason:isChangeNote?"発走時刻変更・遅延注記":"時刻後方にコース/本賞金情報なし",
        source:lines[i].text
      });
      continue;
    }

    const candidate={
      index:i,timeIndex:i,date,track,time,
      label:"(時刻候補から復元)",
      fallback:true,
      sourceLine:lines[i].text
    };
    headerCandidates.push(candidate);
    diagnostics.timeBasedHeaderCandidates++;

    if(diagnostics.headerCandidates.length<80){
      diagnostics.headerCandidates.push({
        page:lines[i].page,row:lines[i].row,date,track,
        time:`${time.hour}:${String(time.minute).padStart(2,"0")}`,
        label:"(時刻候補から復元)",
        timeSource:lines[i].text,
        fallback:true,
        hasCourse,hasPrize
      });
    }
  }

  headerCandidates.sort((a,b)=>a.index-b.index);
  diagnostics.raceHeaders=headerCandidates.filter(h=>h.date&&h.track).length;

  const records=[];
  const counters=new Map();

  for(let hIndex=0;hIndex<headerCandidates.length;hIndex++){
    const h=headerCandidates[hIndex];
    if(!h.date||!h.track) continue;
    const nextHeader=headerCandidates.slice(hIndex+1).find(x=>x.index>h.index);
    const end=nextHeader?nextHeader.index:lines.length;
    const block=lines.slice(h.index,end);
    const key=`${h.date}__${h.track}`;
    const number=(counters.get(key)||0)+1;
    counters.set(key,number);
    const current=jraResultCreateRace(h.date,h.track,number);
    const raceDiag={
      key:`${h.date} ${h.track} ${number}R`,
      pageStart:lines[h.index].page,
      pageEnd:block.length?block[block.length-1].page:lines[h.index].page,
      startDetected:true,
      raceInfo:false,
      entries:0,
      finishOrder:[],
      payouts:0,
      raceResults:0,
      errors:[],
      sample:block.slice(0,20).map(x=>`[p${x.page}:${x.row}] ${x.text}`)
    };

    try{
      // レース名・コース・条件詳細はヘッダー直後の広い範囲から取得。
      const metaLines = block.slice(0,18).map(x=>x.text);
      const metaText = metaLines.join(" ");
      const course=jraResultParseCourseLoose(metaText);
      if(course.course_type){
        current.course_type=course.course_type;
        current.distance=course.distance;
      }
      // 条件詳細(斤量区分・条件フラグ・回り)は「コース：」を含む行から抽出する
      // (メタ全体を1行に連結すると「メートル」を含まない行の断片が混ざり誤検出
      // しやすいため、該当行を個別に走査する)。
      for (const s of metaLines) {
        if (/コ\s*ー\s*ス\s*[:：]/.test(s) || /メートル/.test(s)) {
          const cond = jraResultParseConditions(s);
          if (cond.weight_type && !current.weight_type) current.weight_type = cond.weight_type;
          if (cond.class_flags && !current.class_flags) current.class_flags = cond.class_flags;
          if (cond.course_direction && !current.course_direction) current.course_direction = cond.course_direction;
        }
      }
      // 天候・馬場状態の行は、着順表の後ろ(払戻表の手前)に出現することが多く、
      // 先頭18行に収まらない場合があるため、ブロック全体から検索する。
      const weatherLine = block.find((l) => /天候/.test(l.text));
      if (weatherLine) {
        const w = jraResultParseWeather(weatherLine.text);
        if (w.weather) current.weather = w.weather;
        if (w.track_condition) current.track_condition = w.track_condition;
      }
      for(let i=1;i<Math.min(block.length,15);i++){
        const s=block[i].text;
        if(!current.race_name &&
          s.length>=2 && s.length<=80 &&
          !/^(本賞金|出馬表|オッズ|印刷用ページ|レース結果の見方|レース映像|着順|馬名|番|重量|騎手名|タイム|天候|芝|ダート|障害|コース|発走)/.test(s) &&
          !/^\d{4}年/.test(s) &&
          !/^\d+\s*時\s*\d+\s*分/.test(s)
        ){
          current.race_name=s;
        }
      }
      raceDiag.raceInfo=Boolean(current.race_name||current.course_type||current.distance);

      // 「競走中の出来事等」の箇条書きは着順表より後ろ(払戻の下)に出現するため、
      // レースブロック全体を対象に馬名→注記のマップを事前に作っておく。
      const incidentNotes = jraResultParseIncidentNotes(block);

      let inResults=false;
      let pendingRank=null;
      let payoutCarryState = { 1:null, 2:null, 3:null };

      for(let i=0;i<block.length;i++){
        const line=block[i].text;
        if(!line)continue;

        if(/着順/.test(line)){
          inResults=true;
          pendingRank=null;
          continue;
        }

        if(inResults){
          // 取消・除外は着順を持たない特殊行のため、他の行より先に判定する。
          const scratchRow = jraResultParseScratchRow(line);
          if (scratchRow) {
            scratchRow.incident_note = incidentNotes.get(String(scratchRow.horse_name || "")) || null;
            current.race_results.push(scratchRow);
            diagnostics.scratchedRowsDetected++;
            continue;
          }

          const rankOnly=line.match(/^(\d{1,2})$/);
          if(rankOnly){pendingRank=Number(rankOnly[1]);continue;}

          if(pendingRank!==null){
            const hh=jraResultParseHorseFromResultLine(line);
            if(hh){
              diagnostics.resultRows++;
              if(!current.entries.some(e=>e.horse_number===hh.horse_number)){
                current.entries.push({waku_number:hh.waku_number??null,horse_number:hh.horse_number,horse_name:hh.horse_name,jockey:hh.jockey??null});
              }
              if(pendingRank>=1&&pendingRank<=3){
                current.finish_order[pendingRank-1]=hh.horse_number;
                diagnostics.finishRanks++;
                raceDiag.finishOrder[pendingRank-1]=hh.horse_number;
              }
              raceDiag.entries=current.entries.length;

              // race_results用の詳細レコードも試みる(失敗しても上記entries/
              // finish_orderの抽出結果には影響しない)。
              const full = jraResultParseFullResultRow(line, pendingRank);
              if (full) {
                full.incident_note = incidentNotes.get(String(full.horse_name || "")) || null;
                delete full._trainer;
                current.race_results.push(full);
                diagnostics.fullResultRowsDetected++;
              } else {
                diagnostics.fullResultRowsFailed++;
              }

              pendingRank=null;
              continue;
            }
          }

          const rm=line.match(/^(\d{1,2})\s+(.+)$/);
          if(rm){
            const hh=jraResultParseHorseFromResultLine(rm[2]);
            if(hh){
              diagnostics.resultRows++;
              if(!current.entries.some(e=>e.horse_number===hh.horse_number)){
                current.entries.push({waku_number:hh.waku_number??null,horse_number:hh.horse_number,horse_name:hh.horse_name,jockey:hh.jockey??null});
              }
              const rank=Number(rm[1]);
              if(rank>=1&&rank<=3){
                current.finish_order[rank-1]=hh.horse_number;
                diagnostics.finishRanks++;
                raceDiag.finishOrder[rank-1]=hh.horse_number;
              }
              raceDiag.entries=current.entries.length;

              const full = jraResultParseFullResultRow(rm[2], rank);
              if (full) {
                full.incident_note = incidentNotes.get(String(full.horse_name || "")) || null;
                delete full._trainer;
                current.race_results.push(full);
                diagnostics.fullResultRowsDetected++;
              } else {
                diagnostics.fullResultRowsFailed++;
              }

              continue;
            }
          }

          if(/円/.test(line)&&/(単勝|複勝|枠連|馬連|馬単|ワイド|3連複|3連単)/.test(line)){
            inResults=false;
          } else {
            continue;
          }
        }

        const payoutLabels=[
          ["3連単","sanrentan"],["3連複","sanrenpuku"],["単勝","tan"],["複勝","fuku"],
          ["枠連","wakuren"],["馬連","umaren"],["馬単","umatan"],["ワイド","wide"]
        ];
        let explicitPayoutType=null;
        for(const [label,type] of payoutLabels){
          if(line.includes(label)){explicitPayoutType=type;break;}
        }

        // ラベルの有無にかかわらず、円を含む行は常に jraResultParsePayoutLine で処理する
        // (行内の複数ラベル・ラベル無し継続行のいずれにも対応できるよう統一)。
        // payoutCarryStateは頭数(1頭/2頭/3頭)ごとの直前の式別を保持し、行の処理結果で更新する。
        const hasCarryState = Object.values(payoutCarryState).some(Boolean);
        if(explicitPayoutType || (hasCarryState && /円/.test(line))){
          const { count, carryState } = jraResultParsePayoutLine(current,line,payoutCarryState);
          if(count){diagnostics.payoutLines++;diagnostics.payoutItems+=count;}
          payoutCarryState = carryState;
          continue;
        }

        if(/返還/.test(line)){
          jraResultParseRefund(current,line);
          diagnostics.refundLines++;
        }
      }

      current.finish_order=current.finish_order.filter(Number.isInteger).slice(0,3);

      // 出走馬は着順ではなく馬番順に並べ替える。出走馬表編集画面(races.js)は
      // 「entries配列のi番目 ≒ 馬番(i+1)」という前提で行を描画するため、
      // 着順順のまま渡すと表示が総崩れになる。
      current.entries.sort((a,b)=>a.horse_number-b.horse_number);

      // 2026-08-11方針変更: 枠番が結果表から数字として取得できなかった場合、
      // 以前は defaultWakuNumber() で推定値を計算しその場で entries へ埋め込んで
      // いたが、この推定値が「確定値」としてDBに保存され枠連馬券の的中判定に
      // 誤って使われるリスクがあるため廃止した。取得できない場合は null のまま
      // 送信する(docs/DESIGN.md「枠番の推定値をDBに保存しない」参照)。
      // race_results.waku_number も同様に基本 null のまま送信する。

      current.race_results.sort((a,b)=>a.horse_number-b.horse_number);

      for(const type of Object.keys(current.payouts)){
        const seen=new Set();
        current.payouts[type]=current.payouts[type].filter(x=>{
          const k=`${x.label}__${x.rate}`;
          if(seen.has(k))return false;
          seen.add(k);return true;
        });
      }
      if(current.refunds.length)current.payouts.refunds=current.refunds;

      raceDiag.finishOrder=current.finish_order.slice();
      raceDiag.payouts=Object.entries(current.payouts).filter(([k])=>k!=="refunds").reduce((n,[,v])=>n+v.length,0);
      raceDiag.raceResults=current.race_results.length;
      if(!current.entries.length)raceDiag.errors.push("出走馬情報を取得できませんでした");
      if(current.finish_order.length<3)raceDiag.errors.push(`1〜3着の取得が不完全です(${current.finish_order.join("-")||"なし"})`);
      if(raceDiag.payouts===0)raceDiag.errors.push("払戻項目を取得できませんでした");
      if(!current.race_results.length)raceDiag.errors.push("race_results用の詳細行を取得できませんでした(全着順・タイム等の記録は行われません)");

      if(current.finish_order.length||raceDiag.payouts||current.entries.length){
        records.push({race:current,diag:raceDiag});
      } else {
        raceDiag.errors.push("有効データがないため登録候補から除外しました");
      }
    }catch(e){
      raceDiag.errors.push(`例外: ${e.message||String(e)}`);
      diagnostics.errors.push(`${raceDiag.key}: ${e.message||String(e)}`);
    }
    if(!diagnostics.raceDiagnostics)diagnostics.raceDiagnostics=[];
    diagnostics.raceDiagnostics.push(raceDiag);
  }

  // 同一キーの重複を統合。
  const merged=new Map();
  for(const item of records){
    const r=item.race;
    const key=`${r.race_date}__${r.track}__${r.race_number}`;
    const old=merged.get(key);
    if(!old){merged.set(key,r);continue;}
    old.race_name ||= r.race_name;
    old.course_type ||= r.course_type;
    old.distance ||= r.distance;
    old.weight_type ||= r.weight_type;
    old.class_flags ||= r.class_flags;
    old.course_direction ||= r.course_direction;
    old.weather ||= r.weather;
    old.track_condition ||= r.track_condition;
    for(const e of r.entries)if(!old.entries.some(x=>x.horse_number===e.horse_number))old.entries.push(e);
    r.finish_order.forEach((v,i)=>{if(Number.isInteger(v))old.finish_order[i]=v;});
    for(const [type,list] of Object.entries(r.payouts||{})){
      old.payouts[type] ||= [];
      old.payouts[type].push(...list);
    }
    for(const rr of r.race_results||[])if(!old.race_results.some(x=>x.horse_number===rr.horse_number))old.race_results.push(rr);
  }

  for(const r of merged.values()){
    for(const type of Object.keys(r.payouts)){
      const seen=new Set();
      r.payouts[type]=r.payouts[type].filter(x=>{
        const k=`${x.label}__${x.rate}`;
        if(seen.has(k))return false;
        seen.add(k);return true;
      });
    }
  }

  const validRecords=[...merged.values()].filter(r=>r.finish_order.length||Object.keys(r.payouts).some(k=>k!=="refunds"&&r.payouts[k]?.length));
  diagnostics.records=merged.size;
  diagnostics.validRecords=validRecords.length;
  diagnostics.racesWithEntries=[...merged.values()].filter(r=>r.entries.length).length;
  diagnostics.racesWithFinish=[...merged.values()].filter(r=>r.finish_order.length>=3).length;
  diagnostics.racesWithPayouts=[...merged.values()].filter(r=>Object.keys(r.payouts).some(k=>k!=="refunds"&&r.payouts[k]?.length)).length;

  if(!diagnostics.raceHeaders){
    diagnostics.errors.push("レース開始を1件も検出できませんでした。発走時刻ラベル・時刻候補・開催情報・コース情報の組み合わせを確認してください。");
  }

  return {records:validRecords,diagnostics};
}

async function jraResultExtractPdfPages(file, log=()=>{}) {
  if(!window.pdfjsLib){
    log("PDF.js未読込 → CDNから読み込み開始");
    await new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload=()=>{log("PDF.js読み込み成功");resolve();};
      script.onerror=()=>reject(new Error("PDF解析ライブラリの読み込みに失敗しました"));
      document.head.appendChild(script);
    });
  }
  if(!window.pdfjsLib)throw new Error("PDF解析ライブラリを利用できませんでした");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  log("PDF.jsバージョン="+(window.pdfjsLib.version||"unknown"));
  const buffer=await file.arrayBuffer();
  log("ArrayBuffer取得="+buffer.byteLength+" bytes");
  const pdf=await window.pdfjsLib.getDocument({data:buffer,useWorkerFetch:false,isEvalSupported:true}).promise;
  log("PDF読み込み成功 pages="+pdf.numPages);
  const pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    log(`ページ ${p}/${pdf.numPages} 抽出開始`);
    const page=await pdf.getPage(p);
    const content=await page.getTextContent({disableCombineTextItems:false});
    const items=content.items.filter(x=>x.str&&x.str.trim()).map(x=>({
      str:jraResultNormalizeUnit(x.str),x:x.transform[4],y:x.transform[5],w:x.width||0
    }));
    items.sort((a,b)=>b.y-a.y||a.x-b.x);
    const rows=[];
    for(const item of items){
      let row=rows.find(r=>Math.abs(r.y-item.y)<3.0);
      if(!row){row={y:item.y,items:[]};rows.push(row);}
      row.items.push(item);
    }
    // 行内の連結方法は「間隔の実測に基づく3段階判定」を用いる(詳細は jraResultJoinRowItems 参照)。
    pages.push(rows.sort((a,b)=>b.y-a.y).map(r=>{
      const sortedItems=r.items.sort((a,b)=>a.x-b.x);
      const joined=jraResultJoinRowItems(sortedItems);
      return {
        text:joined.text,
        y:r.y,
        items:sortedItems.map(x=>({str:x.str,x:x.x,w:x.w})),
        gaps:joined.gaps
      };
    }));
    log(`ページ ${p} 抽出完了 items=${items.length} rows=${rows.length}`);
  }
  return {pages,pdfPages:pdf.numPages};
}

function jraResultRenderDiagnostics(d, extracted) {
  const raceRows=(d.raceDiagnostics||[]).map(r=>{
    const finish=r.finishOrder?.length?r.finishOrder.join("-"):"なし";
    const err=r.errors?.length?`<ul>${r.errors.map(e=>`<li>${escapeHtml(e)}</li>`).join("")}</ul>`:"なし";
    return `<tr><td>${escapeHtml(r.key)}</td><td>${r.pageStart}-${r.pageEnd}</td><td>${r.entries}</td><td>${escapeHtml(finish)}</td><td>${r.payouts}</td><td>${r.raceResults||0}</td><td>${err}</td></tr>`;
  }).join("");
  const candidateRows=(d.headerCandidates||[]).map(x=>
    `<li>p${x.page}:${x.row} / ${escapeHtml(x.date||"日付なし")} / ${escapeHtml(x.track||"競馬場なし")} / ${escapeHtml(x.time||"時刻なし")} / ${escapeHtml(x.label||"")} ${x.timeSource?` → ${escapeHtml(x.timeSource)}`:""}</li>`
  ).join("");
  const sampleRows=(d.rawSamples||[]).map(x=>`<li>[p${x.page}:${x.row}] ${escapeHtml(x.text||"")}</li>`).join("");
  const gapRows=(d.gapSamples||[]).map(x=>{
    const gapsText=(x.gaps||[]).map(g=>`${g.gap}pt→${g.sep}`).join(", ");
    return `<li>[p${x.page}:${x.row}] "${escapeHtml(x.text||"")}"<br><small>${escapeHtml(gapsText)}</small></li>`;
  }).join("");
  const rawText=(extracted?.pages||[]).map((p,i)=>`===== PAGE ${i+1} =====\n${p.map(r=>r.text||"").join("\n")}`).join("\n\n");
  return `<details open style="margin-top:10px"><summary>解析診断情報（JRA PDF Parser ${JRA_RESULT_PDF_PARSER_VERSION}）</summary>
  <div class="picker-hint">
  PDFページ数: ${d.pages}<br>
  抽出行数: ${d.rows}<br>
  抽出文字数: ${d.rawChars}<br>
  正規化後文字数: ${d.normalizedChars}<br>
  開催情報候補: ${d.meetingCandidates}<br>
  日付候補: ${d.dateCandidates}<br>
  「発走時刻」候補: ${d.startLabelCandidates}<br>
  発走時刻候補: ${d.startTimeCandidates}<br>
  時刻候補から復元したレースヘッダー: ${d.timeBasedHeaderCandidates}<br>
  除外した発走時刻候補: ${d.rejectedStartTimeCandidates}<br>
  レース開始検出: ${d.raceHeaders}<br>
  結果行検出: ${d.resultRows}<br>
  1〜3着検出: ${d.finishRanks}<br>
  race_results詳細行 検出: ${d.fullResultRowsDetected} / 解析失敗: ${d.fullResultRowsFailed}<br>
  取消・除外行 検出: ${d.scratchedRowsDetected}<br>
  払戻行検出: ${d.payoutLines}<br>
  払戻項目検出: ${d.payoutItems}<br>
  返還行検出: ${d.refundLines}<br>
  有効レース: ${d.validRecords}<br>
  完全着順取得レース: ${d.racesWithFinish}<br>
  払戻取得レース: ${d.racesWithPayouts}
  </div>
  ${d.errors?.length?`<details open><summary>解析エラー・警告 (${d.errors.length})</summary><ul>${d.errors.map(e=>`<li>${escapeHtml(e)}</li>`).join("")}</ul></details>`:""}
  <details><summary>レース開始候補 (${(d.headerCandidates||[]).length})</summary><ul>${candidateRows||"<li>候補なし</li>"}</ul></details>
  <details><summary>レース別解析結果 (${(d.raceDiagnostics||[]).length})</summary>
    <div style="overflow:auto"><table><thead><tr><th>レース</th><th>ページ</th><th>出走馬</th><th>1〜3着</th><th>払戻項目</th><th>race_results行数</th><th>問題</th></tr></thead><tbody>${raceRows||"<tr><td colspan='7'>レース解析結果なし</td></tr>"}</tbody></table></div>
  </details>
  <details><summary>抽出テキスト候補サンプル (${(d.rawSamples||[]).length})</summary><ul>${sampleRows||"<li>なし</li>"}</ul></details>
  <details><summary>行内文字間隔サンプル・閾値調整用 (${(d.gapSamples||[]).length})</summary>
    <p class="picker-hint">各行を構成するテキスト断片間の実測ギャップ(pt)と、連結/SPACE/TABどれと判定したかの一覧です。「発走時刻」等が正しく1語として繋がらない場合、ここでどの間隔がどう判定されたか確認できます。</p>
    <ul>${gapRows||"<li>なし</li>"}</ul>
  </details>
  <details><summary>PDF全文抽出テキストを表示</summary><textarea readonly rows="18" style="width:100%;font-family:monospace">${escapeHtml(rawText)}</textarea></details>
  </details>`;
}

const jraImportModal=document.getElementById("jra-result-import-modal");
const jraImportFile=document.getElementById("jra-result-pdf-file");
const jraImportPreview=document.getElementById("jra-result-import-preview");
const jraImportSubmit=document.getElementById("jra-result-import-submit-btn");
const jraImportMessage=document.getElementById("jra-result-import-message");
let jraParsedRecords=[];let jraExistingMap=new Map();

document.getElementById("jra-result-import-btn")?.addEventListener("click",()=>{
  jraImportFile.value="";jraImportPreview.innerHTML="";jraImportMessage.hidden=true;jraImportSubmit.disabled=true;jraParsedRecords=[];jraImportModal.hidden=false;
});
document.getElementById("jra-result-import-cancel-btn")?.addEventListener("click",closeJraResultImportModal);
jraImportModal?.addEventListener("click",e=>{if(e.target===jraImportModal)closeJraResultImportModal();});

function closeJraResultImportModal(){
  if(jraImportModal) jraImportModal.hidden=true;
}
// ESCキーでキャンセル相当(保存せず閉じる)にする(docs/BACKLOG.md クラスタK対応)。
registerEscToClose(jraImportModal, closeJraResultImportModal);

jraImportFile?.addEventListener("change",()=>{
  jraImportPreview.innerHTML="";
  jraImportMessage.hidden=true;
  jraImportSubmit.disabled=true;
  jraParsedRecords=[];
});

document.getElementById("jra-result-parse-btn")?.addEventListener("click",async()=>{
  const file=jraImportFile.files?.[0];
  if(!file){alert("PDFファイルを選択してください");return;}
  jraImportSubmit.disabled=true;
  jraImportPreview.innerHTML=`<p>解析中です…<br>解析エンジン: ${JRA_RESULT_PDF_PARSER_VERSION}</p>`;
  const logs=[];
  const log=(message)=>{
    const line=`[${new Date().toLocaleTimeString()}] ${message}`;
    logs.push(line);
    console.log("[JRA PDF]",message);
  };
  try{
    log(`START file=${file.name} size=${file.size}`);
    const extracted=await jraResultExtractPdfPages(file,log);
    log(`EXTRACT DONE pages=${extracted.pdfPages}`);
    const parsed=jraResultParseExtractedPages(extracted.pages);
    log(`PARSE DONE headers=${parsed.diagnostics.raceHeaders} records=${parsed.records.length}`);
    jraParsedRecords=parsed.records;
    const key=r=>`${r.race_date}__${r.track}__${Number(r.race_number)}`;
    jraExistingMap=new Map((typeof races!=="undefined"?races:[]).map(r=>[key(r),r]));
    const created=jraParsedRecords.filter(r=>!jraExistingMap.has(key(r))).length;
    const existing=jraParsedRecords.length-created;
    const logHtml=logs.map(x=>`<li>${escapeHtml(x)}</li>`).join("");
    jraImportPreview.innerHTML=`<p>解析結果：<strong>${jraParsedRecords.length}レース</strong>（未登録 ${created}、既存 ${existing}）</p>
    ${jraResultRenderDiagnostics(parsed.diagnostics,extracted)}
    <details><summary>実行ログ (${logs.length})</summary><pre style="white-space:pre-wrap">${escapeHtml(logs.join("\n"))}</pre></details>
    <div class="import-preview-list">${jraParsedRecords.map(r=>{
      const old=jraExistingMap.get(key(r));
      const finish=r.finish_order.length?r.finish_order.join("-"):"着順未取得";
      const payouts=Object.entries(r.payouts||{}).filter(([k])=>k!=="refunds").reduce((n,[,v])=>n+(Array.isArray(v)?v.length:0),0);
      return `<div class="import-preview-row"><strong>${escapeHtml(r.race_date)} ${escapeHtml(r.track)} ${r.race_number}R</strong> ${escapeHtml(r.race_name||"")} <span>着順: ${escapeHtml(finish)} / 払戻: ${payouts}項目 / race_results: ${(r.race_results||[]).length}頭分 / ${old?"既存レースへ結果登録":"レース新規登録＋結果登録"}</span></div>`;
    }).join("")}</div>`;
    jraImportSubmit.disabled=jraParsedRecords.length===0;
  }catch(e){
    console.error("[JRA PDF] import failed",e);
    jraImportPreview.innerHTML=`<p class="error-text">解析中にエラーが発生しました: ${escapeHtml(e.message||String(e))}</p><details open><summary>実行ログ</summary><pre style="white-space:pre-wrap">${escapeHtml(logs.join("\n"))}</pre></details>`;
  }
});

jraImportSubmit?.addEventListener("click",async()=>{
  if(!jraParsedRecords.length)return;
  if(!confirm(`${jraParsedRecords.length}レースの結果・払戻を登録します。未登録レースは新規作成されます。実行しますか？`))return;
  jraImportSubmit.disabled=true;jraImportMessage.hidden=false;jraImportMessage.textContent="登録中です…";
  try{
    const res=await authedFetch("/api/races/results-import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({races:jraParsedRecords,mode:"fill-empty"})});
    const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||"一括登録に失敗しました");
    const c=(data.results||[]).filter(x=>x.status==="created").length,u=(data.results||[]).filter(x=>x.status==="updated").length,s=(data.results||[]).filter(x=>x.status==="skipped").length;
    alert(`JRAレース結果を登録しました。\n新規登録：${c}レース\n既存更新：${u}レース${s?`\nスキップ：${s}レース`:""}`);
    jraImportModal.hidden=true;await loadRaces();
  }catch(e){console.error("[JRA PDF] registration failed",e);alert(e.message||String(e));jraImportSubmit.disabled=false;}
});
