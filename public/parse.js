// テキストの貼り付けで出走馬を一括入力する解析(parseEntries・parseNetkeibaEntries・parseEntriesSimple)は 2026-10-16 に削除
// (画面の貼り付け欄を削除したため)。残りは netkeiba の馬柱の解析だけ(ブックマークレットの netkeiba-html.js が使う)。

// netkeibaの馬柱ページ(race.netkeiba.com/race/shutuba_past.html)をコピーしたテキストを解析する
// (2026-10-06追加。仕様・行の並びは docs/design/umabashira-paste.md)。
// 1頭ぶんは「枠番<TAB>馬番<TAB>」の行で始まり、印 / 父 / 馬名 / 母 / (母の父) / 所属・調教師 /
// 脚質・間隔 / 馬体重 / オッズ / 性齢・毛色 / 騎手 / 斤量 / (休養情報) / 過去走… と続く。
// 戻り値: [{ waku_number, horse_number, horse_name, sire, dam, dam_sire, affiliation, trainer_abbr,
//            sex_age, coat_color, jockey_abbr, weight_carried, past_jockeys: [...] }]
// 馬柱形式でなければ空配列(呼び出し元は従来の形式として読み取る)。
// 行末の空白・タブは落としてから判定する(コピー元では「1<TAB>1<TAB>」のように末尾にタブが付く)。
const UMABASHIRA_HEADER_RE = /^(\d{1,2})\t(\d{1,2})$/;
const UMABASHIRA_SEX_AGE_RE = /^(牡|牝|セ|せん)(\d{1,2})(.*)$/;

function parseNetkeibaUmabashira(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const starts = [];
  lines.forEach((l, i) => { if (UMABASHIRA_HEADER_RE.test(l.trim())) starts.push(i); });
  const results = [];
  for (let s = 0; s < starts.length; s++) {
    const header = lines[starts[s]].trim().split("\t");
    const block = lines.slice(starts[s] + 1, s + 1 < starts.length ? starts[s + 1] : lines.length)
      .map((l) => l.trim()).filter(Boolean);
    // 印の行(◎◯○▲△☆✓ や「--」等の短い記号)を飛ばす
    let i = 0;
    if (block[i] && (block[i].length <= 2 || /^[-‐ー─]+$/.test(block[i]))) i++;
    const sire = block[i++] || "";
    const nameRaw = block[i++] || "";
    const dam = block[i++] || "";
    const damSireRaw = block[i] && /^[(（].*[)）]$/.test(block[i]) ? block[i++] : "";
    // 所属・調教師(例「栗東・橋口」)
    let affiliation = null;
    let trainerAbbr = null;
    const tm = (block[i] || "").match(/^([^・\s]+)・(.+)$/);
    if (tm) { affiliation = tm[1]; trainerAbbr = tm[2].trim(); i++; }
    // 性齢・毛色の行を探し、その次を騎手、さらに次を斤量とみなす
    let sexAge = null, coatColor = null, jockeyAbbr = null, weight = null;
    const sexIdx = block.findIndex((l, k) => k >= i && UMABASHIRA_SEX_AGE_RE.test(l));
    if (sexIdx >= 0) {
      const m = block[sexIdx].match(UMABASHIRA_SEX_AGE_RE);
      sexAge = `${m[1] === "せん" ? "セ" : m[1]}${m[2]}`;
      coatColor = m[3].trim() || null;
      jockeyAbbr = block[sexIdx + 1] || null;
      const w = (block[sexIdx + 2] || "").match(/^(\d{2}(?:\.\d)?)$/);
      if (w) weight = Number(w[1]);
    }
    // 過去走の「17頭 13番 6人 幸英明 58.0」行から騎手名を集める(騎手エイリアスの候補用)
    const pastJockeys = [];
    for (const l of block) {
      const pm = l.match(/^\d+頭\s+\d+番\s+\d+人\s+(.+?)\s+\d{2}(?:\.\d)?$/);
      if (pm) pastJockeys.push(pm[1].trim());
    }
    // 馬名末尾の「B」はブリンカー着用の印(馬名の一部ではない)
    const horseName = nameRaw.replace(/B$/, "").trim();
    // 所属・調教師の行が無いブロックは馬柱形式ではない(従来の netkeiba 出馬表形式も
    // 「枠<TAB>馬番」で始まるため、取り違えないよう馬柱特有の行の有無で判定する)
    if (!horseName || !sire || !trainerAbbr) continue;
    results.push({
      waku_number: Number(header[0]) <= 8 ? Number(header[0]) : null,
      horse_number: Number(header[1]),
      horse_name: horseName,
      sire,
      dam: dam || null,
      dam_sire: damSireRaw ? damSireRaw.replace(/^[(（]|[)）]$/g, "").trim() : null,
      affiliation,
      trainer_abbr: trainerAbbr,
      sex_age: sexAge,
      coat_color: coatColor,
      jockey_abbr: jockeyAbbr,
      weight_carried: weight,
      past_jockeys: [...new Set(pastJockeys)],
    });
  }
  return results;
}

