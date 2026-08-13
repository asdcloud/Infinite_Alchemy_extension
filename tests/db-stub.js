// 測試替身：把 db.js 換成記憶體資料
const base = Date.now() - 12 * 3600000;
const T = (h) => base + h * 3600000;

const mkA = (o) => {
  const inputs = o.inputs;
  const action = o.action || 'combine';
  return {
    id: o.id,
    ts: o.ts,
    action,
    inputs,
    pairKey: action === 'refine' ? `refine:${inputs[0]}` : `combine:${[...inputs].sort().join(' | ')}`,
    prayed: !!o.prayed,
    outcome: o.outcome || 'success',
    result: o.outcome && o.outcome !== 'success' ? null : o.result,
    emoji: o.emoji || null,
    type: o.type || null,
    rarity: o.rarity || null,
    value: 100,
    isNewDiscovery: !!o.isNew,
    isGlobalFirst: !!o.first,
    reward: o.reward || 0,
    reason: o.reason || null,
    manaSpent: 1,
    status: 200,
    accountId: o.acc === undefined ? 'A1' : o.acc,
    accountName: o.accName === undefined ? '主號' : o.accName,
    accountIsGuest: !!o.guest,
    raw: {},
  };
};

const ATTEMPTS = [
  { id: 1, ts: T(1), inputs: ['水', '火'], result: '蒸氣', emoji: '💨', isNew: true, reward: 10, rarity: 2 },
  { id: 2, ts: T(2), inputs: ['蒸氣', '土'], result: '溫泉', emoji: '♨️' },
  { id: 3, ts: T(3), inputs: ['溫泉', '雷'], outcome: 'fail', reason: '崩解' },
  { id: 4, ts: T(4), inputs: ['溫泉', '雷'], prayed: true, result: '間歇泉', emoji: '⛲', first: true, isNew: true, reward: 500, rarity: 4 },
  { id: 5, ts: T(5), action: 'refine', inputs: ['火'], result: '燃燒', emoji: '🔥' },
  { id: 6, ts: T(6), inputs: ['水', '水'], result: '海', emoji: '🌊' },
  { id: 7, ts: T(7), inputs: ['風', '雷'], result: '暴風', emoji: '🌀', acc: 'A2', accName: '小號' },
  { id: 8, ts: T(8), inputs: ['暴風', '水'], outcome: 'error', reason: '魔力不足', acc: 'A2', accName: '小號' },
].map(mkA);

const arm = (o, s = 0, f = 0) => ({ outcome: o, success: s, fail: f, firstTs: T(1), lastTs: T(2) });

const mkK = (action, inputs, result, o = {}) => ({
  key: action === 'refine' ? `refine:${inputs[0]}` : `combine:${[...inputs].sort().join('|')}`,
  action,
  inputs: action === 'refine' ? inputs : [...inputs].sort(),
  result,
  emoji: o.emoji || null,
  type: o.type || null,
  rarity: o.rarity || null,
  normal: o.normal || arm('success', 1, 0),
  pray: o.pray || arm(null),
  discoveredBy: o.by
    ? { accountId: o.byId === undefined ? 'A1' : o.byId, accountName: o.by, finderName: o.by, source: o.src || 'local', ts: T(1) }
    : null,
  finders: o.by ? [{ name: o.by, source: o.src || 'local' }] : [],
  globalFirst: !!o.first,
  sources: [o.src || 'local'],
  createdAt: T(1),
  updatedAt: T(2),
});

const KNOWLEDGE = [
  mkK('combine', ['水', '火'], '蒸氣', { emoji: '💨', by: '主號' }),
  mkK('combine', ['蒸氣', '土'], '溫泉', { emoji: '♨️', by: '主號' }),
  mkK('combine', ['溫泉', '雷'], '間歇泉', { emoji: '⛲', first: true, by: '主號', normal: arm('fail', 0, 2), pray: arm('success', 1, 0) }),
  mkK('refine', ['火'], '燃燒', { emoji: '🔥', by: '主號' }),
  mkK('combine', ['燃燒', '間歇泉'], '地熱', { emoji: '🌋', by: '朋友甲', byId: null, src: 'import' }),
  mkK('combine', ['水', '水'], '海', { emoji: '🌊', by: '主號' }),
  mkK('combine', ['海', '風'], '浪', { emoji: '〰️', by: '別人', byId: null, src: 'sync' }),
  mkK('combine', ['隕鐵', '燃燒'], '熔爐', { emoji: '🏭', by: '別人', byId: null, src: 'sync' }),
  mkK('combine', ['水', '雷'], null, { normal: arm('fail', 0, 3) }),
  // 同一個造物的第二條配方，來源沒帶 emoji——不該在畫面上長得不一樣
  mkK('combine', ['雲', '火'], '蒸氣', { by: '別人', byId: null, src: 'sync' }),
];

const INV = {
  A1: {
    accountId: 'A1',
    items: {
      水: { word: '水' },
      火: { word: '火' },
      土: { word: '土' },
      風: { word: '風' },
      雷: { word: '雷' },
      蒸氣: { word: '蒸氣', emoji: '💨', rarity: 2 },
      溫泉: { word: '溫泉', emoji: '♨️' },
    },
    count: 7,
    snapshotAt: T(9),
    updatedAt: T(9),
  },
  A2: {
    accountId: 'A2',
    items: { 風: { word: '風' }, 雷: { word: '雷' }, 暴風: { word: '暴風', emoji: '🌀' } },
    count: 3,
    snapshotAt: T(9),
    updatedAt: T(9),
  },
};

const STATE = {
  A1: {
    accountId: 'A1',
    name: '主號',
    balance: 12345,
    soul: 300,
    stamina: { value: 42, cap: 60 },
    bagUsed: 7,
    bagLimit: 60,
    inventions: ['間歇泉'],
    lastSync: T(9),
  },
};

export async function allAttempts() {
  return ATTEMPTS.slice();
}
export async function countAttempts() {
  return ATTEMPTS.length;
}
export async function allKnowledge() {
  return KNOWLEDGE.slice();
}
export async function countKnowledge() {
  return KNOWLEDGE.length;
}
export async function getInventory(id) {
  return INV[String(id)] || null;
}
export async function getAccountState(id) {
  return STATE[String(id)] || null;
}
// meta 要能真的來回讀寫，否則像 feedStats 這種累加值測不出來
const META = new Map([
  ['account', { id: 'A1', name: '主號', isGuest: false }],
  ['accounts', { A1: { id: 'A1', name: '主號', lastSeen: T(6) }, A2: { id: 'A2', name: '小號', lastSeen: T(8) } }],
]);
export async function getMeta(k, fb = null) {
  return META.has(k) ? META.get(k) : fb;
}
export async function setMeta(k, v) {
  META.set(k, v);
}
export async function clearAttempts() {}
export async function bulkAdd() {
  return 0;
}
// 讓 bg-test 看得到背景到底寫了什麼進軌跡
window.__iaWritten = window.__iaWritten || [];
export async function addAttempt(rec) {
  window.__iaWritten.push(rec);
}
export async function openDB() {
  return null;
}

window.__iaWiped = window.__iaWiped || [];
export async function wipeAll() {
  const counts = {
    attempts: ATTEMPTS.length,
    knowledge: KNOWLEDGE.length,
    inventory: Object.keys(INV).length,
    accountState: Object.keys(STATE).length,
    goals: GOALS.size,
    meta: 3,
  };
  // 真的清掉，之後 allAttempts() 才會回傳空的——不然測不出重置的效果
  ATTEMPTS.length = 0;
  KNOWLEDGE.length = 0;
  for (const k of Object.keys(INV)) delete INV[k];
  for (const k of Object.keys(STATE)) delete STATE[k];
  GOALS.clear();
  META.clear();
  window.__iaWiped.push(counts);
  return counts;
}

// background.js 用得到的其餘匯出
export async function clearKnowledge() {}
window.__iaLearned = window.__iaLearned || [];
export async function upsertKnowledgeBatch(entries) {
  for (const e of entries) window.__iaLearned.push({ key: e.key, rec: e.merge(undefined) });
  return entries.length;
}
export async function getKnowledge(key) { return KNOWLEDGE.find((k) => k.key === key) || undefined; }
export async function putInventory() {}
export async function putAccountState() {}

// goals 也要真的來回讀寫，星星點亮／取消才測得出來
const GOALS = new Map();
export async function allGoals() {
  return [...GOALS.values()];
}
export async function getGoal(key) {
  return GOALS.get(key);
}
export async function putGoal(rec) {
  GOALS.set(rec.key, rec);
}
export async function deleteGoal(key) {
  GOALS.delete(key);
}
