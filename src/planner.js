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
 * 小根堆。原本是每次結算都線性掃過整個候選陣列找成本最低的那條，
 * 那是 O(候選數) × O(結算次數)，等於配方數的平方——五萬條配方要跑八秒多。
 * 換成堆之後是 O(配方數 × log 配方數)。
 *
 * 同成本時比 seq（進來的順序），維持跟舊版一樣「先就緒的先贏」，
 * 免得同樣好的兩條路每次選到不同條。
 */
function makeHeap(cmp) {
  const a = [];
  const less = (x, y) => cmp(x, y) - 0 || x.seq - y.seq;
  const swap = (i, j) => {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  };
  return {
    get size() {
      return a.length;
    },
    push(v) {
      a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (less(a[i], a[p]) >= 0) break;
        swap(i, p);
        i = p;
      }
    },
    pop() {
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && less(a[l], a[m]) < 0) m = l;
          if (r < a.length && less(a[r], a[m]) < 0) m = r;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
      return top;
    },
  };
}

/**
 * 從持有物出發，算出每個造物的最低成本路徑。
 * @param {Set<string>} owned 目前持有（含五原質）
 * @param {Map<string, Array>} byResult knowledge.recipesByResult() 的輸出
 * @param {string} mode 'steps' | 'missing'
 * @returns {Map<string, {steps:Set, missing:Set, recipe:object|null, kind:string}>}
 * 產品端只透過 plan() 使用；獨立匯出是為了讓測試能直接驗這顆引擎。
 *
 * 注意這是**啟發式**，不是最佳解。成本算的是「路徑上用到的造物集合大小」——
 * 共用的中間產物只算一次，這種非加法的成本讓 Dijkstra 的最佳性保證失效
 * （這個問題等價於 directed Steiner tree，NP-hard）。plan() 會再跑一次
 * 局部搜尋把明顯的浪費修掉。
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
  const ready = makeHeap(cmp);
  let seq = 0;

  function pushReady(r) {
    if (settled.has(r.result)) return;
    const parts = r.distinct.map((w) => settled.get(w));
    if (parts.some((p) => !p)) return;
    const steps = union(parts.map((p) => p.steps));
    steps.add(r.result);
    ready.push({ steps, missing: union(parts.map((p) => p.missing)), recipe: r, kind: 'craft', seq: seq++ });
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
  while (ready.size && guard++ < maxRounds) {
    const best = ready.pop();
    // 已經被更便宜的配方結算掉了就跳過（堆裡的舊項目留著不刪，取出來再判斷比較快）
    if (settled.has(best.recipe.result)) continue;
    settle(best.recipe.result, best);
  }

  return settled;
}

// ── solve 的快取 ────────────────────────────────────────
//
// solve() 會把整份配方表算完，五萬條配方要 0.4 秒；但同一份配方表＋同一個素材櫃
// 問幾十個目標，答案是同一份，沒必要每次重算。
//
// 以 byResult 與 owned 這兩個**容器本身**當鍵：儀表板每次資料變動都是重建一個新的
// Map／Set，識別碼一換就等於自動失效，不必手動管理，WeakMap 也不會漏記憶體。
// ⚠ 反過來說，**就地修改**同一個 Map／Set 不會讓快取失效——要換資料請重建。
const solveCache = new WeakMap();

function cachedSolve(ownedSet, byResult, mode) {
  let byOwned = solveCache.get(byResult);
  if (!byOwned) {
    byOwned = new WeakMap();
    solveCache.set(byResult, byOwned);
  }
  let byMode = byOwned.get(ownedSet);
  if (!byMode) {
    byMode = new Map();
    byOwned.set(ownedSet, byMode);
  }
  if (!byMode.has(mode)) byMode.set(mode, solve(ownedSet, byResult, mode));
  return byMode.get(mode);
}

/** 照著 chosen（造物 → 配方；沒指定就用 solve 選的那條）從目標往下展開 */
function collect(target, chosen, settled) {
  const needed = new Map();
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
    const r = chosen.get(w) || e.recipe;
    if (!r) {
      missing.add(w);
      continue;
    }
    needed.set(w, r);
    for (const inp of r.inputs) stack.push(inp);
  }
  return { needed, missing, usedOwned };
}

/**
 * 局部搜尋：貪婪結算完之後，逐一問「這個造物改用另一條配方，總步數會不會變少？」
 *
 * 貪婪最常漏掉的就是「另一條配方用的材料，我本來就要煉」——那條路實際上是免費的，
 * 但結算當下看不出來。只接受**嚴格更好**的換法，所以結果不可能比原本差。
 * 實測平均少 5% 步數，每次查詢不到 1 毫秒。
 */
const EVAL_BUDGET = 4000; // 展開次數上限，免得配方多又深的目標算太久

function refine(target, settled, byResult, mode, rounds = 4) {
  const worse =
    mode === 'missing'
      ? (a, b) => a.missing.size - b.missing.size || a.needed.size - b.needed.size
      : (a, b) => a.needed.size - b.needed.size || a.missing.size - b.missing.size;

  const chosen = new Map();
  let cur = collect(target, chosen, settled);
  let evals = 0;
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (const w of [...cur.needed.keys()]) {
      const list = byResult.get(w) || [];
      if (list.length < 2) continue;
      const now = cur.needed.get(w);
      for (const alt of list) {
        if (alt === now || evals >= EVAL_BUDGET) continue;
        chosen.set(w, alt);
        evals++;
        const next = collect(target, chosen, settled);
        // next.needed 還留著 w 才算數：換完就把自己弄不見的那種不是改良，是走岔了
        if (next.needed.has(w) && worse(next, cur) < 0) {
          cur = next;
          improved = true;
        } else if (now) {
          chosen.set(w, now);
        } else {
          chosen.delete(w);
        }
      }
    }
    if (!improved || evals >= EVAL_BUDGET) break;
  }
  return cur;
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
  const settled = cachedSolve(ownedSet, byResult, mode);
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

  // 從目標往回收集要動手煉的節點，再跑一次局部搜尋把貪婪漏掉的共用撿回來
  const { needed, missing, usedOwned } = refine(target, settled, byResult, mode);

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
          // key 一定要帶：畫路徑樹的人要靠它認出「這一步用的是哪一條配方」，
          // 少了它樹就只能照全域最短深度自己挑，跟這裡算出來的路徑對不起來
          key: recipe.key,
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
