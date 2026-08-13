// 擴充套件自己的 IndexedDB（與遊戲頁面的儲存空間互不干擾）。
// service worker、popup、dashboard、content script 同源，可直接共用這個模組。
//
// 資料分兩層：
//   attempts / inventory / accountState  → 跟著帳號走（軌跡、持有物、金錢、體力）
//   knowledge                            → 共用配方表（配方是世界的性質，不因帳號而異，
//                                          只標記是誰、用哪個帳號煉出來的）

const DB_NAME = 'ia-tracker';
const DB_VERSION = 2;
const STORE = 'attempts';
const META = 'meta';
const KNOWLEDGE = 'knowledge';
const INVENTORY = 'inventory';
const ACCOUNT_STATE = 'accountState';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
        s.createIndex('outcome', 'outcome');
        s.createIndex('result', 'result');
        s.createIndex('pairKey', 'pairKey');
        s.createIndex('accountId', 'accountId');
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'k' });
      }
      // v2
      if (!db.objectStoreNames.contains(KNOWLEDGE)) {
        const k = db.createObjectStore(KNOWLEDGE, { keyPath: 'key' });
        k.createIndex('result', 'result');
        k.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(INVENTORY)) {
        db.createObjectStore(INVENTORY, { keyPath: 'accountId' });
      }
      if (!db.objectStoreNames.contains(ACCOUNT_STATE)) {
        db.createObjectStore(ACCOUNT_STATE, { keyPath: 'accountId' });
      }
      if (ev.oldVersion > 0 && ev.oldVersion < 2) {
        // 舊資料不動；配方表會在下次寫入或按「由軌跡重建配方表」時補起來
        const tx = req.transaction;
        tx.objectStore(META).put({ k: 'needsKnowledgeRebuild', v: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ── attempts ───────────────────────────────────────────
export async function addAttempt(rec) {
  return wrap((await store(STORE, 'readwrite')).add(rec));
}

export async function bulkAdd(records) {
  const s = await store(STORE, 'readwrite');
  let n = 0;
  for (const r of records) {
    const { id, ...rest } = r; // 匯入時重新編號，避免覆蓋既有紀錄
    s.add(rest);
    n++;
  }
  await done(s.transaction);
  return n;
}

export async function allAttempts() {
  return wrap((await store(STORE)).getAll());
}

export async function countAttempts() {
  return wrap((await store(STORE)).count());
}

export async function clearAttempts() {
  return wrap((await store(STORE, 'readwrite')).clear());
}

// ── knowledge（共用配方表）─────────────────────────────
export async function getKnowledge(key) {
  return wrap((await store(KNOWLEDGE)).get(key));
}

export async function allKnowledge() {
  return wrap((await store(KNOWLEDGE)).getAll());
}

export async function countKnowledge() {
  return wrap((await store(KNOWLEDGE)).count());
}

/** 以 merge 函式批次 upsert：merge(既有 | undefined) → 新值（回傳 null 表示略過） */
export async function upsertKnowledgeBatch(entries) {
  if (!entries.length) return 0;
  const s = await store(KNOWLEDGE, 'readwrite');
  let n = 0;
  for (const { key, merge } of entries) {
    const prev = await wrap(s.get(key));
    const next = merge(prev);
    if (next) {
      s.put(next);
      n++;
    }
  }
  await done(s.transaction);
  return n;
}

export async function clearKnowledge() {
  return wrap((await store(KNOWLEDGE, 'readwrite')).clear());
}

// ── inventory（分帳號持有物快照）───────────────────────
export async function getInventory(accountId) {
  return wrap((await store(INVENTORY)).get(String(accountId ?? 'unknown')));
}

export async function putInventory(rec) {
  return wrap((await store(INVENTORY, 'readwrite')).put(rec));
}

// ── accountState（分帳號金錢／體力／同步時間）──────────
export async function getAccountState(accountId) {
  return wrap((await store(ACCOUNT_STATE)).get(String(accountId ?? 'unknown')));
}

export async function putAccountState(rec) {
  return wrap((await store(ACCOUNT_STATE, 'readwrite')).put(rec));
}

// ── meta ───────────────────────────────────────────────
export async function getMeta(k, fallback = null) {
  const row = await wrap((await store(META)).get(k));
  return row ? row.v : fallback;
}

export async function setMeta(k, v) {
  return wrap((await store(META, 'readwrite')).put({ k, v }));
}

// ── 完全重置 ───────────────────────────────────────────
/**
 * 清掉每一個資料表，讓擴充套件回到剛安裝的狀態。
 * 軌跡、共用配方表、素材櫃、帳號狀態、帳號名冊、魔力基準全部一起清——
 * 只清一部分的話，測「全新帳號」會測不準。
 */
export async function wipeAll() {
  const db = await openDB();
  const names = [STORE, KNOWLEDGE, INVENTORY, ACCOUNT_STATE, META];
  const tx = db.transaction(names, 'readwrite');
  const counts = {};
  for (const name of names) {
    const s = tx.objectStore(name);
    counts[name] = await wrap(s.count());
    s.clear();
  }
  await done(tx);
  return counts;
}
