// データ検索画面「推奨馬比較」タブ(2026-11-10追加)。仕様は docs/design/data-search.md「推奨馬比較タブ」。
// 競馬場ごとに、推奨馬の印(◎〇▲☆)別の単勝・複勝の的中率と回収率を表にする。
// API: GET /api/data-search/pick-stats(夜間の計算が保存した「年|競馬場|芝ダ|印の出どころ」ごとの数。絞り込みと合計はここで行う)。
// 印の出どころ: r = 結果登録の直前に記録した印、c = 記録の無いレースを今の比率で採点し直した印
// escapeHtml は utils.js、DS_TRACK_ORDER・dsTrackSortIndex は data-search.js のもの。

const pkEls = {};
let pkData = null; // { computed_at, races, marks, cells }
let pkCourse = "";
let pkBet = "tan";
let pkSource = ""; // "" = すべて(記録した印+記録の無いレースは今の印)、"r" = 記録した印だけ
const PK_FEW_RACES = 30; // これ未満の行は薄く表示

function pkSetStatus(text) {
  pkEls.status.hidden = !text;
  pkEls.status.textContent = text || "";
}

// cells の1つの数の並び: [レース数, 印ごとに(買えた数, 単勝的中, 複勝的中, 単勝払戻, 複勝払戻)]。
// 買えた数 = 印の馬が出走したレース数(記録した印の馬が取消・除外なら返還なので数えない)
function pkAdd(a, c) {
  for (let i = 0; i < c.length; i++) a[i] = (a[i] || 0) + c[i];
  return a;
}

function pkRowHtml(label, a, marks, cls = "") {
  const n = a[0] || 0;
  const few = n < PK_FEW_RACES;
  const cells = marks.map((_, i) => {
    const o = 1 + i * 5;
    const bought = a[o] || 0;
    if (!bought) return `<td class="pk-first">—</td><td>—</td>`;
    const hit = (a[o + (pkBet === "tan" ? 1 : 2)] / bought) * 100;
    const ret = a[o + (pkBet === "tan" ? 3 : 4)] / bought; // 払戻は100円あたりなので、買えた数で割ると回収率(%)
    return `<td class="pk-first">${hit.toFixed(1)}%</td><td class="${ret >= 100 ? "pk-plus" : ""}">${ret.toFixed(0)}%</td>`;
  }).join("");
  return `<tr class="${[cls, few ? "pk-few" : ""].filter(Boolean).join(" ")}"><th scope="row">${escapeHtml(label)}</th><td>${n}</td>${cells}</tr>`;
}

function pkRender() {
  if (!pkData) return;
  const year = pkEls.year.value;
  const marks = pkData.marks || ["◎", "〇", "▲", "☆"];
  const byTrack = new Map();
  for (const [k, c] of Object.entries(pkData.cells || {})) {
    const [y, track, ct, src] = k.split("|");
    if (year && y !== year) continue;
    if (pkCourse && ct !== pkCourse) continue;
    if (pkSource && src !== pkSource) continue;
    byTrack.set(track, pkAdd(byTrack.get(track) || [], c));
  }
  if (!byTrack.size) {
    pkEls.table.innerHTML = `<tbody><tr><td class="ticket-sub">該当するレースがありません。</td></tr></tbody>`;
    return;
  }
  const isJra = (t) => DS_TRACK_ORDER.includes(t);
  const jra = [...byTrack.keys()].filter(isJra).sort((a, b) => dsTrackSortIndex(a) - dsTrackSortIndex(b));
  const local = [...byTrack.keys()].filter((t) => !isJra(t)).sort((a, b) => byTrack.get(b)[0] - byTrack.get(a)[0]);
  const sumOf = (list) => list.reduce((a, t) => pkAdd(a, byTrack.get(t)), []);
  const betLabel = pkBet === "tan" ? "単勝" : "複勝";
  const head = `<thead>
    <tr><th rowspan="2">競馬場</th><th rowspan="2">レース</th>${marks.map((m) => `<th colspan="2" class="pk-mark-head">${escapeHtml(m)}</th>`).join("")}</tr>
    <tr>${marks.map(() => `<th class="pk-mark-head">${betLabel}的中</th><th>回収率</th>`).join("")}</tr>
  </thead>`;
  const rows = [pkRowHtml("全体", sumOf([...byTrack.keys()]), marks, "pk-total")];
  if (jra.length && local.length) {
    rows.push(pkRowHtml("中央 計", sumOf(jra), marks, "pk-total"));
    rows.push(pkRowHtml("地方 計", sumOf(local), marks, "pk-total"));
  }
  for (const t of [...jra, ...local]) rows.push(pkRowHtml(t, byTrack.get(t), marks));
  pkEls.table.innerHTML = `${head}<tbody>${rows.join("")}</tbody>`;
}

function pkRenderYears() {
  const years = [...new Set(Object.keys(pkData.cells || {}).map((k) => k.split("|")[0]))].sort().reverse();
  pkEls.year.innerHTML = `<option value="">全期間</option>${years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}年</option>`).join("")}`;
}

async function pkLoad() {
  pkSetStatus("読み込み中…");
  try {
    const res = await authedFetch("/api/data-search/pick-stats");
    if (res.status === 503) throw new Error("paused");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!data.cells) {
      pkSetStatus("まだ集計していません(夜間の計算で作ります)。");
      return;
    }
    pkData = data;
  } catch (e) {
    pkSetStatus(e.message === "paused" ? "D1の使用量が多いため、データ検索の集計は一時停止中です。" : "取得に失敗しました。");
    return;
  }
  const at = pkData.computed_at ? new Date(pkData.computed_at) : null;
  pkSetStatus(at && !Number.isNaN(at.getTime())
    ? `集計: ${at.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}(${pkData.races}レース。うち記録した印 ${pkData.recorded || 0}レース)`
    : "");
  pkRenderYears();
  pkRender();
}

function pkSetupButtons(container, onSelect) {
  container.querySelectorAll(".horse-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".horse-row-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onSelect(btn.dataset.value);
    });
  });
}

function pkInit() {
  pkEls.year = document.getElementById("pk-year");
  pkEls.status = document.getElementById("pk-status");
  pkEls.table = document.getElementById("pk-table");
  pkSetupButtons(document.getElementById("pk-course-filter"), (v) => { pkCourse = v; pkRender(); });
  pkSetupButtons(document.getElementById("pk-bet-filter"), (v) => { pkBet = v; pkRender(); });
  pkSetupButtons(document.getElementById("pk-source-filter"), (v) => { pkSource = v; pkRender(); });
  pkEls.year.addEventListener("change", pkRender);
  pkLoad();
}
