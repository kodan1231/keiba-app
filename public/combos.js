// 買い目生成エンジン。
// slots = 各着順/グループごとの候補馬番配列。
// ordered=true は着順を区別し、false は順序違いを重複除去する。

function generateCombinations(slots, ordered) {
  const results = [];

  function backtrack(idx, chosen) {
    if (idx === slots.length) {
      results.push([...chosen]);
      return;
    }
    for (const horse of slots[idx]) {
      if (chosen.includes(horse)) continue;
      chosen.push(horse);
      backtrack(idx + 1, chosen);
      chosen.pop();
    }
  }

  if (!slots.length || slots.some((s) => !Array.isArray(s) || s.length === 0)) return [];
  backtrack(0, []);

  if (ordered) return dedupeOrdered(results);

  return dedupeUnordered(results);
}

function dedupeOrdered(results) {
  const seen = new Set();
  return results.filter((combo) => {
    const key = combo.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeUnordered(results) {
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

function slotsForNormal(orderedPicks) {
  return orderedPicks.map((h) => [h]);
}

function slotsForBox(n, selectedHorses) {
  return Array.from({ length: n }, () => selectedHorses);
}

function slotsForNagashiUnordered(n, axisHorses, partnerHorses) {
  const axisSlots = axisHorses.map((h) => [h]);
  const remaining = n - axisHorses.length;
  const partnerSlots = Array.from({ length: Math.max(remaining, 0) }, () => partnerHorses);
  return [...axisSlots, ...partnerSlots];
}

function slotsForNagashiOrdered(n, axisHorse, axisPosition, partnerHorses) {
  const slots = [];
  for (let i = 0; i < n; i++) {
    slots.push(i === axisPosition ? [axisHorse] : partnerHorses);
  }
  return slots;
}

function slotsForFormation(candidatesPerSlot) {
  return candidatesPerSlot;
}

// 1頭軸。
// 三連複などの順不同券種では、軸1頭＋相手2頭を生成。
// 三連単では、軸馬を指定着順に固定して相手2頭を残り着順に展開。
function slotsForAxis1Unordered(n, axisHorse, partnerHorses) {
  if (n === 2) return [[axisHorse], partnerHorses];
  return [[axisHorse], partnerHorses, partnerHorses];
}

function slotsForAxis1Ordered(n, axisHorse, axisPosition, partnerHorses) {
  return slotsForNagashiOrdered(n, axisHorse, axisPosition, partnerHorses);
}

// 3連単2頭軸・着順固定。
// axisOrder[0]を1着、axisOrder[1]を2着、partnerを3着に固定。
function slotsForAxis2Ordered(axisOrder, partnerHorses) {
  return [[axisOrder[0]], [axisOrder[1]], partnerHorses];
}

// 3連単2頭軸マルチ。
// 軸2頭＋相手1頭について、3頭の全着順を生成。
function generateAxis2Multi(axisHorses, partnerHorses) {
  if (axisHorses.length !== 2 || partnerHorses.length === 0) return [];
  const results = [];
  for (const partner of partnerHorses) {
    const trio = [axisHorses[0], axisHorses[1], partner];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (j === i) continue;
        const k = 3 - i - j;
        results.push([trio[i], trio[j], trio[k]]);
      }
    }
  }
  return dedupeOrdered(results);
}

// 指定した馬を軸にしたマルチ。
// 3連単の1頭軸なら、軸馬＋相手2頭の全着順。
// 1頭軸の相手が3頭以上なら、相手から2頭ずつ選ぶ。
function generateAxis1Multi(axisHorse, partnerHorses) {
  if (axisHorse === undefined || partnerHorses.length < 2) return [];
  const results = [];
  for (let i = 0; i < partnerHorses.length; i++) {
    for (let j = i + 1; j < partnerHorses.length; j++) {
      const trio = [axisHorse, partnerHorses[i], partnerHorses[j]];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          if (a === b) continue;
          const c = 3 - a - b;
          results.push([trio[a], trio[b], trio[c]]);
        }
      }
    }
  }
  return dedupeOrdered(results);
}
