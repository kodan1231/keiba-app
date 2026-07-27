// 馬券種類・購入方式の定義。全ページで共通利用する。

const BET_TYPES = {
  tan:        { label: "単勝",   n: 1, ordered: false },
  fuku:       { label: "複勝",   n: 1, ordered: false },
  wakuren:    { label: "枠連",   n: 2, ordered: false },
  umaren:     { label: "馬連",   n: 2, ordered: false },
  wide:       { label: "ワイド", n: 2, ordered: false },
  umatan:     { label: "馬単",   n: 2, ordered: true  },
  sanrenpuku: { label: "三連複", n: 3, ordered: false },
  sanrentan:  { label: "三連単", n: 3, ordered: true  },
};

const BET_TYPE_ORDER = ["tan", "fuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];

const METHODS = {
  normal: { label: "通常" },
  box: { label: "ボックス" },
  nagashi: { label: "流し" },
  formation: { label: "フォーメーション" },
};

// n=1(単勝・複勝)は組み合わせという概念がないため「通常」のみ選択可能
function availableMethods(betType) {
  const def = BET_TYPES[betType];
  if (!def || def.n === 1) return ["normal"];
  return ["normal", "box", "nagashi", "formation"];
}

function betTypeLabel(key) {
  return BET_TYPES[key] ? BET_TYPES[key].label : key;
}

function methodLabel(key) {
  return METHODS[key] ? METHODS[key].label : key;
}

// 着順指定のあるなしで、選択位置のラベルを変える
// (馬単・三連単は着順そのものが的中条件なので「1着」「2着」…と明示する)
function selectionLabel(betType, index) {
  const def = BET_TYPES[betType];
  if (!def) return `${index + 1}`;
  if (def.ordered) {
    return ["1着", "2着", "3着"][index] || `${index + 1}着`;
  }
  return ["1頭目", "2頭目", "3頭目"][index] || `${index + 1}頭目`;
}

// 選択馬の配列を「3-5」「3→5→7」のような短い表記にする(一覧表示用)
function formatSelections(betType, selections) {
  const def = BET_TYPES[betType];
  const nums = selections.map((s) => s.horse_number ?? "?");
  return nums.join(def && def.ordered ? " → " : " - ");
}
