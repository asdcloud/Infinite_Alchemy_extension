// 儀表板的實際渲染測試：把 db 換成 tests/db-stub.js，載入真正的 dashboard.js，
// 逐一點過每個分頁與功能，確認畫面有東西、而且沒有任何 console 錯誤。
const log = [];
window.addEventListener('error', (e) => log.push('ERROR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => log.push('REJECT: ' + ((e.reason && e.reason.message) || e.reason)));
localStorage.clear();

window.chrome = {
  runtime: {
    id: 'test',
    onMessage: { addListener() {} },
    sendMessage(m, cb) {
      if (typeof cb === 'function') cb({ ok: true, merged: 0, total: 0, report: 'diag' });
    },
    getURL: (p) => p,
  },
  tabs: { create() {} },
  storage: { local: { get(k, cb) { if (cb) cb({}); }, set() {} } },
};

const html = await (await fetch('/ui/dashboard.html')).text();
const doc = new DOMParser().parseFromString(html, 'text/html');
for (const s of doc.querySelectorAll('script')) s.remove();
document.body.innerHTML = doc.body.innerHTML;
await import('/ui/dashboard.js');
await new Promise((r) => setTimeout(r, 400));

const q = (s) => document.querySelectorAll(s).length;
const txt = (s) => ((document.querySelector(s) || {}).textContent || '').trim().replace(/\s+/g, ' ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];

out.push('分頁 = ' + [...document.querySelectorAll('.tab')].map((t) => t.textContent).join(' / '));
out.push('預設顯示 = ' + [...document.querySelectorAll('.view')].filter((v) => !v.classList.contains('hidden')).map((v) => v.id).join(','));

for (const t of document.querySelectorAll('.tab')) t.click();

// 查配方：五種判定都要出得來
for (const [a, b, label] of [
  ['水', '雷', '已知崩解'],
  ['溫泉', '雷', '需祈禱'],
  ['火', '風', '未知'],
  ['火', '', '萃取'],
  ['水', '水', '水加水'],
]) {
  document.getElementById('look-a').value = a;
  document.getElementById('look-b').value = b;
  document.getElementById('look-go').click();
  await wait(50);
  out.push(`lookup(${label}) = ` + txt('#look-result .big'));
}

// 規劃
document.getElementById('plan-input').value = '地熱';
document.getElementById('plan-go').click();
await wait(120);
out.push('plan.地熱 = ' + txt('#plan-result .verdict-box .big') + ' | 步驟=' + q('#plan-result .steps li'));

document.getElementById('plan-input').value = '熔爐';
document.getElementById('plan-go').click();
await wait(120);
out.push('plan.熔爐 = ' + txt('#plan-result .verdict-box .big'));

out.push(
  '現在就能煉 = ' + q('#suggest-body tr') + ' 筆：' +
    [...document.querySelectorAll('#suggest-body .res-success')].map((e) => e.textContent).join('、')
);
out.push('共用配方表 = ' + txt('#kb-count') + ' / 列數=' + q('#kb-body tr'));
document.getElementById('kb-search').value = '蒸氣';
document.getElementById('kb-search').dispatchEvent(new Event('input'));
await wait(60);
out.push('蒸氣的兩條配方顯示 = ' + [...document.querySelectorAll('#kb-body .res-success')].map((e) => e.textContent.trim()).join(' | '));
document.getElementById('kb-search').value = '';
document.getElementById('kb-search').dispatchEvent(new Event('input'));
await wait(60);
document.getElementById('kb-filter').value = 'fail';
document.getElementById('kb-filter').dispatchEvent(new Event('change'));
await wait(50);
out.push('共用配方表(只看崩解) = ' + txt('#kb-count'));

out.push('素材櫃 = ' + txt('#bag-count') + ' / 卡片=' + q('#bag-cards .card'));
out.push('軌跡 = ' + txt('#log-count') + ' / 列數=' + q('#log-body tr'));

document.getElementById('plan-input').value = '地熱';
document.getElementById('plan-go').click();
await wait(80);
out.push(
  '路徑樹 = 節點' + q('#tree-out .node') + ' / 換配方鈕=' + q('#tree-out .link') +
    ' / 已持有標記=' + [...document.querySelectorAll('#tree-out .depth')].filter((e) => e.textContent.includes('已持有')).length
);

// 切帳號：帳號範疇的要換，配方表不換
const sel = document.getElementById('account-select');
sel.value = 'A2';
sel.dispatchEvent(new Event('change'));
await wait(200);
out.push('切小號 → 素材櫃=' + txt('#bag-count') + ' / 軌跡=' + txt('#log-count') + ' / 共用配方表=' + txt('#kb-count'));

out.push('errors=[' + log.join(' | ') + ']');
document.title = log.length ? 'FAIL' : 'PASS';
const pre = document.createElement('pre');
pre.id = 'report';
pre.textContent = out.join('\n');
document.body.prepend(pre);
