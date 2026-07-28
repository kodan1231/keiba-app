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