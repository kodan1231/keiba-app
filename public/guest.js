// ゲスト閲覧のレース一覧(2026-10-14。guest.html。docs/design/guest.md)。
// レースが指定されていないとき、prediction.js の loadRaces() から呼ばれ、次の開催週末の中央のレースを
// 日付 → 競馬場 → R の順に並べる(一覧はサーバー〈GET /api/races?index=1〉がゲスト向けに期間内へ絞って返す)。
// レースを選ぶと guest.html?race=ID で、予想登録画面と同じ出馬表・馬柱・展開・時計を閲覧専用で出す。

function showGuestRaceList(races, message) {
  const listEl = document.getElementById("guest-race-list");
  document.getElementById("prediction-panel").hidden = true;
  document.getElementById("prediction-empty").hidden = true;
  if (!listEl) return;
  listEl.hidden = false;
  const byDate = new Map();
  for (const r of races || []) {
    if (!byDate.has(r.race_date)) byDate.set(r.race_date, []);
    byDate.get(r.race_date).push(r);
  }
  const head = `<h2 class="guest-list-title">今週のレース</h2>${message ? `<p class="error-text">${escapeHtml(message)}</p>` : ""}`;
  if (!byDate.size) {
    listEl.innerHTML = `${head}<p class="ticket-sub">表示できるレースはまだありません(出走馬が登録されると表示されます)。</p>`;
    return;
  }
  const dates = [...byDate.keys()].sort();
  listEl.innerHTML = head + dates.map((d) => {
    const byTrack = new Map();
    for (const r of byDate.get(d)) {
      if (!byTrack.has(r.track)) byTrack.set(r.track, []);
      byTrack.get(r.track).push(r);
    }
    const tracks = [...byTrack.keys()].sort((a, b) => trackDisplayOrderIndex(a) - trackDisplayOrderIndex(b));
    return `
      <section class="guest-day">
        <h3 class="guest-day-title">${escapeHtml(formatDateMdW(d))}</h3>
        <div class="guest-tracks">
          ${tracks.map((t) => `
            <div class="guest-track">
              <h4 class="guest-track-title">${escapeHtml(t)}</h4>
              <ul class="guest-race-items">
                ${byTrack.get(t).sort((a, b) => Number(a.race_number) - Number(b.race_number)).map((r) => `
                  <li><a href="guest.html?race=${encodeURIComponent(r.id)}" class="guest-race-link">
                    <span class="guest-race-num">${Number(r.race_number)}R</span>
                    <span class="guest-race-name">${escapeHtml(r.race_name || "")}</span>
                    <span class="guest-race-sub">${escapeHtml([formatCourseText(r.course_type, r.distance), r.post_time || "", r.entry_count ? `${r.entry_count}頭` : ""].filter(Boolean).join(" "))}</span>
                  </a></li>`).join("")}
              </ul>
            </div>`).join("")}
        </div>
      </section>`;
  }).join("");
}

function hideGuestRaceList() {
  const listEl = document.getElementById("guest-race-list");
  if (listEl) listEl.hidden = true;
}
