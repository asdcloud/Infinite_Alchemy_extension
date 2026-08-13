// 重現「按更新 → 未知錯誤」：把 background.js 當成 service worker 載入，
// 用假的 chrome API 捕捉它註冊的 onMessage listener，然後真的送一則 ia-cmd 進去。
const out = [];
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    out.push('  ok   ' + name);
  } else {
    fail++;
    out.push('  FAIL ' + name + ' → ' + extra);
  }
};

let listener = null;
const calls = { tabsQuery: [], tabsSendMessage: [], created: [] };
let queryResult = [{ id: 7, url: 'https://pillars-of-creation.funtuan.work/' }];
let sendMessageBehaviour = () => Promise.resolve({ ok: true });

window.chrome = {
  runtime: {
    id: 'testext',
    onMessage: { addListener: (fn) => (listener = fn) },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage() {},
    getURL: (p) => 'chrome-extension://testext/' + p,
  },
  tabs: {
    query: (q) => {
      calls.tabsQuery.push(q);
      return Promise.resolve(queryResult);
    },
    sendMessage: (id, m) => {
      calls.tabsSendMessage.push([id, m]);
      return sendMessageBehaviour();
    },
    onRemoved: { addListener() {} },
    create: (o) => {
      calls.created.push(o);
      return Promise.resolve({});
    },
  },
  tabs_onRemoved_shim: true,
  action: {
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
  },
};

await import('/src/background.js');

check('background.js 有註冊 onMessage listener', typeof listener === 'function', String(typeof listener));

// 模擬儀表板送出的訊息
function send(msg, sender) {
  return new Promise((resolve) => {
    let replied = false;
    const sendResponse = (r) => {
      replied = true;
      resolve({ replied: true, r });
    };
    const ret = listener(msg, sender, sendResponse);
    // 沒回傳 true 而且沒同步回覆 → 訊息通道會關閉，呼叫端收到 undefined（就是「未知錯誤」）
    if (ret !== true && !replied) resolve({ replied: false, ret });
    setTimeout(() => resolve({ replied, timeout: true }), 2500);
  });
}

const dashSender = { id: 'testext', url: 'chrome-extension://testext/ui/dashboard.html' };
const gameSender = { id: 'testext', url: 'https://pillars-of-creation.funtuan.work/' };
// db-stub 會把 addAttempt 寫進來，讓測試看得到補了什麼
const written = window.__iaWritten;

out.push('[sync-start：有遊戲分頁]');
let res = await send({ type: 'ia-cmd', cmd: 'sync-start', opts: { deep: true, skipWords: [] } }, dashSender);
check('有回覆（沒回覆就是「未知錯誤」）', res.replied === true, JSON.stringify(res));
check('回覆 ok=true', res.r && res.r.ok === true, JSON.stringify(res.r));
check('有查詢遊戲分頁', calls.tabsQuery.length === 1, JSON.stringify(calls.tabsQuery));
check('有通知 content script 開跑', calls.tabsSendMessage.length === 1 && calls.tabsSendMessage[0][1].type === 'ia-sync-run', JSON.stringify(calls.tabsSendMessage));

out.push('[卡死的同步不能永遠擋住後續]');
// 前一次 sync-start 已把 running 設成 true，且不會有 done 回來
res = await send({ type: 'ia-cmd', cmd: 'sync-start', opts: {} }, dashSender);
check('進行中時會擋住第二次', res.r && res.r.error === '同步進行中', JSON.stringify(res.r));
res = await send({ type: 'ia-cmd', cmd: 'sync-start', opts: { force: true } }, dashSender);
check('force 可以硬開', res.r && res.r.ok === true, JSON.stringify(res.r));

out.push('[sync-start：找不到遊戲分頁]');
queryResult = [];
res = await send({ type: 'ia-cmd', cmd: 'sync-start', opts: { force: true } }, dashSender);
check('仍然有回覆', res.replied === true, JSON.stringify(res));
check('錯誤碼是 no-tab', res.r && res.r.error === 'no-tab', JSON.stringify(res.r));

out.push('[sync-start：content script 是舊的（分頁沒重整）]');
queryResult = [{ id: 7, url: 'https://pillars-of-creation.funtuan.work/' }];
sendMessageBehaviour = () => Promise.reject(new Error('Could not establish connection.'));
res = await send({ type: 'ia-cmd', cmd: 'sync-start', opts: { force: true } }, dashSender);
check('仍然有回覆', res.replied === true, JSON.stringify(res));
check('錯誤碼是 stale-tab', res.r && res.r.error === 'stale-tab', JSON.stringify(res.r));

out.push('[ping 握手]');
res = await send({ type: 'ia-cmd', cmd: 'ping' }, dashSender);
check('ping 有回覆且帶版本', res.r && res.r.ok === true && !!res.r.version, JSON.stringify(res.r));

out.push('[我的煉製紀錄 → 軌跡 ＋ 共用配方表]');
// combine-log：一筆成功、一筆失敗、一筆祈禱、一筆已經即時記過的（水+火→蒸氣）
const LOG = {
  entries: [
    { id: 1, action: 'combine', a: '土', b: '水', resultWord: '泥', resultEmoji: '🟤', failed: false, prayed: false, createdAt: 1700000000000 },
    { id: 2, action: 'combine', a: '風', b: '火', resultWord: null, failed: true, prayed: false, createdAt: 1700000100000 },
    { id: 3, action: 'refine', a: '土', resultWord: '塵', resultEmoji: '🌫️', failed: false, prayed: true, createdAt: 1700000200000 },
    { id: 4, action: 'combine', a: '水', b: '火', resultWord: '蒸氣', resultEmoji: '💨', failed: false, prayed: false, createdAt: 1700000300000 },
    { id: 5, action: 'combine', a: '土', b: '水', resultWord: '泥', resultEmoji: '🟤', failed: false, prayed: false, createdAt: 1700000400000 },
  ],
};
written.length = 0;
window.__iaLearned = [];
res = await send({ type: 'ia-sync-data', kind: 'combine-log', data: LOG, ts: Date.now() }, gameSender);
check('有回覆', res.replied === true, JSON.stringify(res));
// LOG 有 5 筆（其中 1 筆失敗、泥重複兩次）→ 5 筆都要送進配方表
check('五筆都收進配方表（含失敗那筆）', res.r && res.r.seen === 5, JSON.stringify(res.r));
check('有算出崩解筆數', res.r && res.r.failures === 1, JSON.stringify(res.r));
const failKey = window.__iaLearned.find((e) => e.key === 'combine:火|風');
check('崩解那組確實進了配方表', !!failKey, window.__iaLearned.map((e) => e.key).join(','));
check('崩解那組標成 fail、沒有產物', failKey && failKey.rec.normal.outcome === 'fail' && failKey.rec.result === null, JSON.stringify(failKey && failKey.rec.normal));

// 同一批也要進軌跡：水+火→蒸氣 已經有即時紀錄了不補；泥重複兩次只補一次 → 新增 3 筆
check('煉製紀錄有補進軌跡', res.r && res.r.added === 3, JSON.stringify(res.r));
check('補進來的都標了 fromGame', written.length === 3 && written.every((w) => w.fromGame === true), JSON.stringify(written.map((w) => w.fromGame)));
check('崩解那筆也進了軌跡', written.some((w) => w.outcome === 'fail' && w.inputs.includes('風')), JSON.stringify(written.map((w) => [w.outcome, w.inputs.join('+')])));
check('祈禱標記有保留', written.some((w) => w.prayed && w.result === '塵'));
check('萃取那筆材料只有一個', written.find((w) => w.action === 'refine').inputs.length === 1);
check('用遊戲給的時間', written.some((w) => w.ts === 1700000000000), JSON.stringify(written.map((w) => w.ts)));
check('補回來的不記魔力與崩解原因', written.every((w) => w.manaSpent === null && w.reason === null));

out.push('[我發現的配方（/me/recipes 分頁）→ 軌跡 ＋ 共用配方表]');
written.length = 0;
window.__iaLearned = [];
res = await send(
  {
    type: 'ia-sync-data',
    kind: 'my-recipes',
    data: {
      total: 3,
      hasMore: false,
      recipes: [
        { action: 'combine', a: '金', b: '火', resultWord: '劍', resultEmoji: '🗡️', prayed: false, createdAt: 1700001000000 },
        { action: 'refine', a: '金', resultWord: '光澤', resultEmoji: '✨', prayed: true },
        { action: 'combine', a: '水', b: '火', resultWord: '蒸氣', resultEmoji: '💨', prayed: false },
      ],
    },
    ts: Date.now(),
  },
  gameSender
);
check('有回覆', res.replied === true, JSON.stringify(res));
check('三條都收進配方表', res.r && res.r.learned === 3, JSON.stringify(res.r));
// 前一段已經把 水+火→蒸氣 的即時紀錄擋掉過，這裡同樣不該重複
check('也補進軌跡，且已存在的不重複', res.r && res.r.added === 2, JSON.stringify(res.r));
// 「新配方」≠「全服首煉」：/me/recipes 回的是第一個找到這條做法的人，
// 真正的全服首煉（世上創生）要對得上 /me/inventions 的名單才算。
// db-stub 的創生名單只有「間歇泉」，所以劍與光澤都不該掛全服首煉。
check('都標成首度發現', written.every((w) => w.isNewDiscovery), JSON.stringify(written.map((w) => w.isNewDiscovery)));
check(
  '不在創生名單裡的不掛全服首煉',
  written.every((w) => w.isGlobalFirst === false),
  JSON.stringify(written.map((w) => [w.result, w.isGlobalFirst]))
);

check(
  '沒時間的標 tsExact=false',
  (written.find((w) => w.result === '光澤') || {}).tsExact === false,
  JSON.stringify(written.map((w) => [w.result, w.tsExact]))
);

// 這批的配方主鍵（趁下一批進來之前先斷言）
const learnedKeys = window.__iaLearned.map((e) => e.key).sort();
check('主鍵正規化正確（含萃取）', learnedKeys.join(',') === 'combine:水|火,combine:火|金,refine:金', learnedKeys.join(','));
check('祈禱那條標在 pray 軌', window.__iaLearned.find((e) => e.key === 'refine:金').rec.pray.outcome === 'success', JSON.stringify(window.__iaLearned.find((e) => e.key === 'refine:金').rec.pray));
check('記下是我發現的', window.__iaLearned.every((e) => e.rec.discoveredBy && e.rec.discoveredBy.accountId === 'A1'), JSON.stringify(window.__iaLearned.map((e) => e.rec.discoveredBy)));

// 換一批：這次的產物在創生名單裡（db-stub 的 inventions 只有「間歇泉」）
written.length = 0;
res = await send(
  {
    type: 'ia-sync-data',
    kind: 'my-recipes',
    data: { total: 1, hasMore: false, recipes: [{ action: 'combine', a: '溫泉', b: '霧', resultWord: '間歇泉', prayed: false }] },
    ts: Date.now(),
  },
  gameSender
);
check(
  '在創生名單裡的才掛全服首煉',
  written.length === 1 && written[0].isGlobalFirst === true,
  JSON.stringify(written.map((w) => [w.result, w.isGlobalFirst]))
);

out.push('[全服動態收集]');
// /api/ranking/recent 的列：別人煉的東西，含一筆崩解（沒有 resultWord）
written.length = 0;
window.__iaLearned = [];
const FEED = [
  { id: 901, action: 'combine', a: '鐵', b: '水', resultWord: '鏽', resultEmoji: '🟫', finderName: '路人甲', prayed: false, createdAt: 1700900000000 },
  { id: 902, action: 'combine', a: '雲', b: '雷', resultWord: null, finderName: '路人乙', prayed: false, createdAt: 1700900100000 },
  { id: 903, action: 'refine', a: '鐵', resultWord: '鏽蝕', resultEmoji: '🧪', finderName: '路人丙', prayed: true, createdAt: 1700900200000 },
];
res = await send({ type: 'ia-sync-data', kind: 'global-feed', rows: FEED, ts: Date.now() }, gameSender);
check('有回覆', res.replied === true, JSON.stringify(res));
check('三筆都收進配方表', res.r && res.r.learned === 3, JSON.stringify(res.r));
check('★ 一筆都不進軌跡（那是別人煉的）', written.length === 0, JSON.stringify(written));
const rust = window.__iaLearned.find((e) => e.key === 'combine:水|鐵');
check('發現者記成遊戲回報的路人，不是我', rust && rust.rec.discoveredBy.finderName === '路人甲', JSON.stringify(rust && rust.rec.discoveredBy));
check('★ 不會掛上我的帳號 id', rust && rust.rec.discoveredBy.accountId === null && rust.rec.discoveredBy.accountName === null, JSON.stringify(rust && rust.rec.discoveredBy));
const dud = window.__iaLearned.find((e) => e.key === 'combine:雲|雷');
check('沒有產物的那筆記成崩解', dud && dud.rec.normal.outcome === 'fail' && dud.rec.result === null, JSON.stringify(dud && dud.rec.normal));
check('祈禱那筆記在 pray 軌', window.__iaLearned.find((e) => e.key === 'refine:鐵').pray?.outcome === 'success' || window.__iaLearned.find((e) => e.key === 'refine:鐵').rec.pray.outcome === 'success');
res = await send({ type: 'ia-sync-data', kind: 'global-feed', rows: [], ts: Date.now() }, gameSender);
check('空清單不會出事', res.r && res.r.learned === 0, JSON.stringify(res.r));

out.push('[輪詢租約：同時只有一個分頁在打]');
res = await send({ type: 'ia-cmd', cmd: 'feed-claim' }, { id: 'testext', url: 'https://pillars-of-creation.funtuan.work/', tab: { id: 11 } });
check('第一個分頁拿到租約', res.r && res.r.granted === true, JSON.stringify(res.r));
res = await send({ type: 'ia-cmd', cmd: 'feed-claim' }, { id: 'testext', url: 'https://pillars-of-creation.funtuan.work/', tab: { id: 22 } });
check('第二個分頁拿不到，不會變兩倍請求', res.r && res.r.granted === false, JSON.stringify(res.r));
res = await send({ type: 'ia-cmd', cmd: 'feed-claim' }, { id: 'testext', url: 'https://pillars-of-creation.funtuan.work/', tab: { id: 11 } });
check('持有者可以續約', res.r && res.r.granted === true, JSON.stringify(res.r));
res = await send({ type: 'ia-cmd', cmd: 'feed-claim' }, dashSender);
check('沒有 tabId 的來源拿不到租約', res.r && res.r.granted === false, JSON.stringify(res.r));

res = await send({ type: 'ia-cmd', cmd: 'feed-stats' }, dashSender);
check('統計有累加', res.r && res.r.stats.polls >= 1 && res.r.stats.learned >= 3, JSON.stringify(res.r && res.r.stats));

out.push('[目標]');
res = await send({ type: 'ia-cmd', cmd: 'goals' }, dashSender);
check('一開始沒有目標', res.r && res.r.ok && res.r.items.length === 0, JSON.stringify(res.r));

res = await send({ type: 'ia-cmd', cmd: 'predict', action: 'combine', inputs: ['火', '風'] }, dashSender);
check('還沒設成目標時 starred=false', res.r && res.r.starred === false, JSON.stringify(res.r));

res = await send({ type: 'ia-cmd', cmd: 'goal-toggle', action: 'combine', inputs: ['火', '風'] }, dashSender);
check('點☆會設成目標', res.r && res.r.ok && res.r.starred === true, JSON.stringify(res.r));
check('主鍵跟配方表用的是同一把', res.r && res.r.key === 'combine:火|風', JSON.stringify(res.r));

res = await send({ type: 'ia-cmd', cmd: 'predict', action: 'combine', inputs: ['風', '火'] }, dashSender);
check('材料順序反過來也認得出已設為目標', res.r && res.r.starred === true, JSON.stringify(res.r));

await new Promise((r) => setTimeout(r, 5)); // 錯開 addedAt，才測得出排序
res = await send({ type: 'ia-cmd', cmd: 'goal-toggle', action: 'combine', inputs: ['溫泉', '雷'] }, dashSender);
check('可以設第二個', res.r && res.r.starred === true, JSON.stringify(res.r));

res = await send({ type: 'ia-cmd', cmd: 'goals' }, dashSender);
let goals = (res.r && res.r.items) || [];
check('清單有兩筆', goals.length === 2, JSON.stringify(goals.map((g) => g.key)));
check('新設的排前面', goals[0].key === 'combine:溫泉|雷', JSON.stringify(goals.map((g) => g.key)));
check(
  '已知的那組會附上判定與產物',
  goals[0].prediction.status === 'pray-only' && goals[0].prediction.result === '間歇泉',
  JSON.stringify(goals[0].prediction)
);
check(
  '沒人試過的那組是「尚無紀錄」',
  goals[1].prediction.status === 'unknown' && !goals[1].prediction.result,
  JSON.stringify(goals[1].prediction)
);
check('只存材料，不存結果', goals[1].result === undefined && Array.isArray(goals[1].inputs), JSON.stringify(goals[1]));

res = await send({ type: 'ia-cmd', cmd: 'goal-toggle', action: 'combine', inputs: ['火', '風'] }, dashSender);
check('再點一次就取消', res.r && res.r.starred === false, JSON.stringify(res.r));
res = await send({ type: 'ia-cmd', cmd: 'goals' }, dashSender);
check('清單剩一筆', res.r.items.length === 1, JSON.stringify(res.r.items.map((g) => g.key)));

res = await send({ type: 'ia-cmd', cmd: 'goal-toggle', action: 'refine', inputs: ['火'] }, dashSender);
check('萃取也能設成目標', res.r && res.r.ok && res.r.key === 'refine:火', JSON.stringify(res.r));
res = await send({ type: 'ia-cmd', cmd: 'goal-toggle', action: 'combine', inputs: [] }, dashSender);
check('沒材料就不收', res.r && res.r.ok === false, JSON.stringify(res.r));

out.push('[完全重置]');
const broadcasts = [];
window.chrome.runtime.sendMessage = (m) => broadcasts.push(m);
res = await send({ type: 'ia-cmd', cmd: 'reset-all' }, dashSender);
check('重置有回覆', res.replied === true, JSON.stringify(res));
check('每個資料表都清了', window.__iaWiped.length === 1, JSON.stringify(window.__iaWiped));
check(
  '回報清掉的筆數',
  res.r && res.r.ok && res.r.cleared.attempts === 8 && res.r.cleared.knowledge === 10 && res.r.cleared.inventory === 2,
  JSON.stringify(res.r)
);
check('目標也一起清掉', res.r && res.r.cleared.goals === 2, JSON.stringify(res.r && res.r.cleared));
res = await send({ type: 'ia-cmd', cmd: 'goals' }, dashSender);
check('重置後目標清單是空的', res.r && res.r.items.length === 0, JSON.stringify(res.r));
check('有廣播 ia-reset 讓開著的頁面重載', broadcasts.some((m) => m && m.type === 'ia-reset'), JSON.stringify(broadcasts));

out.push('[版本檢查]');
// 只攔 api.github.com，其他 fetch（例如下面要讀 content.js 原始碼）照舊
const realFetch = window.fetch.bind(window);
let ghCalls = 0;
const okRelease = () =>
  new Response(
    JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/x/y/releases/tag/v9.9.9' }),
    { status: 200 }
  );
let ghResponse = okRelease;
window.fetch = (url, init) => {
  if (String(url).includes('api.github.com')) {
    ghCalls++;
    return Promise.resolve(ghResponse());
  }
  return realFetch(url, init);
};

// 更新跑完會順手查一次（這時還沒查過，所以真的會打出去）
broadcasts.length = 0;
res = await send(
  { type: 'ia-sync-progress', phase: 'done', done: 6, total: 6, stats: { discoveries: 1 } },
  gameSender
);
const doneMsg = broadcasts.filter((m) => m && m.type === 'ia-progress' && m.phase === 'done').pop();
check('按更新跑完會順手查一次', ghCalls === 1, String(ghCalls));
check('更新完成的廣播帶著版本檢查結果（儀表板走這條）', !!(doneMsg && doneMsg.update), JSON.stringify(doneMsg));
// runtime 廣播送不到 content script，浮層只能靠這條回覆拿到
check('回覆裡也要帶著版本檢查結果（浮層走這條）', !!(res.r && res.r.update), JSON.stringify(res.r));
check('而且說得出有新版本', doneMsg && doneMsg.update.hasUpdate === true, JSON.stringify(doneMsg && doneMsg.update));
check('版本號是去掉 v 的', doneMsg && doneMsg.update.latest === '9.9.9', JSON.stringify(doneMsg && doneMsg.update));

res = await send({ type: 'ia-cmd', cmd: 'check-update' }, dashSender);
check('一小時內不會再打一次', ghCalls === 1, String(ghCalls));
check('照樣說得出有新版本（讀存下來的）', res.r && res.r.hasUpdate === true, JSON.stringify(res.r));

res = await send({ type: 'ia-cmd', cmd: 'check-update', opts: { cachedOnly: true } }, dashSender);
check('cachedOnly 一定不打 GitHub', ghCalls === 1, String(ghCalls));
check('cachedOnly 也回得出結果', res.r && res.r.hasUpdate === true, JSON.stringify(res.r));

out.push('[開發布頁]');
const createdBefore = calls.created.length;
res = await send({ type: 'ia-cmd', cmd: 'open-release' }, dashSender);
check('開了一個分頁', calls.created.length === createdBefore + 1, JSON.stringify(calls.created));
check(
  '開的是那一版的發布頁',
  calls.created[calls.created.length - 1].url === 'https://github.com/x/y/releases/tag/v9.9.9',
  JSON.stringify(calls.created[calls.created.length - 1])
);

out.push('[沒有新版本／查不到時]');
ghResponse = () => new Response(JSON.stringify({ tag_name: 'v1.0.0', html_url: 'https://github.com/x/y/releases/tag/v1.0.0' }), { status: 200 });
res = await send({ type: 'ia-cmd', cmd: 'check-update', opts: { force: true } }, dashSender);
check('force 會重新查一次', ghCalls === 2, String(ghCalls));
check('版本一樣就不提示更新', res.r && res.r.ok && res.r.hasUpdate === false, JSON.stringify(res.r));

ghResponse = () => new Response('nope', { status: 503 });
res = await send({ type: 'ia-cmd', cmd: 'check-update', opts: { force: true } }, dashSender);
check('GitHub 掛掉也一定會回覆', res.replied === true, JSON.stringify(res));
check('查不到就當作沒有更新，不會誤報', res.r && res.r.hasUpdate === false, JSON.stringify(res.r));
check('查不到會說明原因', res.r && !res.r.ok && !!res.r.error, JSON.stringify(res.r));

ghResponse = () => new Response(JSON.stringify({ tag_name: 'v9.9.9', prerelease: true }), { status: 200 });
res = await send({ type: 'ia-cmd', cmd: 'check-update', opts: { force: true } }, dashSender);
check('預發布不算新版本', res.r && res.r.hasUpdate === false, JSON.stringify(res.r));

ghResponse = okRelease;

out.push('[content.js 只會打白名單上的端點]');
// 直接掃 content.js 裡所有的 API 路徑字面值——不管寫成什麼形式都抓得到，
// 這樣以後有人（包括我）加了新端點或把逐一走訪造物的迴圈放回來，測試就會紅。
const SYNC_SRC = await (await fetch('/src/content.js')).text();
const paths = [...new Set([...SYNC_SRC.matchAll(/['"`](\/(?:me|combine-log|ranking|nodes)[^'"`]*)['"`]/g)].map((m) => m[1]))].sort();
const ALLOWED = [
  '/me', '/me/discoveries', '/me/seeds', '/me/inventions', '/me/recipes', // 更新：我自己的
  '/combine-log', // 更新：我自己的煉製紀錄
  '/ranking/recent', // 全服動態收集（可關閉）
];
const base = (p) => p.split('?')[0];
check('沒有任何逐一走訪造物的請求', !paths.some((p) => p.includes('/nodes/')), paths.join(' , '));
check(
  '每一支都在白名單上',
  paths.every((p) => ALLOWED.includes(base(p))),
  paths.filter((p) => !ALLOWED.includes(base(p))).join(' , ') || paths.join(' , ')
);
check('全服動態只用 ranking/recent 這一支', paths.filter((p) => p.startsWith('/ranking')).join(',') === '/ranking/recent', paths.filter((p) => p.startsWith('/ranking')).join(','));
check('確實有讀煉製紀錄與我發現的配方', paths.some((p) => base(p) === '/combine-log') && paths.some((p) => base(p) === '/me/recipes'), paths.join(' , '));

out.push('[未知指令與不明來源]');
res = await send({ type: 'ia-cmd', cmd: '亂打' }, dashSender);
check('未知指令也會回覆', res.replied === true, JSON.stringify(res));
res = await send({ type: 'ia-cmd', cmd: 'sync-start' }, { id: '別的擴充' });
check('不是自己人的訊息不處理', res.replied === false, JSON.stringify(res));

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
document.getElementById('out').textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
