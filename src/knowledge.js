// 全域配方知識庫。
//
// 配方是世界的性質，不因帳號而異——所以這裡的資料跨帳號共用，只標記「是誰、用哪個帳號煉出來的」。
// 每筆以「材料組合」為主鍵，普通與祈禱分軌記錄，失敗也是知識（可以幫你省下體力）。

export const SOURCE = {
  LOCAL: 'local', // 這台瀏覽器實際煉的
  SYNC: 'sync', // 按「更新」從遊戲回填的
  IMPORT: 'import', // 別人分享匯入的
};

/** 材料組合的正規化主鍵：合成兩材料不分先後，萃取只有一個材料 */
export function recipeKey(action, inputs) {
  const list = (inputs || []).filter((w) => typeof w === 'string' && w.length);
  if (action === 'refine') return `refine:${list[0] ?? ''}`;
  return `combine:${[...list].sort().join('|')}`;
}

export function normalizeInputs(action, inputs) {
  const list = (inputs || []).filter((w) => typeof w === 'string' && w.length);
  return action === 'refine' ? list.slice(0, 1) : [...list].sort();
}

function blankArm() {
  return { outcome: null, success: 0, fail: 0, firstTs: null, lastTs: null };
}

function blank(key, action, inputs, ts) {
  return {
    key,
    action,
    inputs,
    result: null,
    emoji: null,
    type: null,
    rarity: null,
    value: null,
    normal: blankArm(), // 沒祈禱的嘗試
    pray: blankArm(), // 祈禱的嘗試
    discoveredBy: null, // { accountId, accountName, finderName, source, ts }
    finders: [], // 遊戲回填的發現者名單
    globalFirst: false,
    sources: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function noteArm(arm, outcome, ts) {
  if (outcome === 'success') {
    arm.success++;
    arm.outcome = 'success'; // 成功一次就永遠是成功
  } else if (outcome === 'fail') {
    arm.fail++;
    if (arm.outcome !== 'success') arm.outcome = 'fail';
  }
  if (arm.firstTs == null || ts < arm.firstTs) arm.firstTs = ts;
  if (arm.lastTs == null || ts > arm.lastTs) arm.lastTs = ts;
  return arm;
}

function addSource(rec, source) {
  if (source && !rec.sources.includes(source)) rec.sources.push(source);
}

/**
 * 把一筆煉製紀錄併進知識庫。
 * 回傳 { key, merge } 給 db.upsertKnowledgeBatch 用。
 */
export function fromAttempt(a, source = SOURCE.LOCAL) {
  const action = a.action === 'refine' ? 'refine' : 'combine';
  const inputs = normalizeInputs(action, a.inputs);
  const key = recipeKey(action, inputs);
  const ts = a.ts || Date.now();
  return {
    key,
    merge(prev) {
      // outcome === 'error' 是伺服器擋下的請求（魔力不足等），沒有真的煉，不算知識
      if (a.outcome !== 'success' && a.outcome !== 'fail') return null;
      if (!inputs.length) return null;
      const rec = prev ? { ...prev } : blank(key, action, inputs, ts);
      rec.normal = { ...(rec.normal || blankArm()) };
      rec.pray = { ...(rec.pray || blankArm()) };
      noteArm(a.prayed ? rec.pray : rec.normal, a.outcome, ts);

      if (a.outcome === 'success' && a.result) {
        rec.result = a.result;
        if (a.emoji) rec.emoji = a.emoji;
        if (a.type) rec.type = a.type;
        if (a.rarity != null) rec.rarity = a.rarity;
        if (a.value != null) rec.value = a.value;
        if (!rec.discoveredBy || ts < (rec.discoveredBy.ts ?? Infinity)) {
          rec.discoveredBy = {
            accountId: a.accountId ?? null,
            accountName: a.accountName ?? null,
            finderName: a.accountName ?? null,
            source,
            ts,
          };
        }
        if (a.isGlobalFirst) rec.globalFirst = true;
      }
      addSource(rec, source);
      rec.updatedAt = Math.max(rec.updatedAt || 0, ts);
      return rec;
    },
  };
}

/**
 * 遊戲 /api/nodes/{word}/recipes 回來的配方列
 * { action, a, aEmoji, b, bEmoji, finderName, prayed }
 * 這代表「這組材料確實煉得出 word」。
 */
export function fromGameRecipe(word, row, opts = {}) {
  const action = row.action === 'refine' ? 'refine' : 'combine';
  const inputs = normalizeInputs(action, action === 'refine' ? [row.a] : [row.a, row.b]);
  const key = recipeKey(action, inputs);
  const ts = opts.ts || Date.now();
  const source = opts.source || SOURCE.SYNC;
  return {
    key,
    merge(prev) {
      if (!inputs.length || !word) return null;
      const rec = prev ? { ...prev } : blank(key, action, inputs, ts);
      rec.normal = { ...(rec.normal || blankArm()) };
      rec.pray = { ...(rec.pray || blankArm()) };
      // 回填的是「已知可成」的事實，不是一次新的嘗試，所以只標結論不累加次數
      const arm = row.prayed ? rec.pray : rec.normal;
      arm.outcome = 'success';
      if (arm.firstTs == null) arm.firstTs = ts;
      arm.lastTs = Math.max(arm.lastTs || 0, ts);

      rec.result = word;
      if (opts.emoji) rec.emoji = opts.emoji;
      if (row.aEmoji || row.bEmoji) rec.inputEmoji = { [row.a]: row.aEmoji, [row.b]: row.bEmoji };
      if (row.finderName && !rec.finders.some((f) => f.name === row.finderName)) {
        rec.finders.push({ name: row.finderName, source });
      }
      if (!rec.discoveredBy) {
        rec.discoveredBy = {
          accountId: opts.accountId ?? null,
          accountName: opts.mine ? opts.accountName ?? null : null,
          finderName: row.finderName ?? null,
          source,
          ts,
        };
      }
      addSource(rec, source);
      rec.updatedAt = Math.max(rec.updatedAt || 0, ts);
      return rec;
    },
  };
}

/**
 * 遊戲 /api/combine-log 的一筆煉製紀錄
 * { action, a, aEmoji, b, bEmoji, resultWord, resultEmoji, failed, prayed, createdAt }
 *
 * 跟 fromGameRecipe 的差別：**這裡會收失敗的紀錄**。
 * 「這組煉不出東西」跟「這組煉得出什麼」一樣是知識，而且更省魔力——
 * 下次要按下去之前就能看到「已知會崩解」。
 */
export function fromGameLogEntry(e, opts = {}) {
  const action = e.action === 'refine' ? 'refine' : 'combine';
  const inputs = normalizeInputs(action, action === 'refine' ? [e.a] : [e.a, e.b]);
  const key = recipeKey(action, inputs);
  const ts = e.createdAt || opts.ts || Date.now();
  const source = opts.source || SOURCE.SYNC;
  const failed = !!e.failed || !e.resultWord;
  return {
    key,
    merge(prev) {
      if (!inputs.length) return null;
      const rec = prev ? { ...prev } : blank(key, action, inputs, ts);
      rec.normal = { ...(rec.normal || blankArm()) };
      rec.pray = { ...(rec.pray || blankArm()) };
      const arm = e.prayed ? rec.pray : rec.normal;
      // 回填的是既成事實，不是一次新的嘗試，所以只標結論不累加次數
      if (failed) {
        if (arm.outcome !== 'success') arm.outcome = 'fail';
      } else {
        arm.outcome = 'success';
      }
      if (arm.firstTs == null || ts < arm.firstTs) arm.firstTs = ts;
      arm.lastTs = Math.max(arm.lastTs || 0, ts);

      if (!failed) {
        rec.result = e.resultWord;
        if (e.resultEmoji) rec.emoji = e.resultEmoji;
        if (e.finderName && !rec.finders.some((f) => f.name === e.finderName)) {
          rec.finders.push({ name: e.finderName, source });
        }
        if (!rec.discoveredBy) {
          rec.discoveredBy = {
            accountId: opts.accountId ?? null,
            accountName: opts.accountName ?? null,
            finderName: e.finderName ?? opts.accountName ?? null,
            source,
            ts,
          };
        }
      }
      addSource(rec, source);
      rec.updatedAt = Math.max(rec.updatedAt || 0, ts);
      return rec;
    },
  };
}

/**
 * 匯入別人的配方表紀錄，跟你既有的那一筆合併。
 *
 * 以「材料組合」為主鍵（材料順序不影響），所以同一組配方不會變成兩筆，而是併進同一筆：
 *   判定    別人成功 → 那一軌就是成功；別人失敗只會在你還沒成功過時才標成失敗
 *   產物    你已經有的不覆蓋（你自己煉到的最準），你沒有的才補上
 *   發現者  時間較早的那個保留
 *   來源    加上「他人分享」，可以在共用配方表頁篩選
 *
 * 嘗試次數會累加，所以畫面上標的是「**一共**嘗試過 N 次」——你的加上所有匯入來源的。
 * 注意：同一份檔案匯入兩次，次數會算兩次（判定不受影響，只是那個數字會偏大）。
 */
export function fromForeignKnowledge(foreign, label) {
  const action = foreign.action === 'refine' ? 'refine' : 'combine';
  const inputs = normalizeInputs(action, foreign.inputs);
  const key = recipeKey(action, inputs);
  return {
    key,
    merge(prev) {
      if (!inputs.length) return null;
      const ts = foreign.updatedAt || foreign.createdAt || Date.now();
      const rec = prev ? { ...prev } : blank(key, action, inputs, ts);
      for (const armName of ['normal', 'pray']) {
        const mine = { ...(rec[armName] || blankArm()) };
        const theirs = foreign[armName] || blankArm();
        mine.success += theirs.success || 0;
        mine.fail += theirs.fail || 0;
        if (theirs.outcome === 'success') mine.outcome = 'success';
        else if (theirs.outcome === 'fail' && mine.outcome !== 'success') mine.outcome = 'fail';
        if (theirs.firstTs && (mine.firstTs == null || theirs.firstTs < mine.firstTs)) mine.firstTs = theirs.firstTs;
        if (theirs.lastTs && (mine.lastTs == null || theirs.lastTs > mine.lastTs)) mine.lastTs = theirs.lastTs;
        rec[armName] = mine;
      }
      if (!rec.result && foreign.result) rec.result = foreign.result;
      if (!rec.emoji && foreign.emoji) rec.emoji = foreign.emoji;
      if (!rec.type && foreign.type) rec.type = foreign.type;
      if (rec.rarity == null && foreign.rarity != null) rec.rarity = foreign.rarity;
      for (const f of foreign.finders || []) {
        if (!rec.finders.some((x) => x.name === f.name)) rec.finders.push({ ...f, source: SOURCE.IMPORT });
      }
      const theirFinder = foreign.discoveredBy;
      if (theirFinder && (!rec.discoveredBy || (theirFinder.ts ?? Infinity) < (rec.discoveredBy.ts ?? Infinity))) {
        rec.discoveredBy = {
          accountId: null, // 別人的帳號 id 對我沒意義，只留名字
          accountName: theirFinder.accountName || theirFinder.finderName || label || null,
          finderName: theirFinder.finderName || theirFinder.accountName || label || null,
          source: SOURCE.IMPORT,
          ts: theirFinder.ts ?? ts,
        };
      }
      if (foreign.globalFirst) rec.globalFirst = true;
      addSource(rec, SOURCE.IMPORT);
      rec.updatedAt = Math.max(rec.updatedAt || 0, ts);
      return rec;
    },
  };
}

/**
 * 查一組材料的已知結果。
 * status:
 *   success     普通煉就會成功
 *   pray-only   普通已知崩解，祈禱可成
 *   pray-known  只有祈禱的成功紀錄（普通沒人試過）
 *   fail        普通崩解，祈禱還沒人試
 *   dead        普通與祈禱都崩解過
 *   unknown     知識庫裡沒有這組
 */
export function predict(rec) {
  // 查無此組合時也要回傳完整形狀，呼叫端才能無條件讀 normal / pray
  if (!rec) {
    return {
      status: 'unknown',
      result: null,
      emoji: null,
      type: null,
      rarity: null,
      normal: blankArm(),
      pray: blankArm(),
      discoveredBy: null,
      finders: [],
      globalFirst: false,
      sources: [],
      record: null,
    };
  }
  const n = rec.normal || blankArm();
  const p = rec.pray || blankArm();
  let status;
  if (n.outcome === 'success') status = 'success';
  else if (n.outcome === 'fail' && p.outcome === 'success') status = 'pray-only';
  else if (n.outcome === 'fail' && p.outcome === 'fail') status = 'dead';
  else if (n.outcome === 'fail') status = 'fail';
  else if (p.outcome === 'success') status = 'pray-known';
  else if (p.outcome === 'fail') status = 'fail';
  else status = 'unknown';
  return {
    status,
    result: rec.result,
    emoji: rec.emoji,
    type: rec.type,
    rarity: rec.rarity,
    normal: n,
    pray: p,
    discoveredBy: rec.discoveredBy,
    finders: rec.finders || [],
    globalFirst: !!rec.globalFirst,
    sources: rec.sources || [],
    record: rec,
  };
}

export const PREDICT_LABEL = {
  success: '已知可成',
  'pray-only': '普通會崩解，祈禱可成',
  'pray-known': '祈禱煉得出來',
  fail: '已知會崩解',
  dead: '普通與祈禱都失敗過',
  unknown: '尚無紀錄',
};

/** 把整份 attempts 重建成共用配方表（v1 升級或手動重建時用） */
export function rebuildEntries(attempts) {
  return attempts
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((a) => fromAttempt(a, a.source || SOURCE.LOCAL));
}

/** 共用配方表 → result 對應的配方清單（給規劃器用） */
export function recipesByResult(knowledge) {
  const map = new Map();
  for (const rec of knowledge) {
    if (!rec.result) continue;
    const ok = (rec.normal && rec.normal.outcome === 'success') || (rec.pray && rec.pray.outcome === 'success');
    if (!ok) continue;
    if (rec.inputs.includes(rec.result)) continue; // 退化配方不能當來源
    if (!map.has(rec.result)) map.set(rec.result, []);
    const needsPray = !(rec.normal && rec.normal.outcome === 'success');
    map.get(rec.result).push({
      key: rec.key,
      action: rec.action,
      inputs: rec.inputs,
      result: rec.result,
      emoji: rec.emoji,
      rarity: rec.rarity,
      needsPray,
      prayed: needsPray, // analysis.js 的樹狀圖用這個欄位標記
      discoveredBy: rec.discoveredBy,
      globalFirst: !!rec.globalFirst,
      sources: rec.sources || [],
      ts: rec.updatedAt || rec.createdAt || 0,
      firstTs: (rec.normal && rec.normal.firstTs) || (rec.pray && rec.pray.firstTs) || rec.createdAt || 0,
    });
  }
  return map;
}
