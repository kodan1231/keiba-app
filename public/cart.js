// 馬券かご機能(docs/ROADMAP.md クラスタF)。
//
// 2026-09-06新規作成。全6画面(index/history/stats/prediction/races/admin)から
// 共通で読み込まれる唯一のファイルのため、他ページのスクリプトとの変数名衝突を
// 避ける目的でIIFEにまとめている(本プロジェクトの他ファイルはグローバルスコープ
// に直接関数を定義する方針だが、cart.jsは6画面すべてに同居する特殊性から、この
// ファイルに限りIIFEで内部実装を隠蔽し、必要な公開関数のみwindowへ明示的に
// 公開する方針とした)。
//
// 依存する共有関数: escapeHtml(utils.js)・authedFetch(auth.js)・formatDate(utils.js
// またはページ固有スクリプトが上書きしたもの)・betTypeLabel/methodLabel/
// formatSelections(bettypes.js)。bettypes.jsは元々admin.htmlに読み込まれていな
// かったため、本対応にあわせてadmin.htmlにも追加した。
//
// データモデル(localStorage、ユーザーごとにキーを分離): 配列
//   [{ groupKey, race_id, race_date, track, race_number, race_name, bet_type,
//      method, combos: [{ selections, amount, checked }, ...] }, ...]
// 「かごに追加」1回の操作 = 1グループ。同じレース・式別でも常に新規グループとして
// 追加する(マージしない)。金額は購入モーダル側で入力した暫定値がそのまま入り、
// カゴ側で一括/個別に上書きできる。購入対象はチェックボックス(買い目ごと)で
// 選べ、グループ側には一括選択/解除のチェックも置く。
//
// サーバーとの通信は「購入」ボタン押下時の POST /api/tickets/bulk (groups配列形式。
// functions/api/tickets/bulk.js参照)のみで、かごへの追加・削除・金額編集は
// すべてクライアント側(localStorage)で完結する。

(function () {
  "use strict";

  // ---------- localStorage 読み書き ----------
  function cartStorageKey() {
    const username = (window.currentUser && window.currentUser.username) || "anon";
    return `keiba-cart:${username}`;
  }

  function loadCart() {
    try {
      const raw = localStorage.getItem(cartStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveCart(cart) {
    try {
      localStorage.setItem(cartStorageKey(), JSON.stringify(cart));
    } catch (e) {
      console.error("cart save failed", e);
    }
  }

  function checkedCount(cart) {
    return cart.reduce((sum, g) => sum + g.combos.filter((c) => c.checked).length, 0);
  }

  function checkedAmount(cart) {
    return cart.reduce(
      (sum, g) => sum + g.combos.filter((c) => c.checked).reduce((s, c) => s + Number(c.amount || 0), 0),
      0
    );
  }

  function findGroup(cart, groupKey) {
    return cart.find((g) => g.groupKey === groupKey);
  }

  // ---------- 公開関数: かごへの追加(購入モーダル側から呼ばれる) ----------
  function addToCart(payload) {
    const cart = loadCart();
    cart.push({
      groupKey: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `g${Date.now()}_${Math.random().toString(36).slice(2)}`,
      race_id: payload.race_id,
      race_date: payload.race_date,
      track: payload.track,
      race_number: payload.race_number,
      race_name: payload.race_name,
      bet_type: payload.bet_type,
      method: payload.method,
      combos: payload.combos.map((c) => ({ selections: c.selections, amount: c.amount, checked: true })),
    });
    saveCart(cart);
    renderBadge();
  }
  window.addToCart = addToCart;

  // ---------- ヘッダーバッジ ----------
  function renderBadge() {
    const countEl = document.getElementById("cart-badge-count");
    if (!countEl) return;
    // 2026-09-07修正: バッジ用CSS(.cart-badge-count の絶対配置スタイル)は、以前は
    // カゴパネルを一度開いたとき(ensureOverlay()内)にしか注入されていなかった。
    // そのため、パネルを開く前に「かごへ追加」しただけの状態では、数字が丸バッジ
    // ではなく「かご」の直後にそのまま文字として並んでしまい、見た目上「かご1」
    // 「かご2」のようにボタン自体の文字が変わったように見える不具合があった。
    // renderBadge()は「かごへ追加」のたびに必ず呼ばれるため、ここでスタイル注入も
    // 済ませておく(injectStyles()は二重注入を自身でガードしているので安全)。
    injectStyles();
    const count = checkedCount(loadCart());
    countEl.textContent = String(count);
    countEl.hidden = count === 0;
  }

  // ---------- スタイル注入(style.cssは編集せず、このファイル内で完結させる) ----------
  function injectStyles() {
    if (document.getElementById("cart-inline-styles")) return;
    const style = document.createElement("style");
    style.id = "cart-inline-styles";
    style.textContent = `
      .cart-badge-btn { position: relative; }
      .cart-badge-count {
        position: absolute; top: -6px; right: -6px;
        background: var(--hanko, #b5231c); color: #fff;
        font-family: var(--font-mono, monospace); font-size: 10px; font-weight: 700;
        min-width: 16px; height: 16px; padding: 0 3px; border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .cart-overlay {
        position: fixed; inset: 0; z-index: 1100; display: flex;
        align-items: flex-end; justify-content: center;
        background: rgba(20,18,15,0.55);
      }
      .cart-overlay[hidden] { display: none; }
      .cart-panel {
        width: min(720px, 100%); max-height: min(880px, calc(100vh - 24px));
        background: var(--paper, #eeece4); border-top: 1px solid var(--rule-strong, #1c1b18);
        display: flex; flex-direction: column; overflow: hidden;
      }
      .cart-panel-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 18px; border-bottom: 1px solid var(--rule, #c9c5b8);
        background: var(--paper-raised, #f7f6f0);
      }
      .cart-panel-head h2 { margin: 0; font-family: var(--font-display, serif); font-size: 19px; }
      .cart-panel-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
      .cart-empty { text-align: center; color: var(--ink-soft, #55524a); padding: 40px 20px; }
      .cart-group { border: 1px solid var(--rule-strong, #1c1b18); background: #fff; margin-bottom: 10px; }
      .cart-group-head {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer;
        flex-wrap: wrap;
      }
      .cart-group-head:hover { background: rgba(28,27,24,0.04); }
      .cart-group-money { margin-left: auto; font-family: var(--font-mono, monospace); font-size: 13px; }
      .cart-group-body { border-top: 1px dashed var(--rule, #c9c5b8); padding: 10px 12px; }
      .cart-group-body[hidden] { display: none; }
      .cart-bulk-amount { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
      .cart-bulk-amount input { width: 110px; }
      .cart-combo-row {
        display: flex; align-items: center; gap: 10px; padding: 6px 0;
        border-bottom: 1px dashed var(--rule, #c9c5b8); font-size: 13px;
      }
      .cart-combo-row:last-child { border-bottom: none; }
      .cart-combo-label { flex: 1; font-family: var(--font-mono, monospace); }
      .cart-combo-amount { width: 90px; font-family: var(--font-mono, monospace); }
      .cart-panel-foot {
        display: flex; align-items: center; gap: 10px; padding: 12px 16px;
        border-top: 1px solid var(--rule-strong, #1c1b18); background: var(--paper-raised, #f7f6f0);
        flex-wrap: wrap;
      }
      .cart-foot-total { margin-right: auto; font-family: var(--font-mono, monospace); font-size: 15px; }
      .cart-delete-group { color: var(--hanko, #b5231c); }
    `;
    document.head.appendChild(style);
  }

  // ---------- パネルDOM(遅延生成。HTML側には埋め込まない) ----------
  let overlayEl = null;
  // アコーディオンの開閉状態はlocalStorageへ保存せず、ページ内でのみ保持する
  // (history.html等の他の一覧画面のexpandedGroups等と同じ考え方)。
  const expandedGroupKeys = new Set();

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    injectStyles();
    overlayEl = document.createElement("div");
    overlayEl.className = "cart-overlay";
    overlayEl.hidden = true;
    overlayEl.innerHTML = `
      <div class="cart-panel">
        <div class="cart-panel-head">
          <h2>馬券かご</h2>
          <button type="button" id="cart-close-btn" class="dialog-close">×</button>
        </div>
        <div class="cart-panel-body" id="cart-panel-body"></div>
        <div class="cart-panel-foot">
          <span class="cart-foot-total" id="cart-foot-total"></span>
          <button type="button" id="cart-clear-btn" class="ghost-btn">カゴを空にする</button>
          <button type="button" id="cart-checkout-btn" class="stamp-btn">購入</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlayEl);

    overlayEl.addEventListener("click", (e) => { if (e.target === overlayEl) closePanel(); });
    document.getElementById("cart-close-btn").addEventListener("click", closePanel);
    document.getElementById("cart-clear-btn").addEventListener("click", () => {
      if (!loadCart().length) return;
      if (!confirm("カゴを空にしますか？この操作は元に戻せません。")) return;
      saveCart([]);
      renderBadge();
      renderPanel();
    });
    document.getElementById("cart-checkout-btn").addEventListener("click", checkout);
    if (typeof registerEscToClose === "function") registerEscToClose(overlayEl, closePanel);

    return overlayEl;
  }

  function openPanel() {
    ensureOverlay();
    renderPanel();
    overlayEl.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closePanel() {
    if (overlayEl) overlayEl.hidden = true;
    document.body.classList.remove("modal-open");
  }

  // ---------- パネル描画 ----------
  function renderPanel() {
    if (!overlayEl) return;
    const body = document.getElementById("cart-panel-body");
    const footTotal = document.getElementById("cart-foot-total");
    const cart = loadCart();

    body.innerHTML = cart.length
      ? cart.map((g) => renderGroupHtml(g)).join("")
      : `<p class="cart-empty">カゴは空です。購入画面で買い目を選んで「馬券かごへ追加」してください。</p>`;

    footTotal.textContent = `${checkedCount(cart)}点 ／ 合計¥${checkedAmount(cart).toLocaleString()}`;

    bindPanelEvents();
  }

  function renderGroupHtml(g) {
    const allChecked = g.combos.every((c) => c.checked);
    const someChecked = g.combos.some((c) => c.checked);
    const subtotal = g.combos.filter((c) => c.checked).reduce((s, c) => s + Number(c.amount || 0), 0);
    const expanded = expandedGroupKeys.has(g.groupKey);
    return `
      <div class="cart-group" data-key="${g.groupKey}">
        <div class="cart-group-head" data-toggle="${g.groupKey}">
          <span class="expand-arrow">${expanded ? "▾" : "▸"}</span>
          <input type="checkbox" class="cart-group-check" data-key="${g.groupKey}"
            ${allChecked ? "checked" : ""} ${!allChecked && someChecked ? "data-indeterminate=\"1\"" : ""} />
          <span>${escapeHtml(formatDate(g.race_date))}</span>
          <span>${escapeHtml(g.track)}${g.race_number}R</span>
          <span class="bet-badge">${escapeHtml(betTypeLabel(g.bet_type))}</span>
          <span class="method-badge">${escapeHtml(methodLabel(g.method))}</span>
          <span>${g.combos.length}点</span>
          <span class="cart-group-money">¥${subtotal.toLocaleString()}</span>
          <button type="button" class="icon-btn delete cart-delete-group" data-key="${g.groupKey}" title="削除">×</button>
        </div>
        <div class="cart-group-body" ${expanded ? "" : "hidden"}>
          <div class="cart-bulk-amount">
            <input type="number" min="100" step="100" class="cart-bulk-amount-input" placeholder="一括金額" />
            <button type="button" class="ghost-btn cart-bulk-amount-btn" data-key="${g.groupKey}">全点に反映</button>
          </div>
          ${g.combos.map((c, ci) => `
            <div class="cart-combo-row">
              <input type="checkbox" class="cart-combo-check" data-key="${g.groupKey}" data-ci="${ci}" ${c.checked ? "checked" : ""} />
              <span class="cart-combo-label">${escapeHtml(formatSelections(g.bet_type, c.selections))}</span>
              <input type="number" min="100" step="100" class="cart-combo-amount" data-key="${g.groupKey}" data-ci="${ci}" value="${c.amount}" />
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function bindPanelEvents() {
    const body = document.getElementById("cart-panel-body");

    // グループの開閉(チェックボックス・削除ボタン・個別入力欄のクリックは
    // stopPropagation()で開閉トグルに伝播させない)。
    body.querySelectorAll(".cart-group-head").forEach((head) => {
      head.addEventListener("click", () => {
        const key = head.dataset.toggle;
        if (expandedGroupKeys.has(key)) expandedGroupKeys.delete(key);
        else expandedGroupKeys.add(key);
        renderPanel();
      });
    });

    body.querySelectorAll(".cart-group-check").forEach((chk) => {
      if (chk.dataset.indeterminate) chk.indeterminate = true;
      chk.addEventListener("click", (e) => e.stopPropagation());
      chk.addEventListener("change", () => {
        const cart = loadCart();
        const g = findGroup(cart, chk.dataset.key);
        if (!g) return;
        g.combos.forEach((c) => (c.checked = chk.checked));
        saveCart(cart);
        renderBadge();
        renderPanel();
      });
    });

    body.querySelectorAll(".cart-delete-group").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const cart = loadCart().filter((g) => g.groupKey !== btn.dataset.key);
        saveCart(cart);
        expandedGroupKeys.delete(btn.dataset.key);
        renderBadge();
        renderPanel();
      });
    });

    body.querySelectorAll(".cart-combo-check").forEach((chk) => {
      chk.addEventListener("click", (e) => e.stopPropagation());
      chk.addEventListener("change", () => {
        const cart = loadCart();
        const g = findGroup(cart, chk.dataset.key);
        if (!g) return;
        g.combos[Number(chk.dataset.ci)].checked = chk.checked;
        saveCart(cart);
        renderBadge();
        renderPanel();
      });
    });

    body.querySelectorAll(".cart-combo-amount").forEach((input) => {
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("change", () => {
        const cart = loadCart();
        const g = findGroup(cart, input.dataset.key);
        if (!g) return;
        g.combos[Number(input.dataset.ci)].amount = Number(input.value) || 0;
        saveCart(cart);
        renderBadge();
        renderPanel();
      });
    });

    body.querySelectorAll(".cart-bulk-amount-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wrap = btn.closest(".cart-group-body");
        const value = Number(wrap.querySelector(".cart-bulk-amount-input").value) || 0;
        if (!value) { alert("金額を入力してください"); return; }
        const cart = loadCart();
        const g = findGroup(cart, btn.dataset.key);
        if (!g) return;
        g.combos.forEach((c) => (c.amount = value));
        saveCart(cart);
        renderBadge();
        renderPanel();
      });
    });
  }

  // ---------- 購入確定 ----------
  async function checkout() {
    const cart = loadCart();
    const groups = [];

    for (const g of cart) {
      const checkedCombos = g.combos.filter((c) => c.checked);
      if (!checkedCombos.length) continue;
      if (checkedCombos.some((c) => !c.amount)) {
        alert("金額が未入力(または0円)の買い目があります。確認してください。");
        return;
      }
      groups.push({
        client_key: g.groupKey,
        race_id: g.race_id,
        race_date: g.race_date,
        track: g.track,
        race_number: g.race_number,
        race_name: g.race_name,
        bet_type: g.bet_type,
        method: g.method,
        combos: checkedCombos.map((c) => ({ selections: c.selections, amount: c.amount })),
      });
    }

    if (!groups.length) {
      alert("購入対象として選択されている買い目がありません(チェックを確認してください)。");
      return;
    }

    const checkoutBtn = document.getElementById("cart-checkout-btn");
    if (checkoutBtn) checkoutBtn.disabled = true;

    let res, data;
    try {
      res = await authedFetch("/api/tickets/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups }),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      if (checkoutBtn) checkoutBtn.disabled = false;
      alert("通信に失敗しました。時間をおいて再度お試しください。");
      return;
    }
    if (checkoutBtn) checkoutBtn.disabled = false;

    if (!res.ok) {
      alert(data.error || "購入に失敗しました。");
      return;
    }

    // 成功したグループの、送信した(=チェック済みだった)買い目だけをカゴから
    // 取り除く。未チェックのまま残っていた買い目、および失敗したグループは
    // そのまま残す(client_keyで結果を突き合わせる。functions/api/tickets/bulk.js参照)。
    const resultByKey = new Map((data.results || []).map((r) => [r.client_key, r]));
    let purchasedPoints = 0;
    const failedMessages = [];
    const nextCart = [];

    for (const g of cart) {
      const result = resultByKey.get(g.groupKey);
      if (!result || result.status !== "created") {
        if (result && result.status !== "created") {
          failedMessages.push(`${g.track}${g.race_number}R ${betTypeLabel(g.bet_type)}: ${result.error || "失敗"}`);
        }
        nextCart.push(g);
        continue;
      }
      purchasedPoints += result.count || 0;
      const remaining = g.combos.filter((c) => !c.checked);
      if (remaining.length) nextCart.push({ ...g, combos: remaining });
    }

    saveCart(nextCart);
    renderBadge();
    renderPanel();

    // 購入画面(index.html)を開いている場合は、購入済みレースの色分けをすぐ反映する
    // (buy.js側の関数。他ページには存在しないためtypeof チェックで安全に呼び分ける)。
    if (typeof loadPurchasedRaceIds === "function" && typeof renderGrid === "function") {
      loadPurchasedRaceIds().then(renderGrid);
    }

    let message = `${purchasedPoints}点を購入しました。`;
    if (failedMessages.length) {
      message += `\n\n以下は購入できませんでした(カゴに残しています):\n${failedMessages.join("\n")}`;
    }
    alert(message);
  }

  // ---------- 初期化 ----------
  // window.currentUser.username が確定する(=ログイン成功後)まではカゴの
  // localStorageキーを正しく組み立てられないため、auth.js側のログイン成功
  // タイミングで発火する keiba-auth-ready イベントを待って初期化する。
  document.addEventListener("keiba-auth-ready", () => {
    const btn = document.getElementById("cart-badge-btn");
    if (btn && !btn.dataset.cartBound) {
      btn.dataset.cartBound = "1";
      btn.addEventListener("click", openPanel);
    }
    renderBadge();
  });

  // ログアウト時は、他ユーザーの画面にカゴが開いたまま残らないよう閉じる
  // (カゴのオーバーレイはdocument.body直下に生成され、#app-screenの外側にあるため、
  // #app-screenを隠すだけではカゴが隠れない)。
  document.addEventListener("keiba-logout", closePanel);
})();
