import {
  allAttempts,
  clearAttempts,
  bulkAdd,
  getMeta,
  countAttempts,
  allKnowledge,
  countKnowledge,
  getInventory,
  getAccountState,
} from '../src/db.js';
import { computeDepths, buildTree, classify, PRIMORDIALS } from '../src/analysis.js';
import { recipesByResult, recipeKey, normalizeInputs, predict, PREDICT_LABEL } from '../src/knowledge.js';
import { plan as planPath, knownCombosFromOwned } from '../src/planner.js';

const PAGE = 200;

const ALL = '__all__';
const UNKNOWN = '__unknown__';
const ACCOUNT_PREF = 'ia-tracker-account';

const state = {
  raw: [], // 全部紀錄
  accounts: [], // [{key, id, name, isGuest, count, lastTs}]
  account: ALL, // 目前檢視的帳號 key
  attempts: [], // 已依帳號篩選（軌跡用）
  knowledge: [], // 共用配方表（跨帳號，配方不因帳號而異）
  kbIndex: new Map(), // key → 配方表紀錄
  recipes: new Map(), // result → 配方陣列（由配方表建）
  owned: new Set(), // 目前帳號的持有物
  inventory: null,
  accountState: null,
  depth: new Map(),
  best: new Map(),
  logShown: PAGE,
  kbShown: PAGE,
  wordMeta: new Map(), // 造物 → { emoji, type, rarity }（同一造物到處長一樣）
  treePick: new Map(), // 使用者在樹上手動換過的配方
  planChosen: new Map(), // 規劃器這次選用的配方
  planTarget: null,
};

// ── 小工具 ──────────────────────────────────────────────
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

function inputsEl(inputs) {
  const frag = document.createDocumentFragment();
  (inputs || []).forEach((w, i) => {
    if (i > 0) frag.appendChild(el('span', { class: 'op', text: '＋' }));
    frag.appendChild(el('span', { class: 'w', text: w }));
  });
  return frag;
}

function tags(a) {
  const frag = document.createDocumentFragment();
  if (a.fromGame) {
    frag.appendChild(
      el('span', {
        class: 'tag dim',
        title:
          a.tsExact === false
            ? '按「更新」從遊戲補回來的；遊戲沒給時間，顯示的是更新當下的時間'
            : '按「更新」從遊戲補回來的，時間是遊戲給的',
        text: a.tsExact === false ? '遊戲紀錄・時間不明' : '遊戲紀錄',
      })
    );
  }
  if (a.prayed) frag.appendChild(el('span', { class: 'tag pray', text: '祈禱' }));
  if (a.isGlobalFirst) frag.appendChild(el('span', { class: 'tag first', text: '全服首煉' }));
  else if (a.isNewDiscovery) frag.appendChild(el('span', { class: 'tag new', text: '首度發現配方' }));
  if (a.rarity) frag.appendChild(el('span', { class: 'tag dim', text: `${a.rarity}★` }));
  return frag;
}

// ── 載入與重算 ──────────────────────────────────────────
const accountKey = (a) => (a.accountId == null ? UNKNOWN : String(a.accountId));

/** 帳號名冊：以 accountId 分組（名號會改，id 不會），再併入尚未有紀錄的帳號 */
async function buildAccounts() {
  const map = new Map();
  for (const a of state.raw) {
    const key = accountKey(a);
    if (!map.has(key)) {
      map.set(key, {
        key,
        id: a.accountId ?? null,
        name: a.accountName || null,
        isGuest: !!a.accountIsGuest,
        count: 0,
        lastTs: 0,
      });
    }
    const acc = map.get(key);
    acc.count++;
    if (a.ts > acc.lastTs) {
      acc.lastTs = a.ts;
      if (a.accountName) acc.name = a.accountName; // 取最新的名號
      acc.isGuest = !!a.accountIsGuest;
    }
  }
  const book = (await getMeta('accounts', null)) || {};
  for (const [key, info] of Object.entries(book)) {
    if (!map.has(key)) {
      map.set(key, {
        key,
        id: info.id ?? null,
        name: info.name || null,
        isGuest: !!info.isGuest,
        count: 0,
        lastTs: info.lastSeen || 0,
      });
    } else if (info.name && !map.get(key).name) {
      map.get(key).name = info.name;
    }
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
}

function accountLabel(acc) {
  if (acc.key === UNKNOWN) return `未標記帳號（${fmt(acc.count)}）`;
  const name = acc.name || `#${acc.id ?? '?'}`;
  return `${acc.isGuest ? '訪客・' : ''}${name}（${fmt(acc.count)}）`;
}

function renderAccountSelect() {
  const sel = $('account-select');
  sel.textContent = '';
  if (state.accounts.length > 1 || state.accounts.some((a) => a.key === UNKNOWN)) {
    sel.appendChild(el('option', { value: ALL, text: `全部帳號（${fmt(state.raw.length)}）` }));
  }
  for (const acc of state.accounts) {
    sel.appendChild(el('option', { value: acc.key, text: accountLabel(acc) }));
  }
  if (!state.accounts.length) sel.appendChild(el('option', { value: ALL, text: '尚無紀錄' }));
  sel.value = state.account;
  if (sel.value !== state.account) {
    // 記住的帳號已不存在（例如清空過），退回第一個選項
    state.account = sel.value || ALL;
  }
  // 只有一個帳號時不必顯示選單
  const single = state.accounts.length <= 1;
  sel.classList.toggle('hidden', single);
  document.querySelector('label[for="account-select"]').classList.toggle('hidden', single);
}

/** 帳號範疇的東西才需要重算：軌跡與持有物（配方是全域的，不必動） */
async function applyAccountFilter() {
  state.attempts =
    state.account === ALL ? state.raw.slice() : state.raw.filter((a) => accountKey(a) === state.account);
  state.logShown = PAGE;

  const invKey = state.account === ALL ? (state.accounts[0] ? state.accounts[0].key : 'unknown') : state.account;
  state.inventory = await getInventory(invKey);
  state.accountState = await getAccountState(invKey);
  state.owned = new Set(state.inventory && state.inventory.items ? Object.keys(state.inventory.items) : []);
  for (const w of PRIMORDIALS) state.owned.add(w); // 五原質一定拿得到
}

/** 配方是全域的：不因帳號而異，只標記是誰煉出來的 */
function buildKnowledgeViews() {
  state.kbIndex = new Map(state.knowledge.map((k) => [k.key, k]));
  state.recipes = recipesByResult(state.knowledge);
  const d = computeDepths(state.recipes);
  state.depth = d.depth;
  state.best = d.best;

  // emoji／類型／星等是「造物」的屬性，不是「某一條配方」的。
  // 同一個造物可能有好幾條配方，而各條的來源不見得都帶了 emoji——
  // 所以把整份表掃過一次湊出每個造物的樣貌，顯示時一律查這張表，
  // 否則同一個東西會在不同列長得不一樣，看起來像兩種造物。
  const meta = new Map();
  const note = (word, src) => {
    if (!word || !src) return;
    const cur = meta.get(word) || {};
    if (!cur.emoji && src.emoji) cur.emoji = src.emoji;
    if (!cur.type && src.type) cur.type = src.type;
    if (cur.rarity == null && src.rarity != null) cur.rarity = src.rarity;
    meta.set(word, cur);
  };
  for (const k of state.knowledge) {
    note(k.result, k);
    if (k.inputEmoji) for (const [w, e] of Object.entries(k.inputEmoji)) note(w, { emoji: e });
  }
  // 素材櫃裡的資料最完整（有 type 與星等），優先採用
  if (state.inventory && state.inventory.items) {
    for (const it of Object.values(state.inventory.items)) note(it.word, it);
  }
  for (const a of state.raw) note(a.result, a);
  state.wordMeta = meta;
}

/** 造物在畫面上的樣子：emoji ＋ 名稱（同一個造物到處都長一樣） */
function wordLabel(word) {
  if (!word) return '—';
  const m = state.wordMeta.get(word);
  return `${m && m.emoji ? m.emoji + ' ' : ''}${word}`;
}

// 版本號一律從 manifest 讀，畫面上與 manifest 才不會各說各話
try {
  const m = chrome.runtime.getManifest();
  const v = m.version_name || `v${m.version}`;
  $('version').textContent = v;
  document.title = `煉製軌跡 ${v} · 無限煉製`;
} catch (_) {
  /* 測試頁沒有 chrome API，就用 HTML 裡寫死的當備援 */
}

async function load() {
  state.raw = (await allAttempts()).sort((a, b) => b.ts - a.ts);
  state.knowledge = await allKnowledge();
  state.accounts = await buildAccounts();
  buildKnowledgeViews();

  // 預設看「你現在登入的那個帳號」；使用者自己選過就記住他的選擇
  const saved = localStorage.getItem(ACCOUNT_PREF);
  const known = new Set([ALL, ...state.accounts.map((a) => a.key)]);
  if (saved && known.has(saved)) {
    state.account = saved;
  } else {
    const cur = await getMeta('account', null);
    const curKey = cur && cur.id != null ? String(cur.id) : null;
    const newestReal = state.accounts.find((a) => a.key !== UNKNOWN);
    state.account =
      (curKey && known.has(curKey) && curKey) || (newestReal && newestReal.key) ||
      (state.accounts[0] && state.accounts[0].key) || ALL;
  }

  renderAccountSelect();
  await applyAccountFilter();
  renderAll();
}

function renderAll() {
  renderLog();
  renderWordList();
  renderKnowledge();
  renderSuggest();
  renderBag();
  renderFeed();
  renderPlanBasis();
  // 資料變了，正在看的那條路徑也要跟著重算，否則按「重新整理」在這一頁看起來像沒反應
  if (state.planTarget) renderPlan(state.planTarget);
}

// ── 軌跡 ────────────────────────────────────────────────
function filteredLog() {
  const q = $('log-search').value.trim();
  const f = $('log-filter').value;
  return state.attempts.filter((a) => {
    if (q) {
      const hay = [...(a.inputs || []), a.result || '', a.reason || ''].join(' ');
      if (!hay.includes(q)) return false;
    }
    switch (f) {
      case 'success':
        return a.outcome === 'success';
      case 'fail':
        return a.outcome === 'fail';
      case 'error':
        return a.outcome === 'error';
      case 'new':
        return a.isNewDiscovery;
      case 'global':
        return a.isGlobalFirst;
      case 'pray':
        return a.prayed;
      case 'refine':
        return a.action === 'refine';
      case 'game':
        return !!a.fromGame;
      case 'live':
        return !a.fromGame;
      default:
        return true;
    }
  });
}

function renderLog() {
  const rows = filteredLog();
  const body = $('log-body');
  body.textContent = '';
  const slice = rows.slice(0, state.logShown);

  for (const a of slice) {
    const resultCell = el('td');
    if (a.outcome === 'success') {
      resultCell.appendChild(
        el('span', { class: 'res-success', text: wordLabel(a.result) })
      );
      if (a.type) resultCell.appendChild(el('span', { class: 'reason', text: a.type }));
    } else if (a.outcome === 'fail') {
      resultCell.appendChild(el('span', { class: 'res-fail', text: '崩解' }));
      if (a.reason) resultCell.appendChild(el('span', { class: 'reason', text: a.reason }));
    } else {
      resultCell.appendChild(el('span', { class: 'res-error', text: '未執行' }));
      if (a.reason) resultCell.appendChild(el('span', { class: 'reason', text: a.reason }));
    }

    body.appendChild(
      el('tr', {}, [
        el('td', { class: 'time', text: fmtTime(a.ts) }),
        el('td', {
          class: 'col-account muted',
          text: a.accountName || (a.accountId != null ? `#${a.accountId}` : '—'),
        }),
        el('td', { text: a.action === 'refine' ? '萃取' : '合成' }),
        el('td', {}, [inputsEl(a.inputs)]),
        resultCell,
        el('td', {}, [tags(a)]),
        el('td', { text: a.manaSpent == null ? '—' : String(a.manaSpent) }),
        el('td', { text: a.reward ? fmt(a.reward) : '—' }),
      ])
    );
  }

  $('log-count').textContent = `${fmt(rows.length)} 筆${
    rows.length > slice.length ? `（顯示前 ${fmt(slice.length)} 筆）` : ''
  }`;
  $('log-more').classList.toggle('hidden', rows.length <= slice.length);
  // 只有在檢視「全部帳號」時才需要帳號欄
  document.body.classList.toggle('single-account', state.account !== ALL);
  if (!rows.length) {
    body.appendChild(
      el('tr', {}, [
        el('td', { colspan: '8', class: 'muted', text: '沒有符合條件的紀錄。到遊戲裡煉幾爐就會出現。' }),
      ])
    );
  }
}

// ── 族譜 ────────────────────────────────────────────────
function renderWordList() {
  const results = [...state.recipes.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  // 所有出現過的詞（含只當過材料的），給「查配方」的輸入框用
  const every = new Set([...results, ...PRIMORDIALS, ...state.owned]);
  for (const rec of state.knowledge) for (const w of rec.inputs) every.add(w);
  const all = [...every].sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  for (const [id, words] of [
    ['known-words', results],
    ['all-words', all],
  ]) {
    const dl = $(id);
    if (!dl) continue;
    dl.textContent = '';
    for (const w of words.slice(0, 4000)) dl.appendChild(el('option', { value: w }));
  }
}

// ── 知識庫 ──────────────────────────────────────────────
const VERDICT_TONE = {
  success: 'ok',
  'pray-only': 'pray',
  'pray-known': 'pray',
  fail: 'bad',
  dead: 'bad',
  unknown: 'dim',
};

function finderName(rec) {
  const d = rec && rec.discoveredBy;
  if (!d) return null;
  return d.accountName || d.finderName || null;
}

function sourceLabel(sources) {
  const map = { local: '自己煉的', sync: '遊戲回填', import: '他人分享' };
  return (sources || []).map((s) => map[s] || s).join('、') || '—';
}

function verdictCell(rec) {
  const p = predict(rec);
  const td = el('td');
  td.appendChild(
    el('span', { class: `tag ${p.status === 'success' ? 'new' : p.status.startsWith('pray') ? 'pray' : p.status === 'unknown' ? 'dim' : 'first'}`, text: PREDICT_LABEL[p.status] })
  );
  const tries = (p.normal.success || 0) + (p.normal.fail || 0) + (p.pray.success || 0) + (p.pray.fail || 0);
  if (tries) td.appendChild(el('span', { class: 'reason', text: `一共嘗試過 ${tries} 次` }));
  return td;
}

function filteredKnowledge() {
  const q = $('kb-search').value.trim();
  const f = $('kb-filter').value;
  return state.knowledge.filter((rec) => {
    if (q && ![...rec.inputs, rec.result || ''].some((w) => w.includes(q))) return false;
    const p = predict(rec);
    switch (f) {
      case 'success':
        return p.status === 'success';
      case 'pray':
        return p.status === 'pray-only' || p.status === 'pray-known';
      case 'fail':
        return p.status === 'fail' || p.status === 'dead';
      case 'mine':
        return rec.discoveredBy && rec.discoveredBy.accountId != null;
      case 'import':
        return (rec.sources || []).includes('import');
      default:
        return true;
    }
  });
}

function renderKnowledge() {
  const rows = filteredKnowledge().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const body = $('kb-body');
  body.textContent = '';
  const slice = rows.slice(0, state.kbShown);
  for (const rec of slice) {
    const matCell = el('td');
    if (rec.action === 'refine') matCell.appendChild(el('span', { class: 'tag refine', text: '萃取' }));
    rec.inputs.forEach((w, i) => {
      if (i > 0) matCell.appendChild(el('span', { class: 'op', text: '＋' }));
      matCell.appendChild(el('span', { class: 'w', text: w }));
    });
    const resultCell = el('td');
    if (rec.result) {
      resultCell.appendChild(
        el('span', { class: 'res-success', text: wordLabel(rec.result) })
      );
      if (state.owned.has(rec.result)) resultCell.appendChild(el('span', { class: 'tag new', text: '已持有' }));
    } else {
      resultCell.appendChild(el('span', { class: 'res-fail', text: '—' }));
    }

    body.appendChild(
      el('tr', {}, [
        matCell,
        resultCell,
        verdictCell(rec),
        el('td', { class: 'muted', text: finderName(rec) || '—' }),
        el('td', { class: 'muted', text: sourceLabel(rec.sources) }),
        el('td', {}, [
          rec.result
            ? el('button', {
                class: 'link',
                text: '怎麼煉',
                onclick: () => {
                  switchView('plan');
                  $('plan-input').value = rec.result;
                  renderPlan(rec.result);
                },
              })
            : null,
        ]),
      ])
    );
  }
  $('kb-count').textContent = `${fmt(rows.length)} 組・共用配方表共 ${fmt(state.knowledge.length)} 筆`;
  $('kb-more').classList.toggle('hidden', rows.length <= slice.length);
  if (!rows.length) {
    body.appendChild(
      el('tr', {}, [
        el('td', {
          colspan: '6',
          class: 'muted',
          text: '共用配方表是空的。按右上角「⟳ 更新」把遊戲裡的配方收進來，或到「資料」頁匯入別人分享的檔案。',
        }),
      ])
    );
  }
}

// ── 查配方 ──────────────────────────────────────────────
function renderLookup() {
  const a = $('look-a').value.trim();
  const b = $('look-b').value.trim();
  const box = $('look-result');
  box.textContent = '';
  if (!a) return;
  const action = b ? 'combine' : 'refine';
  const inputs = normalizeInputs(action, b ? [a, b] : [a]);
  const rec = state.kbIndex.get(recipeKey(action, inputs));
  const p = predict(rec);

  const div = el('div', { class: `verdict-box ${VERDICT_TONE[p.status]}` });
  div.appendChild(
    el('div', { class: 'big', text: `${inputs.join(' ＋ ')} → ${PREDICT_LABEL[p.status]}` })
  );
  if (p.result) {
    div.appendChild(el('div', { text: `產物：${wordLabel(p.result)}${p.type ? `（${p.type}）` : ''}` }));
  }
  const bits = [];
  if (finderName(rec)) bits.push(`由 ${finderName(rec)} 發現`);
  if (p.globalFirst) bits.push('全服首煉');
  const tries = (p.normal.success || 0) + (p.normal.fail || 0) + (p.pray.success || 0) + (p.pray.fail || 0);
  if (tries) bits.push(`一共嘗試過 ${tries} 次（普通 ${p.normal.success}成/${p.normal.fail}敗・祈禱 ${p.pray.success}成/${p.pray.fail}敗）`);
  if (rec) bits.push(`來源：${sourceLabel(rec.sources)}`);
  if (p.status === 'unknown') bits.push('沒人試過——煉出來就是你的');
  if (bits.length) div.appendChild(el('div', { class: 'sub muted', text: bits.join('・') }));
  box.appendChild(div);
}

// ── 怎麼煉：步驟表 ＋ 路徑樹（同一條路）────────────────
//
// 規劃器算出來的是「用你手上的東西怎麼做出目標」，樹則是同一條路的圖像化。
// 兩者共用同一份 chosen（造物 → 這次選用的配方），所以永遠一致；
// 使用者在樹上點「換一條配方」時，步驟表也會跟著重算。

function treeNodeEl(node) {
  const li = el('li');
  const owned = node.kind === 'owned' || state.owned.has(node.word);
  const label = el('span', { class: `node ${node.kind}` }, [
    el('span', { text: wordLabel(node.word) }),
    owned ? el('span', { class: 'depth', text: '✔ 已持有' }) : null,
    node.kind === 'primordial' ? el('span', { class: 'depth', text: '原質' }) : null,
    node.kind === 'unknown' ? el('span', { class: 'depth', text: '缺料・要去市集買' }) : null,
    node.cycle ? el('span', { class: 'depth', text: '（循環，已截斷）' }) : null,
    node.recipe && node.recipe.action === 'refine' ? el('span', { class: 'tag refine', text: '萃取' }) : null,
    node.recipe && node.recipe.needsPray ? el('span', { class: 'tag pray', text: '需祈禱' }) : null,
    // 樹只能畫一條路，但同一個造物常常有好幾種做法——點這裡換一條
    node.alternatives
      ? el('button', {
          class: 'link',
          title: '換一條配方，步驟表會跟著重算',
          text: `另有 ${node.alternatives} 條配方 ⇄`,
          onclick: () => cycleRecipe(node.word),
        })
      : null,
  ]);
  li.appendChild(label);
  if (node.children.length) {
    const ul = el('ul');
    for (const c of node.children) ul.appendChild(treeNodeEl(c));
    li.appendChild(ul);
  }
  return li;
}

/** 把某個節點換成它的下一條配方，然後整頁重算 */
function cycleRecipe(word) {
  const list = state.recipes.get(word) || [];
  if (list.length < 2) return;
  const fallback = (state.planChosen.get(word) || state.best.get(word) || list[0]).key;
  const cur = state.treePick.get(word) || fallback;
  const i = list.findIndex((r) => r.key === cur);
  state.treePick.set(word, list[(i + 1) % list.length].key);
  renderPlan($('plan-input').value.trim());
}

/** 由樹推回步驟：材料先於產物，跟樹上畫的完全一致 */
function stepsFromTree(tree) {
  const needed = new Map(); // word → recipe
  const missing = new Set();
  const usedOwned = new Set();
  const cycles = new Set(); // 要用到自己才煉得出自己的造物
  (function walk(n) {
    if (n.kind === 'owned' || (n.kind === 'primordial' && !n.recipe)) {
      usedOwned.add(n.word);
      return;
    }
    if (n.kind === 'unknown') {
      missing.add(n.word);
      return;
    }
    if (n.cycle) {
      cycles.add(n.word);
      return;
    }
    if (!n.recipe) return;
    needed.set(n.word, n.recipe);
    n.children.forEach(walk);
  })(tree);

  const have = new Set([...usedOwned, ...missing, ...state.owned]);
  const steps = [];
  const left = new Map(needed);
  let guard = 0;
  while (left.size && guard++ <= needed.size + 5) {
    let moved = false;
    for (const [word, recipe] of [...left]) {
      if (recipe.inputs.every((i) => have.has(i))) {
        steps.push({ ...recipe, result: word });
        have.add(word);
        left.delete(word);
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const [word, recipe] of left) steps.push({ ...recipe, result: word, unresolved: true });
  return { steps, missing: [...missing], usedOwned: [...usedOwned], cycles: [...cycles] };
}

function renderPlanBasis() {
  const inv = state.inventory;
  $('plan-basis').textContent = inv
    ? `依據這個帳號的素材櫃：持有 ${fmt(state.owned.size)} 種造物（快照時間 ${inv.snapshotAt ? fmtTime(inv.snapshotAt) : '未知'}）`
    : '還沒有這個帳號的素材櫃資料——先按右上角「⟳ 更新」，算出來的路徑才會準。';
}

function renderPlan(target) {
  const box = $('plan-result');
  const treeBox = $('plan-tree');
  box.textContent = '';
  $('tree-out').textContent = '';
  if (!target) {
    box.classList.add('hidden');
    treeBox.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  if (state.planTarget !== target) {
    state.treePick.clear(); // 換目標就不要沿用上一個目標的選擇
    state.planTarget = target;
  }

  const mode = $('plan-mode').value;
  const kind = classify(target, state.recipes);
  if (state.owned.has(target)) {
    treeBox.classList.add('hidden');
    box.appendChild(
      el('div', { class: 'verdict-box ok' }, [
        el('div', { class: 'big', text: `你已經有「${wordLabel(target)}」了。` }),
      ])
    );
    return;
  }
  if (kind !== 'crafted') {
    treeBox.classList.add('hidden');
    box.appendChild(
      el('div', { class: 'verdict-box dim' }, [
        el('div', { class: 'big', text: `煉不出「${target}」` }),
        el('div', {
          text:
            kind === 'primordial'
              ? '這是五原質之一，本來就有。'
              : '共用配方表裡還沒有這個造物的配方。',
        }),
        el('div', { class: 'sub muted', text: '按「⟳ 更新」把配方收進來，或匯入別人分享的檔案。' }),
      ])
    );
    return;
  }

  // 規劃器決定走哪條路；使用者在樹上換過的節點覆蓋上去
  const result = planPath(target, state.owned, state.recipes, mode);
  state.planChosen = new Map(result.steps.map((s) => [s.result, s]));
  const bestFor = new Map(state.best);
  for (const [w, s] of state.planChosen) {
    const r = (state.recipes.get(w) || []).find((x) => x.key === s.key);
    if (r) bestFor.set(w, r);
  }
  for (const [w, key] of state.treePick) {
    const alt = (state.recipes.get(w) || []).find((r) => r.key === key);
    if (alt) bestFor.set(w, alt);
  }

  const tree = buildTree(target, state.recipes, bestFor, { stopAt: state.owned });
  const { steps, missing, usedOwned, cycles } = stepsFromTree(tree);
  const picked = state.treePick.size > 0;
  const needsPray = steps.some((s) => s.needsPray);
  // 有循環（要用到自己才煉得出自己）或排不出順序，這條路就是照著做不出來的，
  // 不能還印成「N 步」——那會叫人照著一份根本走不通的順序去花魔力。
  const stuck = steps.filter((s) => s.unresolved).map((s) => s.result);
  const blocked = cycles.length > 0 || stuck.length > 0;

  const head = el('div', { class: `verdict-box ${blocked ? 'bad' : missing.length ? 'pray' : 'ok'}` });
  head.appendChild(
    el('div', {
      class: 'big',
      text: blocked
        ? `這條路走不通`
        : missing.length
          ? `${steps.length} 步，但缺 ${missing.length} 樣材料`
          : `${steps.length} 步就能煉出「${wordLabel(target)}」`,
    })
  );
  head.appendChild(
    el('div', {
      class: 'sub muted',
      text: `${picked ? '你自己選的路徑' : mode === 'steps' ? '最短路徑' : '最少未知'}・用到手上 ${
        usedOwned.length
      } 種材料${needsPray ? '・路徑中有需要祈禱的步驟' : ''}`,
    })
  );
  if (cycles.length) {
    head.appendChild(
      el('div', {
        text: `${cycles.map(wordLabel).join('、')} 要先有自己才煉得出自己（互相循環）——樹上標「循環，已截斷」的就是這裡。`,
      })
    );
  }
  if (stuck.length) {
    head.appendChild(el('div', { text: `排不出順序：${stuck.map(wordLabel).join('、')}——材料要靠它自己（或後面的步驟）才生得出來。` }));
  }
  if (blocked) {
    head.appendChild(
      el('div', {
        class: 'sub muted',
        text: picked
          ? '換一條配方看看，或按下面的「↺ 回到自動選的路徑」。'
          : '樹上有多條配方的節點可以點「另有 N 條配方 ⇄」換一條試試。',
      })
    );
  }
  if (missing.length) {
    head.appendChild(el('div', { text: `缺少：${missing.map(wordLabel).join('、')}（要去市集買，或還沒有人發現配方）` }));
  }
  if (picked) {
    head.appendChild(
      el('p', {}, [
        el('button', {
          class: 'link',
          text: '↺ 回到自動選的路徑',
          onclick: () => {
            state.treePick.clear();
            renderPlan(target);
          },
        }),
      ])
    );
  }
  box.appendChild(head);

  const ol = el('ul', { class: 'steps' });
  if (blocked) {
    // 這種時候編號會誤導人，所以講明白：下面只是這條路用到的配方，不是可以照做的順序
    box.appendChild(
      el('p', { class: 'muted', text: '下面是這條路用到的配方，但因為上面說的原因排不成可以照做的順序：' })
    );
  }
  steps.forEach((s, i) => {
    const li = el('li');
    li.appendChild(el('span', { class: 'no', text: blocked ? '・' : `${i + 1}.` }));
    const line = el('span');
    if (s.action === 'refine') {
      line.appendChild(el('span', { class: 'tag refine', text: '萃取' }));
      line.appendChild(el('span', { class: 'w', text: wordLabel(s.inputs[0]) }));
    } else {
      s.inputs.forEach((w, j) => {
        if (j > 0) line.appendChild(el('span', { class: 'op', text: '＋' }));
        line.appendChild(el('span', { class: 'w', text: wordLabel(w) }));
      });
    }
    line.appendChild(el('span', { class: 'op', text: '→' }));
    line.appendChild(el('span', { class: 'to', text: wordLabel(s.result) }));
    if (s.needsPray) line.appendChild(el('span', { class: 'tag pray', text: '需祈禱' }));
    if (s.unresolved) line.appendChild(el('span', { class: 'tag dim', text: '材料還湊不齊' }));
    const by = s.discoveredBy && (s.discoveredBy.accountName || s.discoveredBy.finderName);
    if (by) line.appendChild(el('span', { class: 'reason', text: `由 ${by} 發現` }));
    li.appendChild(line);
    ol.appendChild(li);
  });
  if (!steps.length) ol.appendChild(el('li', { class: 'muted', text: '不需要任何步驟。' }));
  box.appendChild(ol);

  // 路徑樹
  treeBox.classList.remove('hidden');
  const ul = el('ul');
  ul.appendChild(treeNodeEl(tree));
  $('tree-out').appendChild(ul);
}


function renderSuggest() {
  const items = knownCombosFromOwned(state.owned, state.knowledge, 200);
  const body = $('suggest-body');
  body.textContent = '';
  for (const it of items.slice(0, 200)) {
    const matCell = el('td');
    if (it.action === 'refine') matCell.appendChild(el('span', { class: 'tag refine', text: '萃取' }));
    it.inputs.forEach((w, i) => {
      if (i > 0) matCell.appendChild(el('span', { class: 'op', text: '＋' }));
      matCell.appendChild(el('span', { class: 'w', text: w }));
    });
    const tagCell = el('td');
    if (it.needsPray) tagCell.appendChild(el('span', { class: 'tag pray', text: '需祈禱' }));
    if (it.rarity) tagCell.appendChild(el('span', { class: 'tag dim', text: `${it.rarity}★` }));
    body.appendChild(
      el('tr', {}, [
        matCell,
        el('td', { class: 'res-success', text: wordLabel(it.result) }),
        tagCell,
        el('td', { class: 'muted', text: (it.discoveredBy && (it.discoveredBy.accountName || it.discoveredBy.finderName)) || '—' }),
        el('td', {}, [
          el('button', {
            class: 'link',
            text: '怎麼煉',
            onclick: () => {
              switchView('plan');
              $('plan-input').value = it.result;
              renderPlan(it.result);
            },
          }),
        ]),
      ])
    );
  }
  if (!items.length) {
    body.appendChild(
      el('tr', {}, [
        el('td', {
          colspan: '5',
          class: 'muted',
          text: state.owned.size <= 5
            ? '還沒有這個帳號的素材櫃資料。先按右上角「⟳ 更新」。'
            : '共用配方表裡沒有你手上材料能直接做出來的新東西。按「⟳ 更新」或匯入別人分享的檔案試試。',
        }),
      ])
    );
  }
}

// ── 素材櫃 ──────────────────────────────────────────────
function renderBag() {
  const st = state.accountState || {};
  const cards = [
    ['持有造物', fmt(state.owned.size), state.inventory && state.inventory.snapshotAt ? `快照 ${fmtTime(state.inventory.snapshotAt).slice(5)}` : '尚未同步'],
    ['素材櫃', st.bagUsed != null ? `${fmt(st.bagUsed)} / ${fmt(st.bagLimit)}` : '—', ''],
    ['金砂', st.balance != null ? fmt(st.balance) : '—', ''],
    ['魂元', st.soul != null ? fmt(st.soul) : '—', ''],
    ['魔力', st.stamina ? `${st.stamina.value} / ${st.stamina.cap}` : '—', ''],
    ['最後更新', st.lastSync ? fmtTime(st.lastSync).slice(5) : '尚未更新', ''],
  ];
  const box = $('bag-cards');
  box.textContent = '';
  for (const [k, v, sub] of cards) {
    box.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'k', text: k }),
        el('div', { class: 'v', text: String(v) }),
        sub ? el('div', { class: 'sub', text: sub }) : null,
      ])
    );
  }

  const q = $('bag-search').value.trim();
  const items = state.inventory && state.inventory.items ? Object.values(state.inventory.items) : [];
  const list = items.filter((it) => !q || it.word.includes(q)).sort((a, b) => (b.rarity || 0) - (a.rarity || 0) || a.word.localeCompare(b.word, 'zh-Hant'));
  const wrap = $('bag-list');
  wrap.className = 'chips bag';
  wrap.textContent = '';
  for (const it of list.slice(0, 1500)) {
    wrap.appendChild(
      el('span', { class: 'chip', title: [it.type, it.rarity ? `${it.rarity}★` : null].filter(Boolean).join('・') }, [
        wordLabel(it.word),
      ])
    );
  }
  $('bag-count').textContent = `${fmt(list.length)} 種`;
  $('bag-note').textContent = state.inventory
    ? '這是按「⟳ 更新」時抓到的素材櫃內容，之後在遊戲裡煉出或清出的東西會即時跟著更新。'
    : '還沒有這個帳號的素材櫃資料。按右上角「⟳ 更新」（需要開著遊戲分頁）。';
  if (!list.length && state.inventory) wrap.appendChild(el('span', { class: 'muted', text: '沒有符合的造物。' }));
}

// ── 同步 ────────────────────────────────────────────────
/**
 * 送指令給背景服務。
 * 背景沒回應時不要吞掉原因——那通常代表 service worker 沒在跑
 * （擴充套件改版後沒重新載入，或它自己出錯了），一定要講清楚怎麼修。
 */
function cmd(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (r) => {
        const le = chrome.runtime.lastError;
        if (r === undefined) resolve({ ok: false, noResponse: true, error: le ? le.message : '背景服務沒有回應' });
        else resolve(r);
      });
    } catch (e) {
      resolve({ ok: false, noResponse: true, error: String(e && e.message ? e.message : e) });
    }
  });
}

const SYNC_ERROR_HELP = {
  'no-tab': '找不到遊戲分頁。請先在另一個分頁開啟遊戲並登入，再按一次更新。',
  'stale-tab':
    '遊戲分頁上的擴充套件是舊的。請重新整理遊戲分頁（F5）後再按一次更新——擴充套件更新後，已經開著的分頁需要重整才會接上。',
  '同步進行中': '已經有一個更新在跑了。想重來的話等它結束，或先按「取消」。',
};

function syncErrorText(r) {
  if (r && r.noResponse) {
    return (
      '背景服務沒有回應，更新無法開始。請到 chrome://extensions 找到本擴充套件按「重新載入」，' +
      '再重新整理遊戲分頁與這個頁面。' +
      (r.error ? `（瀏覽器回報：${r.error}）` : '')
    );
  }
  const e = (r && r.error) || '';
  return SYNC_ERROR_HELP[e] || `無法開始更新：${e || '未知錯誤'}`;
}

// 有新版本才浮出來的那顆；按下去開 GitHub 的發布頁，要不要更新自己決定
function showUpdate(u) {
  if (!u || !u.hasUpdate) return;
  const btn = $('update-btn');
  btn.textContent = `⬆ 有新版本 v${u.latest}`;
  btn.title = `目前是 v${u.current}，GitHub 上已經有 v${u.latest}。點一下開發布頁。`;
  btn.classList.remove('hidden');
}

async function startSync() {
  const msg = $('sync-msg');
  if (msg) msg.textContent = '';

  // 先握手，確認背景服務是活的、而且是新版
  const ping = await cmd({ type: 'ia-cmd', cmd: 'ping' });
  if (!ping || !ping.ok) {
    const text = syncErrorText(ping);
    if (msg) msg.textContent = text;
    $('syncbar').classList.remove('hidden');
    $('sync-text').textContent = text;
    return;
  }

  const r = await cmd({ type: 'ia-cmd', cmd: 'sync-start', opts: {} });
  if (!r || !r.ok) {
    const text = syncErrorText(r);
    if (msg) msg.textContent = text;
    $('syncbar').classList.remove('hidden');
    $('sync-text').textContent = text;
    return;
  }
  $('syncbar').classList.remove('hidden');
  $('sync-text').textContent = '準備中…';
}

chrome.runtime.onMessage.addListener((m) => {
  if (!m) return;
  if (m.type === 'ia-reset') {
    localStorage.removeItem(ACCOUNT_PREF);
    load();
    return;
  }
  if (m.type !== 'ia-progress') return;
  if (m.update) showUpdate(m.update);
  const bar = $('syncbar');
  bar.classList.remove('hidden');
  const pct = m.total ? Math.round((m.done / m.total) * 100) : m.phase === 'done' ? 100 : 0;
  $('sync-bar').style.width = `${pct}%`;
  if (m.phase === 'done') {
    const s = m.stats || {};
    const bits = [`素材櫃 ${s.discoveries ?? 0} 種`];
    // 遊戲的 /combine-log 只給最近一批，講清楚是誰的上限，不然會以為是擴充套件漏抓
    const capNote = s.logMode
      ? `・可分頁（${s.logMode}）`
      : s.logServerCap
        ? `・遊戲只給最近 ${s.logServerCap} 筆`
        : '';
    bits.push(`煉製紀錄 ${s.logEntries ?? 0} 筆（含崩解 ${s.logFailures ?? 0}）${capNote}`);
    bits.push(`我發現的配方 ${s.myRecipes ?? 0} 條`);
    bits.push(`軌跡新增 ${(s.logAdded ?? 0) + (s.myRecipesAdded ?? 0)} 筆`);
    bits.push(`共用配方表併入 ${s.learned ?? 0} 組`);
    $('sync-text').textContent = `更新完成：${bits.join('、')}`;
    // 有任何一支失敗就直接把原因寫出來，不要讓使用者看到「更新完成」卻什麼也沒有
    if (s.errors && s.errors.length) {
      const box = $('diag-out');
      box.classList.remove('hidden');
      box.textContent = `這次更新有 ${s.errors.length} 支端點失敗：\n\n${s.errors.join('\n')}\n\n按「診斷」可以看到每支端點的完整回應。`;
      $('sync-msg').textContent = `有 ${s.errors.length} 支端點失敗，詳見下方。`;
    }
    load();
    setTimeout(() => bar.classList.add('hidden'), 8000);
  } else if (m.phase === 'error') {
    $('sync-text').textContent = `更新失敗：${m.error || '未知錯誤'}`;
  } else if (m.phase === 'cancelled') {
    $('sync-text').textContent = '已取消';
    load();
    setTimeout(() => bar.classList.add('hidden'), 4000);
  } else {
    $('sync-text').textContent = `${m.label || '更新中'}${m.total ? `（${m.done}/${m.total}）` : ''}`;
  }
});

// ── 匯出 / 匯入 / 清空 ──────────────────────────────────
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function exportJson() {
  // 備份一律匯出全部帳號，不受目前篩選影響
  // knowledge 是可以分享給別人的部分；attempts 是你自己的軌跡
  const payload = {
    app: 'infinite-alchemy-tracker',
    version: 2,
    exportedAt: Date.now(),
    count: state.raw.length,
    accounts: state.accounts.map(({ key, id, name, isGuest, count }) => ({ key, id, name, isGuest, count })),
    knowledge: state.knowledge,
    attempts: [...state.raw].sort((a, b) => a.ts - b.ts),
  };
  download(`煉製軌跡-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

/**
 * 分享用匯出：只出配方知識庫。
 * 去掉個人軌跡、素材櫃與帳號 id——傳給別人的東西不該夾帶這些。
 * 發現者只留名字（那是遊戲裡本來就公開的資訊）。
 */
function exportShare() {
  const knowledge = state.knowledge.map((k) => ({
    action: k.action,
    inputs: k.inputs,
    result: k.result,
    emoji: k.emoji,
    type: k.type,
    rarity: k.rarity,
    normal: k.normal,
    pray: k.pray,
    globalFirst: !!k.globalFirst,
    finders: (k.finders || []).map((f) => ({ name: f.name })),
    discoveredBy: k.discoveredBy
      ? { accountName: k.discoveredBy.accountName || k.discoveredBy.finderName || null, ts: k.discoveredBy.ts ?? null }
      : null,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  }));
  const payload = {
    app: 'infinite-alchemy-tracker',
    kind: 'knowledge', // 分享用：只有配方
    version: 2,
    exportedAt: Date.now(),
    count: knowledge.length,
    knowledge,
  };
  download(`煉金配方-${stamp()}.json`, JSON.stringify(payload), 'application/json');
  const ok = knowledge.filter((k) => k.result).length;
  $('share-msg').textContent = `已匯出 ${fmt(knowledge.length)} 組配方（其中 ${fmt(ok)} 組煉得出東西）。`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const head = [
    '時間',
    '帳號',
    '行為',
    '材料1',
    '材料2',
    '祈禱',
    '結果',
    '產物',
    '類型',
    '星等',
    '估值',
    '首度發現',
    '全服首煉',
    '獎勵',
    '魔力',
    '原因',
  ];
  const lines = [head.join(',')];
  for (const a of [...state.attempts].sort((x, y) => x.ts - y.ts)) {
    lines.push(
      [
        fmtTime(a.ts),
        a.accountName || (a.accountId != null ? `#${a.accountId}` : ''),
        a.action === 'refine' ? '萃取' : '合成',
        (a.inputs || [])[0] || '',
        (a.inputs || [])[1] || '',
        a.prayed ? '是' : '',
        a.outcome === 'success' ? '成功' : a.outcome === 'fail' ? '崩解' : '未執行',
        a.result || '',
        a.type || '',
        a.rarity || '',
        a.value || '',
        a.isNewDiscovery ? '是' : '',
        a.isGlobalFirst ? '是' : '',
        a.reward || 0,
        a.manaSpent == null ? '' : a.manaSpent,
        a.reason || '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  download(`煉製軌跡-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

async function importJson(file) {
  const msg = $('import-msg');
  msg.textContent = '讀取中…';
  try {
    const data = JSON.parse(await file.text());
    const payload = Array.isArray(data) ? { attempts: data } : data;
    const mine = await getMeta('accounts', null);
    const label = file.name.replace(/\.json$/i, '');

    // 自己的備份：連軌跡一起還原；別人分享的：只吃配方知識
    const isOwnBackup =
      payload.accounts &&
      mine &&
      payload.accounts.some((a) => a.id != null && Object.keys(mine).includes(String(a.id)));

    let restored = 0;
    if (isOwnBackup && Array.isArray(payload.attempts)) {
      const have = new Set(state.raw.map((a) => `${a.ts}|${a.pairKey}|${a.outcome}`));
      const fresh = payload.attempts.filter((a) => !have.has(`${a.ts}|${a.pairKey}|${a.outcome}`));
      restored = fresh.length ? await bulkAdd(fresh) : 0;
    }

    const r = await cmd({ type: 'ia-cmd', cmd: 'import', payload, label });
    if (!r || !r.ok) throw new Error((r && r.error) || '背景服務沒有回應');
    msg.textContent = `共用配方表併入 ${r.merged} 筆（共 ${r.total} 筆）${
      restored ? `，另還原自己的軌跡 ${restored} 筆` : '；你自己的軌跡未變動'
    }。`;
    await load();
  } catch (e) {
    msg.textContent = `匯入失敗：${e.message}`;
  }
}

// ── 分頁切換與事件綁定 ──────────────────────────────────
function switchView(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === name);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('hidden', v.id !== `view-${name}`);
  }
}

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchView(tab.dataset.view);
});

// 重新整理：重讀資料庫再重畫。資料通常沒變，所以一定要給回饋，
// 不然按下去畫面一模一樣，會以為這顆按鈕壞了。
$('reload').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  btn.disabled = true;
  btn.textContent = '重新整理中…';
  try {
    await load();
    btn.textContent = '已重新整理';
  } catch (err) {
    btn.textContent = '重新整理失敗';
  }
  setTimeout(() => {
    btn.textContent = label;
    btn.disabled = false;
  }, 1200);
});

$('account-select').addEventListener('change', async (e) => {
  state.account = e.target.value;
  localStorage.setItem(ACCOUNT_PREF, state.account);
  await applyAccountFilter();
  buildKnowledgeViews(); // 素材櫃換了，造物樣貌也要跟著重建
  renderAll(); // 裡面已經包含 renderPlanBasis 與重畫路徑
});

// 更新（同步）
$('sync').addEventListener('click', () => startSync());
$('sync-run').addEventListener('click', () => startSync());
$('sync-cancel').addEventListener('click', () => cmd({ type: 'ia-cmd', cmd: 'sync-cancel' }));

// 版本提示：只讀上次按「更新」時查到的結果，開儀表板不會自己去打 GitHub
$('update-btn').addEventListener('click', () => cmd({ type: 'ia-cmd', cmd: 'open-release' }));
cmd({ type: 'ia-cmd', cmd: 'check-update', opts: { cachedOnly: true } }).then(showUpdate);

// 全服動態收集（開關存在 chrome.storage.local，遊戲分頁的 content script 直接讀得到）
async function renderFeed() {
  const r = await cmd({ type: 'ia-cmd', cmd: 'feed-stats' });
  const s = (r && r.ok && r.stats) || null;
  $('feed-stats').textContent =
    s && s.polls
      ? `已讀取 ${fmt(s.polls)} 次、看過 ${fmt(s.rows)} 筆紀錄、併入 ${fmt(s.learned)} 組配方${
          s.lastAt ? `・最後一次 ${fmtTime(s.lastAt).slice(5)}` : ''
        }`
      : '尚未收集過';
}

$('feed-toggle').addEventListener('change', (e) => {
  const on = e.target.checked;
  $('feed-state').textContent = on ? '開啟中' : '關閉';
  try {
    chrome.storage.local.set({ globalFeed: on });
  } catch (_) {
    $('feed-state').textContent = '無法儲存設定';
  }
});

try {
  chrome.storage.local.get(['globalFeed'], (v) => {
    const on = !!(v && v.globalFeed);
    $('feed-toggle').checked = on;
    $('feed-state').textContent = on ? '開啟中' : '關閉';
  });
} catch (_) {
  /* 測試頁沒有 chrome API */
}

$('diagnose').addEventListener('click', async () => {
  const box = $('diag-out');
  box.classList.remove('hidden');
  box.textContent = '診斷中…';
  const r = await cmd({ type: 'ia-cmd', cmd: 'diagnose' });
  box.textContent = !r || !r.ok ? syncErrorText(r) : r.report;
});

$('rebuild').addEventListener('click', async () => {
  $('sync-msg').textContent = '重建中…';
  const r = await cmd({ type: 'ia-cmd', cmd: 'rebuild-knowledge' });
  $('sync-msg').textContent = r && r.ok ? `已由 ${r.from} 筆軌跡重建出 ${r.rebuilt} 組配方。` : '重建失敗';
  await load();
});

// 共用配方表
$('kb-search').addEventListener('input', () => {
  state.kbShown = PAGE;
  renderKnowledge();
});
$('kb-filter').addEventListener('change', () => {
  state.kbShown = PAGE;
  renderKnowledge();
});
$('kb-more').addEventListener('click', () => {
  state.kbShown += PAGE;
  renderKnowledge();
});

// 查配方
$('look-go').addEventListener('click', renderLookup);
for (const id of ['look-a', 'look-b']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renderLookup();
  });
}

// 怎麼煉
$('plan-go').addEventListener('click', () => renderPlan($('plan-input').value.trim()));
$('plan-mode').addEventListener('change', () => {
  const t = $('plan-input').value.trim();
  if (t) renderPlan(t);
});
$('plan-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') renderPlan($('plan-input').value.trim());
});

// 素材櫃
$('bag-search').addEventListener('input', renderBag);

// 軌跡
$('log-search').addEventListener('input', () => {
  state.logShown = PAGE;
  renderLog();
});
$('log-filter').addEventListener('change', () => {
  state.logShown = PAGE;
  renderLog();
});
$('log-more').addEventListener('click', () => {
  state.logShown += PAGE;
  renderLog();
});

// 資料
$('export-share').addEventListener('click', exportShare);
$('export-json').addEventListener('click', exportJson);
$('export-csv').addEventListener('click', exportCsv);
$('import-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importJson(f);
});

$('clear-all').addEventListener('click', async () => {
  if (!confirm('要刪除所有煉製軌跡嗎？\n共用配方表、素材櫃與帳號狀態會保留。\n此動作無法復原。')) return;
  await clearAttempts();
  $('clear-msg').textContent = '軌跡已清空。';
  await load();
});

$('reset-all').addEventListener('click', async () => {
  if (
    !confirm(
      '完全重置：軌跡、共用配方表、素材櫃、帳號狀態、帳號名冊全部刪除，\n' +
        '擴充套件會回到剛安裝的狀態。\n\n' +
        '此動作無法復原。建議先匯出 JSON 備份。\n確定要繼續嗎？'
    )
  )
    return;
  if (!confirm('再確認一次：真的要清成全新的嗎？')) return;

  $('clear-msg').textContent = '重置中…';
  const r = await cmd({ type: 'ia-cmd', cmd: 'reset-all' });
  if (!r || !r.ok) {
    $('clear-msg').textContent = syncErrorText(r);
    return;
  }
  const c = r.cleared || {};
  $('clear-msg').textContent = `已重置：軌跡 ${fmt(c.attempts)}、配方 ${fmt(c.knowledge)}、素材櫃 ${fmt(
    c.inventory
  )}、帳號狀態 ${fmt(c.accountState)}、目標 ${fmt(c.goals)} 筆全部清掉。現在是全新狀態，可以去按「⟳ 更新」測試了。`;
  localStorage.removeItem(ACCOUNT_PREF);
  await load();
});

// 開新紀錄進來時自動更新（dashboard 開著也會即時反映）
setInterval(async () => {
  const [a, k] = await Promise.all([countAttempts(), countKnowledge()]);
  if (a !== state.raw.length || k !== state.knowledge.length) load();
}, 5000);

// 網址帶 ?plan=xxx（或舊的 ?word=xxx）直接查那個造物怎麼煉
const params = new URLSearchParams(location.search);
load().then(() => {
  const t = params.get('plan') || params.get('word');
  if (t) {
    switchView('plan');
    $('plan-input').value = t;
    renderPlan(t);
  }
});
