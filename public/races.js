// レース管理画面のコア(state・カレンダー・レース一覧描画)。
//
// 2026-09-01リファクタリング: トークン消費削減のため、元々1ファイルだった races.js を
// 関心事ごとに3分割した(docs/ROADMAP.md「クラスタI」参照)。
//   - races.js(本ファイル): state・初期化・カレンダー・レース一覧描画
//   - races-entries-modal.js: 出走馬表 登録・編集モーダル
//   - races-payout-modal.js: 払戻 登録・編集モーダル
// いずれもESモジュールを使わないクラシックスクリプトのため、3ファイルは同一の
// グローバルスコープ(let/constの束縛も含む)を共有する。この前提は
// public/utils.js の JRA_CENTRAL_TRACKS を他ファイルが `const JRA_TRACKS =
// JRA_CENTRAL_TRACKS;` として参照している既存パターンと同じ。races.html での
// 読み込み順は races.js → races-entries-modal.js → races-payout-modal.js
// (この順序自体に機能的な依存は無いが、両モーダルファイルが参照する
// HORSE_COUNT_OPTIONS の定義元である races.js を先に読み込む必要がある)。
// 分割によって画面の挙動・DOM構造・APIは一切変更していない。

let races = [];
let selectedRaceDate = null;
let racesCalendarMonth = new Date();
racesCalendarMonth.setDate(1);

const racesMain = document.getElementById("races-main");
const racesCalendarGrid = document.getElementById("races-calendar-grid");
const racesCalendarMonthLabel = document.getElementById("races-calendar-month-label");

// 出走頭数は最低5頭・最大18頭(JRAの実運用上の範囲)。出走馬表モーダル・払戻モーダル
// 双方の頭数セレクトで共有するため、ここで一度だけ定義する
// (races-entries-modal.js・races-payout-modal.js から参照する)。
const HORSE_COUNT_OPTIONS = Array.from({ length: 14 }, (_, i) => i + 5).map((n) => `<option value="${n}">${n}頭</option>`).join("");

async function loadRaces() {
  const res = await authedFetch("/api/races");
  if (!res.ok) return;
  races = await res.json();
  renderRaceCalendar();
  renderRaceList();

  // app.js の「払戻を編集(レース管理へ)」リンク(?edit=)は払戻モーダルを直接開く。
  const editId = new URLSearchParams(window.location.search).get("edit");
  if (editId) {
    const target = races.find((r) => r.id === Number(editId));
    if (target && window.currentUser && window.currentUser.isAdmin) openPayoutModal(target);
    history.replaceState(null, "", "races.html");
    return;
  }

  // admin.html の「未登録レース一覧」から「登録する」で遷移してきた場合、
  // 日付・競馬場・レース番号を事前入力した状態で出走馬表登録モーダルを開く。
  const params = new URLSearchParams(window.location.search);
  const newDate = params.get("new_date");
  if (newDate && window.currentUser && window.currentUser.isAdmin) {
    openEntriesModal(null, {
      race_date: newDate,
      track: params.get("new_track") || "",
      race_number: params.get("new_race_number") || "1",
    });
    history.replaceState(null, "", "races.html");
  }
}

// ---------- カレンダーから日付を選ぶ ----------
// レースが登録されている日をカレンダー上でマークし、クリックするとその日だけに絞り込む。
function renderRaceCalendar() {
  if (!racesCalendarGrid || !racesCalendarMonthLabel) return;
  const year = racesCalendarMonth.getFullYear();
  const month = racesCalendarMonth.getMonth();
  racesCalendarMonthLabel.textContent = `${year}年${month + 1}月`;

  const byDate = new Map();
  races.forEach((r) => {
    if (!byDate.has(r.race_date)) byDate.set(r.race_date, []);
    byDate.get(r.race_date).push(r);
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const headers = ["日", "月", "火", "水", "木", "金", "土"];
  let html = headers.map((h) => `<span class="calendar-weekday">${h}</span>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<span class="calendar-day empty"></span>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dateRaces = byDate.get(key);
    const settledCount = dateRaces ? dateRaces.filter((r) => r.finish_order).length : 0;
    html += `<button type="button" class="calendar-day ${key === selectedRaceDate ? "selected" : ""} ${dateRaces ? "has-race" : ""}" data-date="${key}">
      <span>${d}</span>
      ${dateRaces ? `<span class="calendar-day-count">${settledCount}/${dateRaces.length}</span>` : ""}
    </button>`;
  }
  racesCalendarGrid.innerHTML = html;
  racesCalendarGrid.querySelectorAll("button[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // 同じ日付を再クリックすると絞り込みを解除する(その月全体の表示に戻る)。
      selectedRaceDate = selectedRaceDate === btn.dataset.date ? null : btn.dataset.date;
      expandedDates.add(selectedRaceDate);
      renderRaceCalendar();
      renderRaceList();
    });
  });
}

document.getElementById("races-prev-month-btn")?.addEventListener("click", () => {
  racesCalendarMonth.setMonth(racesCalendarMonth.getMonth() - 1);
  renderRaceCalendar();
  renderRaceList();
});
document.getElementById("races-next-month-btn")?.addEventListener("click", () => {
  racesCalendarMonth.setMonth(racesCalendarMonth.getMonth() + 1);
  renderRaceCalendar();
  renderRaceList();
});
document.getElementById("races-today-btn")?.addEventListener("click", () => {
  const now = new Date();
  racesCalendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  renderRaceCalendar();
  renderRaceList();
});

let expandedDates = new Set();

function renderRaceList() {
  if (races.length === 0) {
    racesMain.innerHTML = `<p class="empty-state">まだレースが登録されていません。「＋ レースを登録」から始めましょう。</p>`;
    return;
  }

  racesMain.innerHTML = "";

  const byDate = new Map();
  races.forEach((r) => {
    if (!byDate.has(r.race_date)) byDate.set(r.race_date, []);
    byDate.get(r.race_date).push(r);
  });
  let dates = [...byDate.keys()].sort().reverse();

  if (selectedRaceDate) {
    // カレンダーで特定の日付が選択されている場合は、その日だけに絞り込む。
    dates = dates.filter((d) => d === selectedRaceDate);
    if (dates.length === 0) {
      racesMain.innerHTML = `<p class="empty-state">この日に登録されているレースはありません。「＋ レースを登録」から追加できます。</p>`;
      return;
    }
  } else {
    // 特定の日付が未選択の場合は、カレンダーに表示中の月のレースだけに絞り込まれる
    // (全期間を一覧表示すると縦に長くなりすぎるため)。
    const ym = `${racesCalendarMonth.getFullYear()}-${String(racesCalendarMonth.getMonth() + 1).padStart(2, "0")}`;
    dates = dates.filter((d) => d.startsWith(ym));
    if (dates.length === 0) {
      racesMain.innerHTML = `<p class="empty-state">${racesCalendarMonth.getFullYear()}年${racesCalendarMonth.getMonth() + 1}月に登録されているレースはありません。カレンダーの‹›で他の月を確認できます。</p>`;
      return;
    }
  }

  for (const date of dates) {
    const dateRaces = byDate.get(date);
    const settledCount = dateRaces.filter((r) => r.finish_order).length;
    const dateExpanded = expandedDates.has(date);

    const dateWrap = document.createElement("div");
    dateWrap.className = "date-group";

    const dateHead = document.createElement("div");
    dateHead.className = "date-group-head";
    dateHead.innerHTML = `
      <span class="expand-arrow">${dateExpanded ? "▾" : "▸"}</span>
      <span class="date-label">${formatDate(date)}</span>
      <span class="date-meta">${dateRaces.length}レース ・ 結果確定 ${settledCount}/${dateRaces.length}</span>
    `;

    const dateBody = document.createElement("div");
    dateBody.className = "date-group-body";
    dateBody.hidden = !dateExpanded;

    // 競馬場は横に並べ、その下にR1〜12を縦に並べる。
    const byTrack = new Map();
    dateRaces.forEach((r) => {
      if (!byTrack.has(r.track)) byTrack.set(r.track, []);
      byTrack.get(r.track).push(r);
    });

    const columnsWrap = document.createElement("div");
    columnsWrap.className = "race-columns";

    for (const [track, trackRaces] of byTrack) {
      const trackSettled = trackRaces.filter((r) => r.finish_order).length;
      const byNumber = new Map(trackRaces.map((r) => [r.race_number, r]));

      const col = document.createElement("section");
      col.className = "race-track-column";
      col.innerHTML = `<h3>${escapeHtml(track)} <span class="track-meta">結果確定 ${trackSettled}/${trackRaces.length}</span></h3>`;

      for (let n = 1; n <= 12; n++) {
        const r = byNumber.get(n);
        if (!r) {
          const empty = document.createElement("div");
          empty.className = "race-column-row no-race";
          empty.innerHTML = `<b>${n}R</b><span>未登録</span>`;
          if (window.currentUser && window.currentUser.isAdmin) {
            empty.addEventListener("click", () => {
              openEntriesModal(null, { race_date: date, track, race_number: n });
            });
          }
          col.appendChild(empty);
          continue;
        }
        col.appendChild(renderRaceRow(r));
      }
      columnsWrap.appendChild(col);
    }

    dateBody.appendChild(columnsWrap);

    dateHead.addEventListener("click", () => {
      const nowHidden = !dateBody.hidden;
      dateBody.hidden = nowHidden;
      if (nowHidden) expandedDates.delete(date); else expandedDates.add(date);
      dateHead.querySelector(".expand-arrow").textContent = dateBody.hidden ? "▸" : "▾";
    });

    dateWrap.appendChild(dateHead);
    dateWrap.appendChild(dateBody);
    racesMain.appendChild(dateWrap);
  }
}

// courseTypeShort / formatCourseText は public/utils.js の共有関数を使用する
// (2026-08-16: buy.jsのレース選択グリッドにもコース情報表示を追加するにあたり、
// races.js側にのみあった重複定義をutils.jsへ集約した。races.htmlはutils.jsを
// races.jsより先に読み込むため、そのまま参照できる)。

function renderRaceRow(r) {
  const settled = !!r.finish_order;
  const hasEntries = r.entries.length > 0;
  // 出走馬一覧PDFインポート(枠番なし)対応により、entriesに枠番・馬番が未確定(null)の
  // 馬が混在するケースが発生するため、一覧上でも分かるようにする
  // (詳細はdocs/DESIGN.md「出走馬一覧PDFインポート」参照)。
  const hasUnconfirmedNumbers = hasEntries && r.entries.some((e) => e.horse_number === null || e.horse_number === undefined);
  const isAdmin = Boolean(window.currentUser && window.currentUser.isAdmin);
  const courseText = formatCourseText(r.course_type, r.distance);

  // 出走馬表・払戻それぞれの状態バッジは、管理者にはそのまま登録・編集への入口(ボタン)を兼ねる。
  const unconfirmedSuffix = hasUnconfirmedNumbers ? "・枠番未確定" : "";
  const entriesLabel = hasEntries ? `出走馬表を編集(${r.entries.length}頭${unconfirmedSuffix})` : "出走馬表を登録";
  const settledLabel = settled ? "払戻を編集" : "払戻を登録";

  const row = document.createElement("div");
  row.className = "race-list-card";
  row.innerHTML = `
    <span class="r-num">${r.race_number}R</span>
    ${r.race_name ? `<span class="meta">${escapeHtml(r.race_name)}</span>` : ""}
    ${courseText ? `<span class="meta course-meta">${escapeHtml(courseText)}</span>` : ""}
    ${isAdmin
      ? `<button type="button" class="entries-badge ${hasEntries ? "done" : ""}" data-id="${r.id}">${entriesLabel}</button>`
      : `<span class="entries-badge ${hasEntries ? "done" : ""}">${hasEntries ? `出走馬登録済み(${r.entries.length}頭${unconfirmedSuffix})` : "出走馬未登録"}</span>`}
    ${isAdmin
      ? `<button type="button" class="settled-badge ${settled ? "done" : ""}" data-id="${r.id}">${settledLabel}</button>`
      : `<span class="settled-badge ${settled ? "done" : ""}">${settled ? "結果確定" : "結果未確定"}</span>`}
    <span class="card-actions">
      ${isAdmin ? `<button class="icon-btn delete delete-race-btn" data-id="${r.id}" title="削除">×</button>` : ""}
    </span>
  `;
  if (isAdmin) {
    row.querySelector(".entries-badge").addEventListener("click", (e) => {
      e.stopPropagation();
      openEntriesModal(races.find((x) => x.id === r.id));
    });
    row.querySelector(".settled-badge").addEventListener("click", (e) => {
      e.stopPropagation();
      openPayoutModal(races.find((x) => x.id === r.id));
    });
    row.querySelector(".delete-race-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRace(r.id);
    });
  }
  return row;
}

async function deleteRace(id) {
  if (!confirm("このレースを削除しますか？関連する購入履歴も削除されます。")) return;

  try {
    const res = await authedFetch(`/api/races/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // 409: 確認が必要なケース
      if (res.status === 409 && data.requires_confirmation) {
        const message = `${data.error}\n\n削除を強制実行しますか？`;
        if (confirm(message)) {
          const forceRes = await authedFetch(`/api/races/${id}?force=1`, { method: "DELETE" });
          const forceData = await forceRes.json().catch(() => ({}));
          if (forceRes.ok) {
            alert("レースを削除しました。");
            loadRaces();
          } else {
            alert(forceData.error || "削除に失敗しました。");
          }
        }
        return;
      }
      alert(data.error || "削除に失敗しました。");
      return;
    }

    alert("レースを削除しました。");
    loadRaces();
  } catch (e) {
    alert("削除に失敗しました: " + (e.message || e));
  }
}

// ---------- ユーティリティ ----------
// escapeHtml / escapeAttr は utils.js のものを使用する

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
}

setupAuth(loadRaces);
