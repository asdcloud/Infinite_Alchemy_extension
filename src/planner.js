// 合成路徑規劃器。
//
// 這是一張 AND/OR 圖（要煉出 X，必須「同時」擁有 A 和 B），用 Dijkstra 的方式由已持有的東西
// 往外擴散，每次結算「目前成本最低、且材料都已就緒」的那條配方。
//
// 成本是兩個數字：
//   missing = 路上需要用到、但你既沒有也煉不出來的材料數（要去市集買或等人發現）
//   steps   = 需要動手煉幾次
// 兩種模式只差在誰優先：
//   'steps'   最短路徑——步數少優先，允許用到你沒有的材料
//   'missing' 最少未知——盡量只用你手上有的東西，寧可多煉幾步

// 五原質只定義一次，其他模組一律從這裡拿
export { PRIMORDIALS } from './analysis.js';

function cmpBy(mode) {
  return mode === 'missing'
    ? (a, b) => a.missing.size - b.missing.size || a.steps.size - b.steps.size
    : (a, b) => a.steps.size - b.steps.size || a.missing.size - b.missing.size;
}

function union(sets) {
  const out = new Set();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

/**
 * 從持有物出發，算出每個造物的最低成本路徑。
 * @param {Set<string>} owned 目前持有（含五原質）
 * @param {Map<string, Array>} byResult knowledge.recipesByResult() 的輸出
 * @param {string} mode 'steps' | 'missing'
 * @returns {Map<string, {steps:Set, missing:Set, recipe:object|null, kind:string}>}
 * 產品端只透過 plan() 使用；獨立匯出是為了讓測試能直接驗這顆引擎。
 */
export function solve(owned, byResult, mode = 'steps') {
  const cmp = cmpBy(mode);
  const settled = new Map();

  // 材料 → 用得到它的配方（同一配方裡重複的材料只登記一次，「水＋水」才不會少算）
  const usedBy = new Map();
  const universe = new Set();
  const allRecipes = [];
  for (const [result, list] of byResult) {
    universe.add(result);
    for (const r of list) {
      const distinct = [...new Set(r.inputs)];
      const entry = { ...r, distinct };
      allRecipes.push(entry);
      for (const inp of distinct) {
        universe.add(inp);
        if (!usedBy.has(inp)) usedBy.set(inp, []);
        usedBy.get(inp).push(entry);
      }
    }
  }
  for (const w of owned) universe.add(w);

  const pending = new Map(); // 配方 → 還沒就緒的材料數
  for (const r of allRecipes) pending.set(r, r.distinct.length);

  // ready 裡直接存算好的成本：配方就緒的當下，所有材料都已結算且不會再變，
  // 成本因此是固定的，只需要算一次。
  const ready = [];

  function pushReady(r) {
    if (settled.has(r.result)) return;
    const parts = r.distinct.map((w) => settled.get(w));
    if (parts.some((p) => !p)) return;
    const steps = union(parts.map((p) => p.steps));
    steps.add(r.result);
    ready.push({ steps, missing: union(parts.map((p) => p.missing)), recipe: r, kind: 'craft' });
  }

  function settle(word, entry) {
    if (settled.has(word)) return;
    settled.set(word, entry);
    for (const r of usedBy.get(word) || []) {
      const left = pending.get(r);
      if (left == null) continue;
      const n = left - 1;
      pending.set(r, n);
      if (n === 0) pushReady(r);
    }
  }

  // 起點：持有物成本為零
  for (const w of owned) settle(w, { steps: new Set(), missing: new Set(), recipe: null, kind: 'owned' });
  // 沒有任何已知配方、又不在手上的材料 → 缺料葉節點（要去市集買或等人發現）
  for (const w of universe) {
    if (settled.has(w) || byResult.has(w)) continue;
    settle(w, { steps: new Set(), missing: new Set([w]), recipe: null, kind: 'missing' });
  }

  let guard = 0;
  const maxRounds = universe.size + allRecipes.length + 1000;
  while (ready.length && guard++ < maxRounds) {
    let bestIdx = -1;
    for (let i = 0; i < ready.length; i++) {
      if (settled.has(ready[i].recipe.result)) {
        // 已經被更便宜的配方結算掉了，原地移除
        ready[i] = ready[ready.length - 1];
        ready.pop();
        i--;
        continue;
      }
      if (bestIdx < 0 || cmp(ready[i], ready[bestIdx]) < 0) bestIdx = i;
    }
    if (bestIdx < 0) break;
    const best = ready[bestIdx];
    ready[bestIdx] = ready[ready.length - 1];
    ready.pop();
    settle(best.recipe.result, best);
  }

  return settled;
}

/**
 * 針對單一目標產出可執行的步驟表。
 * 回傳 { ok, target, mode, steps[], stepCount, missing[], usedOwned[], needsPray }
 */
export function plan(target, owned, byResult, mode = 'steps') {
  const ownedSet = owned instanceof Set ? owned : new Set(owned);
  if (ownedSet.has(target)) {
    return { ok: true, target, mode, steps: [], stepCount: 0, missing: [], usedOwned: [target], alreadyOwned: true };
  }
  const settled = solve(ownedSet, byResult, mode);
  const entry = settled.get(target);
  if (!entry || entry.kind === 'missing') {
    return {
      ok: false,
      target,
      mode,
      steps: [],
      stepCount: 0,
      missing: entry ? [...entry.missing] : [target],
      usedOwned: [],
      reason: byResult.has(target) ? '共用配方表裡的配方湊不齊材料' : '共用配方表裡還沒有這個造物的配方',
    };
  }

  // 從目標往回收集需要動手煉的節點
  const needed = new Map(); // word → recipe
  const missing = new Set();
  const usedOwned = new Set();
  const stack = [target];
  const seen = new Set();
  while (stack.length) {
    const w = stack.pop();
    if (seen.has(w)) continue;
    seen.add(w);
    const e = settled.get(w);
    if (!e) {
      missing.add(w);
      continue;
    }
    if (e.kind === 'owned') {
      usedOwned.add(w);
      continue;
    }
    if (e.kind === 'missing') {
      missing.add(w);
      continue;
    }
    needed.set(w, e.recipe);
    for (const inp of e.recipe.inputs) stack.push(inp);
  }

  // 拓撲排序：材料都備妥的步驟先做
  const have = new Set([...usedOwned, ...missing]);
  const steps = [];
  const remaining = new Map(needed);
  let guard = 0;
  while (remaining.size && guard++ < needed.size + 5) {
    let progressed = false;
    for (const [word, recipe] of [...remaining]) {
      if (recipe.inputs.every((i) => have.has(i))) {
        steps.push({
          action: recipe.action,
          inputs: recipe.inputs,
          result: word,
          emoji: recipe.emoji,
          needsPray: !!recipe.needsPray,
          discoveredBy: recipe.discoveredBy || null,
        });
        have.add(word);
        remaining.delete(word);
        progressed = true;
      }
    }
    if (!progressed) break; // 理論上不會發生（circular），保險
  }
  for (const [word, recipe] of remaining) {
    steps.push({
      action: recipe.action,
      inputs: recipe.inputs,
      result: word,
      emoji: recipe.emoji,
      needsPray: !!recipe.needsPray,
      discoveredBy: recipe.discoveredBy || null,
      unresolved: true,
    });
  }

  return {
    ok: missing.size === 0,
    target,
    mode,
    steps,
    stepCount: steps.length,
    missing: [...missing],
    usedOwned: [...usedOwned],
    needsPray: steps.some((s) => s.needsPray),
  };
}

/**
 * 拿手上的材料兩兩配對，找出共用配方表裡「已知會成功、但你還沒擁有那個產物」的組合。
 * 這是省體力的重點：直接照著煉，不用亂試。
 */
export function knownCombosFromOwned(owned, knowledge, limit = 500) {
  const ownedSet = owned instanceof Set ? owned : new Set(owned);
  const out = [];
  for (const rec of knowledge) {
    if (!rec.result || ownedSet.has(rec.result)) continue;
    const ok = (rec.normal && rec.normal.outcome === 'success') || (rec.pray && rec.pray.outcome === 'success');
    if (!ok) continue;
    if (!rec.inputs.every((i) => ownedSet.has(i))) continue;
    out.push({
      key: rec.key,
      action: rec.action,
      inputs: rec.inputs,
      result: rec.result,
      emoji: rec.emoji,
      rarity: rec.rarity,
      needsPray: !(rec.normal && rec.normal.outcome === 'success'),
      discoveredBy: rec.discoveredBy,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => Number(a.needsPray) - Number(b.needsPray) || (b.rarity || 0) - (a.rarity || 0));
  return out;
}
