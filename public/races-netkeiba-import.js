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

// 2026-10-10: JRA公式(PC版)の出走馬一覧・結果ページも受け取る(docs/design/netkeiba-bookmarklet.md「JRA公式ページ」)
const NK_ORIGINS = ["https://race.netkeiba.com", "https://nar.netkeiba.com", "https://www.jra.go.jp"];
const JRA_ORIGIN = "https://www.jra.go.jp";
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
  // JRA公式のページは URL が共通(/JRADB/accessD.html 等)のため、中身で出走馬一覧か結果かを判定する
  let origin = "";
  try { origin = new URL(data.url).origin; } catch { /* 下で案内 */ }
  if (origin === JRA_ORIGIN) {
    nkHandleJraPage(new DOMParser().parseFromString(data.html, "text/html"));
    return;
  }
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

// ---------- JRA公式の出走馬一覧・結果ページ(2026-10-10) ----------
// 出走馬一覧(public/jra-entries-html.js)は出走馬一覧の取込API、結果(public/jra-result-html.js)は結果取込APIへ、
// 1開催日・1競馬場の全レースをまとめて送る(PDFインポート・ユーザースクリプトと同じAPI。サーバー側の変更は無い)。
let nkBatch = null; // { kind: "entries" | "result", records }

function nkHandleJraPage(doc) {
  let kind = null;
  let records = [];
  let errors = [];
  if (jraEntriesHtmlIsPage(doc)) {
    kind = "entries";
    ({ records, errors } = jraEntriesHtmlParsePage(doc));
  } else if (doc.querySelector(".race_result_unit")) {
    kind = "result";
    const parsed = jraResultHtmlParsePage(doc);
    records = parsed.records || [];
    errors = parsed.diagnostics?.errors || [];
  } else {
    alert("JRAの出走馬一覧(出馬表)またはレース結果のページではありません。");
    return;
  }
  if (!records.length) {
    alert(`ページからレースを読み取れませんでした。${errors.length ? "\n" + errors.join("\n") : ""}`);
    return;
  }
  const first = records[0];
  nkFinishReceive(`JRAの${kind === "entries" ? "出走馬一覧" : "レース結果"}を受け取りました: ${first.race_date} ${first.track}(${records.length}レース)`);
  showRaceDate(first.race_date);
  nkBatch = { kind, records };
  nkRenderBatch(errors);
}

function nkRenderBatch(errors) {
  const { kind, records } = nkBatch;
  const existingCount = records.filter((r) => nkFindRace(r)).length;
  document.getElementById("nk-batch-title").textContent = kind === "entries" ? "JRAの出走馬一覧を取り込む" : "JRAのレース結果を取り込む";
  document.getElementById("nk-batch-summary").textContent =
    `${records[0].race_date} ${records[0].track} ${records.length}レース(登録済み ${existingCount}・新規 ${records.length - existingCount})。` +
    (kind === "entries"
      ? "出走馬一覧PDFの取り込みと同じ扱いで、出走馬表を登録・更新します(馬名で突き合わせ、手で直した騎手等は取り込みの規則どおり)。"
      : "着順・払戻は取り込んだ内容で置き換え、全着順の記録も登録します(JRA結果の取り込みと同じ)。");
  const rows = records.map((r) => {
    const course = [r.course_type, r.distance ? `${r.distance}m` : ""].filter(Boolean).join("");
    const detail = kind === "entries"
      ? `${r.entries.length}頭 / 馬番${r.entries.some((e) => e.horse_number) ? "あり" : "なし(枠順確定前)"}`
      : `${r.race_results.length}頭 / 1〜3着 ${(r.finish_order || []).join("-") || "—"} / 払戻 ${Object.keys(r.payouts || {}).length}種`;
    return `<tr><td>${r.race_number}R</td><td>${escapeHtml(r.race_name || "")}</td><td>${escapeHtml(course)}</td><td>${escapeHtml(detail)}</td><td>${nkFindRace(r) ? "更新" : "新規"}</td></tr>`;
  }).join("");
  document.getElementById("nk-batch-preview").innerHTML = `
    ${errors.length ? `<p class="submit-message error">${errors.map((e) => escapeHtml(e)).join("<br>")}</p>` : ""}
    <div class="table-wrap"><table class="stats-table ub-preview-table">
      <thead><tr><th>R</th><th>レース名</th><th>コース</th><th>内容</th><th>状態</th></tr></thead><tbody>${rows}</tbody>
    </table></div>`;
  document.getElementById("nk-batch-message").hidden = true;
  document.getElementById("nk-batch-submit-btn").disabled = false;
  document.getElementById("nk-batch-modal").hidden = false;
}

const nkBatchModal = document.getElementById("nk-batch-modal");
document.getElementById("nk-batch-cancel-btn")?.addEventListener("click", () => { nkBatchModal.hidden = true; });
nkBatchModal?.addEventListener("click", (e) => { if (e.target === nkBatchModal) nkBatchModal.hidden = true; });
if (nkBatchModal) registerEscToClose(nkBatchModal, () => { nkBatchModal.hidden = true; });

document.getElementById("nk-batch-submit-btn")?.addEventListener("click", async () => {
  if (!nkBatch) return;
  const btn = document.getElementById("nk-batch-submit-btn");
  const msg = document.getElementById("nk-batch-message");
  btn.disabled = true;
  const isEntries = nkBatch.kind === "entries";
  const res = await authedFetch(isEntries ? "/api/races/entries-import" : "/api/races/results-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isEntries ? { races: nkBatch.records } : { races: nkBatch.records, mode: "overwrite" }),
  });
  const data = await res.json().catch(() => ({}));
  msg.hidden = false;
  if (!res.ok || data.ok === false) {
    btn.disabled = false;
    msg.className = "submit-message error";
    msg.textContent = data.error || "登録に失敗しました";
    return;
  }
  const results = data.results || [];
  const count = (st) => results.filter((r) => r.status === st).length;
  const failed = results.filter((r) => !["created", "updated", "skipped"].includes(r.status));
  msg.className = failed.length ? "submit-message error" : "submit-message success";
  msg.textContent = `新規 ${count("created")}件・更新 ${count("updated")}件${failed.length ? `・失敗 ${failed.length}件(${failed.map((r) => r.key || "").join(" / ")})` : ""}で登録しました。`;
  await loadRaces();
  showRaceDate(nkBatch.records[0].race_date);
});

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
  // 既知の騎手名の一覧(候補用)は、エイリアス・出走馬表の騎手で決まらない名前があるときだけ取る
  // (2026-10-08。一覧は全レースの騎乗から作るため、レースを直した直後は集計用キャッシュの作り直しが起きる)
  const unresolved = record.race_results.some((h) => {
    const j = nkJockeyInfo(h);
    return j.raw && !j.resolved && j.source !== "known";
  });
  if (unresolved && nkKnownJockeys === null) {
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

  const previewEl = document.getElementById("nk-result-preview");
  previewEl.querySelectorAll(".ub-alias-btn").forEach((btn) => {
    btn.addEventListener("click", () => nkRegisterJockeyAlias(btn.closest(".ub-alias-form")));
  });
  // 候補が1つに決まる略称のまとめて登録(2026-10-08。races-entries-modal.js の registerUniqueAliases)
  const bulkHtml = ubBulkAliasButtonHtml(previewEl);
  if (bulkHtml) {
    previewEl.insertAdjacentHTML("afterbegin", `<p>${bulkHtml}</p>`);
    previewEl.querySelector(".ub-bulk-alias-btn").addEventListener("click", async () => {
      if (await registerUniqueAliases(previewEl)) {
        nkJockeyAliasMap = await loadJockeyAliasMapForPaste();
        nkRenderResult();
      }
    });
  }
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
