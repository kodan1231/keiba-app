// レース管理画面: 出走馬表 登録・編集モーダル。
//
// 2026-09-01: races.js から分割(トークン消費削減。docs/ROADMAP.md「クラスタI」参照)。
// ESモジュールを使わないクラシックスクリプトのため races.js とグローバルスコープを
// 共有する。races.html では races.js の後に読み込む必要がある(本ファイル冒頭の
// HORSE_COUNT_OPTIONS 参照のため)。分割によって挙動・DOM構造・APIは変更していない。

let currentEntriesHorseCount = 8; // 出走馬表モーダル内の頭数(entry-rows描画用)

// 出走馬表モーダル
const entriesModal = document.getElementById("race-entries-modal");
const entriesForm = document.getElementById("race-entries-form");
const entriesModalTitle = document.getElementById("race-entries-modal-title");
const entryRows = document.getElementById("entry-rows");
const horseCountSelect = document.getElementById("r-horse-count");
const raceNumberSelect = document.getElementById("r-race-number");

// ---------- 初期化: セレクトの選択肢を用意 ----------
raceNumberSelect.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}R</option>`).join("");
horseCountSelect.innerHTML = HORSE_COUNT_OPTIONS;

// 出走頭数から、枠番の初期値を計算する。JRAの正式な枠番決定ルール(抽選)とは異なるが、
// 「頭数が決まればおおよその枠番の目安はつく」という簡易な初期値であり、
// 実際の枠番と異なる場合は手動で選び直せる(あくまで入力の手間を減らすための初期値)。
// 8頭以下は1頭1枠(枠番=馬番)、9頭以上は8枠に均等に近い形で振り分ける。JRAでは頭数が
// 8で割り切れない場合、余りの馬は大きい枠番(7枠・8枠側)から順に1頭ずつ多くなる慣習が
// あるため、余りは若い枠番ではなく大きい枠番(8枠側)に寄せる。
// 2026-09-08修正: 8頭以下で下のループを回すと horseCount<=7 のとき base=0 になり
// 枠番が後ろへずれるため(例: 5頭立てで馬番1が枠4)、早期リターンする。
function defaultWakuNumber(horseNumber, horseCount) {
  if (horseCount <= 8) return horseNumber;
  const base = Math.floor(horseCount / 8);
  const remainder = horseCount % 8;
  let n = horseNumber;
  for (let waku = 1; waku <= 8; waku++) {
    const size = waku > (8 - remainder) ? base + 1 : base;
    if (n <= size) return waku;
    n -= size;
  }
  return 8;
}

// ---------- 出走馬の行(出走馬表モーダル) ----------
function renderEntryRows(entries, horseCount) {
  currentEntriesHorseCount = horseCount;
  const rows = [];
  for (let i = 0; i < horseCount; i++) {
    // 既存データ(entries[i])に枠番があればそれを尊重し、無い新規行だけ初期値を自動設定する。
    const existing = entries[i];
    const waku_number = (existing?.waku_number ?? null) !== null
      ? existing.waku_number
      : defaultWakuNumber(i + 1, horseCount);
    rows.push(existing ? { ...existing, waku_number } : { waku_number, horse_number: i + 1, horse_name: "", jockey: "" });
  }
  entryRows.innerHTML = rows
    .map((e, i) => {
      // 入力欄の無い項目(性齢・斤量・調教師等。PDF取込や馬柱貼り付け由来)は行に保持し、
      // readEntryRows() で送り返す(2026-10-06。それまでは入力欄の4項目だけを送っており、
      // モーダルで保存するとこれらが消えていた)。
      const { waku_number: _w, horse_number: _n, horse_name: _h, jockey: _j, ...extra } = e;
      return `
        <div class="entry-form-row" data-row="${i}" data-extra="${escapeAttr(JSON.stringify(extra))}">
          <select class="e-waku">
            <option value="">枠-</option>
            ${[1,2,3,4,5,6,7,8].map((n) => `<option value="${n}" ${e.waku_number == n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <select class="e-horse-number">
            ${Array.from({ length: horseCount }, (_, n) => n + 1).map((n) => `<option value="${n}" ${e.horse_number == n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <input type="text" class="e-horse-name" placeholder="馬名" value="${escapeAttr(e.horse_name ?? "")}" />
          <input type="text" class="e-jockey" placeholder="騎手" value="${escapeAttr(e.jockey ?? "")}" />
        </div>
      `;
    })
    .join("");
}

horseCountSelect.addEventListener("change", () => {
  const newCount = Number(horseCountSelect.value);
  const current = readEntryRows();
  renderEntryRows(current, newCount);
});

function readEntryRows() {
  return Array.from(entryRows.querySelectorAll(".entry-form-row")).map((row) => {
    let extra = {};
    try { extra = JSON.parse(row.dataset.extra || "{}") || {}; } catch { extra = {}; }
    return {
      ...extra,
      waku_number: row.querySelector(".e-waku").value ? Number(row.querySelector(".e-waku").value) : null,
      horse_number: Number(row.querySelector(".e-horse-number").value),
      horse_name: row.querySelector(".e-horse-name").value,
      jockey: row.querySelector(".e-jockey").value || null,
    };
  });
}

// ---------- テキスト貼り付けで出走馬を一括入力(出走馬表モーダル) ----------
document.getElementById("toggle-paste-btn").addEventListener("click", () => {
  const area = document.getElementById("paste-area");
  area.hidden = !area.hidden;
});

document.getElementById("apply-paste-btn").addEventListener("click", () => {
  const text = document.getElementById("entries-paste").value;
  // netkeiba馬柱ページのテキストなら、確認画面を出してから反映する(2026-10-06追加)
  const umabashira = parseNetkeibaUmabashira(text);
  if (umabashira.length > 0) {
    startUmabashiraPreview(umabashira);
    return;
  }
  const parsed = parseEntries(text);
  if (parsed.length === 0) {
    alert("読み取れる行が見つかりませんでした。書式をご確認のうえ、直接入力欄で修正してください。");
    return;
  }
  const count = Math.max(parsed.length, currentEntriesHorseCount, 5);
  horseCountSelect.value = count;
  // 馬番が読み取れていればその番号順に、読み取れなければ出現順に並べる
  const withNumbers = parsed.filter((p) => p.horse_number);
  const ordered = withNumbers.length === parsed.length
    ? [...parsed].sort((a, b) => a.horse_number - b.horse_number)
    : parsed.map((p, i) => ({ ...p, horse_number: p.horse_number || i + 1 }));
  renderEntryRows(ordered, count);
  document.getElementById("paste-area").hidden = true;
});

// ---------- 出走馬表モーダル(登録・編集) ----------
document.getElementById("new-race-btn").addEventListener("click", () => openEntriesModal());
document.getElementById("entries-cancel-btn").addEventListener("click", closeEntriesModal);
entriesModal.addEventListener("click", (e) => { if (e.target === entriesModal) closeEntriesModal(); });

function openEntriesModal(race, prefill) {
  entriesForm.reset();
  document.getElementById("paste-area").hidden = true;
  document.getElementById("entries-paste").value = "";
  resetUmabashiraPreview();
  document.getElementById("entries-race-id").value = race ? race.id : "";
  entriesModalTitle.textContent = race
    ? (race.entries.length > 0 ? "出走馬表を編集" : "出走馬表を登録")
    : "レースを登録";

  if (race) {
    document.getElementById("r-race-date").value = race.race_date;
    document.getElementById("r-track").value = race.track;
    raceNumberSelect.value = race.race_number;
    document.getElementById("r-race-name").value = race.race_name || "";
    document.getElementById("r-course-type").value = race.course_type || "";
    document.getElementById("r-distance").value = race.distance || "";

    const count = Math.max(race.entries.length, 5);
    horseCountSelect.value = count;
    renderEntryRows(race.entries, count);
  } else {
    // admin.html の「未登録レース一覧」から遷移してきた場合、日付・競馬場・レース番号を
    // 事前入力しておく(?new_date=&new_track=&new_race_number= のクエリパラメータ経由)。
    document.getElementById("r-race-date").value = (prefill && prefill.race_date) || new Date().toISOString().slice(0, 10);
    document.getElementById("r-track").value = (prefill && prefill.track) || "";
    raceNumberSelect.value = (prefill && prefill.race_number) || "1";
    document.getElementById("r-course-type").value = "";
    document.getElementById("r-distance").value = "";
    horseCountSelect.value = "8";
    renderEntryRows([], 8);
  }

  entriesModal.hidden = false;
  // 前回別レースを開いていたときのスクロール位置が残らないよう、先頭にリセットする。
  const modalBox = entriesModal.querySelector(".modal");
  if (modalBox) modalBox.scrollTop = 0;
}

function closeEntriesModal() {
  entriesModal.hidden = true;
}
// ESCキーでキャンセル相当(保存せず閉じる)にする(docs/BACKLOG.md クラスタK対応)。
registerEscToClose(entriesModal, closeEntriesModal);

entriesForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const id = document.getElementById("entries-race-id").value;
  const entries = readEntryRows();

  const payload = {
    race_date: document.getElementById("r-race-date").value,
    track: document.getElementById("r-track").value,
    race_number: Number(raceNumberSelect.value),
    race_name: document.getElementById("r-race-name").value || null,
    course_type: document.getElementById("r-course-type").value || null,
    distance: document.getElementById("r-distance").value ? Number(document.getElementById("r-distance").value) : null,
    entries,
  };

  const res = id
    ? await authedFetch(`/api/races/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    : await authedFetch("/api/races", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "保存に失敗しました");
    return;
  }

  closeEntriesModal();
  loadRaces();
});

// ---------- netkeiba馬柱テキストの貼り付け取り込み(2026-10-06追加) ----------
// 仕様は docs/design/umabashira-paste.md。貼り付けた馬柱ページのテキストから、出走馬表の入力欄
// (枠・馬番・馬名・斤量・性齢。騎手は空欄のときだけ)と、馬情報マスタ(父・母・母父・調教師・毛色・所属)を
// 確認画面を経て反映する。アプリから netkeiba へは問い合わせない。
// API: POST /api/admin/horses/paste-import(preview / apply)、エイリアス登録は既存の
// POST /api/admin/jockey-aliases と POST /api/admin/trainer-aliases。

const umabashiraPreviewEl = document.getElementById("umabashira-preview");
let umabashiraParsed = [];     // parseNetkeibaUmabashira() の結果
let umabashiraPreview = null;  // preview API の結果(馬ごと)
let umabashiraJockeyMap = new Map(); // 騎手エイリアス: 突き合わせキー → 正しい騎手名

const UB_FIELD_LABELS = { sire: "父", dam: "母", dam_sire: "母父" };
const UB_STATUS_LABELS = {
  new: "新規登録",
  fill: "空欄を埋める",
  same: "変更なし",
  conflict: "保存済みと不一致",
  manual: "手入力済みのため変更なし",
};

// 騎手名の突き合わせキー(サーバーの jockeyAliasKeyOf と同じ: 見習い記号を除き全空白除去)
function ubJockeyKey(name) {
  return String(name || "").replace(/^[☆▲△★◇]/, "").replace(/[　\s]+/g, "");
}
function ubNameKey(name) {
  return String(name || "").normalize("NFKC").replace(/[　\s]+/g, "");
}

function resetUmabashiraPreview() {
  umabashiraParsed = [];
  umabashiraPreview = null;
  if (umabashiraPreviewEl) {
    umabashiraPreviewEl.hidden = true;
    umabashiraPreviewEl.innerHTML = "";
  }
}

async function loadJockeyAliasMapForPaste() {
  const map = new Map();
  try {
    const res = await authedFetch("/api/admin/jockey-aliases");
    if (res.ok) {
      const data = await res.json();
      for (const a of data.items || []) map.set(a.alias_key, a.canonical_name);
    }
  } catch { /* 取得できなくても略称のまま進める */ }
  return map;
}

// 騎手の略称 → 正しい騎手名(エイリアス未登録なら null)と候補(同じ馬の過去走に出た騎手名で略称で始まるもの)
function ubJockeyInfo(p) {
  const abbr = p.jockey_abbr || "";
  const resolved = abbr ? umabashiraJockeyMap.get(ubJockeyKey(abbr)) || null : null;
  const a = ubJockeyKey(abbr);
  const candidates = !resolved && a
    ? (p.past_jockeys || []).filter((j) => ubJockeyKey(j) !== a && ubJockeyKey(j).startsWith(a))
    : [];
  return { abbr, resolved, candidates };
}

function ubPayloadHorses() {
  return umabashiraParsed.map((p) => ({
    horse_name: p.horse_name,
    sire: p.sire,
    dam: p.dam,
    dam_sire: p.dam_sire,
    trainer_abbr: p.trainer_abbr,
    affiliation: p.affiliation,
    coat_color: p.coat_color,
  }));
}

async function startUmabashiraPreview(parsed) {
  umabashiraParsed = parsed;
  umabashiraPreviewEl.hidden = false;
  umabashiraPreviewEl.innerHTML = `<p class="picker-hint">${parsed.length}頭を読み取りました。保存済みの馬情報と照合しています…</p>`;
  const [map, res] = await Promise.all([
    loadJockeyAliasMapForPaste(),
    authedFetch("/api/admin/horses/paste-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preview", horses: ubPayloadHorses() }),
    }),
  ]);
  umabashiraJockeyMap = map;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    umabashiraPreviewEl.innerHTML = `<p class="submit-message error">${escapeHtml(data.error || "照合に失敗しました")}</p>`;
    return;
  }
  umabashiraPreview = data.horses || [];
  renderUmabashiraPreview();
}

// 未登録の略称の行: 候補を入れた入力欄+「エイリアス登録」ボタン
function ubAliasFormHtml(kind, abbr, candidates) {
  const list = (candidates || []).map((c) => `<option value="${escapeAttr(c)}"></option>`).join("");
  const listId = `ub-${kind}-cands-${ubNameKey(abbr)}`;
  return `
    <span class="ub-alias-form" data-kind="${kind}" data-abbr="${escapeAttr(abbr)}" data-unique="${(candidates || []).length === 1 ? "1" : ""}">
      <span class="ub-unregistered">未登録の略称</span>
      <input type="text" class="ub-alias-input" list="${escapeAttr(listId)}" value="${escapeAttr((candidates || [])[0] || "")}" placeholder="正しい${kind === "jockey" ? "騎手" : "調教師"}名" />
      <datalist id="${escapeAttr(listId)}">${list}</datalist>
      <button type="button" class="ghost-btn ub-alias-btn">エイリアス登録</button>
    </span>`;
}

function renderUmabashiraPreview() {
  const byInputName = new Map((umabashiraPreview || []).map((h) => [h.input_name, h]));
  const rows = umabashiraParsed
    .slice()
    .sort((a, b) => a.horse_number - b.horse_number)
    .map((p) => {
      const h = byInputName.get(p.horse_name) || {};
      const pasted = h.pasted || {};
      const existing = h.existing || {};
      const conflicts = new Set(h.conflicts || []);
      const pedigreeCell = (f) => {
        if (!conflicts.has(f)) {
          const v = (h.status === "new" || !existing[f]) ? pasted[f] : existing[f];
          return escapeHtml(v || "—");
        }
        // 不一致: 保存済み / 貼り付け を選ぶ(初期は保存済み)
        const name = `ub-choice-${ubNameKey(p.horse_name)}-${f}`;
        return `
          <label class="ub-choice"><input type="radio" name="${escapeAttr(name)}" value="existing" data-horse="${escapeAttr(p.horse_name)}" data-field="${f}" checked> 保存済み: ${escapeHtml(existing[f] || "—")}</label>
          <label class="ub-choice"><input type="radio" name="${escapeAttr(name)}" value="pasted" data-horse="${escapeAttr(p.horse_name)}" data-field="${f}"> 貼り付け: ${escapeHtml(pasted[f] || "—")}</label>`;
      };
      const t = h.trainer || {};
      const trainerCell = existing.trainer
        ? `${escapeHtml(existing.trainer)}<br><small>(保存済み。上書きしない)</small>`
        : t.resolved
          ? escapeHtml(t.resolved)
          : t.abbr ? `${escapeHtml(t.abbr)}${ubAliasFormHtml("trainer", t.abbr, t.candidates)}` : "—";
      const j = ubJockeyInfo(p);
      const jockeyCell = j.resolved
        ? escapeHtml(j.resolved)
        : j.abbr ? `${escapeHtml(j.abbr)}${ubAliasFormHtml("jockey", j.abbr, j.candidates)}` : "—";
      const manualNote = (h.manual_diffs || []).length
        ? `<br><small>${(h.manual_diffs || []).map((f) => UB_FIELD_LABELS[f]).join("・")}が保存済みと異なります(手入力済みのため変更しません)</small>`
        : "";
      return `
        <tr class="ub-status-${escapeAttr(h.status || "")}">
          <td>${p.horse_number}</td>
          <td>${escapeHtml(h.horse_name || p.horse_name)}</td>
          <td>${pedigreeCell("sire")}</td>
          <td>${pedigreeCell("dam")}</td>
          <td>${pedigreeCell("dam_sire")}</td>
          <td>${trainerCell}</td>
          <td>${jockeyCell}</td>
          <td>${escapeHtml(UB_STATUS_LABELS[h.status] || "—")}${manualNote}</td>
        </tr>`;
    })
    .join("");
  const conflictCount = (umabashiraPreview || []).filter((h) => h.status === "conflict").length;
  umabashiraPreviewEl.innerHTML = `
    <p class="picker-hint">${umabashiraParsed.length}頭を読み取りました。内容を確認して「反映する」を押してください。
      ${conflictCount ? `<b>${conflictCount}頭で保存済みの血統と不一致があります。項目ごとに正とする方を選んでください。</b>` : ""}
      騎手・調教師は略称のため、既に値がある場合は上書きしません。</p>
    <div class="table-wrap">
      <table class="stats-table ub-preview-table">
        <thead><tr><th>馬番</th><th>馬名</th><th>父</th><th>母</th><th>母父</th><th>調教師</th><th>騎手</th><th>状態</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="ub-preview-actions">
      <span id="ub-bulk-alias-slot"></span>
      <button type="button" class="ghost-btn" id="ub-cancel-btn">取り込みをやめる</button>
      <button type="button" class="stamp-btn" id="ub-apply-btn">反映する</button>
    </div>
    <p id="ub-message" class="submit-message" hidden></p>`;

  umabashiraPreviewEl.querySelectorAll(".ub-alias-btn").forEach((btn) => {
    btn.addEventListener("click", () => registerUmabashiraAlias(btn.closest(".ub-alias-form")));
  });
  const bulkSlot = document.getElementById("ub-bulk-alias-slot");
  bulkSlot.innerHTML = ubBulkAliasButtonHtml(umabashiraPreviewEl);
  bulkSlot.querySelector(".ub-bulk-alias-btn")?.addEventListener("click", async () => {
    if (await registerUniqueAliases(umabashiraPreviewEl)) await startUmabashiraPreview(umabashiraParsed);
  });
  document.getElementById("ub-cancel-btn").addEventListener("click", resetUmabashiraPreview);
  document.getElementById("ub-apply-btn").addEventListener("click", applyUmabashira);
}

// 候補が1つに決まる未登録の略称(例「幸」→ 過去走が全部「幸英明」)を、入力欄の名前でまとめてエイリアス登録する
// (2026-10-08)。同じ略称が複数の馬に出ていても1回だけ登録する。候補が複数・無いものは対象外(1件ずつ確認して登録)。
// 戻り値: 登録した件数。馬柱の確認画面(このファイル)と netkeiba 結果の確認画面(races-netkeiba-import.js)で共用。
function ubUniqueAliasForms(containerEl) {
  const seen = new Set();
  return [...containerEl.querySelectorAll('.ub-alias-form[data-unique="1"]')].filter((f) => {
    const key = `${f.dataset.kind}|${f.dataset.abbr}`;
    if (seen.has(key) || !f.querySelector(".ub-alias-input").value.trim()) return false;
    seen.add(key);
    return true;
  });
}

function ubBulkAliasButtonHtml(containerEl) {
  const n = ubUniqueAliasForms(containerEl).length;
  return n ? `<button type="button" class="ghost-btn ub-bulk-alias-btn">候補が1つの略称をまとめて登録(${n}件)</button>` : "";
}

async function registerUniqueAliases(containerEl) {
  const forms = ubUniqueAliasForms(containerEl);
  if (!forms.length) return 0;
  const lines = forms.map((f) => `${f.dataset.kind === "jockey" ? "騎手" : "調教師"}: ${f.dataset.abbr} → ${f.querySelector(".ub-alias-input").value.trim()}`);
  if (!confirm(`次のエイリアスを登録します。\n\n${lines.join("\n")}`)) return 0;
  let done = 0;
  for (const f of forms) {
    const url = f.dataset.kind === "jockey" ? "/api/admin/jockey-aliases" : "/api/admin/trainer-aliases";
    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias_display: f.dataset.abbr, canonical_name: f.querySelector(".ub-alias-input").value.trim() }),
    });
    if (res.ok) done++;
  }
  if (done < forms.length) alert(`${forms.length - done}件の登録に失敗しました(既に登録済み等)。`);
  return done;
}

async function registerUmabashiraAlias(formEl) {
  const kind = formEl.dataset.kind;
  const abbr = formEl.dataset.abbr;
  const canonical = formEl.querySelector(".ub-alias-input").value.trim();
  if (!canonical) { alert("正しい名前を入力してください"); return; }
  const url = kind === "jockey" ? "/api/admin/jockey-aliases" : "/api/admin/trainer-aliases";
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alias_display: abbr, canonical_name: canonical }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || "エイリアスの登録に失敗しました"); return; }
  // 登録した変換を反映して照合し直す(他の馬の同じ略称にも効く)
  await startUmabashiraPreview(umabashiraParsed);
}

async function applyUmabashira() {
  const choices = {};
  umabashiraPreviewEl.querySelectorAll('.ub-choice input[type="radio"]:checked').forEach((r) => {
    if (!choices[r.dataset.horse]) choices[r.dataset.horse] = {};
    choices[r.dataset.horse][r.dataset.field] = r.value;
  });
  const btn = document.getElementById("ub-apply-btn");
  const msg = document.getElementById("ub-message");
  btn.disabled = true;
  const res = await authedFetch("/api/admin/horses/paste-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "apply", horses: ubPayloadHorses(), choices }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    btn.disabled = false;
    msg.hidden = false;
    msg.className = "submit-message error";
    msg.textContent = data.error || "馬情報の反映に失敗しました(出走馬表の入力欄はまだ変えていません)";
    return;
  }

  // 出走馬表の入力欄へ反映(保存は従来どおり「保存する」)。騎手は同じ馬の既存の行に値があれば残す。
  const currentByName = new Map(readEntryRows().filter((e) => e.horse_name).map((e) => [ubNameKey(e.horse_name), e]));
  const entries = umabashiraParsed
    .slice()
    .sort((a, b) => a.horse_number - b.horse_number)
    .map((p) => {
      const cur = currentByName.get(ubNameKey(p.horse_name)) || {};
      const j = ubJockeyInfo(p);
      return {
        ...cur,
        waku_number: p.waku_number,
        horse_number: p.horse_number,
        horse_name: p.horse_name,
        jockey: cur.jockey || j.resolved || j.abbr || null,
        sex_age: p.sex_age || cur.sex_age || null,
        weight_carried: p.weight_carried ?? cur.weight_carried ?? null,
      };
    });
  const count = Math.max(entries.length, ...entries.map((e) => e.horse_number || 0), 5);
  horseCountSelect.value = count;
  renderEntryRows(entries, count);

  const applied = data.horses || [];
  const n = (k) => applied.filter((h) => h.applied === k).length;
  msg.hidden = false;
  msg.className = "submit-message success";
  msg.textContent = `馬情報: 新規${n("inserted")}頭・更新${n("updated")}頭・変更なし${n("unchanged")}頭。出走馬表の入力欄にも反映しました(「保存する」で出走馬表を保存してください)。`;
  // 反映済み(二重送信しない)。やり直す場合は貼り付け直して「読み込む」から
}
