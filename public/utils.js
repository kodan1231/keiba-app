// 共通ユーティリティ関数

/**
 * HTML特殊文字をエスケープ
 * @param {string} str - エスケープ対象文字列
 * @returns {string} エスケープ済み文字列
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? "";
  return div.innerHTML;
}

/**
 * HTML属性用のエスケープ（シングルクォートも対応）
 * @param {string} str - エスケープ対象文字列
 * @returns {string} エスケープ済み文字列
 */
function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

/**
 * 日付文字列をフォーマット
 * @param {string} dateStr - YYYY-MM-DD形式の日付文字列
 * @returns {string} フォーマット済み日付（日本語表示）
 */
function formatDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });
}

/**
 * モーダル/ダイアログ共通: ESCキー押下時に「キャンセル」ボタンと同じ扱いで
 * (保存せず)閉じるようにする(docs/BACKLOG.md クラスタK対応・2026-08-12)。
 *
 * closeFn には、そのモーダルの既存の「キャンセル/閉じる」ボタンが呼んでいる
 * 処理をそのまま渡すこと(フォーム送信・API呼び出しは行わず、モーダルを
 * hidden にするだけの関数)。modalEl が既に hidden の場合は何もしない。
 *
 * 複数のモーダルが同時に登録されていても、実際に表示中(hidden でない)の
 * ものだけが閉じられるため、通常のUIフロー上想定していない「複数モーダル
 * 同時オープン」が万一発生しても安全に動作する。
 *
 * @param {HTMLElement} modalEl - モーダルのルート要素(hidden属性で表示制御されるもの)
 * @param {Function} closeFn - キャンセル相当の「保存せず閉じる」処理
 */
function registerEscToClose(modalEl, closeFn) {
  if (!modalEl || typeof closeFn !== "function") return;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modalEl.hidden) return;
    closeFn();
  });
}
