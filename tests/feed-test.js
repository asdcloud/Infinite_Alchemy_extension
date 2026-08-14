// 全服動態輪詢器（content.js）的行為測試。
// 重點：預設關閉不發請求、開了才發、拿不到租約就不打、同一列不重複送。
const o = document.getElementById('out');
const out = [];
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; out.push('  ok   ' + n); } else { fail++; out.push('  FAIL ' + n + ' → ' + e); }
};

const calls = [];
const sent = [];
let granted = true;
let storageValue = {};
let storageListener = null;

const makeRows = (from, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    action: 'combine',
    a: 'a' + (from + i),
    b: 'b',
    resultWord: 'r' + (from + i),
    finderName: '路人',
    createdAt: 1700000000000 + from + i,
  }));

let feedRows = makeRows(0, 3);

window.chrome = {
  runtime: {
    id: 't',
    onMessage: { addListener(f) { window.__cs = f; } },
    sendMessage(m, cb) {
      if (m.type === 'ia-cmd' && m.cmd === 'feed-claim') { if (cb) cb({ ok: true, granted }); return; }
      if (m.type === 'ia-sync-data' && m.kind === 'global-feed') { sent.push(m.rows); if (cb) cb({ ok: true, learned: m.rows.length }); return; }
      // 背景在「完成／失敗」那一則會把版本檢查結果放進回覆
      if (m.type === 'ia-sync-progress' && (m.phase === 'done' || m.phase === 'error')) {
        if (cb) cb({ ok: true, update: { hasUpdate: true, latest: '9.9.9', current: '1.0.0' } });
        return;
      }
      if (cb) cb({ ok: true });
    },
    getURL: (p) => p,
  },
  storage: {
    local: {
      get(keys, cb) { if (cb) cb(storageValue); },
      set(v) { Object.assign(storageValue, v); },
    },
    onChanged: { addListener(f) { storageListener = f; } },
  },
};

window.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/api/ranking/recent')) return new Response(JSON.stringify({ combines: feedRows }), { status: 200 });
  return new Response('{}', { status: 200 });
};

const feedCalls = () => calls.filter((c) => c.includes('ranking/recent')).length;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await import('/src/content.js');
await wait(150);

out.push('[預設關閉]');
check('沒設定過就不發任何請求', feedCalls() === 0, String(feedCalls()));
check('也沒送任何東西給背景', sent.length === 0, JSON.stringify(sent));

out.push('[開啟]');
storageListener({ globalFeed: { newValue: true } }, 'local');
await wait(200);
check('開啟後立刻讀一次', feedCalls() === 1, String(feedCalls()));
check('三列都送給背景', sent.length === 1 && sent[0].length === 3, JSON.stringify(sent.map((s) => s.length)));

out.push('[去重]');
storageListener({ globalFeed: { newValue: false } }, 'local');
storageListener({ globalFeed: { newValue: true } }, 'local'); // 再開一次會立刻再讀
await wait(200);
check('又讀了一次', feedCalls() === 2, String(feedCalls()));
check('同樣的列不會重送', sent.length === 1, JSON.stringify(sent.map((s) => s.length)));

feedRows = feedRows.concat(makeRows(100, 2)); // 出現兩列新的
storageListener({ globalFeed: { newValue: false } }, 'local');
storageListener({ globalFeed: { newValue: true } }, 'local');
await wait(200);
check('只送新出現的兩列', sent.length === 2 && sent[1].length === 2, JSON.stringify(sent.map((s) => s.length)));

out.push('[關閉]');
storageListener({ globalFeed: { newValue: false } }, 'local');
const before = feedCalls();
await wait(200);
check('關掉之後不再發請求', feedCalls() === before, `${feedCalls()} vs ${before}`);

out.push('[版本檢查要真的傳得到浮層]');
// 背景把結果放在「進度回報」的回覆裡（runtime 廣播送不到 content script），
// content.js 得把它撈出來轉成 ia-update-info 事件，浮層才收得到。
// 這一段斷過一次：浮層去讀進度事件本身的 update，那裡永遠是空的。
const seenUpdates = [];
window.addEventListener('ia-update-info', (e) => seenUpdates.push(e.detail));
window.__cs({ type: 'ia-sync-run', opts: {} }, {}, () => {});
await wait(600);
check('跑完更新後有把版本檢查結果轉發給浮層', seenUpdates.length >= 1, JSON.stringify(seenUpdates));
check('轉發的就是背景回的那份', seenUpdates[0] && seenUpdates[0].latest === '9.9.9', JSON.stringify(seenUpdates[0]));

out.push('[沒拿到租約]');
granted = false;
storageListener({ globalFeed: { newValue: true } }, 'local');
await wait(200);
check('租約被別的分頁佔著就不打 ranking', feedCalls() === before, `${feedCalls()} vs ${before}`);
storageListener({ globalFeed: { newValue: false } }, 'local');

out.push('[防呆：遊戲把合成紀錄拿掉時要自己收手]');
// 2026-08 遊戲改版就把「全服最新的合成紀錄」這個排行榜整個拿掉了：
// 端點還在、回 200，但內容裡沒有 combines。不防呆的話就會每 30 秒空打一次，永遠沒結果。
const gaveUp = [];
const realSend = window.chrome.runtime.sendMessage;
window.chrome.runtime.sendMessage = (m, cb) => {
  if (m.type === 'ia-cmd' && m.cmd === 'feed-give-up') {
    gaveUp.push(m.reason);
    if (cb) cb({ ok: true });
    return;
  }
  return realSend(m, cb);
};
// 每次「關掉再打開」就等於再輪詢一次（打開的當下會立刻讀一次）
const pollOnce = async () => {
  storageListener({ globalFeed: { newValue: false } }, 'local');
  storageListener({ globalFeed: { newValue: true } }, 'local');
  await wait(120);
};

granted = true;
window.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('/api/ranking/recent')) return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  return new Response('{}', { status: 200 });
};
await pollOnce();
check('第一次讀不到還不會放棄', gaveUp.length === 0, JSON.stringify(gaveUp));
await pollOnce();
check('第二次也還在忍', gaveUp.length === 0, JSON.stringify(gaveUp));
await pollOnce();
check('連續三次讀不到就自己收手', gaveUp.length === 1, JSON.stringify(gaveUp));
check('而且說得出是為什麼', /沒有合成紀錄/.test(gaveUp[0] || ''), gaveUp[0]);

// 空陣列不算失敗——可能只是這 30 秒剛好沒人煉
gaveUp.length = 0;
window.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('/api/ranking/recent')) return new Response(JSON.stringify({ combines: [] }), { status: 200 });
  return new Response('{}', { status: 200 });
};
for (let i = 0; i < 4; i++) await pollOnce();
check('拿到空陣列不算失敗，不會誤關', gaveUp.length === 0, JSON.stringify(gaveUp));

// 整支讀不到（斷網、401）也要收手
window.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('/api/ranking/recent')) return new Response('{"error":"尚未登入"}', { status: 401 });
  return new Response('{}', { status: 200 });
};
for (let i = 0; i < 3; i++) await pollOnce();
check('連續三次整支讀不到也會收手', gaveUp.length === 1, JSON.stringify(gaveUp));
check('原因寫得出是讀不到', /讀不到/.test(gaveUp[0] || ''), gaveUp[0]);

storageListener({ globalFeed: { newValue: false } }, 'local');
window.chrome.runtime.sendMessage = realSend;

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
o.textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
