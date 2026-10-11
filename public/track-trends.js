// データ検索画面「競馬場傾向」タブ(2026-10-12追加)。仕様は docs/design/data-search.md「競馬場傾向タブ」。
// 芝ダ・距離・クラスを選ぶと、競馬場ごと・馬場状態ごとの勝ちタイムの平均と、全競馬場の平均との差を表にする。
// API: GET /api/data-search/track-trends。escapeHtml は utils.js、dsTrackSortIndex は data-search.js のもの。

const ttEls = {};
let ttCourse = "芝";
let ttClass = "all";
let ttDistances = null; // { 芝: [{distance, races}], ... }
let ttLoadToken = 0;

function ttTimeText(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(2).padStart(5, "0")}` : s.toFixed(2);
}
function ttDiffText(d) {
  if (d == null) return "";
  const v = Math.round(d * 100) / 100;
  return v === 0 ? "±0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
}

function ttSetStatus(text) {
  ttEls.status.hidden = !text;
  ttEls.status.textContent = text || "";
}

function ttRenderDistances() {
  const list = (ttDistances && ttDistances[ttCourse]) || [];
  const prev = Number(ttEls.distance.value);
  ttEls.distance.innerHTML = list.length
    ? list.map((d) => `<option value="${d.distance}">${d.distance}m(${d.races}レース)</option>`).join("")
    : `<option value="">(データなし)</option>`;
  if (list.some((d) => d.distance === prev)) ttEls.distance.value = String(prev);
  else if (list.length) {
    // 既定はレース数の一番多い距離
    ttEls.distance.value = String([...list].sort((a, b) => b.races - a.races)[0].distance);
  }
}

// 1つの欄: 平均タイム・差・レース数。レース数が少ない欄は薄く表示する。
function ttCellHtml(cell, base, minRaces) {
  if (!cell || !cell.n) return `<td class="tt-cell tt-empty">—</td>`;
  const diff = base && base.avg != null && cell.avg != null ? cell.avg - base.avg : null;
  const few = cell.n < minRaces;
  const cls = diff == null || few ? "" : diff < 0 ? " tt-fast" : diff > 0 ? " tt-slow" : "";
  return `<td class="tt-cell${few ? " tt-few" : ""}">
    <div class="tt-avg">${ttTimeText(cell.avg)}</div>
    <div class="tt-diff${cls}">${ttDiffText(diff)}</div>
    <div class="tt-n">${cell.n}R</div>
  </td>`;
}

function ttRenderTable(data) {
  const conds = data.conditions || ["良", "稍重", "重", "不良"];
  const minRaces = data.min_races || 3;
  ttEls.min.textContent = String(minRaces);
  if (!data.tracks || !data.tracks.length) {
    ttEls.table.innerHTML = `<tbody><tr><td class="ticket-sub">該当するレースがありません。</td></tr></tbody>`;
    return;
  }
  const ov = data.overall;
  const head = `<thead><tr><th>競馬場</th><th>全体</th>${conds.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  // 全競馬場の行: 全体は差なし、馬場の列は良馬場との差(馬場による補正値)
  const overallRow = `<tr class="tt-overall"><th scope="row">全競馬場</th>${ttCellHtml(ov.all, null, minRaces)}${conds
    .map((c) => ttCellHtml(ov[c], c === "良" ? null : ov["良"], minRaces))
    .join("")}</tr>`;
  const tracks = [...data.tracks].sort((a, b) => dsTrackSortIndex(a.track) - dsTrackSortIndex(b.track) || b.all.n - a.all.n);
  const rows = tracks
    .map((t) => `<tr><th scope="row">${escapeHtml(t.track)}</th>${ttCellHtml(t.all, ov.all, minRaces)}${conds
      .map((c) => ttCellHtml(t[c], ov[c], minRaces))
      .join("")}</tr>`)
    .join("");
  ttEls.table.innerHTML = `${head}<tbody>${overallRow}${rows}</tbody>`;
}

async function ttLoad() {
  const distance = Number(ttEls.distance.value);
  if (!distance) {
    ttEls.table.innerHTML = "";
    ttSetStatus("この芝ダの勝ちタイムのデータがありません。");
    return;
  }
  const token = ++ttLoadToken;
  ttSetStatus("読み込み中…");
  try {
    const q = new URLSearchParams({ course_type: ttCourse, distance: String(distance), class: ttClass });
    const res = await authedFetch(`/api/data-search/track-trends?${q}`);
    if (res.status === 503) throw new Error("paused");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (token !== ttLoadToken) return;
    ttSetStatus("");
    ttRenderTable(data);
  } catch (e) {
    if (token !== ttLoadToken) return;
    ttEls.table.innerHTML = "";
    ttSetStatus(e.message === "paused" ? "D1の使用量が多いため、データ検索の集計は一時停止中です。" : "取得に失敗しました。");
  }
}

async function ttLoadDistances() {
  ttSetStatus("読み込み中…");
  try {
    const res = await authedFetch("/api/data-search/track-trends");
    if (res.status === 503) throw new Error("paused");
    if (!res.ok) throw new Error(String(res.status));
    ttDistances = (await res.json()).distances || {};
  } catch (e) {
    ttSetStatus(e.message === "paused" ? "D1の使用量が多いため、データ検索の集計は一時停止中です。" : "取得に失敗しました。");
    return;
  }
  ttRenderDistances();
  ttLoad();
}

function ttSetupButtons(container, onSelect) {
  container.querySelectorAll(".horse-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".horse-row-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onSelect(btn.dataset.value);
    });
  });
}

function ttInit() {
  ttEls.distance = document.getElementById("tt-distance");
  ttEls.status = document.getElementById("tt-status");
  ttEls.table = document.getElementById("tt-table");
  ttEls.min = document.getElementById("tt-min");

  ttSetupButtons(document.getElementById("tt-course-filter"), (v) => {
    ttCourse = v;
    ttRenderDistances();
    ttLoad();
  });
  ttSetupButtons(document.getElementById("tt-class-filter"), (v) => {
    ttClass = v;
    ttLoad();
  });
  ttEls.distance.addEventListener("change", ttLoad);
  ttLoadDistances();
}
