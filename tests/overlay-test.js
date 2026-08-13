// 遊戲內浮層的行為測試。
// 重點：從煉製台自動讀出材料填進輸入框、沒有煉製台時別亂動、全服動態開關與 storage 同步。
const o = document.getElementById('out');
const out = [];
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; out.push('  ok   ' + n); } else { fail++; out.push('  FAIL ' + n + ' → ' + e); }
};

const cmds = [];
let syncRuns = 0;
let storageValue = {};
let storageListener = null;
const writes = [];

window.chrome = {
  runtime: { id: 't', getURL: (p) => p },
  storage: {
    local: {
      get(keys, cb) { if (cb) cb(storageValue); },
      set(v) { writes.push(v); Object.assign(storageValue, v); },
    },
    onChanged: { addListener(f) { storageListener = f; } },
  },
};

const ctx = {
  async sendAsync(m) {
    cmds.push(m);
    if (m.cmd === 'predict') {
      return {
        ok: true,
        prediction: {
          status: 'pray-only',
          result: '殭屍',
          emoji: '🧟',
          normal: { success: 0, fail: 1 },
          pray: { success: 1, fail: 0 },
          discoveredBy: { finderName: '鮭魚二號機' },
        },
      };
    }
    return { ok: true };
  },
  runSync() { syncRuns++; },
};

const HOST = 'ia-tracker-overlay';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(320); // MutationObserver 那邊有 160ms 的緩衝
const lastPredict = () => cmds.filter((m) => m.cmd === 'predict').pop();
const chipHTML = (emoji, word, fav) =>
  `<div class="chip r3"><span>${emoji}</span><span>${word}</span>` +
  (fav ? '<span class="chip-fav" aria-hidden="true"><i class="fa-solid fa-star"></i></span>' : '') +
  '</div>';

const { mountOverlay } = await import('/src/overlay.js');

// ── 頁面上還沒有煉製台 ──
mountOverlay(ctx);
await wait(120);
let root = document.getElementById(HOST).shadowRoot;
const $ = (s) => root.querySelector(s);

out.push('[沒有煉製台時]');
check('沒有另一列重複顯示材料', $('.pair') === null, '.pair 還在');
check('兩個輸入框在，而且是空的', $('.ma').value === '' && $('.mb').value === '');
check('判定是預設提示', $('.verdict').textContent.includes('在遊戲裡點材料'), $('.verdict').textContent);
check('掛載時不會沒事去問背景', !cmds.some((m) => m.cmd === 'predict'), JSON.stringify(cmds));

$('.ma').value = '水';
$('.mb').value = '火';
$('.ma').dispatchEvent(new Event('input'));
await wait(400);
check('自己打字查得到', lastPredict()?.inputs.join('|') === '水|火', JSON.stringify(lastPredict()));
check('打字的框不會標成「自動填的」', !$('.ma').classList.contains('auto'));
await settle();
check('沒有煉製台就不會擦掉你打的字', $('.ma').value === '水', $('.ma').value);

// ── 出現煉製台（兩格都空）──
const bench = document.createElement('div');
bench.className = 'workbench';
bench.innerHTML = '<div class="slots"><div class="slot"></div><span class="op">＋</span><div class="slot"></div></div>';
document.body.appendChild(bench);
const slots = bench.querySelectorAll('.slot');
await settle();

out.push('[煉製台是空的]');
check('輸入框跟著清空', $('.ma').value === '' && $('.mb').value === '', `${$('.ma').value}|${$('.mb').value}`);
check('判定回到預設提示', $('.verdict').textContent.includes('在遊戲裡點材料'), $('.verdict').textContent);

// ── 放第一樣材料 ──
out.push('[放第一樣材料]');
slots[0].className = 'slot filled';
slots[0].innerHTML = chipHTML('🧟', '殭屍');
await settle();
check('材料 A 自動填入「殭屍」', $('.ma').value === '殭屍', $('.ma').value);
check('材料 B 還是空的', $('.mb').value === '');
check('自動填的框有記號', $('.ma').classList.contains('auto') && !$('.mb').classList.contains('auto'));
check('只放一樣就問萃取', lastPredict()?.action === 'refine', JSON.stringify(lastPredict()));
check('判定標出「萃取」', $('.verdict').textContent.includes('萃取：'), $('.verdict').textContent);

// ── 放第二樣材料 ──
out.push('[放第二樣材料]');
slots[1].className = 'slot filled';
slots[1].innerHTML = chipHTML('👹', '融合怪獸');
await settle();
check('材料 B 自動填入「融合怪獸」', $('.mb').value === '融合怪獸', $('.mb').value);
check('兩樣就問煉成', lastPredict()?.action === 'combine', JSON.stringify(lastPredict()));
check('順序照格子', lastPredict()?.inputs.join('|') === '殭屍|融合怪獸', JSON.stringify(lastPredict()));
check('判定不再有「萃取」字樣', !$('.verdict').textContent.includes('萃取：'), $('.verdict').textContent);
check('判定顯示產物', $('.verdict').textContent.includes('殭屍'), $('.verdict').textContent);
check('顯示發現者與次數', $('.sub')?.textContent === '由 鮭魚二號機 發現・一共嘗試過 2 次', $('.sub')?.textContent);

// ── 收藏過的材料多一個空的 .chip-fav ──
out.push('[收藏過的材料]');
slots[0].innerHTML = chipHTML('🧟', '殭屍王', true);
await settle();
check('不會把收藏星星當成材料', $('.ma').value === '殭屍王', $('.ma').value);
check('送出去的還是兩個詞', lastPredict()?.inputs.join('|') === '殭屍王|融合怪獸', JSON.stringify(lastPredict()));

// ── 拿掉一樣 ──
out.push('[拿掉一樣]');
slots[1].className = 'slot';
slots[1].innerHTML = '';
await settle();
check('材料 B 跟著清空', $('.mb').value === '', $('.mb').value);
check('回到萃取', lastPredict()?.action === 'refine', JSON.stringify(lastPredict()));

// ── 煉製台不見了，改看材料列表被點亮的那幾顆 ──
out.push('[退路：材料列表]');
bench.remove();
const tray = document.createElement('div');
tray.innerHTML =
  '<button class="chip r1 selected"><span>💧</span><span>水</span></button>' +
  '<button class="chip r1 selected"><span>🔥</span><span>火</span></button>';
document.body.appendChild(tray);
await settle();
check('讀得到被點亮的兩顆', $('.ma').value === '水' && $('.mb').value === '火', `${$('.ma').value}|${$('.mb').value}`);

out.push('[什麼都偵測不到時]');
tray.remove();
$('.ma').value = '土';
$('.mb').value = '';
$('.ma').dispatchEvent(new Event('input'));
await wait(400);
await settle();
check('不會把你打的字擦掉', $('.ma').value === '土', $('.ma').value);

// ── 全服動態收集開關 ──
out.push('[全服動態開關]');
check('開關在浮層裡', !!$('.fd'));
check('預設是關的', $('.fd').checked === false);
check('文字寫「關閉」', $('.st').textContent === '關閉', $('.st').textContent);
check('沒設定過就不會亂寫 storage', writes.length === 0, JSON.stringify(writes));

$('.lbl').click();
await wait(20);
check('點文字就能打開', $('.fd').checked === true && $('.st').textContent === '開啟中');
check('寫進 storage 的 globalFeed 是 true', writes.some((w) => w.globalFeed === true), JSON.stringify(writes));
check('撥開關不會把浮層收起來', !$('.wrap').classList.contains('collapsed'));

$('.lbl').click();
await wait(20);
check('再點一次就關掉', $('.fd').checked === false && $('.st').textContent === '關閉');

const writesBefore = writes.length;
storageListener({ globalFeed: { newValue: true } }, 'local');
await wait(20);
check('別的地方（儀表板）打開，浮層跟著亮', $('.fd').checked === true && $('.st').textContent === '開啟中');
check('跟隨外部變更時不會再寫回去', writes.length === writesBefore, JSON.stringify(writes.slice(writesBefore)));

out.push('[⟳ 更新]');
$('.sync').click();
check('按下去會叫 runSync', syncRuns === 1, String(syncRuns));
check('進度列跟著露出來', !$('.prog').classList.contains('hide'));

// ── 重開分頁：storage 裡已經是開的 ──
out.push('[重開分頁時讀回設定]');
document.getElementById(HOST).remove();
storageValue = { globalFeed: true };
mountOverlay(ctx);
await wait(120);
root = document.getElementById(HOST).shadowRoot;
check('掛載時就照 storage 顯示為開啟', $('.fd').checked === true && $('.st').textContent === '開啟中', $('.st').textContent);

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
o.textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
