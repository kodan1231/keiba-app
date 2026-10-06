// データ検索画面「重賞検索」タブ(2026-10-02追加)。仕様は docs/design/graded-race-search.md。
//   GET /api/data-search/graded-races            … 重賞の候補一覧(graded_races)
//   GET /api/data-search/graded-race?id=         … ①今年の出走馬一覧 ③過去10年の成績・傾向
//   GET /api/data-search/graded-race-horses?race_id= … ②出走馬ごとの詳細
// 血統等(horses)は保存済みの分だけを表示し、このタブからは netkeiba へ取得しに行かない
// (2026-10-04。以前は未取得の馬について horse-info を1頭ずつ順に呼んで取得していた。
// 取得は馬情報検索タブで検索したときだけ)。
// 過去走の表は予想登録画面の過去成績(.horse-history-table)の見た目を流用する。
// escapeHtml / escapeAttr / formatDate / formatDateMdW / formatYen / formatCourseText は utils.js、
// BET_TYPES は bettypes.js のものを使う。

const grEls = {};
let grItems = [];
let grGradeFilter = "all";
let grLoadToken = 0; // 別の重賞へ切り替えたら、進行中の取得結果を捨てるための世代番号
let grHorsesByNumber = new Map();

const GR_RECENT_RUNS = 5;
const GR_PAYOUT_ORDER = ["tan", "fuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];
const GR_STATUS_LABEL = { scratched: "取消", excluded: "除外", stopped: "中止" };

// 絞り込み用の正規化(graded_races.name_key と同じく略記へ寄せる。部分入力にも効くよう末尾以外も置換)
function grNorm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/ステークス/g, "S")
    .replace(/カップ/g, "C")
    .replace(/トロフィー/g, "T")
    .toLowerCase();
}

function grGradeLabel(item) {
  return `${item.is_jump ? "J・" : ""}${item.grade}`;
}

function grDash(v) {
  return v === null || v === undefined || v === "" ? "—" : v;
}

function grFixed1(v) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? "—" : n.toFixed(1);
}

function grSecondsText(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : s.toFixed(1);
}

function grPlaceText(status, finishPosition) {
  if (GR_STATUS_LABEL[status]) return GR_STATUS_LABEL[status];
  return finishPosition != null ? `${finishPosition}着` : "—";
}

function grCountsText(c) {
  return Array.isArray(c) ? c.join("-") : "—";
}

function grRates(c) {
  const runs = c[0] + c[1] + c[2] + c[3];
  if (!runs) return { runs, win: "—", show: "—" };
  return {
    runs,
    win: `${((c[0] / runs) * 100).toFixed(1)}%`,
    show: `${(((c[0] + c[1] + c[2]) / runs) * 100).toFixed(1)}%`,
  };
}

function grBodyWeightText(w, change) {
  if (w === null || w === undefined) return "—";
  return `${w}${change ? `(${change})` : ""}`;
}

// ---------- 候補一覧 ----------

function grFilteredItems() {
  const q = grNorm(grEls.search.value);
  return grItems.filter((it) => {
    if (grGradeFilter === "jump" && !it.is_jump) return false;
    if (["G1", "G2", "G3"].includes(grGradeFilter) && (it.is_jump || it.grade !== grGradeFilter)) return false;
    if (!q) return true;
    return grNorm(it.name).includes(q) || String(it.name_key || "").toLowerCase().includes(q);
  });
}

function grRenderList() {
  const items = grFilteredItems();
  if (!grItems.length) {
    grEls.list.innerHTML = `<p class="ticket-sub">重賞マスタが未登録です(管理画面「重賞管理」で登録してください)。</p>`;
    return;
  }
  if (!items.length) {
    grEls.list.innerHTML = `<p class="ticket-sub">該当する重賞がありません。</p>`;
    return;
  }
  const groups = new Map();
  for (const it of items) {
    const label = it.schedule_md ? `${Number(it.schedule_md.slice(0, 2))}月` : "開催日未設定";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(it);
  }
  grEls.list.innerHTML = [...groups]
    .map(
      ([label, list]) => `
      <div class="gr-month">
        <h3 class="gr-month-label">${escapeHtml(label)}</h3>
        <div class="gr-cand-wrap">
          ${list
            .map((it) => {
              const sub = [
                it.schedule_md ? it.schedule_md.replace("-", "/") : null,
                it.track,
                formatCourseText(it.course_type, it.distance) || null,
                it.age_condition,
              ]
                .filter(Boolean)
                .join(" ");
              return `
              <button type="button" class="hi-result-btn gr-cand-btn" data-id="${it.id}">
                <span class="gr-grade gr-grade-${escapeAttr(it.is_jump ? "J" : it.grade)}">${escapeHtml(grGradeLabel(it))}</span>
                <span class="hi-result-name">${escapeHtml(it.name)}</span>
                ${sub ? `<span class="hi-result-count">${escapeHtml(sub)}</span>` : ""}
              </button>`;
            })
            .join("")}
        </div>
      </div>`
    )
    .join("");
}

async function grLoadList() {
  grEls.status.hidden = false;
  grEls.status.textContent = "読み込み中…";
  try {
    const res = await authedFetch("/api/data-search/graded-races");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    grItems = data.items || [];
    grEls.status.hidden = true;
    grRenderList();
  } catch {
    grEls.status.textContent = "重賞一覧の取得に失敗しました。";
  }
}

function grShowPicker() {
  grLoadToken += 1;
  grEls.detail.hidden = true;
  grEls.picker.hidden = false;
}

// ---------- ① 今年の出走馬一覧 ----------

function grRaceMetaText(race, fieldSize) {
  if (!race) return "";
  return [
    formatDate(race.race_date),
    `${race.track || ""}${race.race_number ? `${race.race_number}R` : ""}`,
    formatCourseText(race.course_type, race.distance),
    race.weather,
    race.track_condition,
    fieldSize ? `${fieldSize}頭` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function grRenderCurrent(data) {
  const cur = data.current;
  grEls.currentHeading.textContent = `${data.current_year}年の出走馬`;
  if (cur.status === "unannounced") {
    const sched = data.master.schedule_md ? `(開催予定 ${data.master.schedule_md.replace("-", "/")})` : "";
    grEls.current.innerHTML = `<p class="gr-unannounced">未発表(未取込)${escapeHtml(sched)}</p>`;
    return;
  }
  const finished = cur.status === "finished";
  const head = `
    <tr>
      ${finished ? "<th>着順</th>" : ""}
      <th>枠</th><th>馬番</th><th>馬名</th><th>性齢</th><th>斤量</th><th>騎手</th>
      ${finished ? "<th>人気</th><th>タイム</th>" : ""}
      <th>調教師</th><th>父</th><th>母父</th><th>前走</th><th>間隔</th><th>脚質</th><th>持ちタイム<br>(同距離)</th>
    </tr>`;
  const colCount = finished ? 16 : 13;
  const rows = cur.entries
    .map((e) => {
      const r = e.result;
      const waku = e.waku_number ? `<span class="gr-waku waku-${e.waku_number}">${e.waku_number}</span>` : "—";
      return `
      <tr class="gr-entry-row${r && GR_STATUS_LABEL[r.status] && r.status !== "stopped" ? " gr-entry-scratched" : ""}" data-hn="${e.horse_number ?? ""}" data-name="${escapeAttr(e.horse_name)}">
        ${finished ? `<td class="hh-place">${escapeHtml(r ? grPlaceText(r.status, r.finish_position) : "—")}</td>` : ""}
        <td>${waku}</td>
        <td>${grDash(e.horse_number)}</td>
        <td class="table-name gr-horse-name"><button type="button" class="gr-horse-toggle">${escapeHtml(e.horse_name)}</button></td>
        <td>${escapeHtml(grDash(e.sex_age))}</td>
        <td>${grFixed1(e.weight_carried)}</td>
        <td>${escapeHtml(grDash(e.jockey))}</td>
        ${finished ? `<td>${r?.win_popularity ?? "—"}</td><td>${escapeHtml(r?.time_text || "—")}</td>` : ""}
        <td data-col="trainer">…</td>
        <td data-col="sire">…</td>
        <td data-col="dam_sire">…</td>
        <td data-col="prev" class="table-name">…</td>
        <td data-col="interval">…</td>
        <td data-col="style">…</td>
        <td data-col="best">…</td>
      </tr>
      <tr class="gr-entry-detail" hidden><td colspan="${colCount}"><div class="gr-horse-detail">読み込み中…</div></td></tr>`;
    })
    .join("");
  grEls.current.innerHTML = `
    <p class="ticket-sub">${escapeHtml(grRaceMetaText(cur.race, cur.field_size))}</p>
    <p class="stats-note">馬名を押すと、過去走・持ちタイム・着別度数などの詳細を開きます。</p>
    <div class="table-wrap"><table class="stats-table gr-entry-table">${head}${rows}</table></div>
    ${finished && cur.payouts ? `<h3 class="stats-subheading gr-sub-heading">払戻</h3>${grPayoutTableHtml(cur.payouts)}` : ""}`;

  grSyncDetailWidth();
  grEls.current.querySelectorAll(".gr-horse-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      const detail = row.nextElementSibling;
      detail.hidden = !detail.hidden;
      if (!detail.hidden) grRenderHorseDetail(row);
    });
  });
}

// 詳細パネルの幅を出走馬表の表示枠(.table-wrap)の幅に合わせる(style.css の .gr-horse-detail 参照)
function grSyncDetailWidth() {
  const wrap = grEls.current?.querySelector(".table-wrap");
  if (wrap) wrap.style.setProperty("--gr-wrap-w", `${Math.max(240, wrap.clientWidth - 20)}px`);
}

function grBestText(b, { last3f = false } = {}) {
  if (!b) return "—";
  return last3f ? grFixed1(b.value) : b.time_text || grSecondsText(b.value);
}

function grBestSub(b) {
  if (!b) return "記録なし";
  return [
    b.race_date ? formatDate(b.race_date) : null,
    b.track,
    b.race_name,
    formatCourseText(b.course_type, b.distance),
    b.track_condition,
    b.finish_position != null ? `${b.finish_position}着` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function grApplyMasterCells(row, master) {
  const set = (col, v) => {
    const cell = row.querySelector(`[data-col="${col}"]`);
    if (cell) cell.textContent = grDash(v);
  };
  set("trainer", master?.trainer);
  set("sire", master?.sire);
  set("dam_sire", master?.dam_sire);
}

function grApplyHorseRow(row, h) {
  const set = (col, html) => {
    const cell = row.querySelector(`[data-col="${col}"]`);
    if (cell) cell.innerHTML = html;
  };
  grApplyMasterCells(row, h.master);
  const p = h.prev_run;
  set(
    "prev",
    p
      ? `${escapeHtml(grPlaceText(p.status, p.finish_position))}${p.field_size ? `/${p.field_size}頭` : ""} ${escapeHtml(p.race_name || p.track || "")}`
      : "—"
  );
  set("interval", escapeHtml(h.interval_label || "—"));
  set("style", escapeHtml(h.running_style || "—"));
  const b = h.best_time_same_distance;
  set("best", b ? `${escapeHtml(grBestText(b))}<br><span class="gr-cell-sub">${escapeHtml(b.track_condition || "")}</span>` : "—");
}

function grHistoryTableHtml(runs) {
  const body = runs
    .map(
      (r) => `
      <tr title="${escapeAttr(r.race_name || "")}">
        <td>${escapeHtml(formatDate(r.race_date))}</td>
        <td>${escapeHtml(`${r.track || ""}${r.race_number ? `${r.race_number}R` : ""}`)}</td>
        <td class="gr-hh-name">${r.grade ? `<span class="gr-grade gr-grade-${escapeAttr(r.grade)}">${escapeHtml(r.grade)}</span>` : ""}${escapeHtml(r.race_name || "—")}</td>
        <td>${escapeHtml(formatCourseText(r.course_type, r.distance) || "—")}</td>
        <td>${escapeHtml(grDash(r.track_condition))}</td>
        <td>${escapeHtml(grDash(r.weather))}</td>
        <td>${grDash(r.field_size)}</td>
        <td>${grDash(r.waku_number)}</td>
        <td>${grDash(r.horse_number)}</td>
        <td>${r.win_popularity != null ? `${r.win_popularity}人` : "—"}</td>
        <td class="hh-place">${escapeHtml(grPlaceText(r.status, r.finish_position))}</td>
        <td>${escapeHtml(grDash(r.jockey))}</td>
        <td>${grFixed1(r.weight_carried)}</td>
        <td>${escapeHtml(grDash(r.time_text))}</td>
        <td>${escapeHtml(grDash(r.margin))}</td>
        <td>${escapeHtml(grDash(r.corner_positions))}</td>
        <td>${grFixed1(r.final_furlong_time)}</td>
        <td>${escapeHtml(grBodyWeightText(r.body_weight, r.body_weight_change))}</td>
        <td>${escapeHtml(grDash(r.running_style))}</td>
        <td class="gr-hh-note">${escapeHtml(r.incident_note || "")}</td>
      </tr>`
    )
    .join("");
  return `
    <div class="horse-history-scroll">
      <table class="horse-history-table">
        <thead><tr><th>日付</th><th>場</th><th>レース名</th><th>コース</th><th>馬場</th><th>天候</th><th>頭数</th><th>枠</th><th>馬番</th><th>人気</th><th>着順</th><th>騎手</th><th>斤量</th><th>タイム</th><th>着差</th><th>通過</th><th>上がり</th><th>馬体重</th><th>脚質</th><th>備考</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function grCardsHtml(cards) {
  return `<div class="overall-grid hi-master-grid">${cards
    .map(
      (c) => `
      <div class="overall-card">
        <span class="overall-label">${escapeHtml(c.label)}</span>
        <span class="overall-value">${escapeHtml(grDash(c.value))}</span>
        ${c.sub ? `<span class="gr-card-sub">${escapeHtml(c.sub)}</span>` : ""}
      </div>`
    )
    .join("")}</div>`;
}

function grCountsTableHtml(rows) {
  return `
    <div class="table-wrap"><table class="stats-table gr-counts-table">
      <tr><th>区分</th><th>着別度数</th><th>出走</th><th>勝率</th><th>複勝率</th></tr>
      ${rows
        .map((r) => {
          const rt = grRates(r.counts);
          return `<tr><td class="table-name">${escapeHtml(r.label)}</td><td>${grCountsText(r.counts)}</td><td>${rt.runs}</td><td>${rt.win}</td><td>${rt.show}</td></tr>`;
        })
        .join("")}
    </table></div>`;
}

function grRenderHorseDetail(row) {
  const box = row.nextElementSibling.querySelector(".gr-horse-detail");
  const h = grHorsesByNumber.get(row.dataset.hn) || grHorsesByNumber.get(`name:${row.dataset.name}`);
  if (!h) {
    box.textContent = "読み込み中…";
    return;
  }
  const m = h.master || {};
  const p = h.prev_run;
  const jc = h.jockey_course ? grRates(h.jockey_course) : null;
  const jw = h.jockey_with_horse ? grRates(h.jockey_with_horse) : null;
  const recent = h.runs.slice(0, GR_RECENT_RUNS);
  box.innerHTML = `
    <h4 class="gr-detail-heading">血統・関係者</h4>
    ${grCardsHtml([
      { label: "父", value: m.sire },
      { label: "母", value: m.dam },
      { label: "母父", value: m.dam_sire },
      { label: "調教師", value: m.trainer },
      { label: "馬主", value: m.owner },
      { label: "生産牧場", value: m.breeder },
    ])}
    ${!h.has_master ? `<p class="stats-note">血統等は未取得です。馬情報検索タブでこの馬を検索すると取得されます。</p>` : m.fetch_error ? `<p class="stats-note">${escapeHtml(hiFetchErrorWithWhenText(m.fetch_error, m.fetched_at, m.fetched_now))}${window.currentUser?.isAdmin ? "馬情報検索タブから編集・再取得できます。" : ""}</p>` : ""}
    <h4 class="gr-detail-heading">持ちタイム・上がり・ローテーション</h4>
    ${grCardsHtml([
      { label: "持ちタイム(同距離)", value: grBestText(h.best_time_same_distance), sub: grBestSub(h.best_time_same_distance) },
      { label: "持ちタイム(同コース)", value: grBestText(h.best_time_same_course), sub: grBestSub(h.best_time_same_course) },
      { label: "上がり最速(全体)", value: grBestText(h.best_last3f, { last3f: true }), sub: grBestSub(h.best_last3f) },
      { label: "上がり最速(同芝ダ)", value: grBestText(h.best_last3f_same_surface, { last3f: true }), sub: grBestSub(h.best_last3f_same_surface) },
      { label: "前走からの間隔", value: h.interval_label, sub: p ? `前走 ${formatDate(p.race_date)} ${p.race_name || ""}` : "前走なし" },
      { label: "前走馬体重", value: p ? grBodyWeightText(p.body_weight, p.body_weight_change) : null },
      { label: "脚質(直近5走)", value: h.running_style },
      {
        label: "騎手のコース成績",
        value: jc ? `${grCountsText(h.jockey_course)}` : null,
        sub: jc ? `${h.jockey || ""} 勝率${jc.win} 複勝率${jc.show}` : null,
      },
      {
        label: "騎手×この馬",
        value: jw ? `${grCountsText(h.jockey_with_horse)}` : null,
        sub: jw ? `${h.jockey || ""} 勝率${jw.win} 複勝率${jw.show}` : null,
      },
    ])}
    <h4 class="gr-detail-heading">着別度数</h4>
    ${grCountsTableHtml(h.records)}
    <h4 class="gr-detail-heading">過去走(直近${GR_RECENT_RUNS}走)</h4>
    ${recent.length ? `<div class="gr-history" data-mode="recent">${grHistoryTableHtml(recent)}</div>` : `<p class="horse-history-empty">過去成績はありません</p>`}
    ${h.runs.length > GR_RECENT_RUNS ? `<button type="button" class="ghost-btn gr-all-runs-btn">全戦績を表示(${h.runs.length}走)</button>` : ""}`;
  box.querySelector(".gr-all-runs-btn")?.addEventListener("click", (ev) => {
    const wrap = box.querySelector(".gr-history");
    const showAll = wrap.dataset.mode === "recent";
    wrap.dataset.mode = showAll ? "all" : "recent";
    wrap.innerHTML = grHistoryTableHtml(showAll ? h.runs : recent);
    ev.currentTarget.textContent = showAll ? `直近${GR_RECENT_RUNS}走に戻す` : `全戦績を表示(${h.runs.length}走)`;
  });
}

function grRowsForHorse(h) {
  const sel = h.horse_number != null ? `tr.gr-entry-row[data-hn="${h.horse_number}"]` : null;
  const rows = sel ? [...grEls.current.querySelectorAll(sel)] : [];
  if (rows.length) return rows;
  return [...grEls.current.querySelectorAll("tr.gr-entry-row")].filter((r) => r.dataset.name === h.horse_name);
}

async function grLoadHorses(raceId, token) {
  let data;
  try {
    const res = await authedFetch(`/api/data-search/graded-race-horses?race_id=${encodeURIComponent(raceId)}`);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    if (token !== grLoadToken) return;
    grEls.current.querySelectorAll("[data-col]").forEach((c) => { if (c.textContent === "…") c.textContent = "—"; });
    grEls.current.querySelectorAll(".gr-horse-detail").forEach((b) => { b.textContent = "詳細の取得に失敗しました。"; });
    return;
  }
  if (token !== grLoadToken) return;
  grHorsesByNumber = new Map();
  for (const h of data.horses || []) {
    grHorsesByNumber.set(h.horse_number != null ? String(h.horse_number) : `name:${h.horse_name}`, h);
    for (const row of grRowsForHorse(h)) {
      grApplyHorseRow(row, h);
      if (!row.nextElementSibling.hidden) grRenderHorseDetail(row);
    }
  }

  // 2026-10-04: 以前はここで、血統等が未取得の馬について1頭ずつ順に horse-info を呼び netkeiba から
  // 取得していたが、出走馬ぶん(18頭で問い合わせ約50回)を数秒で連続取得することになり、netkeiba から
  // 取得を拒否される(HTTP 400)一因になり得たため廃止した。重賞検索では保存済みの血統だけを表示し、
  // 取得は馬情報検索タブで検索したときだけ行う(docs/design/graded-race-search.md)。
}

// ---------- ③ 過去10年 ----------

function grComboText(key, combo) {
  const def = typeof BET_TYPES !== "undefined" ? BET_TYPES[key] : null;
  return (combo || []).join(def && def.ordered ? "→" : "-");
}

function grPayoutTableHtml(payouts) {
  const rows = GR_PAYOUT_ORDER.filter((k) => Array.isArray(payouts?.[k]) && payouts[k].length)
    .map((k) => {
      const label = (typeof BET_TYPES !== "undefined" && BET_TYPES[k]?.label) || k;
      const cells = payouts[k]
        .map((p) => `${escapeHtml(grComboText(k, p.combo))} ${escapeHtml(formatYen(p.rate))}`)
        .join("<br>");
      return `<tr><td class="table-name">${escapeHtml(label)}</td><td class="gr-payout-cell">${cells}</td></tr>`;
    })
    .join("");
  return rows ? `<div class="table-wrap"><table class="stats-table gr-payout-table">${rows}</table></div>` : `<p class="ticket-sub">払戻の登録なし</p>`;
}

function grMainPayoutText(payouts) {
  return ["tan", "umaren", "sanrentan"]
    .map((k) => {
      const list = payouts?.[k];
      if (!Array.isArray(list) || !list.length) return null;
      const label = (typeof BET_TYPES !== "undefined" && BET_TYPES[k]?.label) || k;
      return `${label} ${list.map((p) => formatYen(p.rate)).join("/")}`;
    })
    .filter(Boolean)
    .join(" ・ ");
}

function grResultTableHtml(rows, { full }) {
  const head = full
    ? `<tr><th>着順</th><th>枠</th><th>馬番</th><th>馬名</th><th>性齢</th><th>斤量</th><th>騎手</th><th>タイム</th><th>着差</th><th>通過</th><th>上がり</th><th>人気</th><th>馬体重</th><th>脚質</th><th>備考</th></tr>`
    : `<tr><th>着順</th><th>馬番</th><th>馬名</th><th>性齢</th><th>人気</th><th>騎手</th><th>斤量</th><th>タイム</th><th>着差</th><th>上がり</th><th>通過</th><th>脚質</th></tr>`;
  const body = rows
    .map((r) =>
      full
        ? `<tr>
            <td class="hh-place">${escapeHtml(grPlaceText(r.status, r.finish_position))}</td>
            <td>${grDash(r.waku_number)}</td><td>${grDash(r.horse_number)}</td>
            <td class="table-name">${escapeHtml(grDash(r.horse_name))}</td>
            <td>${escapeHtml(grDash(r.sex_age))}</td><td>${grFixed1(r.weight_carried)}</td>
            <td>${escapeHtml(grDash(r.jockey))}</td><td>${escapeHtml(grDash(r.time_text))}</td>
            <td>${escapeHtml(grDash(r.margin))}</td><td>${escapeHtml(grDash(r.corner_positions))}</td>
            <td>${grFixed1(r.final_furlong_time)}</td><td>${grDash(r.win_popularity)}</td>
            <td>${escapeHtml(grBodyWeightText(r.body_weight, r.body_weight_change))}</td>
            <td>${escapeHtml(grDash(r.running_style))}</td>
            <td class="gr-hh-note">${escapeHtml(r.incident_note || "")}</td>
          </tr>`
        : `<tr>
            <td class="hh-place">${escapeHtml(grPlaceText(r.status, r.finish_position))}</td>
            <td>${grDash(r.horse_number)}</td>
            <td class="table-name">${escapeHtml(grDash(r.horse_name))}</td>
            <td>${escapeHtml(grDash(r.sex_age))}</td><td>${grDash(r.win_popularity)}</td>
            <td>${escapeHtml(grDash(r.jockey))}</td><td>${grFixed1(r.weight_carried)}</td>
            <td>${escapeHtml(grDash(r.time_text))}</td><td>${escapeHtml(grDash(r.margin))}</td>
            <td>${grFixed1(r.final_furlong_time)}</td><td>${escapeHtml(grDash(r.corner_positions))}</td>
            <td>${escapeHtml(grDash(r.running_style))}</td>
          </tr>`
    )
    .join("");
  return `<div class="table-wrap"><table class="stats-table gr-result-table">${head}${body}</table></div>`;
}

function grRenderPast(data) {
  grEls.pastHeading.textContent = `過去${data.past_years}年の成績(${data.current_year - data.past_years}〜${data.current_year - 1}年)`;
  if (!data.past.length) {
    grEls.past.innerHTML = `<p class="ticket-sub">取り込み済みの過去の結果がありません。</p>`;
    return;
  }
  grEls.past.innerHTML = data.past
    .map((p) => {
      const top3 = p.rows.filter((r) => r.status === "finished" && r.finish_position >= 1 && r.finish_position <= 3);
      return `
      <div class="gr-year-card">
        <div class="gr-year-head">
          <span class="gr-year">${p.year}年</span>
          <span class="ticket-sub">${escapeHtml(grRaceMetaText(p.race, p.field_size))}</span>
          ${p.differs_from_reference ? `<span class="gr-differs">今年と開催条件が異なる</span>` : ""}
        </div>
        ${grResultTableHtml(top3, { full: false })}
        <p class="gr-main-payout">${escapeHtml(grMainPayoutText(p.payouts) || "払戻の登録なし")}</p>
        ${
          p.results_source === "race_results"
            ? `<details class="gr-year-more"><summary>全着順・全払戻を表示</summary>
                ${grResultTableHtml(p.rows, { full: true })}
                ${grPayoutTableHtml(p.payouts)}
              </details>`
            : `<details class="gr-year-more"><summary>全払戻を表示</summary>
                <p class="stats-note">この年は全着順が取り込まれていないため、上位3着のみ表示しています。</p>
                ${grPayoutTableHtml(p.payouts)}
              </details>`
        }
      </div>`;
    })
    .join("");
}

function grRenderTrends(data) {
  const t = data.trends;
  grEls.trendsNote.textContent =
    `人気別・枠番別・年齢/性別・脚質別は、過去${data.past_years}年のうち全着順を取り込み済みの${t.full_years}年分を集計しています。` +
    `払戻は${t.payout_years}年分。勝ちタイム・上がりは今年と同じ競馬場・芝ダ・距離の年のみ。`;
  if (!t.full_years && !t.payout_years) {
    grEls.trends.innerHTML = `<p class="ticket-sub">集計できる過去の結果がありません。</p>`;
    return;
  }
  const payoutRows = t.payouts
    .map((p) => {
      const label = (typeof BET_TYPES !== "undefined" && BET_TYPES[p.key]?.label) || p.key;
      const yen = (v) => (v == null ? "—" : formatYen(Math.round(v)));
      return `<tr><td class="table-name">${escapeHtml(label)}</td><td>${p.years}</td><td>${yen(p.median)}</td><td>${yen(p.max)}</td><td>${yen(p.min)}</td></tr>`;
    })
    .join("");
  grEls.trends.innerHTML = `
    <div class="gr-trend-grid">
      <div><h3 class="stats-subheading">人気別</h3>${grCountsTableHtml(t.popularity)}</div>
      <div><h3 class="stats-subheading">枠番別</h3>${grCountsTableHtml(t.waku)}</div>
      <div><h3 class="stats-subheading">年齢別</h3>${grCountsTableHtml(t.age)}</div>
      <div><h3 class="stats-subheading">性別</h3>${grCountsTableHtml(t.sex)}</div>
      <div><h3 class="stats-subheading">脚質別</h3>${grCountsTableHtml(t.style)}</div>
      <div>
        <h3 class="stats-subheading">払戻</h3>
        <div class="table-wrap"><table class="stats-table">
          <tr><th>式別</th><th>年数</th><th>中央値</th><th>最高</th><th>最低</th></tr>${payoutRows}
        </table></div>
        <h3 class="stats-subheading gr-sub-heading">勝ちタイム・上がり</h3>
        ${grCardsHtml([
          { label: "勝ちタイム平均", value: grSecondsText(t.winning_time.avg_seconds), sub: `${t.winning_time.years}年分` },
          { label: "勝ち馬の上がり平均", value: grFixed1(t.winner_last3f.avg), sub: `${t.winner_last3f.years}年分` },
        ])}
      </div>
    </div>`;
}

// ---------- 詳細の読み込み ----------

async function grLoadDetail(id) {
  const token = ++grLoadToken;
  grHorsesByNumber = new Map();
  grEls.picker.hidden = true;
  grEls.detail.hidden = false;
  const item = grItems.find((it) => String(it.id) === String(id));
  grEls.title.textContent = item ? item.name : "";
  grEls.sub.textContent = "";
  grEls.currentHeading.textContent = "";
  grEls.current.innerHTML = `<p class="ticket-sub">読み込み中…</p>`;
  grEls.past.innerHTML = "";
  grEls.trends.innerHTML = "";
  grEls.trendsNote.textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });

  let data;
  try {
    const res = await authedFetch(`/api/data-search/graded-race?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    if (token === grLoadToken) grEls.current.innerHTML = `<p class="ticket-sub">取得に失敗しました。</p>`;
    return;
  }
  if (token !== grLoadToken) return;
  const m = data.master;
  grEls.title.innerHTML = `<span class="gr-grade gr-grade-${escapeAttr(m.is_jump ? "J" : m.grade)}">${escapeHtml(grGradeLabel(m))}</span> ${escapeHtml(m.name)}`;
  grEls.sub.textContent = [m.track, formatCourseText(m.course_type, m.distance), m.age_condition].filter(Boolean).join(" ");

  grRenderCurrent(data);
  grRenderPast(data);
  grRenderTrends(data);
  if (data.current.status !== "unannounced" && data.current.race) {
    grLoadHorses(data.current.race.id, token);
  }
}

function grInit() {
  grEls.picker = document.getElementById("gr-picker");
  grEls.search = document.getElementById("gr-search");
  grEls.gradeFilter = document.getElementById("gr-grade-filter");
  grEls.status = document.getElementById("gr-status");
  grEls.list = document.getElementById("gr-list");
  grEls.detail = document.getElementById("gr-detail");
  grEls.title = document.getElementById("gr-title");
  grEls.sub = document.getElementById("gr-sub");
  grEls.currentHeading = document.getElementById("gr-current-heading");
  grEls.current = document.getElementById("gr-current");
  grEls.pastHeading = document.getElementById("gr-past-heading");
  grEls.past = document.getElementById("gr-past");
  grEls.trendsNote = document.getElementById("gr-trends-note");
  grEls.trends = document.getElementById("gr-trends");

  grEls.search.addEventListener("input", () => grRenderList());
  grEls.gradeFilter.querySelectorAll(".horse-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      grEls.gradeFilter.querySelectorAll(".horse-row-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      grGradeFilter = btn.dataset.value;
      grRenderList();
    });
  });
  grEls.list.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".gr-cand-btn");
    if (btn) grLoadDetail(btn.dataset.id);
  });
  document.getElementById("gr-back-btn").addEventListener("click", () => grShowPicker());
  window.addEventListener("resize", () => grSyncDetailWidth());

  grLoadList();
}
