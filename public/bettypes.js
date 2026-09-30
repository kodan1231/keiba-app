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

// 買い目グループの要約行(netkeiba風の簡易表示)。購入モーダルの買い目欄と馬券かごで共用する。
// structure は tickets.structure と同じ形({numbers}/{axis,partners}/{slots}/null)、
// comboNumbers は各買い目の馬番(枠連は枠番)配列の配列。
// structure が無い場合(通常・単複の複数頭選択・一部の買い目を外したグループ)は、
// 1点ならその買い目、複数点なら登場する番号の一覧に丸める。
// 戻り値: [{ label, value }, ...]
function describeBetStructure(betType, structure, comboNumbers) {
  const unit = betType === "wakuren" ? "枠番" : "馬番";
  const join = (arr) => arr.join(",");
  if (structure && Array.isArray(structure.slots)) {
    return structure.slots.map((nums, i) => ({ label: selectionLabel(betType, i), value: join(nums) }));
  }
  if (structure && Array.isArray(structure.axis) && Array.isArray(structure.partners)) {
    return [
      { label: "軸", value: structure.axis.join("－") },
      { label: "相手", value: join(structure.partners) },
    ];
  }
  if (structure && Array.isArray(structure.numbers)) {
    return [{ label: unit, value: join(structure.numbers) }];
  }
  const combos = comboNumbers || [];
  if (combos.length === 1) {
    const def = BET_TYPES[betType];
    return [{ label: "買い目", value: combos[0].join(def && def.ordered ? " → " : " - ") }];
  }
  const nums = [...new Set(combos.flat())].sort((a, b) => Number(a) - Number(b));
  return [{ label: unit, value: join(nums) }];
}
