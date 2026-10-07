// netkeiba のページをブックマークレットから受け取って取り込む(2026-10-08追加)。
// 仕様は docs/design/netkeiba-bookmarklet.md。
//
// 流れ: PC の Chrome で netkeiba の馬柱(5走)/結果ページを開き、ブックマークレット「馬券帳へ取込」を押す
//   → このページ(races.html?nk=1)が新しいタブで開く → こちらから opener へ "nk-ready" を送る
//   → ブックマークレットがページの HTML を postMessage で送ってくる → public/netkeiba-html.js で読み取る
//   - 馬柱(5走): 出走馬表モーダル(未登録のレースは新規登録)を開き、貼り付け取り込みと同じ確認画面を出す
//   - 結果: 確認画面(#nk-result-modal)を出し、「反映する」で結果取込API(POST /api/races/results-import)へ送る
// 受け取れない場合(netkeiba 側の設定で opener が切れている等)は、ブックマークレットがクリップボードへ
// コピーした内容を貼り付けて読み込む。アプリから netkeiba へは問い合わせない。

const NK_ORIGINS = ["https://race.netkeiba.com", "https://nar.netkeiba.com"];
const NK_RECEIVE_TIMEOUT_MS = 5000;

const nkWanted = new URLSearchParams(window.location.search).get("nk") === "1";
let nkStarted = false;
let nkHandled = false;
let nkResultRecord = null;     // 結果取込に送るレコード
let nkResultExisting = null;   // 既存レース(GET /api/races/:id。無ければ null)
let nkJockeyAliasMap = new Map();
let nkKnownJockeys = null;     // [{ name, rides }](候補用。必要になったときだけ取る)

const nkReceivePanel = document.getElementById("nk-receive-panel");
const nkReceiveStatus = document.getElementById("nk-receive-status");
const nkResultModal = document.getElementById("nk-result-modal");

// races.js の loadRaces() の最後から呼ばれる(レース一覧の読み込み後でないと既存レースを探せないため)。
function nkOnRacesLoaded() {
  if (!nkWanted || nkStarted) return;
  nkStarted = true;
  if (!window.currentUser?.isAdmin) {
    alert("netkeibaからの取り込みは管理者のみ行えます。");
    return;
  }
  nkReceivePanel.hidden = false;
  window.addEventListener("message", nkOnMessage);
  // opener(netkeiba のタブ)へ「受け取れる状態になった」と伝える。opener の origin は2つのどちらかなので両方へ送る
  // (一致しない方は破棄される)。
  if (window.opener) {
    for (const o of NK_ORIGINS) {
      try { window.opener.postMessage("nk-ready", o); } catch { /* 無視 */ }
    }
  }
  setTimeout(() => {
    if (!nkHandled) document.getElementById("nk-paste-area").hidden = false;
  }, NK_RECEIVE_TIMEOUT_MS);
}

function nkOnMessage(e) {
  if (!NK_ORIGINS.includes(e.origin)) return;
  const data = e.data;
  if (!data || data.type !== "nk-page") return;
  let host = "";
  try { host = new URL(data.url).origin; } catch { return; }
  if (host !== e.origin) return;
  nkHandlePage(data);
}

document.getElementById("nk-paste-btn")?.addEventListener("click", () => {
  const text = document.getElementById("nk-paste-text").value.trim();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 下で案内 */ }
  if (!data || data.type !== "nk-page" || typeof data.html !== "string") {
    alert("ブックマークレットがコピーした内容ではありません。netkeibaのページでもう一度ブックマークレットを押してから貼り付けてください。");
    return;
  }
  nkHandlePage(data);
});

function nkFinishReceive(message) {
  nkHandled = true;
  window.removeEventListener("message", nkOnMessage);
  document.getElementById("nk-paste-area").hidden = true;
  nkReceiveStatus.textContent = message;
  history.replaceState(null, "", "races.html");
}

function nkHandlePage(data) {
  if (nkHandled) return;
  const kind = nkPageKind(data.url);
  if (!kind) {
    alert("netkeibaの馬柱(5走)または結果・払戻のページではありません。");
    return;
  }
  const doc = new DOMParser().parseFromString(data.html, "text/html"); // スクリプトは実行されない
  const meta = nkParseRaceMeta(doc);
  if (!meta) {
    alert("ページからレースの開催日・競馬場・レース番号を読み取れませんでした。");
    return;
  }
  const raceLabel = `${meta.race_date} ${meta.track}${meta.race_number}R ${meta.race_name || ""}`.trim();
  if (kind === "shutuba_past") {
    const horses = nkParseShutubaPast(doc);
    if (!horses.length) {
      alert("出走馬を読み取れませんでした(枠順確定前のページは読み取れません)。");
      return;
    }
    nkFinishReceive(`馬柱を受け取りました: ${raceLabel}(${horses.length}頭)`);
    nkOpenShutuba(meta, horses);
  } else {
    const record = nkParseResult(doc);
    if (!record) {
      alert("結果を読み取れませんでした(確定前のレースは読み取れません)。");
      return;
    }
    // 中央(race.netkeiba.com)の結果ページの調教師は略称(例「橋口」)のため送らない。
    // 送ると馬情報マスタの調教師(フルネーム)が略称で上書きされる(applyImportedTrainerNames)。
    if (new URL(data.url).hostname === "race.netkeiba.com") {
      record.race_results = record.race_results.map((r) => ({ ...r, trainer: null }));
    }
    nkFinishReceive(`結果を受け取りました: ${raceLabel}`);
    nkOpenResult(record);
  }
}

function nkFindRace(meta) {
  return races.find((r) => r.race_date === meta.race_date && r.track === meta.track && Number(r.race_number) === meta.race_number) || null;
}

// ---------- 馬柱(5走) ----------
// 出走馬表モーダルを開いてから、貼り付け取り込みと同じ確認画面(startUmabashiraPreview)を出す。
// レース名・コース・距離は入力欄が空のときだけページの値で埋める。
async function nkOpenShutuba(meta, horses) {
  showRaceDate(meta.race_date);
  const existing = nkFindRace(meta);
  if (existing) {
    const res = await authedFetch(`/api/races/${encodeURIComponent(existing.id)}`);
    if (!res.ok) { alert("レース情報の取得に失敗しました"); return; }
    openEntriesModal(await res.json());
  } else {
    openEntriesModal(null, { race_date: meta.race_date, track: meta.track, race_number: String(meta.race_number) });
  }
  const fillIfEmpty = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value && value !== null && value !== undefined) el.value = String(value);
  };
  fillIfEmpty("r-race-name", meta.race_name);
  fillIfEmpty("r-course-type", meta.course_type);
  fillIfEmpty("r-distance", meta.distance);
  document.getElementById("paste-area").hidden = false;
  startUmabashiraPreview(horses);
}

// ---------- 結果 ----------
const NK_BET_LABELS = { tan: "単勝", fuku: "複勝", wakuren: "枠連", umaren: "馬連", wide: "ワイド", umatan: "馬単", sanrenpuku: "3連複", sanrentan: "3連単" };
const NK_STATUS_LABELS = { scratched: "取消", excluded: "除外", stopped: "中止" };

function nkJockeyKey(name) {
  return String(name || "").replace(/^[☆▲△★◇]/, "").replace(/[　\s]+/g, "");
}

// 騎手名の扱い: ①騎手名エイリアスに登録済みなら正しい名前 ②登録済みのレースの出走馬表で同じ馬の騎手が
// この名前(略称)で始まる・含むならその騎手 ③既知の騎手名と同じなら そのまま ④それ以外は「未登録」として
// エイリアス登録の欄を出す(候補は既知の騎手名のうちこの名前を含むもの。騎乗数の多い順)。
function nkJockeyInfo(r) {
  const raw = r.jockey || "";
  const key = nkJockeyKey(raw);
  if (!key) return { raw, resolved: null, source: null, candidates: [] };
  const alias = nkJockeyAliasMap.get(key);
  if (alias) return { raw, resolved: alias, source: "alias", candidates: [] };
  const existingEntry = (nkResultExisting?.entries || []).find((e) => nkNameKey(e.horse_name) === nkNameKey(r.horse_name));
  const ej = existingEntry?.jockey ? nkJockeyKey(existingEntry.jockey) : "";
  if (ej && ej !== key && ej.includes(key)) return { raw, resolved: existingEntry.jockey, source: "entry", candidates: [] };
  if (ej && ej === key) return { raw, resolved: null, source: "known", candidates: [] };
  const known = nkKnownJockeys || [];
  if (known.some((j) => nkJockeyKey(j.name) === key)) return { raw, resolved: null, source: "known", candidates: [] };
  const candidates = known.filter((j) => nkJockeyKey(j.name).includes(key)).slice(0, 5).map((j) => j.name);
  return { raw, resolved: null, source: null, candidates };
}

function nkNameKey(name) {
  return String(name || "").normalize("NFKC").replace(/[　\s]+/g, "");
}

async function nkOpenResult(record) {
  nkResultRecord = record;
  showRaceDate(record.race_date);
  const existing = nkFindRace(record);
  nkResultExisting = null;
  if (existing) {
    const res = await authedFetch(`/api/races/${encodeURIComponent(existing.id)}`);
    if (res.ok) nkResultExisting = await res.json();
  }
  nkJockeyAliasMap = await loadJockeyAliasMapForPaste(); // races-entries-modal.js
  if (nkKnownJockeys === null) {
    try {
      const res = await authedFetch("/api/data-search/jockeys");
      nkKnownJockeys = res.ok ? (await res.json()).jockeys || [] : [];
    } catch { nkKnownJockeys = []; }
  }
  document.getElementById("nk-result-message").hidden = true;
  document.getElementById("nk-result-submit-btn").disabled = false;
  nkRenderResult();
  nkResultModal.hidden = false;
}

function nkRenderResult() {
  const r = nkResultRecord;
  const course = [r.course_type, r.distance ? `${r.distance}m` : ""].filter(Boolean).join("");
  document.getElementById("nk-result-race").innerHTML = `
    <b>${escapeHtml(`${r.race_date} ${r.track}${r.race_number}R ${r.race_name || ""}`)}</b>
    ${escapeHtml([course, r.track_condition, r.weather].filter(Boolean).join(" / "))}<br>
    ${nkResultExisting
      ? "登録済みのレースを更新します(着順・払戻は取り込んだ内容で置き換え、全着順の記録も更新します)。"
      : "未登録のレースのため、新しく登録します。"}`;

  const rows = r.race_results
    .slice()
    .sort((a, b) => (a.finish_position ?? 99) - (b.finish_position ?? 99) || a.horse_number - b.horse_number)
    .map((h) => {
      const j = nkJockeyInfo(h);
      const jockeyCell = j.resolved
        ? `${escapeHtml(j.resolved)}<br><small>(${escapeHtml(j.raw)}${j.source === "entry" ? "。出走馬表の騎手" : ""})</small>`
        : j.source === "known" || !j.raw
          ? escapeHtml(j.raw || "—")
          : `${escapeHtml(j.raw)}${ubAliasFormHtml("jockey", j.raw, j.candidates)}`;
      return `<tr>
        <td>${escapeHtml(h.finish_position ? String(h.finish_position) : NK_STATUS_LABELS[h.status] || "—")}</td>
        <td>${h.horse_number}</td>
        <td>${escapeHtml(h.horse_name || "—")}</td>
        <td>${jockeyCell}</td>
        <td>${escapeHtml(h.time_text || "—")}</td>
        <td>${h.win_popularity ?? "—"}</td>
      </tr>`;
    })
    .join("");
  const payoutText = Object.entries(r.payouts || {})
    .map(([type, list]) => `${NK_BET_LABELS[type] || type} ${list.map((p) => `${p.combo.join("-")}: ${p.rate.toLocaleString()}円`).join(" / ")}`)
    .join("<br>");
  const unregistered = r.race_results.filter((h) => {
    const j = nkJockeyInfo(h);
    return j.raw && !j.resolved && j.source !== "known";
  }).length;

  document.getElementById("nk-result-preview").innerHTML = `
    ${unregistered ? `<p class="picker-hint"><b>${unregistered}頭の騎手名が未登録です(略称の可能性があります)。</b>正しい騎手名でエイリアス登録してから反映すると、騎手成績が分かれません。登録しなくても反映できます(その名前のまま保存されます)。</p>` : ""}
    <div class="table-wrap">
      <table class="stats-table ub-preview-table">
        <thead><tr><th>着順</th><th>馬番</th><th>馬名</th><th>騎手</th><th>タイム</th><th>人気</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="picker-hint">${payoutText || "払戻を読み取れませんでした"}</p>`;

  document.querySelectorAll("#nk-result-preview .ub-alias-btn").forEach((btn) => {
    btn.addEventListener("click", () => nkRegisterJockeyAlias(btn.closest(".ub-alias-form")));
  });
}

async function nkRegisterJockeyAlias(formEl) {
  const abbr = formEl.dataset.abbr;
  const canonical = formEl.querySelector(".ub-alias-input").value.trim();
  if (!canonical) { alert("正しい騎手名を入力してください"); return; }
  const res = await authedFetch("/api/admin/jockey-aliases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alias_display: abbr, canonical_name: canonical }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || "エイリアスの登録に失敗しました"); return; }
  nkJockeyAliasMap = await loadJockeyAliasMapForPaste();
  nkRenderResult();
}

// 送るレコード: 騎手名は確認画面と同じ扱い(エイリアス・出走馬表の騎手)で置き換える。
// エイリアスはサーバー側の取込でもかかるが、出走馬表の騎手での置き換えはここでしかできないため。
function nkResultPayload() {
  const r = nkResultRecord;
  const jockeyByNumber = new Map(r.race_results.map((h) => {
    const j = nkJockeyInfo(h);
    return [h.horse_number, j.resolved || h.jockey || null];
  }));
  return {
    ...r,
    entries: r.entries.map((e) => ({ ...e, jockey: jockeyByNumber.get(e.horse_number) ?? e.jockey })),
    race_results: r.race_results.map((h) => ({ ...h, jockey: jockeyByNumber.get(h.horse_number) ?? h.jockey })),
  };
}

document.getElementById("nk-result-cancel-btn")?.addEventListener("click", () => { nkResultModal.hidden = true; });
nkResultModal?.addEventListener("click", (e) => { if (e.target === nkResultModal) nkResultModal.hidden = true; });
if (nkResultModal) registerEscToClose(nkResultModal, () => { nkResultModal.hidden = true; });

document.getElementById("nk-result-submit-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("nk-result-submit-btn");
  const msg = document.getElementById("nk-result-message");
  btn.disabled = true;
  const res = await authedFetch("/api/races/results-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ races: [nkResultPayload()], mode: "overwrite" }),
  });
  const data = await res.json().catch(() => ({}));
  msg.hidden = false;
  if (!res.ok || data.ok === false) {
    btn.disabled = false;
    msg.className = "submit-message error";
    msg.textContent = data.error || "反映に失敗しました";
    return;
  }
  const st = (data.results || [])[0]?.status;
  msg.className = "submit-message success";
  msg.textContent = st === "created" ? "新しいレースとして登録しました。" : "結果を反映しました。";
  await loadRaces();
  showRaceDate(nkResultRecord.race_date);
});
