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
  axis1: { label: "1頭軸" },
  axis2: { label: "2頭軸" },
  multi: { label: "マルチ" },
  axis2_multi: { label: "2頭軸マルチ" },
  formation: { label: "フォーメーション" },
  import: { label: "CSV取込" },
};

function availableMethods(betType) {
  const def = BET_TYPES[betType];
  if (!def || def.n === 1) return ["normal"];

  if (betType === "sanrentan") {
    return ["normal", "box", "nagashi", "axis1", "axis2", "multi", "axis2_multi", "formation"];
  }
  if (betType === "sanrenpuku") {
    return ["normal", "box", "nagashi", "axis1", "axis2", "formation"];
  }
  if (def.ordered) {
    return ["normal", "box", "nagashi", "axis1", "formation"];
  }
  return ["normal", "box", "nagashi", "axis1", "formation"];
}

function betTypeLabel(key) {
  return BET_TYPES[key] ? BET_TYPES[key].label : key;
}

function methodLabel(key) {
  return METHODS[key] ? METHODS[key].label : key;
}

function selectionLabel(betType, index) {
  const def = BET_TYPES[betType];
  if (!def) return `${index + 1}`;
  if (def.ordered) {
    return ["1着", "2着", "3着"][index] || `${index + 1}着`;
  }
  return ["1頭目", "2頭目", "3頭目"][index] || `${index + 1}頭目`;
}

function formatSelections(betType, selections) {
  const def = BET_TYPES[betType];
  const nums = selections.map((s) => s.horse_number ?? "?");
  return nums.join(def && def.ordered ? " → " : " - ");
}
