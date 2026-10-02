// データ検索画面「騎手検索」タブ(2026-10-03追加)。仕様は docs/design/data-search.md「騎手検索タブ」。
//   GET /api/data-search/jockeys             … 騎手の全件一覧(タブを初めて開いたときに1回だけ取得)
//   GET /api/data-search/jockey-stats?name=  … 通算・年度別・コース別の成績
// 候補の絞り込み(部分一致)は取得済みの一覧から画面側で行う(入力のたびにAPIを呼ばない)。
// escapeHtml / escapeAttr / formatCourseText は utils.js のものを使う。
// data-search.js のタブ切り替えから jsInit() が1回だけ呼ばれる。

const jsEls = {};
let jsJockeys = null; // [{ name, rides }](騎乗数の降順)。読み込み失敗時は null のまま
let jsLoadToken = 0; // 別の騎手を選び直したら、進行中の取得結果を捨てるための世代番号

const JS_MAX_CANDIDATES = 50;

// 絞り込み用の正規化: NFKC・空白除去・見習い減量記号の除去(サーバー側の名寄せと同じ考え方)。
function jsNorm(s) {
  return String(s ?? "").normalize("NFKC").replace(/^[☆▲△★◇]/, "").replace(/[\s　]+/g, "");
}

function jsPct(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `${(Number(v) * 100).toFixed(1)}%`;
}

function jsCourseLabel(row) {
  if (!row.track && !row.course_type && !row.distance) return "コース不明";
  const course = formatCourseText(row.course_type, row.distance);
  return `${row.track || "競馬場不明"} ${course || "コース不明"}`;
}

// 通算・年度別・コース別で共通の表。labelHead が null なら先頭の見出し列を出さない(通算)。
function jsTableHtml(labelHead, rows, labelOf) {
  const head = `
    <thead><tr>
      ${labelHead ? `<th class="js-label-cell">${escapeHtml(labelHead)}</th>` : ""}
      <th>騎乗数</th><th>1着</th><th>2着</th><th>3着</th><th>着外</th>
      <th>単勝率</th><th>連対率</th><th>複勝率</th>
    </tr></thead>`;
  const body = rows
    .map(
      (r) => `
      <tr>
        ${labelHead ? `<td class="js-label-cell">${escapeHtml(labelOf(r))}</td>` : ""}
        <td>${r.rides}</td><td>${r.first}</td><td>${r.second}</td><td>${r.third}</td><td>${r.other}</td>
        <td>${jsPct(r.winRate)}</td><td>${jsPct(r.quinellaRate)}</td><td>${jsPct(r.showRate)}</td>
      </tr>`
    )
    .join("");
  return `${head}<tbody>${body}</tbody>`;
}

function jsRenderDetail(data) {
  jsEls.detailName.textContent = data.name;
  const p = data.period || {};
  jsEls.detailSub.textContent = p.from && p.to ? `対象期間 ${formatDate(p.from)} 〜 ${formatDate(p.to)}` : "";
  jsEls.totalTable.innerHTML = jsTableHtml(null, [data.total], null);
  jsEls.yearTable.innerHTML = jsTableHtml("年度", data.byYear || [], (r) => `${r.year}年`);
  jsEls.courseTable.innerHTML = jsTableHtml("コース", data.byCourse || [], jsCourseLabel);
  jsEls.detail.hidden = false;
}

async function jsLoadDetail(name) {
  const token = ++jsLoadToken;
  jsEls.searchStatus.textContent = "成績を集計中…";
  try {
    const res = await authedFetch(`/api/data-search/jockey-stats?name=${encodeURIComponent(name)}`);
    if (token !== jsLoadToken) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      jsEls.searchStatus.textContent = err.error || "成績の取得に失敗しました。";
      return;
    }
    const data = await res.json();
    if (token !== jsLoadToken) return;
    jsRenderDetail(data);
    jsEls.searchStatus.textContent = "";
  } catch {
    if (token === jsLoadToken) jsEls.searchStatus.textContent = "成績の取得に失敗しました。";
  }
}

function jsRenderCandidates() {
  const q = jsNorm(jsEls.search.value.trim());
  jsEls.detail.hidden = true;
  jsLoadToken++; // 入力し直したら、表示待ちの成績は捨てる
  if (!jsJockeys) return;
  if (!q) {
    jsEls.resultList.hidden = true;
    jsEls.searchStatus.textContent = `騎手名の一部を入力してください(${jsJockeys.length}人)。`;
    return;
  }
  const matches = jsJockeys.filter((j) => jsNorm(j.name).includes(q));
  if (!matches.length) {
    jsEls.resultList.hidden = true;
    jsEls.searchStatus.textContent = `「${jsEls.search.value.trim()}」に該当する騎手がいません。`;
    return;
  }
  const shown = matches.slice(0, JS_MAX_CANDIDATES);
  jsEls.searchStatus.textContent = `${matches.length}件${matches.length > shown.length ? `(上位${shown.length}件を表示。絞り込んでください)` : ""}`;
  jsEls.resultList.hidden = false;
  jsEls.resultList.innerHTML = shown
    .map(
      (j) => `
      <li><button type="button" class="hi-result-btn" data-name="${escapeAttr(j.name)}">
        <span class="hi-result-name">${escapeHtml(j.name)}</span>
        <span class="hi-result-count">${j.rides}騎乗</span>
      </button></li>`
    )
    .join("");
  jsEls.resultList.querySelectorAll(".hi-result-btn").forEach((btn) => {
    btn.addEventListener("click", () => jsLoadDetail(btn.dataset.name));
  });
}

async function jsLoadJockeys() {
  try {
    const res = await authedFetch("/api/data-search/jockeys");
    if (!res.ok) {
      jsEls.searchStatus.textContent = "騎手一覧の取得に失敗しました。ページを再読み込みしてください。";
      return;
    }
    const data = await res.json();
    jsJockeys = data.jockeys || [];
    jsRenderCandidates();
  } catch {
    jsEls.searchStatus.textContent = "騎手一覧の取得に失敗しました。ページを再読み込みしてください。";
  }
}

function jsInit() {
  jsEls.search = document.getElementById("js-search");
  jsEls.searchStatus = document.getElementById("js-search-status");
  jsEls.resultList = document.getElementById("js-result-list");
  jsEls.detail = document.getElementById("js-detail");
  jsEls.detailName = document.getElementById("js-detail-name");
  jsEls.detailSub = document.getElementById("js-detail-sub");
  jsEls.totalTable = document.getElementById("js-total-table");
  jsEls.yearTable = document.getElementById("js-year-table");
  jsEls.courseTable = document.getElementById("js-course-table");

  jsEls.search.addEventListener("input", jsRenderCandidates);
  jsLoadJockeys();
}
