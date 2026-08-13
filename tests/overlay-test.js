// 遊戲內浮層的行為測試。
// 重點：只保留「查判定」那幾樣（不再有清單）、全服動態開關撥得動且與 storage 同步。
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
          status: 'success',
          result: '蒸氣',
          emoji: '💨',
          normal: { success: 2, fail: 0 },
          pray: { success: 0, fail: 0 },
          discoveredBy: { finderName: '路人' },
        },
      };
    }
    return { ok: true };
  },
  runSync() { syncRuns++; },
};

const HOST = 'ia-tracker-overlay';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { mountOverlay } = await import('/src/overlay.js');

// ── 第一次掛載：storage 沒設定過 ──
mountOverlay(ctx);
await wait(120);
let root = document.getElementById(HOST).shadowRoot;
const $ = (s) => root.querySelector(s);

out.push('[只保留圖上那些東西]');
check('沒有「現在手上就能煉」清單', $('.list') === null, '.list 還在');
check('也沒有那個小標題', $('.h2') === null, '.h2 還在');
check('掛載時不再問背景 suggest', !cmds.some((m) => m.cmd === 'suggest'), JSON.stringify(cmds));
check('標題還是煉製軌跡', $('.head .t').textContent === '煉製軌跡', $('.head .t').textContent);
check('⟳ 更新鈕在', !!$('.sync'));
check('▤ 儀表板鈕在', !!$('.dash'));
check('－ 收合鈕在', !!$('.fold'));
check('材料 A／B 兩格在', $('.ma')?.placeholder === '材料 A' && $('.mb')?.placeholder === '材料 B');
check('判定列在，且是預設提示', $('.verdict').textContent.includes('選兩個材料'), $('.verdict').textContent);

out.push('[全服動態開關]');
check('開關在浮層裡', !!$('.fd'));
check('預設是關的', $('.fd').checked === false);
check('文字寫「關閉」', $('.st').textContent === '關閉', $('.st').textContent);
check('沒設定過就不會亂寫 storage', writes.length === 0, JSON.stringify(writes));

$('.lbl').click();
await wait(20);
check('點文字就能打開', $('.fd').checked === true);
check('文字變「開啟中」', $('.st').textContent === '開啟中', $('.st').textContent);
check('寫進 storage 的 globalFeed 是 true', writes.some((w) => w.globalFeed === true), JSON.stringify(writes));
check('撥開關不會把浮層收起來', !$('.wrap').classList.contains('collapsed'));

$('.lbl').click();
await wait(20);
check('再點一次就關掉', $('.fd').checked === false && $('.st').textContent === '關閉');
check('關掉也寫回 storage', writes[writes.length - 1].globalFeed === false, JSON.stringify(writes));

const writesBefore = writes.length;
storageListener({ globalFeed: { newValue: true } }, 'local');
await wait(20);
check('別的地方（儀表板）打開，浮層跟著亮', $('.fd').checked === true && $('.st').textContent === '開啟中');
check('跟隨外部變更時不會再寫回去', writes.length === writesBefore, JSON.stringify(writes.slice(writesBefore)));

out.push('[查判定還會動]');
// 頁面上沒有 .chip.selected，2.5 秒後浮層會切成手動輸入
await wait(2600);
check('抓不到選取狀態就切成手動輸入', !$('.manual').classList.contains('hide'));
$('.ma').value = '水';
$('.mb').value = '火';
$('.ma').dispatchEvent(new Event('input'));
await wait(400);
const p = cmds.filter((m) => m.cmd === 'predict').pop();
check('把兩個材料送去問背景', !!p && p.inputs.join('|') === '水|火', JSON.stringify(p));
check('判定列顯示結果', $('.verdict').textContent.includes('蒸氣'), $('.verdict').textContent);
check('也顯示發現者與次數', $('.sub')?.textContent === '由 路人 發現・一共嘗試過 2 次', $('.sub')?.textContent);

out.push('[⟳ 更新]');
$('.sync').click();
check('按下去會叫 runSync', syncRuns === 1, String(syncRuns));
check('進度列跟著露出來', !$('.prog').classList.contains('hide'));

// ── 第二次掛載：storage 裡已經是開的 ──
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
