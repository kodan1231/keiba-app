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
 * コース種別(芝/ダート/障害)を1〜2文字に短縮する。
 * @param {string} courseType - "芝"/"ダート"/"障害"のいずれか(またはnull/未入力)
 * @returns {string} "芝"/"ダ"/"障"、該当しなければ空文字
 */
function courseTypeShort(courseType) {
  if (courseType === "芝") return "芝";
  if (courseType === "ダート") return "ダ";
  if (courseType === "障害") return "障";
  return "";
}

/**
 * コース種別・距離のいずれか一方のみ入力の場合でも、入力済みの方だけを表示する
 * 共通関数(2026-08-14・クラスタN-2)。races.js(レース一覧・払戻モーダル)・
 * buy.js(購入画面のレース選択グリッド)の両方から利用する。
 * @param {string} courseType - "芝"/"ダート"/"障害"(またはnull)
 * @param {number} distance - 距離(m。またはnull)
 * @returns {string} 例: "ダ1800m" / "1800m" / "芝" / ""
 */
function formatCourseText(courseType, distance) {
  const parts = [];
  const label = courseTypeShort(courseType);
  if (label) parts.push(label);
  if (distance) parts.push(`${distance}m`);
  return parts.join("");
}

/**
 * races.payouts に、実際の払戻レート(式別ごとの的中組み合わせ・レートのデータ)が
 * 1件以上含まれているかどうかを判定する共通関数(2026-08-23追加)。
 *
 * races.payouts は式別ごとの払戻レート({tan:[...], fuku:[...], ...})に加えて、
 * JRAレース結果PDFインポートが取消・除外・中止馬を検出した際に
 * `payouts.refunds`(返還対象の馬番・枠番の記録。払戻レートそのものではない)を
 * 保持することがある。以前は `Object.keys(payouts).length > 0` によって
 * 「確定済」を判定していたため、返還対象馬がいるだけで実際の払戻レートが
 * 1件も登録されていないレースでも「確定済」と誤判定される不具合があった
 * (docs/DESIGN.md「払戻確定バッジの判定」参照)。
 *
 * この関数は refunds キーを判定対象から除外し、他の式別キーに実際のレート配列
 * (要素数1以上)があるかどうかだけを見る。
 *
 * @param {object|null} payouts - races.payouts (パース済みオブジェクト。null/undefined可)
 * @returns {boolean} 実際の払戻レートが1件以上あればtrue
 */
function hasSettledPayoutRates(payouts) {
  if (!payouts || typeof payouts !== "object") return false;
  return Object.keys(payouts).some(
    (k) => k !== "refunds" && Array.isArray(payouts[k]) && payouts[k].length > 0
  );
}

/**
 * 「今日」の日付をローカルタイムゾーン基準でYYYY-MM-DD形式の文字列として返す
 * 共通関数(2026-08-24追加)。
 *
 * 以前は public/app.js(馬券履歴画面)だけがこのロジック(getFullYear/getMonth/getDate
 * によるローカル基準の組み立て)を持っており、public/buy.js(馬券購入画面)は
 * `Date.prototype.toISOString().slice(0,10)`(UTC基準)を使っていた。日本(JST=UTC+9)
 * では日付が変わってから午前9時頃までの間、toISOString()は前日の日付を返してしまうため、
 * この時間帯に「今日」ボタンを押すと画面によって選択される日付がずれる不具合があった。
 * 両画面から本関数を共有することで、「今日」の判定基準を統一する。
 *
 * @param {Date} [date] - 基準にするDateオブジェクト(省略時は現在時刻)
 * @returns {string} 例: "2026-08-24"
 */
function todayDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

/**
 * JRA中央競馬10場の一覧(五十音順ではなく、開催回・PDF解析等で一般的に使われる並び)。
 * 2026-08-17リファクタリング: 従来 public/parse.js の JRA_TRACKS・
 * public/jra-entries-pdf.js の JRA_ENTRIES_TRACKS・public/jra-result-pdf.js の
 * JRA_RESULT_PDF_TRACKS として、内容が完全に同一の配列がそれぞれ独立して
 * 定義されていた(docs/BACKLOG.md「クラスタI」参照)。本アプリはESモジュールを
 * 使わないグローバルスクリプト構成のため、races.html で utils.js が上記3ファイルより
 * 必ず先に読み込まれる点を利用し、この配列をここへ集約したうえで、各ファイル側は
 * 従来通りの変数名のままこの配列を参照する(`const JRA_TRACKS = JRA_CENTRAL_TRACKS;`等)。
 * 既存の変数名・参照箇所は変更していないため、この集約自体で挙動が変わることはない。
 * `public/buy.js` の RACE_TRACK_ORDER(表示順序用。地方競馬場を含み用途が異なる)とは
 * 別物であり、統合対象ではない。
 */
const JRA_CENTRAL_TRACKS = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];
