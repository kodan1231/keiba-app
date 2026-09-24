// 楽天競馬・netkeibaの払戻表をコピー&ペーストしたテキストから、式別ごとの払戻
// (100円あたり)を解析する。レース管理画面の払戻モーダル「払戻一括取込」で使う。
// 詳細は docs/design/screens.md「払戻モーダル」の「払戻一括取込」参照。
//
// 貼り付けテキストの形(サイトにより異なるが、いずれも「式別名」で始まり、その後に
// 「組番(複数行)→払戻金(複数行)→人気(複数行)」の順でセル(タブ・改行区切り)が続く):
//   楽天競馬: 1行に2つの式別が横並びになる(例: 「単勝 1 120円 1番人気 馬単 1-2 …」)。
//             組番はハイフン区切り(1-2-4)。
//   netkeiba: 式別ごとに縦に並ぶ。組番は空白区切り(2 10)。
// そのため行ではなく「式別名の出現位置」でテキストを区切り、各区間の中で
// 組番(数字の並び)・払戻金(「◯円」)・人気(「◯人気」)をセル単位で分類する。
// 人気は使わない。

// [式別名, 内部キー]。長い名前を先に並べる(三連複が複勝等に食われないように)。
// 内部キーがnullのもの(枠単。地方競馬のみ)は本アプリに該当する式別が無いため無視する。
const PAYOUT_PASTE_KEYWORDS = [
  ["三連複", "sanrenpuku"], ["3連複", "sanrenpuku"],
  ["三連単", "sanrentan"], ["3連単", "sanrentan"],
  ["単勝", "tan"], ["複勝", "fuku"],
  ["枠複", "wakuren"], ["枠連", "wakuren"], ["枠単", null],
  ["馬複", "umaren"], ["馬連", "umaren"], ["馬単", "umatan"],
  ["ワイド", "wide"],
];

const PAYOUT_PASTE_COMBO_LENGTH = { tan: 1, fuku: 1, wakuren: 2, umaren: 2, umatan: 2, wide: 2, sanrenpuku: 3, sanrentan: 3 };
// 着順(先着順)が意味を持つ式別。それ以外は昇順に正規化する(アプリ内の保存形式に合わせる)。
const PAYOUT_PASTE_ORDERED = new Set(["umatan", "sanrentan"]);

// 戻り値: { payouts: {betType:[{combo,rate}]}, finishOrder: number[]|null,
//           ignored: string[], errors: string[], warnings: string[] }
function parsePayoutPaste(rawText) {
  const result = { payouts: {}, finishOrder: null, ignored: [], errors: [], warnings: [] };
  const text = String(rawText ?? "").normalize("NFKC");
  const re = new RegExp(PAYOUT_PASTE_KEYWORDS.map(([k]) => k).join("|"), "g");
  const marks = [...text.matchAll(re)];
  if (!marks.length) {
    result.errors.push("式別名(単勝・複勝など)が見つかりませんでした。払戻表をコピーして貼り付けてください。");
    return result;
  }
  const keyOf = Object.fromEntries(PAYOUT_PASTE_KEYWORDS);

  marks.forEach((m, i) => {
    const label = m[0];
    const betType = keyOf[label];
    if (!betType) { result.ignored.push(label); return; }
    if (result.payouts[betType]) return; // 同じ式別が複数あれば最初のものだけ使う

    const segEnd = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const cells = text.slice(m.index + label.length, segEnd).split(/[\t\r\n]+/).map((s) => s.trim()).filter(Boolean);

    // 組番は払戻金より前に並ぶ。払戻金が出てきた後の数字だけのセルは組番として扱わない。
    const combos = [];
    const amounts = [];
    for (const c of cells) {
      if (/^[\d,]+\s*円$/.test(c)) amounts.push(Number(c.replace(/[,円\s]/g, "")));
      else if (/人気$/.test(c)) continue;
      else if (amounts.length === 0 && /^\d+(?:[\s\-→>]+\d+)*$/.test(c)) combos.push(c.split(/[\s\-→>]+/).map(Number));
    }

    if (!combos.length) { result.errors.push(`${label}: 組番が読み取れませんでした。`); return; }
    if (amounts.length < combos.length) {
      result.errors.push(`${label}: 組番${combos.length}件に対して払戻金が${amounts.length}件しか読み取れませんでした。`);
      return;
    }
    if (combos.some((c) => c.length !== PAYOUT_PASTE_COMBO_LENGTH[betType])) {
      result.errors.push(`${label}: 組番の形式が想定と異なります。`);
      return;
    }
    result.payouts[betType] = combos.map((c, idx) => ({
      combo: PAYOUT_PASTE_ORDERED.has(betType) ? c : [...c].sort((a, b) => a - b),
      rate: amounts[idx],
    }));
  });

  result.finishOrder = derivePayoutPasteFinishOrder(result.payouts);
  const tan = result.payouts.tan && result.payouts.tan[0].combo[0];
  if (result.finishOrder && tan !== undefined && tan !== result.finishOrder[0]) {
    result.warnings.push("単勝の馬番と、他の式別から読み取った1着の馬番が一致しません。貼り付け内容を確認してください。");
  }
  return result;
}

// 1〜3着の馬番を、貼り付け内容から推定する。三連単が最も確実(1〜3着そのもの)。
// 無ければ馬単(1・2着)+複勝(3着=残りの1頭)、それも無ければ単勝(1着のみ)。
function derivePayoutPasteFinishOrder(payouts) {
  const sanrentan = payouts.sanrentan && payouts.sanrentan[0].combo;
  if (sanrentan) return [...sanrentan];
  const umatan = payouts.umatan && payouts.umatan[0].combo;
  if (umatan) {
    const order = [...umatan];
    const rest = (payouts.fuku || []).map((p) => p.combo[0]).filter((h) => !order.includes(h));
    if (rest.length === 1) order.push(rest[0]);
    return order;
  }
  const tan = payouts.tan && payouts.tan[0].combo[0];
  return tan !== undefined ? [tan] : null;
}
