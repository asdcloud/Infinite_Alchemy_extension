// 族譜與深度：把配方表當成一張圖，回答「這東西是從什麼一路煉上來的」。
//
// 輸入的 recipes 是 knowledge.recipesByResult() 的輸出（result → 配方陣列），
// 所以這裡看到的永遠是跨帳號共用的那份配方表。

export const PRIMORDIALS = ['水', '火', '土', '風', '雷'];
const PRIMORDIAL_SET = new Set(PRIMORDIALS);

/**
 * 以定點迭代算出每個造物的最短煉製深度（避免配方互相循環時無限遞迴）。
 * 深度 = 從五原質（或來源不明的葉節點）算起的最長鏈長度。
 */
export function computeDepths(recipes) {
  const depth = new Map();
  const best = new Map();
  for (const w of PRIMORDIALS) depth.set(w, 0);

  const leafDepth = (w) => {
    if (depth.has(w)) return depth.get(w);
    if (!recipes.has(w)) return 0; // 來源不明（市集買的、活動送的、紀錄前就有的）
    return Infinity;
  };

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const [word, list] of recipes) {
      if (PRIMORDIAL_SET.has(word)) continue;
      let bestDepth = Infinity;
      let bestRecipe = null;
      for (const r of list) {
        let d = 0;
        for (const inp of r.inputs) d = Math.max(d, leafDepth(inp));
        if (d === Infinity) continue;
        d += 1;
        if (d < bestDepth) {
          bestDepth = d;
          bestRecipe = r;
        }
      }
      const cur = depth.has(word) ? depth.get(word) : Infinity;
      if (bestDepth < cur) {
        depth.set(word, bestDepth);
        best.set(word, bestRecipe);
        changed = true;
      }
    }
  }
  return { depth, best };
}

export function classify(word, recipes) {
  if (PRIMORDIAL_SET.has(word)) return 'primordial';
  if (recipes.has(word)) return 'crafted';
  return 'unknown';
}

/**
 * 展開某個造物的族譜樹（帶循環保護）。
 * opts.stopAt 是「已經有了、不必再往下追」的造物集合——傳入持有物就會停在你手上的東西，
 * 這樣樹畫出來的就跟規劃器算出來的路徑一致。
 * opts.missing 是規劃器判定「要自己想辦法弄到」的造物——包含沒人煉得出來的，
 * 也包含被拆環拆掉的（有配方，但那條會繞回目標）。兩者在這條路上都是葉節點。
 */
export function buildTree(word, recipes, best, opts = {}, seen = new Set()) {
  const leaf = (kind) => ({ word, kind, children: [], recipe: null, alternatives: 0, cycle: false });
  const stopAt = opts.stopAt;
  if (stopAt && stopAt.has(word) && seen.size > 0) {
    // 根節點不停（不然查自己已有的東西會什麼都看不到）
    return leaf('owned');
  }
  if (opts.missing && opts.missing.has(word) && seen.size > 0) return leaf('unknown');
  const kind = classify(word, recipes);
  const node = { word, kind, children: [], recipe: null, alternatives: 0, cycle: false };
  if (kind !== 'crafted') return node;
  if (seen.has(word)) {
    node.cycle = true;
    return node;
  }
  // best 只收得到「深度算得出來」的造物；算不出深度就代表它的每一條配方
  // 最後都會繞回自己，等於煉不出來。
  //
  // 這裡以前會退而求其次拿 recipes 的第一條，結果就是直接畫出一條繞回自己的環——
  // 那種路徑照著做不出來，不如當它不存在。
  const r = best.get(word);
  if (!r) {
    node.kind = 'unreachable';
    return node;
  }
  node.recipe = r;
  node.alternatives = Math.max(0, (recipes.get(word) || []).length - 1);
  const nextSeen = new Set(seen);
  nextSeen.add(word);
  node.children = r.inputs.map((inp) => buildTree(inp, recipes, best, opts, nextSeen));
  return node;
}
