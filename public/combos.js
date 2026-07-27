// スロット方式による組み合わせ生成。
// slots = 各着順/グループごとの候補馬番配列 (例: [[3], [5,7,9]] なら 1着=3固定, 2着=5/7/9のいずれか)
// ordered = true なら着順(スロットの並び)そのものが意味を持つ(馬単・三連単など)
// ordered = false なら同じ組み合わせの重複(順序違い)を除去する(馬連・三連複など)
function generateCombinations(slots, ordered) {
  const results = [];

  function backtrack(idx, chosen) {
    if (idx === slots.length) {
      results.push([...chosen]);
      return;
    }
    for (const horse of slots[idx]) {
      if (chosen.includes(horse)) continue; // 同じ馬が複数スロットに重複するのは無効
      chosen.push(horse);
      backtrack(idx + 1, chosen);
      chosen.pop();
    }
  }
  backtrack(0, []);

  if (ordered) return results;

  // 着順を問わない馬券は、順序違いの重複を除去したうえで、常に昇順に揃えて返す。
  // (揃えないと、選択順序が変わるたびに組み合わせの表記が入れ替わり、
  //  個別に入力した金額の対応付けが壊れてしまうため)
  const seen = new Set();
  const deduped = [];
  for (const combo of results) {
    const sortedCombo = [...combo].sort((a, b) => a - b);
    const key = sortedCombo.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sortedCombo);
  }
  return deduped;
}

// 通常: 各スロットに1頭ずつ指定(orderedPicksはユーザーが選んだ順)
function slotsForNormal(orderedPicks) {
  return orderedPicks.map((h) => [h]);
}

// ボックス: 選んだ馬の集合を、全スロットに同じ候補として渡す
function slotsForBox(n, selectedHorses) {
  return Array.from({ length: n }, () => selectedHorses);
}

// 流し(着順なし): 軸馬(1〜2頭)を固定スロットにし、残りスロットは相手馬の候補とする
function slotsForNagashiUnordered(n, axisHorses, partnerHorses) {
  const axisSlots = axisHorses.map((h) => [h]);
  const remaining = n - axisHorses.length;
  const partnerSlots = Array.from({ length: Math.max(remaining, 0) }, () => partnerHorses);
  return [...axisSlots, ...partnerSlots];
}

// 流し(着順あり): 軸馬1頭を指定位置に固定し、残りの位置に相手馬の候補を割り当てる
function slotsForNagashiOrdered(n, axisHorse, axisPosition, partnerHorses) {
  const slots = [];
  for (let i = 0; i < n; i++) {
    slots.push(i === axisPosition ? [axisHorse] : partnerHorses);
  }
  return slots;
}

// フォーメーション: 各スロットの候補馬番配列をそのまま使う
function slotsForFormation(candidatesPerSlot) {
  return candidatesPerSlot;
}
