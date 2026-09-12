// 購入馬券グループ表示の共通部品。
//
// 2026-09-08新設: 購入履歴画面(app.js の renderGroupRow)と予想登録画面
// (prediction.js の renderPurchasedTickets)は、どちらも「tickets を group_id 単位で
// まとめ、`.group-card > .group-card-head` + `.group-detail` で開閉表示する」同型の
// UIを持つ。ただし編集可否・削除ボタン・ステータスバッジ・買い目の馬名表示有無等の
// 機能セットが異なるため、レンダラ本体とDOMイベント配線は各ファイルに残し、差分の
// 無い純粋関数だけをここへ集約する。
//
// ESモジュール不使用のグローバルスクリプト構成のため、各HTMLで app.js /
// prediction.js より前、かつ utils.js(formatYen/escapeHtml)・bettypes.js(BET_TYPES)
// より後に読み込む。読み込むのは history.html と prediction.html のみ。

// tickets を group_id 単位でまとめる。返り値は「同一グループの ticket 配列」の配列で、
// 各グループが最初に出現した順を保持する。
function groupTicketsByGroupId(tickets) {
  const map = new Map();
  for (const t of tickets) {
    if (!map.has(t.group_id)) map.set(t.group_id, []);
    map.get(t.group_id).push(t);
  }
  return Array.from(map.values());
}

// 購入額の合計。amount が数値でない場合は 0 扱い。
function sumTicketAmount(tickets) {
  return tickets.reduce((s, t) => s + Number(t.amount || 0), 0);
}

// 払戻が確定している(payout が null/undefined でない)ticket の払戻合計。
function sumSettledPayout(tickets) {
  return tickets
    .filter((t) => t.payout !== null && t.payout !== undefined)
    .reduce((s, t) => s + Number(t.payout || 0), 0);
}

// `<span class="group-money">` の中身になる「購入¥… / 払戻¥…」表示文字列。
// 払戻が1件も確定していなければ購入額のみを返す。
function ticketMoneyText(tickets) {
  const amount = sumTicketAmount(tickets);
  const hasSettled = tickets.some((t) => t.payout !== null && t.payout !== undefined);
  return `購入${formatYen(amount)}${hasSettled ? ` / 払戻${formatYen(sumSettledPayout(tickets))}` : ""}`;
}

// グループの確定状況ラベル。全点確定=「確定済み」、一部のみ=「一部確定」、0点=「未確定」。
function ticketGroupStatus(group) {
  const settled = group.filter((t) => t.payout !== null && t.payout !== undefined).length;
  if (settled === group.length) return "確定済み";
  if (settled > 0) return "一部確定";
  return "未確定";
}

// 買い目セル(`.sel-line` の中身)。馬番+馬名を `.sel-item` で並べ、券種が着順あり
// (馬単・三連単)なら「→」、着順なしなら「-」で連結する。未知/不正な bet_type
// (壊れたインポートデータ等)でも描画がクラッシュしないよう ordered=false にフォールバックする。
function selectionCellHtml(betType, selections) {
  const def = BET_TYPES[betType] || { ordered: false };
  return (selections || [])
    .map((s) => `<span class="sel-item"><span class="sel-num">${s.horse_number}</span>${escapeHtml(s.horse_name || "")}</span>`)
    .join(def.ordered ? '<span class="sel-arrow">→</span>' : '<span class="sel-dash">-</span>');
}

// 買い目の「入力した形」をコンパクトに表現する行を返す(JRA IPAT公式アプリの
// 「照会結果詳細」画面に見た目を寄せる。2026-09-12追加。docs/design/screens.md
// 「購入馬券グループの表示(IPAT風コンパクト表示)」参照)。
//
// IPATは box/フォーメーション/ながし で生成される全組み合わせ(点)を展開せず、
// 「馬番の一覧」「着順ごとの馬番」「軸馬/相手」など入力した形のまま数行で見せる。
// この関数はグループ内の全チケットの実際の selections だけから、その形を逆算する
// (`tickets.method` / `imported_ticket_groups.method` の文字列には依存しない)。
// 依存しないことで、method が常に固定文字列 'import' になる CSV取込グループ
// (imported_ticket_items も group_id 単位で複数組み合わせを持つ点は tickets と同型)
// にも区別なく適用できる。
//
// 判定ロジック:
//   1. 全チケットに共通して登場する馬番(交差)が1〜(n-1)頭あれば「軸馬/相手」形式
//      (box/nagashi/formation/CSV取込のいずれであっても、結果的に軸が立っていれば
//      同じ形で見せる)。軸が2頭ある場合はIPATにならい全角ハイフンで連結する。
//   2. 着順あり(ordered)の券種は、着順位置ごとの馬番集合が全て同じなら「馬番」
//      (ボックス)、位置ごとに違うなら着順ごとに個別表示(フォーメーション)。
//   3. 上記いずれにも当てはまらなければ「馬番」に丸める。
//
// 既知の制約: 着順なし(unordered)の券種のフォーメーションで、かつ共通の軸馬が
// 1頭も無い(各着順グループが完全に別々の馬番)場合は、保存時点で組み合わせが
// 馬番昇順に正規化されており元の枠分けを復元できないため、「馬番: 全馬番の一覧」に
// 丸めるフォールバックになる(2026-09-12。現状把握している唯一の取りこぼしパターン。
// 発生したら都度対応する)。
//
// 1点のみのグループ(通常の単発購入)はコンパクト表示の必要が無いため null を返す。
function describeGroupSelections(betType, group) {
  if (!group || group.length <= 1) return null;
  const def = BET_TYPES[betType] || {};
  const n = def.n || (group[0].selections || []).length;
  if (!n) return null;

  const sortNums = (arr) => [...arr].sort((a, b) => Number(a) - Number(b));
  const ticketSets = group.map((t) => new Set((t.selections || []).map((s) => s.horse_number)));

  const allNumbers = new Set();
  ticketSets.forEach((s) => s.forEach((x) => allNumbers.add(x)));

  const common = ticketSets.reduce(
    (acc, s) => (acc === null ? new Set(s) : new Set([...acc].filter((x) => s.has(x)))),
    null
  ) || new Set();

  if (common.size > 0 && common.size < n) {
    const axisText = sortNums([...common]).join("－");
    const partnerText = sortNums([...allNumbers].filter((x) => !common.has(x))).join(",");
    return [
      { label: "軸馬", value: axisText },
      { label: "相手", value: partnerText },
    ];
  }

  if (def.ordered && n > 1) {
    const posSets = Array.from({ length: n }, (_, i) => {
      const s = new Set();
      group.forEach((t) => {
        const sel = (t.selections || [])[i];
        if (sel) s.add(sel.horse_number);
      });
      return s;
    });
    const allSamePosition = posSets.every(
      (s) => s.size === posSets[0].size && [...s].every((x) => posSets[0].has(x))
    );
    if (!allSamePosition) {
      return posSets.map((s, i) => ({ label: selectionLabel(betType, i), value: sortNums([...s]).join(",") }));
    }
  }

  return [{ label: "馬番", value: sortNums([...allNumbers]).join(",") }];
}

// グループ内の全チケットが同額なら「各◯◯円」用の金額を返す。バラけていれば null
// (呼び出し側は group-money の合計表示のみに任せる)。
function describeGroupUniformAmount(group) {
  const amounts = new Set(group.map((t) => Number(t.amount || 0)));
  return amounts.size === 1 ? [...amounts][0] : null;
}

// describeGroupSelections() の結果をIPAT風のコンパクトな表示のHTMLへ変換する。
// 対象外(1点のみのグループ)なら空文字列を返す。
function groupCompactSummaryHtml(betType, group) {
  const lines = describeGroupSelections(betType, group);
  if (!lines) return "";
  const amount = describeGroupUniformAmount(group);
  return `
    <div class="group-compact-summary">
      ${lines
        .map(
          (l) =>
            `<div class="group-compact-line"><span class="group-compact-label">${escapeHtml(l.label)}</span><span class="group-compact-value">${escapeHtml(l.value)}</span></div>`
        )
        .join("")}
      ${amount !== null ? `<div class="group-compact-line group-compact-amount">各${formatYen(amount)}</div>` : ""}
    </div>
  `;
}
