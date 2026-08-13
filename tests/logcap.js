// combine-log 的抓取策略：伺服器只給固定一批時要停手；支援 limit / offset 時要繼續翻。
// 這支測試釘住「100 筆是伺服器的上限，不是擴充套件的」。
const o = document.getElementById('out');
const out = [];
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; out.push('  ok   ' + n); } else { fail++; out.push('  FAIL ' + n + ' → ' + e); }
};

const calls = [];
const makeEntries = (from, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    action: 'combine',
    a: 'x' + (from + i),
    b: 'y',
    resultWord: 'r' + (from + i),
    createdAt: 1700000000000 + from + i,
  }));

function install(handler) {
  calls.length = 0;
  window.chrome = {
    runtime: {
      id: 't',
      onMessage: { addListener(f) { window.__cs = f; } },
      sendMessage(m, cb) { if (cb) cb({ ok: true, learned: 0, added: 0, failures: 0 }); },
      getURL: (p) => p,
    },
    storage: { local: { get(k, cb) { if (cb) cb({}); }, set() {} } },
  };
  window.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/combine-log')) return new Response(JSON.stringify({ entries: handler(u) }), { status: 200 });
    if (u.includes('/api/me/recipes')) return new Response(JSON.stringify({ total: 0, recipes: [], hasMore: false }), { status: 200 });
    if (u.includes('/api/me/discoveries')) return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
}

let started = false;
async function run() {
  if (!started) { await import('/src/content.js'); started = true; await new Promise((r) => setTimeout(r, 100)); }
  const done = new Promise((resolve) => {
    const h = (e) => {
      if (e.detail && (e.detail.phase === 'done' || e.detail.phase === 'error')) {
        window.removeEventListener('ia-sync-progress', h);
        resolve(e.detail);
      }
    };
    window.addEventListener('ia-sync-progress', h);
  });
  window.__cs({ type: 'ia-sync-run', opts: {} }, {}, () => {});
  return done;
}

const logCalls = () => calls.filter((c) => c.includes('combine-log')).length;

// 情境一：伺服器固定回最近 100 筆，忽略 limit 與 offset（＝目前遊戲的實際行為）
out.push('[伺服器只給最近一批]');
install(() => makeEntries(0, 100));
let d = await run();
check('只拿到伺服器給的 100 筆', d.stats.logEntries === 100, String(d.stats.logEntries));
check('記下伺服器上限 100', d.stats.logServerCap === 100, String(d.stats.logServerCap));
check('判定為不支援分頁', d.stats.logMode === null, String(d.stats.logMode));
check('探測完就停手（最多 3 個請求）', logCalls() <= 3, String(logCalls()));

// 情境二：伺服器吃 limit → 一次要更多
out.push('[伺服器支援 limit]');
install((u) => {
  const m = /limit=(\d+)/.exec(u);
  return makeEntries(0, m ? Math.min(Number(m[1]), 350) : 100);
});
d = await run();
check('用 limit 拿到 350 筆', d.stats.logEntries === 350, String(d.stats.logEntries));
check('模式記成 limit', d.stats.logMode === 'limit', String(d.stats.logMode));

// 情境三：伺服器吃 offset → 一頁一頁翻到底
out.push('[伺服器支援 offset]');
install((u) => {
  const m = /offset=(\d+)/.exec(u);
  const off = m ? Number(m[1]) : 0;
  if (/limit=/.test(u)) return makeEntries(0, 100); // limit 不支援，回一樣的
  return off >= 250 ? [] : makeEntries(off, Math.min(100, 250 - off));
});
d = await run();
check('翻完 250 筆', d.stats.logEntries === 250, String(d.stats.logEntries));
check('模式記成 offset', d.stats.logMode === 'offset', String(d.stats.logMode));

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
o.textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
