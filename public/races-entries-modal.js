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
// 8頭以下は1頭1枠、9頭以上は8枠に均等に近い形で振り分ける。JRAでは頭数が8で割り切れない
// 場合、余りの馬は大きい枠番(7枠・8枠側)から順に1頭ずつ多くなる慣習があるため、
// 余りは若い枠番ではなく大きい枠番(8枠側)に寄せる。
function defaultWakuNumber(horseNumber, horseCount) {
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
      return `
        <div class="entry-form-row" data-row="${i}">
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
  return Array.from(entryRows.querySelectorAll(".entry-form-row")).map((row) => ({
    waku_number: row.querySelector(".e-waku").value ? Number(row.querySelector(".e-waku").value) : null,
    horse_number: Number(row.querySelector(".e-horse-number").value),
    horse_name: row.querySelector(".e-horse-name").value,
    jockey: row.querySelector(".e-jockey").value || null,
  }));
}

// ---------- テキスト貼り付けで出走馬を一括入力(出走馬表モーダル) ----------
document.getElementById("toggle-paste-btn").addEventListener("click", () => {
  const area = document.getElementById("paste-area");
  area.hidden = !area.hidden;
});

document.getElementById("apply-paste-btn").addEventListener("click", () => {
  const text = document.getElementById("entries-paste").value;
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
