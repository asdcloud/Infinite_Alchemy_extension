// Service worker：把 content script 轉來的事件正規化後寫進 IndexedDB，並負責「更新」同步的調度。
import {
  addAttempt,
  allAttempts,
  getMeta,
  setMeta,
  upsertKnowledgeBatch,
  clearKnowledge,
  countKnowledge,
  getInventory,
  putInventory,
  getAccountState,
  putAccountState,
  getKnowledge,
  allGoals,
  getGoal,
  putGoal,
  deleteGoal,
  wipeAll,
} from './db.js';
import {
  fromAttempt,
  fromGameRecipe,
  fromGameLogEntry,
  fromForeignKnowledge,
  rebuildEntries,
  recipeKey,
  normalizeInputs,
  predict,
  SOURCE,
} from './knowledge.js';
import { PRIMORDIALS } from './analysis.js';
import { RELEASE_API, RELEASE_PAGE, isNewer, parseRelease } from './update.js';

const GAME_ORIGIN = 'https://pillars-of-creation.funtuan.work';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const fromGame = !!(sender && sender.url && sender.url.startsWith(GAME_ORIGIN));
  const fromSelf = !!(sender && sender.id === chrome.runtime.id);

  let job = null;
  switch (msg.type) {
    case 'ia-event':
      if (!fromGame) return;
      job = handleEvent(msg.payload);
      break;
    case 'ia-sync-data':
      if (!fromGame) return;
      job = handleSyncData(msg);
      break;
    case 'ia-sync-progress':
      if (!fromGame) return;
      job = handleSyncProgress(msg);
      break;
    case 'ia-cmd':
      if (!fromSelf) return;
      // content script 不知道自己的 tabId，由這裡從 sender 補上（租約要用）
      job = handleCommand({ ...msg, tabId: sender && sender.tab ? sender.tab.id : null });
      break;
    default:
      return;
  }
  job.then((r) => sendResponse(r || { ok: true })).catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // 非同步回覆
});

// ── 事件分派 ───────────────────────────────────────────
async function handleEvent(payload) {
  if (!payload || !payload.kind) return { ok: true, skipped: true };
  switch (payload.kind) {
    case 'attempt':
      return handleAttempt(payload);
    case 'me':
      return handleMe(payload);
    case 'discoveries':
      return handleDiscoveries(payload);
    case 'discoveries-delete':
      return handleDiscoveriesDelete(payload);
    case 'seeds':
      return handleSeeds(payload);
    case 'node-recipes':
      return learnRecipes(payload.param, payload.res && payload.res.recipes, {
        ts: payload.ts,
        source: SOURCE.SYNC,
        mine: /\/recipes\/mine/.test(payload.url || ''),
      });
    case 'node':
      return learnFromNode(payload);
    case 'combine-log':
      return learnFromLog(payload);
    default:
      return { ok: true, skipped: true };
  }
}

// ── 帳號 ───────────────────────────────────────────────
// /api/me 回傳 { id, name, loggedIn, isGuest, stamina, balance, soul, bagUsed, bagLimit, ... }
// id 才是穩定識別（名號可在工坊設定改，PATCH /me），所以一律以 id 分帳號。
async function handleMe(ev) {
  const me = ev.res || {};
  const id = me.id ?? null;
  const account = {
    id,
    name: typeof me.name === 'string' && me.name.trim() ? me.name.trim() : null,
    isGuest: !!me.isGuest,
    loggedIn: me.loggedIn !== false,
    seenAt: ev.ts,
  };
  if (id != null || account.name) {
    await setMeta('account', account);
    const book = (await getMeta('accounts', null)) || {};
    const key = String(id ?? `name:${account.name}`);
    const prevEntry = book[key] || { names: [] };
    const names = prevEntry.names || [];
    if (account.name && names[names.length - 1] !== account.name) names.push(account.name);
    book[key] = {
      id,
      name: account.name || prevEntry.name || null,
      names,
      isGuest: account.isGuest,
      firstSeen: prevEntry.firstSeen ?? ev.ts,
      lastSeen: ev.ts,
    };
    await setMeta('accounts', book);
  }
  if (me.stamina && typeof me.stamina.value === 'number') {
    await setStamina(id, { value: me.stamina.value, cap: me.stamina.cap ?? null, ts: ev.ts });
  }
  // 金錢／體力／素材櫃是帳號自己的狀態
  await mergeAccountState(id, {
    name: account.name,
    isGuest: account.isGuest,
    balance: me.balance ?? null,
    soul: me.soul ?? null,
    stamina: me.stamina ?? null,
    bagUsed: me.bagUsed ?? null,
    bagLimit: me.bagLimit ?? null,
    updatedAt: ev.ts,
  });
  return { ok: true };
}

async function mergeAccountState(accountId, patch) {
  const key = String(accountId ?? 'unknown');
  const prev = (await getAccountState(key)) || { accountId: key };
  await putAccountState({ ...prev, ...patch, accountId: key });
}

// 魔力基準必須跟著帳號走，否則切帳號後前後相減會算出假的消耗量
async function getStamina(accountId) {
  const all = (await getMeta('staminaByAccount', null)) || {};
  return all[String(accountId ?? 'unknown')] || null;
}

async function setStamina(accountId, value) {
  const all = (await getMeta('staminaByAccount', null)) || {};
  all[String(accountId ?? 'unknown')] = value;
  await setMeta('staminaByAccount', all);
}

// ── 煉製 ───────────────────────────────────────────────
async function handleAttempt(ev) {
  const isRefine = /\/api\/refine/.test(ev.url || '');
  const req = ev.req || {};
  const res = ev.res || {};
  const node = res.node || null;

  const inputs = (isRefine ? [req.word] : [req.a, req.b]).filter(
    (w) => typeof w === 'string' && w.length > 0
  );

  // success 煉成造物 / fail 崩解（有扣魔力的正常失敗）/ error HTTP 錯誤（魔力不足、素材櫃滿…）
  let outcome;
  if (!ev.ok) outcome = 'error';
  else if (res.failed) outcome = 'fail';
  else if (node && node.word) outcome = 'success';
  else outcome = 'fail';

  const pairKey = isRefine
    ? `refine:${inputs[0] ?? ''}`
    : `combine:${[...inputs].sort().join(' | ')}`;

  const account = (await getMeta('account', null)) || {};

  // 魔力消耗：回應會帶新的 stamina，跟同一帳號上一次已知值相減推回本次花費。
  let manaSpent = null;
  const prev = await getStamina(account.id);
  const now = res.stamina && typeof res.stamina.value === 'number' ? res.stamina : null;
  if (now && prev && typeof prev.value === 'number' && prev.value >= now.value) {
    manaSpent = prev.value - now.value;
  }
  if (now) await setStamina(account.id, { value: now.value, cap: now.cap ?? null, ts: ev.ts });

  const record = {
    ts: ev.ts || Date.now(),
    dur: ev.dur ?? null,
    action: isRefine ? 'refine' : 'combine',
    inputs,
    pairKey,
    prayed: !!(req.pray || res.prayed),
    prayReq: !!req.pray,
    prayRes: !!res.prayed,
    outcome,
    result: node && node.word ? node.word : null,
    emoji: node ? node.emoji ?? null : null,
    type: node ? node.type ?? null : null,
    value: node ? node.value ?? null : null,
    rarity: node ? node.rarity ?? null : null,
    tier: node ? node.tier ?? null : null,
    recipeCount: node ? node.recipeCount ?? null : null,
    isNewDiscovery: !!res.isNewDiscovery,
    isGlobalFirst: !!res.isGlobalFirst,
    reward: res.reward ?? 0,
    reason: res.reason ?? res.error ?? null,
    stamina: now,
    manaSpent,
    status: ev.status ?? null,
    accountId: account.id ?? null,
    accountName: account.name ?? null,
    accountIsGuest: !!account.isGuest,
    source: SOURCE.LOCAL,
    raw: { req, res }, // 保留原始回應，之後遊戲加欄位也不會漏
  };

  await addAttempt(record);
  if (historyIndex) historyIndex.add(attemptFingerprint(record)); // 之後補歷史時才不會重複
  // 配方是全域知識，不分帳號；只記下是誰煉出來的
  await upsertKnowledgeBatch([fromAttempt(record, SOURCE.LOCAL)]);
  // 煉成的造物會進素材櫃
  let pathTicked = 0;
  if (outcome === 'success' && record.result) {
    await addToInventory(account.id, [{ word: record.result, emoji: record.emoji, type: record.type, rarity: record.rarity, value: record.value }], ev.ts);
    // 你真的照著待煉路徑煉了這一步 → 自動把它從清單上拿掉
    const ticked = await tickPathStep(recipeKey(record.action, normalizeInputs(record.action, inputs)));
    pathTicked = ticked.changed;
  }
  refreshBadge(await bumpToday(record.ts, record.accountId));
  return { ok: true, pathTicked };
}

// ── 持有物 ─────────────────────────────────────────────
function nodeBrief(n) {
  if (typeof n === 'string') return { word: n };
  if (!n || typeof n.word !== 'string') return null;
  return {
    word: n.word,
    emoji: n.emoji ?? null,
    type: n.type ?? null,
    rarity: n.rarity ?? null,
    value: n.value ?? null,
  };
}

/** 完整快照覆蓋（/api/me/discoveries 是素材櫃的全部內容） */
async function snapshotInventory(accountId, nodes, ts) {
  const key = String(accountId ?? 'unknown');
  const items = {};
  for (const n of nodes || []) {
    const b = nodeBrief(n);
    if (b) items[b.word] = b;
  }
  const prev = (await getInventory(key)) || {};
  // 五原質即使不在 discoveries 裡也一定拿得到
  for (const w of PRIMORDIALS) if (!items[w]) items[w] = { word: w };
  await putInventory({
    accountId: key,
    items,
    count: Object.keys(items).length,
    snapshotAt: ts,
    updatedAt: ts,
    firstSeen: prev.firstSeen ?? ts,
  });
  return Object.keys(items).length;
}

async function addToInventory(accountId, nodes, ts) {
  const key = String(accountId ?? 'unknown');
  const inv = (await getInventory(key)) || { accountId: key, items: {}, firstSeen: ts };
  const items = inv.items || {};
  for (const n of nodes || []) {
    const b = nodeBrief(n);
    if (b) items[b.word] = { ...(items[b.word] || {}), ...b };
  }
  await putInventory({ ...inv, accountId: key, items, count: Object.keys(items).length, updatedAt: ts });
}

async function removeFromInventory(accountId, words, ts) {
  const key = String(accountId ?? 'unknown');
  const inv = await getInventory(key);
  if (!inv || !inv.items) return;
  for (const w of words || []) delete inv.items[w];
  await putInventory({ ...inv, count: Object.keys(inv.items).length, updatedAt: ts });
}

async function handleDiscoveries(ev) {
  const account = (await getMeta('account', null)) || {};
  const nodes = (ev.res && (ev.res.nodes || ev.res.items)) || [];
  const n = await snapshotInventory(account.id, nodes, ev.ts);
  await mergeAccountState(account.id, { inventoryCount: n, inventoryAt: ev.ts });
  return { ok: true, count: n };
}

async function handleDiscoveriesDelete(ev) {
  const account = (await getMeta('account', null)) || {};
  const words = (ev.req && ev.req.words) || [];
  await removeFromInventory(account.id, words, ev.ts);
  return { ok: true, removed: words.length };
}

/**
 * /api/me/inventions → { inventions: [...] }
 * 這是「世上創生」——全世界第一個煉出這個造物的人是你，也就是真正的「全服首煉」。
 * 跟 /me/recipes（新配方＝第一個找到這條做法）是兩回事。
 */
async function handleInventions(ev) {
  const account = (await getMeta('account', null)) || {};
  const nodes = (ev.res && (ev.res.inventions || ev.res.nodes || ev.res.items)) || [];
  const words = nodes.map((n) => (typeof n === 'string' ? n : n && n.word)).filter(Boolean);
  await mergeAccountState(account.id, { inventions: words, inventionsAt: ev.ts });
  return { ok: true, count: words.length };
}

async function handleSeeds(ev) {
  const account = (await getMeta('account', null)) || {};
  const seeds = (ev.res && ev.res.seeds) || [];
  await addToInventory(account.id, seeds, ev.ts);
  return { ok: true };
}

// ── 知識庫回填 ─────────────────────────────────────────
async function learnRecipes(word, recipes, opts = {}) {
  if (!word || !Array.isArray(recipes) || !recipes.length) return { ok: true, learned: 0 };
  const account = (await getMeta('account', null)) || {};
  const entries = recipes
    .filter((r) => r && (r.a || r.b))
    .map((r) =>
      fromGameRecipe(word, r, {
        ts: opts.ts || Date.now(),
        source: opts.source || SOURCE.SYNC,
        mine: !!opts.mine,
        accountId: account.id ?? null,
        accountName: account.name ?? null,
        emoji: opts.emoji ?? null,
      })
    );
  const n = await upsertKnowledgeBatch(entries);
  return { ok: true, learned: n };
}

async function learnFromNode(ev) {
  const node = (ev.res && ev.res.node) || null;
  if (!node) return { ok: true, learned: 0 };
  const word = node.word || ev.param;
  const rows = [];
  if (node.latestRecipe) rows.push(node.latestRecipe);
  return learnRecipes(word, rows, { ts: ev.ts, source: SOURCE.SYNC, emoji: node.emoji ?? null });
}

/**
 * /api/combine-log → 這個帳號的煉製紀錄，**成功與失敗都收**。
 * 「這組會崩解」跟「這組煉得出什麼」一樣是知識，而且更省魔力。
 */
async function learnFromLog(ev) {
  const entries = (ev.res && ev.res.entries) || [];
  const account = (await getMeta('account', null)) || {};
  const syncTs = ev.ts || Date.now();
  const batch = [];
  const history = [];
  let failures = 0;
  for (const e of entries) {
    if (!e || !e.a) continue;
    const failed = !!e.failed || !e.resultWord;
    if (failed) failures++;
    batch.push(
      fromGameLogEntry(e, {
        ts: syncTs,
        source: SOURCE.SYNC,
        accountId: account.id ?? null,
        accountName: account.name ?? null,
      })
    );
    // 同一筆也是「我煉過這個」的事實 → 進軌跡
    const rec = makeHistoryAttempt(
      {
        action: e.action,
        a: e.a,
        b: e.b,
        prayed: e.prayed,
        createdAt: e.createdAt,
        outcome: failed ? 'fail' : 'success',
        result: e.resultWord,
        emoji: e.resultEmoji,
      },
      account,
      syncTs
    );
    if (rec) history.push(rec);
  }
  const n = await upsertKnowledgeBatch(batch);
  const added = await addHistory(history);
  return { ok: true, learned: n, added, seen: batch.length, failures };
}

// ── 把遊戲保存的煉製歷史補進軌跡 ─────────────────────
//
// 軌跡要能代表「這個帳號煉過什麼」，所以不能只有安裝後的紀錄。
// 兩個來源：
//   /api/combine-log         我的煉製紀錄（含崩解與祈禱）
//   /api/me/recipes?offset=  所有由我首度發現的配方（分頁，拿得完）
//
// 去重保守：同一帳號只要已經有「相同組合＋相同結果」的紀錄就不再補，
// 免得把即時記到的那一筆重複計一次。現場重複煉的多筆紀錄不受影響。
let historyIndex = null;

async function loadHistoryIndex() {
  if (historyIndex) return historyIndex;
  const rows = await allAttempts();
  historyIndex = new Set(rows.map(attemptFingerprint));
  return historyIndex;
}

function attemptFingerprint(a) {
  return `${a.accountId ?? 'unknown'}|${a.pairKey}|${a.outcome}|${a.result ?? ''}`;
}

async function addHistory(records) {
  const index = await loadHistoryIndex();
  let added = 0;
  for (const rec of records) {
    const fp = attemptFingerprint(rec);
    if (index.has(fp)) continue;
    index.add(fp);
    await addAttempt(rec);
    added++;
  }
  return added;
}

/** 把遊戲給的一列煉製紀錄轉成軌跡格式 */
function makeHistoryAttempt(o, account, syncTs) {
  const action = o.action === 'refine' ? 'refine' : 'combine';
  const inputs = (action === 'refine' ? [o.a] : [o.a, o.b]).filter((w) => typeof w === 'string' && w);
  if (!inputs.length) return null;
  const exact = Number.isFinite(o.createdAt) && o.createdAt > 0;
  return {
    ts: exact ? o.createdAt : syncTs,
    tsExact: exact, // 時間是遊戲給的，還是我們填的
    fromGame: true, // 這筆是從遊戲補回來的，不是即時記到的
    dur: null,
    action,
    inputs,
    pairKey: action === 'refine' ? `refine:${inputs[0]}` : `combine:${[...inputs].sort().join(' | ')}`,
    prayed: !!o.prayed,
    prayReq: !!o.prayed,
    prayRes: !!o.prayed,
    outcome: o.outcome,
    result: o.outcome === 'success' ? o.result ?? null : null,
    emoji: o.emoji ?? null,
    type: null,
    value: null,
    rarity: null,
    tier: null,
    recipeCount: null,
    isNewDiscovery: !!o.newDiscovery,
    isGlobalFirst: !!o.globalFirst,
    reward: 0,
    reason: null, // 遊戲不會回溯崩解原因
    stamina: null,
    manaSpent: null, // 當時花多少魔力已無從得知
    status: null,
    accountId: account.id ?? null,
    accountName: account.name ?? null,
    accountIsGuest: !!account.isGuest,
    source: SOURCE.SYNC,
    raw: { history: o },
  };
}

/**
 * /api/ranking/recent → 全服最新的合成紀錄（所有玩家的）
 * 每列 { id, action, a, aEmoji, b, bEmoji, resultWord, resultEmoji, finderName, prayed, createdAt }
 *
 * **只進共用配方表，絕不進軌跡**——這些是別人煉的，不是你做過的事。
 * 也不帶入你的帳號資訊，發現者一律照遊戲回報的 finderName 記。
 */
async function learnGlobalFeed(ev) {
  const rows = (ev.rows || []).filter((e) => e && e.a);
  if (!rows.length) return { ok: true, learned: 0, seen: 0 };
  const ts = ev.ts || Date.now();
  const learned = await upsertKnowledgeBatch(
    rows.map((e) => fromGameLogEntry(e, { ts, source: SOURCE.SYNC })) // 不傳 accountId/accountName
  );

  const prev = (await getMeta('feedStats', null)) || { polls: 0, rows: 0, learned: 0, lastAt: 0 };
  await setMeta('feedStats', {
    polls: prev.polls + 1,
    rows: prev.rows + rows.length,
    learned: prev.learned + learned,
    lastAt: ts,
  });
  return { ok: true, learned, seen: rows.length };
}

/**
 * /api/me/recipes?offset=N → 所有由我首度發現的配方（分頁）
 * 每列 { action, a, aEmoji, b, bEmoji, resultWord, resultEmoji, prayed, createdAt }
 *
 * 注意：這是「**新配方**」，不是「全服首煉」。遊戲把這兩件事分得很清楚：
 *   造物主 / 世上創生 = 全世界第一個煉出這個「造物」的人 → /api/me/inventions
 *   新配方           = 第一個找到這「條配方」的人（同一造物可以有多條做法）→ 這支
 * 所以這裡只標 isNewDiscovery，全服首煉要另外比對創生名單。
 *
 * 這些既是配方知識，也是「我煉過這個」的事實，兩邊都要進。
 */
async function learnMyRecipes(ev) {
  const rows = (ev.data && ev.data.recipes) || [];
  if (!rows.length) return { ok: true, learned: 0 };
  const account = (await getMeta('account', null)) || {};
  const state = (await getAccountState(String(account.id ?? 'unknown'))) || {};
  const inventions = new Set(state.inventions || []); // 世上創生＝真正的全服首煉
  const syncTs = ev.ts || Date.now();

  const entries = [];
  const history = [];
  for (const r of rows) {
    if (!r || !r.resultWord || !r.a) continue;
    entries.push(
      fromGameRecipe(
        r.resultWord,
        {
          action: r.action,
          a: r.a,
          aEmoji: r.aEmoji,
          b: r.b,
          bEmoji: r.bEmoji,
          finderName: account.name ?? null,
          prayed: r.prayed,
        },
        {
          ts: r.createdAt || syncTs,
          source: SOURCE.SYNC,
          mine: true, // 這支端點回的就是「由你首度發現」的配方
          accountId: account.id ?? null,
          accountName: account.name ?? null,
          emoji: r.resultEmoji ?? null,
        }
      )
    );
    const rec = makeHistoryAttempt(
      {
        action: r.action,
        a: r.a,
        b: r.b,
        prayed: r.prayed,
        createdAt: r.createdAt,
        outcome: 'success',
        result: r.resultWord,
        emoji: r.resultEmoji,
        newDiscovery: true, // 這支端點回的就是「由你首度發現的配方」
        globalFirst: inventions.has(r.resultWord), // 但全服首煉要對得上創生名單才算
      },
      account,
      syncTs
    );
    if (rec) history.push(rec);
  }
  const learned = await upsertKnowledgeBatch(entries);
  const added = await addHistory(history);
  return { ok: true, learned, added, seen: entries.length };
}

// ── UI 指令 ────────────────────────────────────────────
// 沒有進度回報超過這個時間就視為卡死，允許重新開始。
// （分頁被關掉、content script 中途掛掉時，done/error 永遠不會回來）
const SYNC_STALE_MS = 90000;
const sync = { running: false, tabId: null, progress: null, beatAt: 0 };

function syncIsRunning() {
  if (!sync.running) return false;
  if (Date.now() - sync.beatAt > SYNC_STALE_MS) {
    sync.running = false; // 卡死了，放行
    return false;
  }
  return true;
}

// 全服動態輪詢的租約：同時只讓一個遊戲分頁去打，開了三個分頁也不會變三倍請求。
// 持有者每次輪詢前續約，超過兩輪沒續約就視為失效讓別的分頁接手。
const FEED_LEASE_MS = 70000;
const feedLease = { tabId: null, at: 0 };

function claimFeedLease(tabId) {
  const now = Date.now();
  if (feedLease.tabId != null && feedLease.tabId !== tabId && now - feedLease.at < FEED_LEASE_MS) {
    return false; // 別的分頁還握著
  }
  feedLease.tabId = tabId;
  feedLease.at = now;
  return true;
}

/**
 * 輪詢連續讀不到東西 → 自動關掉，並把原因記下來。
 *
 * 遊戲會改版。2026-08 那次就把「全服最新的合成紀錄」這個排行榜整個拿掉了，
 * 端點還在但回來的東西裡沒有合成紀錄——不防呆的話就會每 30 秒空打一次，永遠沒結果。
 */
async function giveUpFeed(reason) {
  await setMeta('feedOff', { at: Date.now(), reason: reason || '連續讀不到資料' });
  try {
    // 關掉開關：content script 的輪詢器與兩邊的 UI 都聽這把鑰匙，會一起停下來
    await chrome.storage.local.set({ globalFeed: false });
  } catch (_) {
    /* 沒有 storage 也不影響已經記下來的原因 */
  }
  return { ok: true, off: true, reason };
}

// 使用者自己再打開時，把上次自動關閉的理由清掉，不然畫面會一直掛著舊訊息
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.globalFeed && changes.globalFeed.newValue) setMeta('feedOff', null);
  });
} catch (_) {
  /* 忽略 */
}

// 遊戲分頁被關掉時，同步一定跑不下去了；輪詢租約也要放掉
chrome.tabs.onRemoved.addListener((tabId) => {
  if (feedLease.tabId === tabId) {
    feedLease.tabId = null;
    feedLease.at = 0;
  }
  if (sync.tabId === tabId) {
    sync.running = false;
    broadcast({ type: 'ia-progress', phase: 'error', error: '遊戲分頁已關閉' });
  }
});

// ── 版本檢查 ──────────────────────────────────────────
//
// 只在按「更新」時順手查一次，查完存起來；分頁重開只讀存下來的那份，
// 不會每開一次遊戲就打一次 GitHub（未登入的 API 一小時只給 60 次）。
const UPDATE_TTL_MS = 60 * 60 * 1000;

async function checkUpdate(opts = {}) {
  const current = chrome.runtime.getManifest().version;
  const cached = await getMeta('update', null);
  const fresh = cached && Date.now() - (cached.checkedAt || 0) < UPDATE_TTL_MS;
  if (opts.cachedOnly || (fresh && !opts.force)) {
    if (!cached) return { ok: true, current, hasUpdate: false };
    return { ok: true, ...cached, current, hasUpdate: isNewer(cached.latest, current) };
  }

  let info;
  try {
    const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = parseRelease(await res.json());
  } catch (e) {
    // 查不到就算了，不要害整趟更新看起來失敗
    return { ok: false, current, hasUpdate: false, error: (e && e.message) || String(e) };
  }
  if (!info) return { ok: false, current, hasUpdate: false, error: '沒有正式發布的版本' };

  const stored = { ...info, checkedAt: Date.now() };
  await setMeta('update', stored);
  return { ok: true, ...stored, current, hasUpdate: isNewer(info.latest, current) };
}

/** 開 GitHub 的最新發布頁，要不要下載由使用者自己決定 */
async function openRelease() {
  const info = (await getMeta('update', null)) || {};
  const url = info.page || RELEASE_PAGE;
  await chrome.tabs.create({ url });
  return { ok: true, page: url };
}

async function handleCommand(msg) {
  switch (msg.cmd) {
    case 'ping':
      return { ok: true, version: chrome.runtime.getManifest().version, contract: 2 };
    case 'check-update':
      return checkUpdate(msg.opts || {});
    case 'open-release':
      return openRelease();
    case 'sync-start':
      return startSync(msg.opts || {});
    case 'sync-cancel':
      return cancelSync();
    case 'rebuild-knowledge':
      return rebuildKnowledge();
    case 'reset-all':
      return resetAll();
    case 'diagnose':
      return runDiagnose();
    case 'import':
      return importPayload(msg.payload, msg.label);
    case 'predict':
      return doPredict(msg.action, msg.inputs);
    case 'goal-toggle':
      return toggleGoal(msg.action, msg.inputs);
    case 'goals':
      return listGoals();
    case 'goal-path':
      return saveGoalPath(msg.target, msg.steps);
    case 'goal-step-done':
      return tickPathStep(msg.stepKey);
    case 'goal-remove':
      return removeGoal(msg.key);
    case 'feed-claim':
      // 只有拿到租約的分頁才輪詢；tabId 由訊息處理器從 sender 補上
      return { ok: true, granted: msg.tabId != null && claimFeedLease(msg.tabId) };
    case 'feed-stats':
      return {
        ok: true,
        stats: (await getMeta('feedStats', null)) || { polls: 0, rows: 0, learned: 0, lastAt: 0 },
        off: await getMeta('feedOff', null),
      };
    case 'feed-give-up':
      return giveUpFeed(msg.reason);
    case 'open-dashboard':
      await chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') });
      return { ok: true };
    default:
      return { ok: false, error: '未知指令' };
  }
}

// ── 查詢（浮層用；儀表板是擴充套件頁面，直接讀資料庫不繞這裡）──
async function doPredict(action, inputs) {
  const act = action === 'refine' ? 'refine' : 'combine';
  const norm = normalizeInputs(act, inputs);
  if (!norm.length) return { ok: false, error: '請提供材料' };
  const key = recipeKey(act, norm);
  const rec = await getKnowledge(key);
  // 順便回報有沒有被設成目標，浮層才不用為了畫那顆星星再問一次
  const starred = !!(await getGoal(key));
  return { ok: true, inputs: norm, action: act, prediction: predict(rec), starred };
}

// ── 目標：想試但還沒試的組合 ───────────────────────────
//
// 只存「哪一組材料」，結果不存——每次列出來時都用當下的共用配方表重算，
// 這樣別人分享的配方匯進來以後，本來「尚無紀錄」的目標會自己變成有結果。
async function toggleGoal(action, inputs) {
  const act = action === 'refine' ? 'refine' : 'combine';
  const norm = normalizeInputs(act, inputs);
  if (!norm.length) return { ok: false, error: '請提供材料' };
  const key = recipeKey(act, norm);
  if (await getGoal(key)) {
    await deleteGoal(key);
    return { ok: true, starred: false, key };
  }
  await putGoal({ key, action: act, inputs: norm, addedAt: Date.now() });
  return { ok: true, starred: true, key };
}

async function listGoals() {
  const goals = await allGoals();
  goals.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); // 新加的排前面
  const items = [];
  for (const g of goals) {
    if (g.kind === 'path') items.push(g);
    else items.push({ ...g, prediction: predict(await getKnowledge(g.key)) });
  }
  return { ok: true, items };
}

/**
 * 把「怎麼煉」算出來的整條路徑存進待煉清單。
 * 同一個目標只留一條，重新規劃就覆蓋掉——不然同一個東西會存出好幾條互相矛盾的路。
 */
async function saveGoalPath(target, steps) {
  if (!target || !Array.isArray(steps) || !steps.length) return { ok: false, error: '沒有可存的路徑' };
  const key = `path:${target}`;
  const prev = await getGoal(key);
  await putGoal({
    key,
    kind: 'path',
    target,
    steps: steps.map((s) => ({
      key: s.key,
      action: s.action,
      inputs: s.inputs,
      result: s.result,
      emoji: s.emoji ?? null,
      needsPray: !!s.needsPray,
    })),
    addedAt: (prev && prev.addedAt) || Date.now(),
    updatedAt: Date.now(),
  });
  return { ok: true, key, count: steps.length };
}

/**
 * 某一步做完了就從路徑上拿掉，整條做完就把它清掉。
 * 這是自動的（handleAttempt 煉成功時會呼叫），浮層上那顆 ✓ 是給
 * 「擴充套件沒看到那一爐」時補的，不然那條會永遠卡著。
 */
async function tickPathStep(stepKey) {
  if (!stepKey) return { ok: true, changed: 0 };
  const goals = await allGoals();
  let changed = 0;
  for (const g of goals) {
    if (g.kind !== 'path' || !Array.isArray(g.steps)) continue;
    const left = g.steps.filter((s) => s.key !== stepKey);
    if (left.length === g.steps.length) continue;
    changed++;
    if (left.length) await putGoal({ ...g, steps: left, updatedAt: Date.now() });
    else await deleteGoal(g.key); // 整條煉完了
  }
  return { ok: true, changed };
}

async function removeGoal(key) {
  if (!key) return { ok: false, error: '沒有指定要移除哪一筆' };
  await deleteGoal(key);
  return { ok: true };
}

async function findGameTab() {
  const tabs = await chrome.tabs.query({ url: `${GAME_ORIGIN}/*` });
  return tabs && tabs.length ? tabs[0] : null;
}

async function startSync(opts) {
  if (syncIsRunning() && !opts.force) return { ok: false, error: '同步進行中' };
  const tab = await findGameTab();
  if (!tab) return { ok: false, error: 'no-tab' };
  historyIndex = null; // 每次更新都重新建一次去重索引
  sync.running = true;
  sync.tabId = tab.id;
  sync.beatAt = Date.now();
  sync.progress = { phase: 'starting', done: 0, total: 0 };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ia-sync-run', opts });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    sync.running = false;
    return { ok: false, error: 'stale-tab' };
  }
}

async function cancelSync() {
  if (sync.tabId != null) {
    try {
      await chrome.tabs.sendMessage(sync.tabId, { type: 'ia-sync-cancel' });
    } catch (_) {
      /* 分頁可能已關閉 */
    }
  }
  sync.running = false;
  broadcast({ type: 'ia-progress', phase: 'cancelled' });
  return { ok: true };
}

async function handleSyncProgress(msg) {
  sync.progress = msg;
  sync.beatAt = Date.now(); // 心跳：有進度就代表還活著
  let update = null;
  if (msg.phase === 'done' || msg.phase === 'error' || msg.phase === 'cancelled') {
    sync.running = false;
    if (msg.phase === 'done') {
      const account = (await getMeta('account', null)) || {};
      await mergeAccountState(account.id, { lastSync: Date.now(), lastSyncStats: msg.stats || null });
      // 順手看一眼 GitHub 上有沒有新版本；查不到就當沒這回事，不影響更新結果。
      //
      // 這裡一定要 force：一小時的快取是給「開個頁面順手讀一下」用的，
      // 但按「⟳ 更新」是使用者刻意的動作，而且三個入口都是點擊觸發、沒有自動排程。
      // 不強制重查的話，我這邊剛發了更新的一版，你在一小時內再按也只會看到舊的那一版。
      update = await checkUpdate({ force: true });
    }
  }
  // 廣播給儀表板／popup；content script 收不到 runtime 廣播，所以也回覆一份給它
  broadcast({ ...msg, type: 'ia-progress', update });
  return { ok: true, update };
}

async function handleSyncData(msg) {
  switch (msg.kind) {
    case 'me':
      return handleMe({ res: msg.data, ts: msg.ts || Date.now() });
    case 'discoveries':
      return handleDiscoveries({ res: msg.data, ts: msg.ts || Date.now() });
    case 'seeds':
      return handleSeeds({ res: msg.data, ts: msg.ts || Date.now() });
    case 'inventions':
      return handleInventions({ res: msg.data, ts: msg.ts || Date.now() });
    case 'my-recipes':
      return learnMyRecipes({ data: msg.data, ts: msg.ts || Date.now() });
    case 'global-feed':
      return learnGlobalFeed({ rows: msg.rows, ts: msg.ts || Date.now() });
    case 'combine-log':
      return learnFromLog({ res: msg.data, ts: msg.ts || Date.now() });
    default:
      return { ok: true, skipped: true };
  }
}

/** 診斷：請遊戲分頁把每支端點的原始回應撈回來 */
async function runDiagnose() {
  const tab = await findGameTab();
  if (!tab) return { ok: false, error: 'no-tab' };
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ia-diagnose' });
    return r || { ok: false, error: '遊戲分頁沒有回應' };
  } catch (_) {
    return { ok: false, error: 'stale-tab' };
  }
}

/** 完全重置：清掉所有資料表，讓擴充套件回到剛安裝的狀態 */
async function resetAll() {
  if (syncIsRunning()) await cancelSync();
  const counts = await wipeAll();
  historyIndex = null;
  sync.running = false;
  sync.tabId = null;
  sync.progress = null;
  await refreshBadge(0);
  broadcast({ type: 'ia-reset' });
  return {
    ok: true,
    cleared: {
      attempts: counts.attempts || 0,
      knowledge: counts.knowledge || 0,
      inventory: counts.inventory || 0,
      accountState: counts.accountState || 0,
      goals: counts.goals || 0,
      meta: counts.meta || 0,
    },
  };
}

async function rebuildKnowledge() {
  const attempts = await allAttempts();
  await clearKnowledge();
  const entries = rebuildEntries(attempts);
  const n = await upsertKnowledgeBatch(entries);
  await setMeta('needsKnowledgeRebuild', false);
  return { ok: true, rebuilt: n, from: attempts.length };
}

/** 匯入別人分享出來的檔案：只併配方知識，不動你自己的統計 */
async function importPayload(payload, label) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: '檔案格式不正確' };
  const entries = [];
  if (Array.isArray(payload.knowledge)) {
    for (const k of payload.knowledge) entries.push(fromForeignKnowledge(k, label));
  }
  // 舊版（只有 attempts）的檔案也能吃
  if (Array.isArray(payload.attempts)) {
    for (const a of payload.attempts) {
      entries.push(fromAttempt({ ...a, accountId: null }, SOURCE.IMPORT));
    }
  }
  if (!entries.length) return { ok: false, error: '檔案裡沒有可用的配方資料' };
  const n = await upsertKnowledgeBatch(entries);
  return { ok: true, merged: n, total: await countKnowledge() };
}

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    /* 沒有開著的 UI 頁面 */
  }
}

// ── 徽章 ───────────────────────────────────────────────
function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 計數綁在「日期 + 帳號」上，切帳號時徽章顯示的是該帳號今天的次數
async function bumpToday(ts, accountId) {
  const key = `${todayKey(ts)}|${accountId ?? 'unknown'}`;
  const cur = (await getMeta('today', null)) || { key, n: 0 };
  const next = cur.key === key ? { key, n: cur.n + 1 } : { key, n: 1 };
  await setMeta('today', next);
  return next.n;
}

async function refreshBadge(n) {
  try {
    if (n == null) {
      const cur = await getMeta('today', null);
      n = cur && cur.key.startsWith(`${todayKey()}|`) ? cur.n : 0;
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#8a5a1e' });
    await chrome.action.setBadgeText({ text: n > 0 ? String(Math.min(n, 99999)) : '' });
  } catch (_) {
    /* 忽略 */
  }
}

chrome.runtime.onStartup.addListener(() => refreshBadge());
chrome.runtime.onInstalled.addListener(async () => {
  refreshBadge();
  // v1 → v2：既有紀錄補建知識庫
  if (await getMeta('needsKnowledgeRebuild', false)) {
    try {
      await rebuildKnowledge();
    } catch (_) {
      /* 下次使用者也可以在「資料」頁手動重建 */
    }
  }
});
