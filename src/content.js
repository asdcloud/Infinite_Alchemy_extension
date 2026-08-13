// ISOLATED world：
//   1. 把 inject.js 旁聽到的事件轉給 service worker
//   2. 執行「更新」同步——用遊戲分頁自己的登入身分讀取你的帳號狀態
//   3. 掛上遊戲內浮層
//
// 同步一定要在這裡做：擴充套件背景的 fetch 帶不到遊戲的登入 cookie，
// 只有跑在遊戲頁面上的 content script 才是同源請求。
//
// 注意：content script 看到的 IndexedDB 是「遊戲頁面」的，不是擴充套件的，
// 所以浮層要的資料一律透過 sendMessage 向 service worker 拿，不能直接開 db。

const API = '/api';

// ── 事件橋接 ───────────────────────────────────────────
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.__iaTracker !== 1 || !data.payload) return;
  send({ type: 'ia-event', payload: data.payload });
});

function send(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    /* Extension context invalidated：重新整理遊戲頁面即可恢復 */
  }
}

function sendAsync(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// ── 同步執行器 ─────────────────────────────────────────
const syncState = { running: false, cancel: false };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'ia-sync-run') {
    if (syncState.running) {
      sendResponse({ ok: false, error: '同步進行中' });
      return true;
    }
    runSync(msg.opts || {}).catch((e) => progress({ phase: 'error', error: String(e && e.message ? e.message : e) }));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ia-sync-cancel') {
    syncState.cancel = true;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ia-overlay-toggle') {
    window.dispatchEvent(new CustomEvent('ia-overlay-toggle'));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ia-diagnose') {
    diagnose()
      .then((report) => sendResponse({ ok: true, report }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
});

/**
 * 診斷：把每支端點的原始回應攤開來看。
 * 「讀不到」有很多種可能——端點回 4xx、欄位名不同、陣列是空的——
 * 靠猜沒有意義，直接把伺服器回什麼印出來。
 */
async function diagnose() {
  const targets = [
    ['/me', null],
    ['/me/discoveries', 'nodes'],
    ['/me/seeds', 'seeds'],
    ['/me/inventions', 'inventions'],
    ['/combine-log', 'entries'],
    ['/me/recipes?offset=0', 'recipes'],
  ];
  const lines = [];
  for (const [path, arrayKey] of targets) {
    let res;
    try {
      res = await fetch(`${API}${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      lines.push(`${path}\n    連線失敗：${e.message}`);
      continue;
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      /* 不是 JSON */
    }
    if (!data) {
      lines.push(`${path}\n    HTTP ${res.status}・回應不是 JSON：${text.slice(0, 120)}`);
      continue;
    }
    const keys = Object.keys(data);
    const out = [`${path}\n    HTTP ${res.status}・頂層欄位：${keys.join(', ') || '(無)'}`];
    // 找出回應裡所有的陣列，列出長度——欄位名跟我猜的不同時一眼就看得出來
    for (const k of keys) {
      const v = data[k];
      if (Array.isArray(v)) {
        out.push(`    ${k}: 陣列，${v.length} 筆${k === arrayKey ? '（擴充套件讀的就是這個）' : ''}`);
        if (v.length) {
          const first = v[0];
          out.push(
            typeof first === 'object' && first
              ? `      第一筆的欄位：${Object.keys(first).join(', ')}`
              : `      第一筆：${JSON.stringify(first)}`
          );
          if (typeof first === 'object' && first) out.push(`      第一筆內容：${JSON.stringify(first).slice(0, 220)}`);
        }
      } else if (v !== null && typeof v === 'object') {
        out.push(`    ${k}: 物件 {${Object.keys(v).join(', ')}}`);
      } else {
        out.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
    if (arrayKey && !keys.includes(arrayKey)) {
      out.push(`    ⚠ 找不到預期的欄位「${arrayKey}」——這就是讀不到的原因`);
    }
    lines.push(out.join('\n'));
  }
  return lines.join('\n\n');
}

function progress(p) {
  send({ type: 'ia-sync-progress', ...p });
  window.dispatchEvent(new CustomEvent('ia-sync-progress', { detail: p }));
}

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * 更新這個帳號的狀態。只讀「我自己的」那幾支，**不會逐一走訪你的造物**：
 *
 *   /me                  帳號、金砂、魂元、魔力、素材櫃格數
 *   /me/discoveries      素材櫃內容（我持有的造物）——規劃器要靠它算路徑
 *   /me/seeds            原初五元素
 *   /me/inventions       世上創生（＝真正的全服首煉，用來標記補回來的紀錄）
 *   /combine-log         ★ 我自己的煉製紀錄，含崩解與祈禱 → 軌跡 ＋ 共用配方表
 *   /me/recipes?offset=N ★ 所有由我首度發現的配方（分頁）→ 軌跡 ＋ 共用配方表
 *
 * 全部都是「我自己的」，不會對每個造物逐一發問。
 */
function note(stats, path, e) {
  stats.failed++;
  stats.errors.push(`${path}：${e && e.status ? `HTTP ${e.status}` : ''}${e && e.message ? ` ${e.message}` : ''}`.trim());
}

async function runSync(opts) {
  syncState.running = true;
  syncState.cancel = false;
  const stats = {
    discoveries: 0,
    inventions: 0,
    logEntries: 0,
    logFailures: 0,
    logAdded: 0, // 補進軌跡的煉製紀錄
    logServerCap: 0, // /combine-log 一次給幾筆
    logMode: null, // 'limit' | 'offset' | null（都不支援，只拿得到最近那批）
    myRecipes: 0,
    myRecipesAdded: 0,
    learned: 0, // 併進共用配方表的配方數
    pages: 0,
    failed: 0,
    errors: [], // 哪一支失敗、失敗原因——不要再默默吞掉
  };
  const ts = Date.now();
  void opts;

  try {
    progress({ phase: 'account', label: '讀取帳號狀態…', done: 0, total: 0 });
    const me = await api('/me');
    await sendAsync({ type: 'ia-sync-data', kind: 'me', data: me, ts });

    progress({ phase: 'inventory', label: '讀取素材櫃…', done: 0, total: 0 });
    const disc = await api('/me/discoveries');
    stats.discoveries = (disc.nodes || []).length;
    await sendAsync({ type: 'ia-sync-data', kind: 'discoveries', data: disc, ts });

    try {
      const seeds = await api('/me/seeds');
      await sendAsync({ type: 'ia-sync-data', kind: 'seeds', data: seeds, ts });
    } catch (_) {
      /* 沒有這支或沒權限就算了 */
    }

    // 世上創生＝真正的「全服首煉」，要拿來判定補回來的紀錄該不該掛那個標記。
    // （/me/recipes 是「新配方」＝第一個找到這條做法，兩者不同）
    progress({ phase: 'inventions', label: '讀取世上創生…', done: 0, total: 0 });
    try {
      const inv = await api('/me/inventions');
      stats.inventions = ((inv.inventions || inv.nodes || inv.items) || []).length;
      await sendAsync({ type: 'ia-sync-data', kind: 'inventions', data: inv, ts });
    } catch (e) {
      note(stats, '/me/inventions', e);
    }

    // ★ 我自己的煉製紀錄（含崩解與祈禱）→ 軌跡 ＋ 共用配方表
    //
    // 這支沒有文件化的分頁參數，一次拿到多少由伺服器決定（實測是最近 100 筆）。
    // 我們照原樣拿一次，再試 limit / offset 兩種常見寫法——伺服器有支援就能多拿一些；
    // 不支援的話會回一模一樣的內容，偵測到沒有新資料就立刻停手，最多只多打兩個請求。
    progress({ phase: 'log', label: '讀取我的煉製紀錄…', done: 0, total: 0 });
    const seenLogIds = new Set();

    const idOf = (e) => e && (e.id ?? `${e.action}|${e.a}|${e.b ?? ''}|${e.createdAt ?? ''}`);

    /** 抓一頁，只把沒看過的送出去；回傳 { got, fresh } */
    async function pullLog(path) {
      let log;
      try {
        log = await api(path);
      } catch (e) {
        note(stats, path, e);
        return { got: 0, fresh: 0 };
      }
      const rows = log.entries || [];
      const fresh = rows.filter((e) => {
        const id = idOf(e);
        if (seenLogIds.has(id)) return false;
        seenLogIds.add(id);
        return true;
      });
      if (fresh.length) {
        stats.logEntries += fresh.length;
        const r = await sendAsync({ type: 'ia-sync-data', kind: 'combine-log', data: { entries: fresh }, ts });
        stats.learned += (r && r.learned) || 0;
        stats.logAdded += (r && r.added) || 0;
        stats.logFailures += (r && r.failures) || 0; // 崩解也是知識
        progress({ phase: 'log', label: `讀取我的煉製紀錄…（${stats.logEntries} 筆）`, done: 0, total: 0 });
      }
      return { got: rows.length, fresh: fresh.length };
    }

    const first = await pullLog('/combine-log');
    stats.logServerCap = first.got; // 伺服器一次給幾筆

    if (first.got) {
      // 試 limit：要得比預設多才算它有支援
      const bigger = await pullLog(`/combine-log?limit=${Math.max(1000, first.got * 10)}`);
      if (bigger.fresh > 0) {
        stats.logMode = 'limit';
      } else {
        // 再試 offset：翻到沒有新資料為止
        let offset = first.got;
        for (let page = 0; page < 100; page++) {
          if (syncState.cancel) {
            progress({ phase: 'cancelled', label: '已取消', stats });
            return;
          }
          const p = await pullLog(`/combine-log?offset=${offset}`);
          if (!p.fresh) break;
          stats.logMode = 'offset';
          offset += p.got;
          await new Promise((r2) => setTimeout(r2, 150));
        }
      }
    }

    // ★ 所有由我首度發現的配方 → 配方知識庫（分頁，不是逐一走訪造物）
    let offset = 0;
    let total = 0;
    for (let page = 0; page < 200; page++) {
      if (syncState.cancel) {
        progress({ phase: 'cancelled', label: '已取消', stats });
        return;
      }
      let data;
      try {
        data = await api(`/me/recipes?offset=${offset}`);
      } catch (e) {
        note(stats, '/me/recipes', e);
        break;
      }
      const rows = data.recipes || [];
      total = data.total ?? total;
      stats.pages++;
      stats.myRecipes += rows.length;
      progress({
        phase: 'my-recipes',
        label: '收錄我發現的配方…',
        done: offset + rows.length,
        total: total || offset + rows.length,
        stats,
      });
      if (rows.length) {
        const r = await sendAsync({ type: 'ia-sync-data', kind: 'my-recipes', data, ts: Date.now() });
        stats.learned += (r && r.learned) || 0;
        stats.myRecipesAdded += (r && r.added) || 0;
      }
      offset += rows.length;
      if (!data.hasMore || !rows.length) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    progress({ phase: 'done', label: '更新完成', stats });
  } catch (e) {
    progress({ phase: 'error', error: String(e && e.message ? e.message : e), stats });
  } finally {
    syncState.running = false;
  }
}

// ── 浮層 ───────────────────────────────────────────────
// content script 是 classic script，不能靜態 import；用動態 import 載入模組
// （overlay.js 必須列在 manifest 的 web_accessible_resources）。
import(chrome.runtime.getURL('src/overlay.js'))
  .then((m) => m.mountOverlay({ sendAsync, runSync: (opts) => runSync(opts) }))
  .catch(() => {
    /* 浮層載入失敗不影響記錄功能 */
  });
