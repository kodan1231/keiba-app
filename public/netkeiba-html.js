// netkeiba のレースページ(馬柱5走・結果)の HTML を読み取る(2026-10-08追加)。
// 仕様は docs/design/netkeiba-bookmarklet.md。
//
// 利用者が PC の Chrome で開いた netkeiba のページから、ブックマークレットがページの HTML を
// レース管理画面へ渡し、ここで読み取る(アプリから netkeiba へは問い合わせない)。
// 対象ページ(中央・地方とも同じ構造。2026-10-08 に実物で確認):
//   - 馬柱(5走): race.netkeiba.com / nar.netkeiba.com の /race/shutuba_past.html
//   - 結果・払戻: race.netkeiba.com / nar.netkeiba.com の /race/result.html
// 読み取りは DOMParser で作った文書に対して行う(スクリプトは実行されない)。

const NK_ALLOWED_HOSTS = ["race.netkeiba.com", "nar.netkeiba.com"];

const NK_BET_TYPE_BY_LABEL = {
  単勝: "tan",
  複勝: "fuku",
  枠連: "wakuren",
  馬連: "umaren",
  ワイド: "wide",
  馬単: "umatan",
  "3連複": "sanrenpuku",
  "3連単": "sanrentan",
  // 枠単(地方のみ)はアプリに券種が無いため読まない
};

const NK_STATUS_BY_RANK_TEXT = { 取消: "scratched", 除外: "excluded", 中止: "stopped" };

function nkText(el) {
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
}

// ページの種類。対象外なら null。
// 2026-10-13: netkeiba の過去レースのデータベース(db.netkeiba.com/race/<レースID 12桁>/。中央・地方)も対象にした("db_result")。
function nkPageKind(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname === "db.netkeiba.com" && /^\/race\/\d{12}\/?$/.test(u.pathname)) return "db_result";
  if (!NK_ALLOWED_HOSTS.includes(u.hostname)) return null;
  if (u.pathname.endsWith("/race/shutuba_past.html")) return "shutuba_past";
  if (u.pathname.endsWith("/race/result.html")) return "result";
  return null;
}

// レースの見出し(開催日・競馬場・R・レース名・コース等)。
// 開催日・競馬場・R はタイトル「毎日王冠(G2) 5走表示 | 2026年10月4日 東京11R レース情報(JRA) - netkeiba」から取る。
function nkParseRaceMeta(doc) {
  const tm = (doc.title || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\S+?)(\d{1,2})R/);
  if (!tm) return null;
  const race_date = `${tm[1]}-${tm[2].padStart(2, "0")}-${tm[3].padStart(2, "0")}`;
  const track = tm[4];
  const race_number = Number(tm[5]);

  // レース名は見出しの文字だけ(グレードは別要素。地方は「Jpn1」等が文字で入るので除く)
  const nameEl = doc.querySelector(".RaceName");
  let race_name = nameEl
    ? Array.from(nameEl.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim()
    : "";
  race_name = race_name.replace(/\s*(Jpn|J・?G|G)[1-3IⅠⅡⅢ]+$/i, "").trim() || null;

  // 例: "15:45発走 / 芝1800m (左 A) / 天候:曇 / 馬場:良"(地方は「ダ2000m (右)」)
  const d1 = nkText(doc.querySelector(".RaceData01"));
  const timeM = d1.match(/(\d{1,2}):(\d{2})発走/);
  // 障害は「障芝3000m」のように書かれる。「障」と距離の間に文字があっても「障」を拾う(2026-10-22。以前は「芝3000m」に当たり芝になっていた)
  const courseM = d1.match(/(芝|ダ|障)[^\d/]*?(\d{3,4})m/);
  const dirM = d1.match(/\((左|右|直)/);
  const weatherM = d1.match(/天候\s*:\s*(\S+)/);
  const condM = d1.match(/馬場\s*:\s*(\S+)/);
  const COURSE = { 芝: "芝", ダ: "ダート", 障: "障害" };

  // 例: ["4回","東京","2日目","サラ系３歳以上","オープン","(国際)(指)","別定","17頭","本賞金:…"]
  const d2 = Array.from(doc.querySelectorAll(".RaceData02 > span")).map((s) => nkText(s).normalize("NFKC"));
  const weight_type = d2.find((s) => /^(馬齢|定量|別定|ハンデ)$/.test(s)) || null;
  const classParts = d2.slice(3).filter((s) => s && s !== weight_type && !/^\d+頭$/.test(s) && !/^本賞金/.test(s));
  // 地方は「サラ系３歳 3歳」のように同じ語が重なるので重複を除く
  const class_flags = [...new Set(classParts.join(" ").replace(/^サラ系/, "").split(/\s+/).filter(Boolean))].join(" ") || null;

  return {
    race_date,
    track,
    race_number,
    race_name,
    course_type: courseM ? COURSE[courseM[1]] : null,
    distance: courseM ? Number(courseM[2]) : null,
    course_direction: dirM && dirM[1] !== "直" ? dirM[1] : null,
    weather: weatherM ? weatherM[1] : null,
    track_condition: condM ? condM[1] : null,
    post_time: timeM ? `${timeM[1].padStart(2, "0")}:${timeM[2]}` : null,
    weight_type,
    class_flags,
  };
}

// 騎手のセルから騎手名を取る。中央は <a>、地方はリンク無しの文字(性齢・斤量の span の間)。
function nkJockeyFromCell(td) {
  if (!td) return null;
  const a = td.querySelector("a");
  if (a && nkText(a)) return nkText(a);
  const clone = td.cloneNode(true);
  clone.querySelectorAll("span, img, br").forEach((el) => el.remove());
  return nkText(clone) || null;
}

// 馬柱(5走)ページ → parseNetkeibaUmabashira()(public/parse.js)と同じ形の配列。
// レース管理画面の貼り付け取り込みの確認画面(races-entries-modal.js の startUmabashiraPreview)へそのまま渡す。
function nkParseShutubaPast(doc) {
  const table = doc.querySelector("table.Shutuba_Past5_Table"); // 同じクラスの表が複数あるが先頭が全頭
  if (!table) return [];
  const seen = new Set();
  const out = [];
  table.querySelectorAll("tr.HorseList").forEach((tr) => {
    const tds = Array.from(tr.children);
    const waku = Number(nkText(tds[0]));
    const horseNumber = Number(nkText(tr.querySelector("td.Waku")));
    if (!Number.isInteger(horseNumber) || horseNumber < 1 || seen.has(horseNumber)) return;
    const info = tr.querySelector("td.Horse_Info");
    const nameA = info?.querySelector(".Horse02 a");
    const horseName = nkText(nameA);
    if (!horseName) return;
    seen.add(horseNumber);
    const sire = nkText(info.querySelector(".Horse01")) || null;
    const dam = nkText(info.querySelector(".Horse03")) || null;
    const damSire = nkText(info.querySelector(".Horse04")).replace(/^[(（]|[)）]$/g, "").trim() || null;
    // 例「栗東・橋口」(中央は略称、地方はフルネーム)
    const tm = nkText(info.querySelector(".Horse05")).match(/^([^・\s]+)・(.+)$/);
    const jockeyTd = tr.querySelector("td.Jockey");
    const sexM = nkText(jockeyTd?.querySelector(".Barei")).match(/^(牡|牝|セ|せん)(\d+)(.*)$/);
    const weightSpan = jockeyTd ? Array.from(jockeyTd.querySelectorAll(":scope > span")).filter((s) => !s.classList.contains("Barei")).pop() : null;
    const weight = Number(nkText(weightSpan));
    // 過去走の「17頭 13番 6人 幸英明 58.0」から騎手名を集める(騎手エイリアスの候補用)
    const pastJockeys = [];
    tr.querySelectorAll("td.Past .Data03").forEach((el) => {
      const pm = nkText(el).match(/^\d+頭\s+\d+番\s+\d+人\s+(.+?)\s+\d{2}(?:\.\d)?$/);
      if (pm) pastJockeys.push(pm[1].trim());
    });
    out.push({
      waku_number: Number.isInteger(waku) && waku >= 1 && waku <= 8 ? waku : null,
      horse_number: horseNumber,
      horse_name: horseName,
      sire,
      dam,
      dam_sire: damSire,
      affiliation: tm ? tm[1] : null,
      trainer_abbr: tm ? tm[2].trim() : null,
      sex_age: sexM ? `${sexM[1] === "せん" ? "セ" : sexM[1]}${sexM[2]}` : null,
      coat_color: sexM ? sexM[3].trim() || null : null,
      jockey_abbr: nkJockeyFromCell(jockeyTd),
      weight_carried: Number.isFinite(weight) && weight > 0 ? weight : null,
      past_jockeys: [...new Set(pastJockeys)],
    });
  });
  return out.sort((a, b) => a.horse_number - b.horse_number);
}

// 払戻表(table.Payout_Detail_Table。2つに分かれている)→ { tan: [{combo, rate}], ... }
function nkParsePayouts(doc) {
  const payouts = {};
  doc.querySelectorAll("table.Payout_Detail_Table tr").forEach((tr) => {
    const type = NK_BET_TYPE_BY_LABEL[nkText(tr.querySelector("th"))];
    if (!type) return;
    const resultTd = tr.querySelector("td.Result");
    const payoutTd = tr.querySelector("td.Payout");
    if (!resultTd || !payoutTd) return;
    // 金額は <br> 区切りで組み合わせの数だけ並ぶ
    const amounts = payoutTd.innerHTML.split(/<br\s*\/?>/i)
      .map((s) => Number(s.replace(/<[^>]*>/g, "").replace(/[,円\s]/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!amounts.length) return;
    // 馬番は組み合わせごとに同じ数の枠(空欄を含む)で並ぶ。全部の枠を組み合わせの数で等分する
    const slots = Array.from(resultTd.querySelectorAll("span")).map((s) => nkText(s));
    const per = slots.length / amounts.length;
    if (!Number.isInteger(per) || per < 1) return;
    const list = [];
    amounts.forEach((rate, i) => {
      let combo = slots.slice(i * per, (i + 1) * per).filter((v) => /^\d+$/.test(v)).map(Number);
      if (type === "tan" || type === "fuku") combo = combo.slice(0, 1);
      if (combo.length) list.push({ combo, rate });
    });
    if (list.length) payouts[type] = list;
  });
  return payouts;
}

// 全体の「コーナー通過順位」の表から、馬ごとの通過順(各馬の列と同じ形 "3-3-2-1")を割り出す(2026-10-16。ユーザー要望)。
// 地方(nar.netkeiba.com)の結果ページは着順の表に通過順の列が無く、脚質が「不明」になっていた。各馬の列があればそちらを使い、
// 列が無い・空の馬だけこれで補う。表は結果ページが table.Corner_Num、過去レースのデータベースが table[summary="コーナー通過順位"]。
// 並びの書き方: 「10,(6,11)-8,2,4,1,(3,7),5-9」。区切り(, - =)は間隔の大きさだけで順位には関係しない。括弧は並走の馬群
// (内の馬から並ぶ。「*」は馬群の先頭)。**順位は「前にいる頭数+1」で、馬群の中の馬は全員同じ順位**(各馬の列と同じ数え方。
// 2026-10-16 に db.netkeiba.com の保存ページで16頭とも各馬の列と一致することを確認。馬群の中を1つずつずらす数え方は10頭だけ一致)。
// あるコーナーに載っていない馬(中止等)は、そのコーナーより後を付けない。戻り値: Map<馬番, "3-3-2-1">
function nkParseCornerPositions(doc) {
  const out = new Map();
  const table = doc.querySelector('table.Corner_Num, table[summary="コーナー通過順位"]');
  if (!table) return out;
  const corners = [];
  table.querySelectorAll("tr").forEach((tr) => {
    const td = tr.querySelector("td");
    if (!td) return;
    const ranks = new Map();
    let ahead = 0;
    const re = /\(([^)]*)\)|\*?(\d+)/g;
    const text = nkText(td).normalize("NFKC");
    let m;
    while ((m = re.exec(text))) {
      const group = m[1] !== undefined
        ? m[1].split(",").map((x) => Number(x.replace("*", "").trim())).filter((n) => Number.isInteger(n) && n > 0)
        : [Number(m[2])];
      for (const h of group) ranks.set(h, ahead + 1);
      ahead += group.length;
    }
    if (ranks.size) corners.push(ranks);
  });
  if (!corners.length) return out;
  const horses = new Set(corners.flatMap((r) => [...r.keys()]));
  for (const h of horses) {
    const list = [];
    for (const r of corners) {
      if (!r.has(h)) break;
      list.push(r.get(h));
    }
    if (list.length) out.set(h, list.join("-"));
  }
  return out;
}

// 結果・払戻ページ → 結果取込API(POST /api/races/results-import)へ送る1レース分のレコード
// (public/jra-result-html.js の jraResultHtmlParseRaceUnit と同じ形)。読み取れなければ null。
function nkParseResult(doc) {
  const meta = nkParseRaceMeta(doc);
  if (!meta) return null;
  const table = doc.querySelector("table.RaceTable01");
  if (!table) return null;
  // 列は見出しの文字で探す(中央と地方で列の並び・有無が違う。地方は通過順が無い等)
  const headers = Array.from(table.querySelectorAll("tr:first-child th")).map((th) => nkText(th).replace(/\s+/g, ""));
  const col = (re) => headers.findIndex((h) => re.test(h));
  const C = {
    rank: col(/^着順$/), waku: col(/^枠$/), num: col(/^馬番$/), name: col(/^馬名$/), sexAge: col(/^性齢$/),
    weight: col(/^斤量$/), jockey: col(/^騎手$/), time: col(/^タイム$/), margin: col(/^着差$/),
    pop: col(/^人気$/), last3f: col(/^後3F$/), corner: col(/^コーナー通過順$/), trainer: col(/^(厩舎|調教師)$/),
    body: col(/^馬体重/),
  };
  const cell = (tds, i) => (i >= 0 ? tds[i] : null);

  const entries = [];
  const race_results = [];
  const cornerByNumber = nkParseCornerPositions(doc); // 各馬の通過順の列が無い・空の馬を補う(2026-10-16)
  const finishSparse = [];
  Array.from(table.querySelectorAll("tr")).slice(1).forEach((tr) => {
    const tds = Array.from(tr.children).filter((c) => c.tagName === "TD");
    if (!tds.length) return;
    const horseNumber = Number(nkText(cell(tds, C.num)));
    if (!Number.isInteger(horseNumber) || horseNumber < 1) return;
    const rankText = nkText(cell(tds, C.rank));
    const status = NK_STATUS_BY_RANK_TEXT[rankText] || "finished";
    const finishPosition = status === "finished" && /^\d+$/.test(rankText) ? Number(rankText) : null;
    const nameTd = cell(tds, C.name);
    const horseName = nkText(nameTd?.querySelector("a")) || nkText(nameTd) || null;
    const waku = Number(nkText(cell(tds, C.waku)));
    const sexAge = nkText(cell(tds, C.sexAge)) || null;
    const weightNum = Number(nkText(cell(tds, C.weight)));
    const jockey = nkJockeyFromCell(cell(tds, C.jockey));
    const trainerTd = cell(tds, C.trainer);
    const trainer = nkText(trainerTd?.querySelector("a")) || null;
    const popText = nkText(cell(tds, C.pop));
    const last3f = Number(nkText(cell(tds, C.last3f)));
    const bodyM = nkText(cell(tds, C.body)).match(/^(\d+)\s*[（(]([^)）]*)[)）]/);
    const weightCarried = Number.isFinite(weightNum) && weightNum > 0 ? weightNum : null;
    entries.push({
      horse_number: horseNumber,
      waku_number: Number.isInteger(waku) && waku >= 1 && waku <= 8 ? waku : null,
      horse_name: horseName,
      jockey,
      sex_age: sexAge,
      weight_carried: weightCarried,
    });
    race_results.push({
      horse_number: horseNumber,
      horse_name: horseName,
      sex_age: sexAge,
      weight_carried: weightCarried,
      jockey,
      status,
      finish_position: finishPosition,
      time_text: nkText(cell(tds, C.time)) || null,
      margin: nkText(cell(tds, C.margin)) || null,
      corner_positions: nkText(cell(tds, C.corner)) || cornerByNumber.get(horseNumber) || null,
      final_furlong_time: Number.isFinite(last3f) && last3f > 0 ? last3f : null,
      body_weight: bodyM ? Number(bodyM[1]) : null,
      body_weight_change: bodyM ? bodyM[2] || null : null,
      trainer,
      win_popularity: /^\d+$/.test(popText) ? Number(popText) : null,
    });
    if (Number.isInteger(finishPosition)) finishSparse[finishPosition - 1] = horseNumber;
  });
  if (!race_results.length) return null;

  return {
    ...meta,
    entries,
    finish_order: finishSparse.filter((v) => v !== undefined).slice(0, 3),
    payouts: nkParsePayouts(doc),
    race_results,
  };
}

// ---------- 過去レースのデータベース(db.netkeiba.com/race/<レースID>/。2026-10-13追加) ----------
// 結果・払戻の1ページ。race.netkeiba.com の結果ページとは作りが違う(見出しは .data_intro、表は table.race_table_01、
// 払戻は table.pay_table_01)。結果取込API へ送る形(nkParseResult と同じ)にする。調教師はフルネームなのでそのまま送る。
const NK_DB_BET_TYPE_BY_LABEL = { ...NK_BET_TYPE_BY_LABEL, 三連複: "sanrenpuku", 三連単: "sanrentan" };

// 見出し: <dt>11R</dt>、<h1>第2回アイルランドT(GII)</h1>、
// <span>芝左1800m / 天候 : 晴 / 芝 : 良 / 発走 : 15:45</span>、<p class="smalltxt">2026年10月11日 4回東京4日目 3歳以上オープン (国際) 牝(指)(別定)</p>
function nkParseDbRaceMeta(doc) {
  const intro = doc.querySelector(".data_intro");
  if (!intro) return null;
  const small = nkText(intro.querySelector("p.smalltxt")).normalize("NFKC");
  const dm = small.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*\d+回(\S+?)\d+日目\s*(.*)$/);
  const rm = nkText(intro.querySelector("dt")).match(/(\d{1,2})\s*R/);
  if (!dm || !rm) return null;
  const rest = dm[5].trim();
  const wm = rest.match(/(馬齢|定量|別定|ハンデ)/);
  const class_flags = rest.replace(/\(?(馬齢|定量|別定|ハンデ)\)?/, "").replace(/\s+/g, " ").trim() || null;

  // レース名(グレード等の括弧書きは除く。例「第2回アイルランドT(GII)」→「第2回アイルランドT」)
  const race_name = nkText(intro.querySelector("h1")).replace(/\s*[(（](G|J・?G|Jpn|L|OP)[^)）]*[)）]\s*$/i, "").trim() || null;

  const d1 = nkText(intro.querySelector("dd p span")).normalize("NFKC");
  const courseM = d1.match(/(芝|ダ|障)[^\d/]*?(\d{3,4})m/);
  const dirM = d1.match(/(芝|ダ|障)\s*(左|右)/);
  const weatherM = d1.match(/天候\s*:\s*([^\s/]+)/);
  const condM = d1.match(/(?:芝|ダート|ダ)\s*:\s*([^\s/]+)/);
  const timeM = d1.match(/発走\s*:\s*(\d{1,2}):(\d{2})/);
  const COURSE = { 芝: "芝", ダ: "ダート", 障: "障害" };
  return {
    race_date: `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`,
    track: dm[4],
    race_number: Number(rm[1]),
    race_name,
    course_type: courseM ? COURSE[courseM[1]] : null,
    distance: courseM ? Number(courseM[2]) : null,
    course_direction: dirM ? dirM[2] : null,
    weather: weatherM ? weatherM[1] : null,
    track_condition: condM ? condM[1] : null,
    post_time: timeM ? `${timeM[1].padStart(2, "0")}:${timeM[2]}` : null,
    weight_type: wm ? wm[1] : null,
    class_flags,
  };
}

// 払戻(table.pay_table_01。2つに分かれている)。組み合わせ・金額は <br> 区切りで同じ数だけ並ぶ。
function nkParseDbPayouts(doc) {
  const payouts = {};
  const lines = (td) => (td ? td.innerHTML.split(/<br\s*\/?>/i).map((s) => s.replace(/<[^>]*>/g, "").trim()).filter(Boolean) : []);
  doc.querySelectorAll("table.pay_table_01 tr").forEach((tr) => {
    const type = NK_DB_BET_TYPE_BY_LABEL[nkText(tr.querySelector("th"))];
    if (!type) return;
    const tds = tr.querySelectorAll("td");
    const combos = lines(tds[0]);
    const amounts = lines(tds[1]).map((s) => Number(s.replace(/[,円\s]/g, "")));
    const list = [];
    combos.forEach((c, i) => {
      const combo = (c.match(/\d+/g) || []).map(Number);
      const rate = amounts[i];
      if (combo.length && Number.isFinite(rate) && rate > 0) list.push({ combo: type === "tan" || type === "fuku" ? combo.slice(0, 1) : combo, rate });
    });
    if (list.length) payouts[type] = list;
  });
  return payouts;
}

// 着順の欄: 数字(「5(降)」等は先頭の数字)、取消・除外・中止は「取」「除」「中」等
function nkDbStatusOf(rankText) {
  if (/取/.test(rankText)) return "scratched";
  if (/除/.test(rankText)) return "excluded";
  if (/中/.test(rankText)) return "stopped";
  return "finished";
}

function nkParseDbResult(doc) {
  const meta = nkParseDbRaceMeta(doc);
  if (!meta) return null;
  const table = doc.querySelector("table.race_table_01");
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll("tr"));
  // 見出し行の th(「着<br>順」は文字だけだと「着順」)。表示されない列(タイム指数マスター等)も th と td の数はそろっている
  const headers = Array.from(rows[0].querySelectorAll("th")).map((th) => nkText(th).replace(/\s+/g, ""));
  const col = (re) => headers.findIndex((h) => re.test(h));
  const C = {
    rank: col(/^着順$/), waku: col(/^枠番$/), num: col(/^馬番$/), name: col(/^馬名$/), sexAge: col(/^性齢$/),
    weight: col(/^斤量$/), jockey: col(/^騎手$/), time: col(/^タイム$/), margin: col(/^着差$/), corner: col(/^通過$/),
    last3f: col(/^上り$/), pop: col(/^人気$/), body: col(/^馬体重/), trainer: col(/^調教師$/),
  };
  const cell = (tds, i) => (i >= 0 ? tds[i] : null);
  const entries = [];
  const race_results = [];
  const cornerByNumber = nkParseCornerPositions(doc); // 各馬の通過順の列が無い・空の馬を補う(2026-10-16)
  const finishSparse = [];
  rows.slice(1).forEach((tr) => {
    const tds = Array.from(tr.children).filter((c) => c.tagName === "TD");
    if (!tds.length) return;
    const horseNumber = Number(nkText(cell(tds, C.num)));
    if (!Number.isInteger(horseNumber) || horseNumber < 1) return;
    const rankText = nkText(cell(tds, C.rank)).normalize("NFKC");
    const status = nkDbStatusOf(rankText);
    const rankNum = rankText.match(/^\d+/);
    const finishPosition = status === "finished" && rankNum ? Number(rankNum[0]) : null;
    const nameTd = cell(tds, C.name);
    const horseName = nkText(nameTd?.querySelector("a")) || nkText(nameTd) || null;
    const waku = Number(nkText(cell(tds, C.waku)));
    const sexAge = nkText(cell(tds, C.sexAge)) || null;
    const weightNum = Number(nkText(cell(tds, C.weight)));
    const weightCarried = Number.isFinite(weightNum) && weightNum > 0 ? weightNum : null;
    const jockey = nkJockeyFromCell(cell(tds, C.jockey));
    const trainer = nkText(cell(tds, C.trainer)?.querySelector("a")) || null;
    const popText = nkText(cell(tds, C.pop));
    const last3f = Number(nkText(cell(tds, C.last3f)));
    const bodyM = nkText(cell(tds, C.body)).match(/^(\d+)\s*[（(]([^)）]*)[)）]/);
    entries.push({
      horse_number: horseNumber,
      waku_number: Number.isInteger(waku) && waku >= 1 && waku <= 8 ? waku : null,
      horse_name: horseName,
      jockey,
      sex_age: sexAge,
      weight_carried: weightCarried,
    });
    race_results.push({
      horse_number: horseNumber,
      horse_name: horseName,
      sex_age: sexAge,
      weight_carried: weightCarried,
      jockey,
      status,
      finish_position: finishPosition,
      time_text: nkText(cell(tds, C.time)) || null,
      margin: nkText(cell(tds, C.margin)) || null,
      corner_positions: nkText(cell(tds, C.corner)) || cornerByNumber.get(horseNumber) || null,
      final_furlong_time: Number.isFinite(last3f) && last3f > 0 ? last3f : null,
      body_weight: bodyM ? Number(bodyM[1]) : null,
      body_weight_change: bodyM ? bodyM[2] || null : null,
      trainer,
      win_popularity: /^\d+$/.test(popText) ? Number(popText) : null,
    });
    if (Number.isInteger(finishPosition) && finishSparse[finishPosition - 1] === undefined) finishSparse[finishPosition - 1] = horseNumber;
  });
  if (!race_results.length) return null;
  return {
    ...meta,
    entries,
    finish_order: finishSparse.filter((v) => v !== undefined).slice(0, 3),
    payouts: nkParseDbPayouts(doc),
    race_results,
  };
}
