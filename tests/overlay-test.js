// 遊戲內浮層的行為測試。
// 重點：從煉製台自動讀出材料填進輸入框、沒有煉製台時別亂動、待煉清單（組合與整條路徑）、全服動態開關。
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

// 假的待煉表：key → 組合或路徑
const goals = new Map();
const keyOf = (action, inputs) =>
  action === 'refine' ? `refine:${inputs[0]}` : `combine:${[...inputs].sort().join('|')}`;

const ctx = {
  async sendAsync(m) {
    cmds.push(m);
    if (m.cmd === 'predict') {
      return {
        ok: true,
        inputs: m.inputs,
        action: m.action,
        starred: goals.has(keyOf(m.action, m.inputs)),
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
    if (m.cmd === 'goal-toggle') {
      const key = keyOf(m.action, m.inputs);
      if (goals.has(key)) {
        goals.delete(key);
        return { ok: true, starred: false, key };
      }
      goals.set(key, { key, action: m.action, inputs: m.inputs, addedAt: goals.size + 1 });
      return { ok: true, starred: true, key };
    }
    if (m.cmd === 'goals') {
      const items = [...goals.values()]
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((g) =>
          g.kind === 'path' || g.kind === 'wish'
            ? g
            : {
                ...g,
                prediction:
                  g.inputs[0] === '水'
                    ? { status: 'unknown', result: null, emoji: null }
                    : { status: 'success', result: '殭屍', emoji: '🧟' },
              }
        );
      return { ok: true, items };
    }
    if (m.cmd === 'goal-remove') {
      goals.delete(m.key);
      return { ok: true };
    }
    if (m.cmd === 'goal-step-done') {
      let changed = 0;
      for (const g of [...goals.values()]) {
        if (g.kind !== 'path') continue;
        const left = g.steps.filter((s) => s.key !== m.stepKey);
        if (left.length === g.steps.length) continue;
        changed++;
        if (left.length) goals.set(g.key, { ...g, steps: left });
        else goals.delete(g.key);
      }
      return { ok: true, changed };
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
out.push('[待煉：判定那一行的星星]');
$('.ma').value = '';
$('.mb').value = '';
$('.ma').dispatchEvent(new Event('input'));
await wait(400);
check('沒選材料時判定列裡沒有星星', $('.verdict .star') === null, $('.verdict').textContent);
$('.ma').value = '融合怪獸';
$('.mb').value = '不死者';
$('.ma').dispatchEvent(new Event('input'));
await wait(400);
const star = () => $('.verdict .star');
check('有結果時星星出現在判定那一行最右邊', !!star() && star().parentElement.classList.contains('line'));
check('預設是暗的', !star().classList.contains('on') && star().textContent === '☆');
check('待煉清單預設收合', $('.glist').classList.contains('hide'));
check('標題本來只寫「待煉」', $('.gt').textContent === '待煉', $('.gt').textContent);

star().click();
await wait(60);
check('點下去會點亮', star().classList.contains('on') && star().textContent === '★');
check('送出的是 goal-toggle',
  cmds.some((m) => m.cmd === 'goal-toggle' && m.inputs.join('|') === '融合怪獸|不死者'), JSON.stringify(cmds.slice(-3)));
check('標題跟著寫出數量', $('.gt').textContent === '待煉（1）', $('.gt').textContent);
check('收合狀態不受影響', $('.glist').classList.contains('hide'));

// 換一組再設一個
$('.ma').value = '水';
$('.mb').value = '火';
$('.ma').dispatchEvent(new Event('input'));
await wait(400);
check('換一組之後星星回到暗的', !star().classList.contains('on'), star().textContent);
star().click();
await wait(60);
check('第二個也設得起來', $('.gt').textContent === '待煉（2）', $('.gt').textContent);

out.push('[待煉：展開的清單]');
$('.gh').click();
await wait(60);
check('點標題就展開', !$('.glist').classList.contains('hide'));
check('展開狀態有記起來', storageValue.goalsOpen === true, JSON.stringify(storageValue));
check('兩筆都在', $('.glist').querySelectorAll('li').length === 2, String($('.glist').querySelectorAll('li').length));
const rows = [...$('.glist').querySelectorAll('li')];
check('新設的排前面', rows[0].querySelector('.gm').textContent === '水 ＋ 火', rows[0].querySelector('.gm').textContent);
check('未知的那組寫「尚無紀錄」', rows[0].querySelector('.say').textContent.includes('尚無紀錄'), rows[0].querySelector('.say').textContent);
check('已知的那組寫得出產物', rows[1].querySelector('.say').textContent.includes('殭屍'), rows[1].querySelector('.say').textContent);

check('目前選著的那組（水＋火）星星是亮的', star().classList.contains('on'));
rows[0].querySelector('.del').click();
await wait(400);
check('✕ 會把那筆移掉', $('.glist').querySelectorAll('li').length === 1, String($('.glist').querySelectorAll('li').length));
check('移掉的正好是選著的那組，星星跟著暗下去', !star().classList.contains('on'), star().textContent);

rows[1].querySelector('.del') && $('.glist').querySelector('.del').click();
await wait(60);
check('全部移掉後顯示空狀態', $('.glist').querySelector('.empty') !== null, $('.glist').textContent);
check('標題也回到只寫「待煉」', $('.gt').textContent === '待煉', $('.gt').textContent);

out.push('[待煉：整條路徑]');
goals.set('path:間歇泉', {
  key: 'path:間歇泉',
  kind: 'path',
  target: '間歇泉',
  addedAt: 99,
  steps: [
    { key: 'k1', action: 'combine', inputs: ['水', '火'], result: '蒸氣', needsPray: false },
    { key: 'k2', action: 'combine', inputs: ['蒸氣', '土'], result: '溫泉', needsPray: false },
    { key: 'k3', action: 'combine', inputs: ['溫泉', '雷'], result: '間歇泉', needsPray: true },
  ],
});
await new Promise((r) => { $('.gh').click(); setTimeout(r, 60); }); // 收起來
await new Promise((r) => { $('.gh').click(); setTimeout(r, 60); }); // 再展開，重畫
const pathLi = () => $('.glist li.path');
check('路徑會畫成一整塊', !!pathLi());
check('標題寫著要煉什麼與剩幾步', pathLi().querySelector('.gm').textContent.includes('間歇泉') && pathLi().querySelector('.gm').textContent.includes('3 步'), pathLi().querySelector('.gm').textContent);
check('三步都列出來', pathLi().querySelectorAll('.psteps li').length === 3, String(pathLi().querySelectorAll('.psteps li').length));
check('步驟寫成 材料＋材料 → 產物', pathLi().querySelector('.psteps .say').textContent.startsWith('水 ＋ 火 → 蒸氣'), pathLi().querySelector('.psteps .say').textContent);
check('需祈禱的那步有標', !!pathLi().querySelectorAll('.psteps li')[2].querySelector('.praytag'));
check('標題數量把路徑也算進去', $('.gt').textContent === '待煉（1）', $('.gt').textContent);

// 手動劃掉第一步
pathLi().querySelectorAll('.psteps .done')[0].click();
await wait(60);
check('劃掉之後只剩兩步', pathLi().querySelectorAll('.psteps li').length === 2, String(pathLi().querySelectorAll('.psteps li').length));
check('剩幾步跟著更新', pathLi().querySelector('.gm').textContent.includes('2 步'), pathLi().querySelector('.gm').textContent);

// 煉完最後兩步 → 整條消失（模擬背景轉來的事件）
pathLi().querySelectorAll('.psteps .done')[0].click();
await wait(60);
pathLi().querySelectorAll('.psteps .done')[0].click();
await wait(60);
check('整條做完就自動消失', $('.glist li.path') === null, $('.glist').textContent);

out.push('[待煉：還沒配方的願望]');
goals.set('wish:歐貝利斯克的巨神兵', {
  key: 'wish:歐貝利斯克的巨神兵', kind: 'wish', target: '歐貝利斯克的巨神兵', addedAt: 97, known: false,
});
window.dispatchEvent(new CustomEvent('ia-goals-changed'));
await wait(60);
const wishLi = () => [...$('.glist').querySelectorAll('li')].find((li) => (li.querySelector('.gm') || {}).textContent === '歐貝利斯克的巨神兵');
check('願望會列出來', !!wishLi(), $('.glist').textContent);
check('還沒配方時寫「還沒人知道怎麼煉」', wishLi().querySelector('.say').textContent.includes('還沒人知道'), wishLi().querySelector('.say').textContent);
check('不會畫成路徑那種一整塊', !wishLi().classList.contains('path'));

// 哪天配方進到表裡，這一列要自己變
goals.set('wish:歐貝利斯克的巨神兵', { ...goals.get('wish:歐貝利斯克的巨神兵'), known: true });
window.dispatchEvent(new CustomEvent('ia-goals-changed'));
await wait(60);
check('有配方之後改口說已經有了', wishLi().querySelector('.say').textContent.includes('已經有配方了'), wishLi().querySelector('.say').textContent);
check('而且換成綠色', wishLi().querySelector('.say').classList.contains('ok'), wishLi().querySelector('.say').className);
wishLi().querySelector('.del').click();
await wait(60);
check('移得掉', !wishLi(), $('.glist').textContent);

// 煉完某一步時，content.js 會轉這個事件過來，浮層要即時重畫
goals.set('path:溫泉', {
  key: 'path:溫泉', kind: 'path', target: '溫泉', addedAt: 98,
  steps: [{ key: 'k9', action: 'combine', inputs: ['水', '火'], result: '蒸氣', needsPray: false }],
});
window.dispatchEvent(new CustomEvent('ia-goals-changed'));
await wait(60);
check('收到 ia-goals-changed 會即時重畫', !!$('.glist li.path'), $('.glist').textContent);
$('.glist li.path .del').click();
await wait(60);
check('整條移得掉', $('.glist li.path') === null, $('.glist').textContent);

$('.gh').click();
await wait(20);
check('再點一次收回去', $('.glist').classList.contains('hide') && storageValue.goalsOpen === false);

out.push('[全服動態開關]');
check('開關在浮層裡', !!$('.fd'));
check('預設是關的', $('.fd').checked === false);
check('文字寫「關閉」', $('.st').textContent === '關閉', $('.st').textContent);
const feedWrites = () => writes.filter((w) => 'globalFeed' in w);
check('沒設定過就不會亂寫 storage', feedWrites().length === 0, JSON.stringify(writes));

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

out.push('[有新版本才浮出來的那顆]');
check('平常藏著', $('.upd').classList.contains('hide'));
check('掛載時只讀存下來的，不會叫背景去打 GitHub',
  cmds.some((m) => m.cmd === 'check-update' && m.opts && m.opts.cachedOnly === true), JSON.stringify(cmds.filter((m) => m.cmd === 'check-update')));

// 進度事件本身不帶版本資訊（背景的廣播送不到 content script），
// 曾經誤以為它帶得到，浮層那顆按鈕就永遠不會冒出來
window.dispatchEvent(new CustomEvent('ia-sync-progress', {
  detail: { phase: 'done', done: 6, total: 6, stats: {}, update: { hasUpdate: true, latest: '9.9.9', current: '1.1.3' } },
}));
await wait(20);
check('不能靠進度事件帶版本資訊', $('.upd').classList.contains('hide'), $('.updbtn').textContent);

window.dispatchEvent(new CustomEvent('ia-update-info', { detail: { hasUpdate: false, latest: '1.1.3', current: '1.1.3' } }));
await wait(20);
check('版本一樣就不要冒出來', $('.upd').classList.contains('hide'));

window.dispatchEvent(new CustomEvent('ia-update-info', { detail: { hasUpdate: true, latest: '9.9.9', current: '1.1.3' } }));
await wait(20);
check('有新版本就浮出來', !$('.upd').classList.contains('hide'));
check('寫著新舊版本號', $('.updbtn').textContent === '⬆ 有新版本 v9.9.9（目前 v1.1.3）', $('.updbtn').textContent);

$('.updbtn').click();
await wait(20);
check('按下去是叫背景開發布頁', cmds.some((m) => m.cmd === 'open-release'), JSON.stringify(cmds.slice(-3)));
check('不會順便把浮層收起來', !$('.wrap').classList.contains('collapsed'));

// ── 重開分頁：storage 裡已經是開的 ──
out.push('[重開分頁時讀回設定]');
document.getElementById(HOST).remove();
storageValue = { globalFeed: true, goalsOpen: true };
goals.set('combine:水|火', { key: 'combine:水|火', action: 'combine', inputs: ['水', '火'], addedAt: 1 });
const writesAtRemount = writes.length;
mountOverlay(ctx);
await wait(150);
root = document.getElementById(HOST).shadowRoot;
check('掛載時就照 storage 顯示為開啟', $('.fd').checked === true && $('.st').textContent === '開啟中', $('.st').textContent);
check('待煉展開狀態也讀得回來', !$('.glist').classList.contains('hide'));
check('讀回來的狀態不會再寫回 storage', writes.length === writesAtRemount, JSON.stringify(writes.slice(writesAtRemount)));
check('展開時就把清單畫出來', $('.glist').querySelectorAll('li').length === 1, String($('.glist').querySelectorAll('li').length));
check('標題帶著數量', $('.gt').textContent === '待煉（1）', $('.gt').textContent);

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
o.textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
