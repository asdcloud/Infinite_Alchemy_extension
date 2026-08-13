// 「怎麼煉」的步驟表與路徑樹畫的必須是同一條路。
// 這裡不看內部變數，直接拿渲染出來的 DOM 逐項比對——使用者看到的就是這兩塊。
const log = [];
window.addEventListener('error', (e) => log.push('ERROR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => log.push('REJECT: ' + ((e.reason && e.reason.message) || e.reason)));
localStorage.clear();

const sent = [];
window.chrome = {
  runtime: {
    id: 'test',
    onMessage: { addListener() {} },
    sendMessage(m, cb) {
      sent.push(m);
      if (typeof cb === 'function') cb(m.cmd === 'goal-path' ? { ok: true, count: (m.steps || []).length } : { ok: true });
    },
    getURL: (p) => p,
  },
  tabs: { create() {} },
  storage: { local: { get(k, cb) { if (cb) cb({}); }, set() {} } },
};

const out = [];
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; out.push('  ok   ' + n); } else { fail++; out.push('  FAIL ' + n + ' → ' + e); }
};

const html = await (await fetch('/ui/dashboard.html')).text();
const doc = new DOMParser().parseFromString(html, 'text/html');
for (const s of doc.querySelectorAll('script')) s.remove();
document.body.innerHTML = doc.body.innerHTML;
await import('/ui/dashboard.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(400);

// 顯示用的標籤會帶 emoji，比對時只留造物名
const NAME = (s) => (s || '').replace(/\s+/g, ' ').trim().split(' ').pop();

/** 步驟表 → [{ result, inputs[] }]，順序就是畫面上的 1. 2. 3. */
function readSteps() {
  return [...document.querySelectorAll('#plan-result .steps > li')]
    .filter((li) => li.querySelector('.to'))
    .map((li) => ({
      result: NAME(li.querySelector('.to').textContent),
      inputs: [...li.querySelectorAll('.w')].map((w) => NAME(w.textContent)),
      unresolved: !!li.querySelector('.tag.dim'),
    }));
}

/**
 * 路徑樹 → Map(產物 → 材料[])，只收「還要動手煉」的節點。
 * 已持有／原質／缺料／循環截斷的葉子不算步驟。
 */
function readTree() {
  const map = new Map();
  const order = [];
  const walk = (li) => {
    const label = li.querySelector(':scope > .node');
    if (!label) return;
    const word = NAME([...label.childNodes].find((n) => n.nodeName === 'SPAN' && !n.className)?.textContent || '');
    const kids = [...li.querySelectorAll(':scope > ul > li')];
    const isLeaf = kids.length === 0;
    const marks = [...label.querySelectorAll('.depth')].map((d) => d.textContent).join('');
    const stopped = marks.includes('已持有') || marks.includes('原質') || marks.includes('缺料') || marks.includes('循環');
    if (!isLeaf && !stopped) {
      map.set(word, kids.map((k) => NAME([...k.querySelector(':scope > .node').childNodes].find((n) => n.nodeName === 'SPAN' && !n.className)?.textContent || '')));
      order.push(word);
    }
    kids.forEach(walk);
  };
  document.querySelectorAll('#tree-out > ul > li').forEach(walk);
  return { map, order };
}

function compare(label) {
  const steps = readSteps();
  const { map } = readTree();
  const stepWords = steps.map((s) => s.result);

  // 樹上每個「還要煉」的節點都必須是步驟表裡的一步
  const onlyTree = [...map.keys()].filter((w) => !stepWords.includes(w));
  check(`${label}：樹上要煉的節點都出現在步驟表`, onlyTree.length === 0, onlyTree.join('、'));

  // 步驟表裡的每一步都必須在樹上，而且材料要一模一樣
  const bad = [];
  for (const s of steps) {
    if (!map.has(s.result)) { bad.push(`${s.result}（樹上沒有）`); continue; }
    const a = [...s.inputs].sort().join('+');
    const b = [...map.get(s.result)].sort().join('+');
    if (a !== b) bad.push(`${s.result}：步驟用 ${a}，樹上畫 ${b}`);
  }
  check(`${label}：每一步的材料跟樹上一致`, bad.length === 0, bad.join(' ｜ '));

  // 排得出順序時，材料必須排在產物前面，不然照著做會卡住。
  // 走不通的路徑本來就排不出順序，那時畫面會直說並改用「・」而不是編號。
  const blocked = [...document.querySelectorAll('#plan-result .steps .no')].some((n) => n.textContent.trim() === '・');
  if (!blocked) {
    const doneAt = new Map(steps.map((s, i) => [s.result, i]));
    const orderBad = [];
    steps.forEach((s, i) => {
      for (const inp of s.inputs) {
        if (doneAt.has(inp) && doneAt.get(inp) > i) orderBad.push(`${s.result} 用到還沒煉的 ${inp}`);
      }
    });
    check(`${label}：材料排在產物前面`, orderBad.length === 0, orderBad.join('、'));
  } else {
    check(`${label}：排不出順序時有直說`, /走不通/.test((document.querySelector('#plan-result .verdict-box') || {}).textContent || ''), '');
  }
  return { steps, map };
}

async function plan(target) {
  document.getElementById('plan-input').value = target;
  document.getElementById('plan-go').click();
  await wait(120);
}

const setAccount = async (id) => {
  const sel = document.getElementById('account-select');
  sel.value = id;
  sel.dispatchEvent(new Event('change'));
  await wait(250);
};

out.push('[主號：手上東西多]');
for (const t of ['地熱', '熔爐', '浪', '間歇泉']) {
  await plan(t);
  compare(t);
}

out.push('[小號：幾乎什麼都沒有，路徑會很長]');
await setAccount('A2');
for (const t of ['地熱', '溫泉', '間歇泉', '浪']) {
  await plan(t);
  compare(t);
}

out.push('[在樹上換一條配方之後，步驟表要跟著換]');
await plan('地熱');
const before = compare('換之前');
const alt = [...document.querySelectorAll('#tree-out .link')];
check('非根節點上有「另有 N 條配方」可以點', alt.length > 0, String(alt.length));
if (alt.length) {
  out.push('  · 可換的節點：' + alt.map((b) => b.closest('li').querySelector('.node span').textContent.trim()).join('、'));
  alt[0].click();
  await wait(150);
  out.push('  · 有沒有出現「回到自動選的路徑」：' + (document.querySelector('#plan-result .link') ? '有（treePick 生效了）' : '沒有（treePick 是空的）'));
  const after = compare('換之後');
  check(
    '換過之後步驟表真的變了',
    JSON.stringify(before.steps) !== JSON.stringify(after.steps),
    JSON.stringify(after.steps)
  );
}

out.push('[會繞回目標的那條配方要當作不存在]');
// 遊戲王 ← 卡片＋決鬥，而 決鬥 ← 對戰＋遊戲王：決鬥那條會繞回目標。
// 規則是把它拔掉 → 決鬥降級成「自己想辦法弄到的材料」，路徑照樣給得出來。
await setAccount('A1');
await plan('遊戲王');
const head = () => document.querySelector('#plan-result .verdict-box');
const headText = () => (head().textContent || '').replace(/\s+/g, ' ');
compare('遊戲王');
check('不會再說「走不通」', !/走不通/.test(headText()), headText());
check('照樣給得出步驟', readSteps().length > 0, JSON.stringify(readSteps()));
check('步驟有編號（代表排得出順序）',
  [...document.querySelectorAll('#plan-result .steps .no')].every((n) => /^\d+\.$/.test(n.textContent.trim())),
  [...document.querySelectorAll('#plan-result .steps .no')].map((n) => n.textContent).join(''));
check('決鬥 被當成要自己弄到的材料', /缺少：.*決鬥/.test(headText()), headText());
check('樹上完全沒有「循環」字樣', !/循環/.test(document.getElementById('tree-out').textContent), document.getElementById('tree-out').textContent.slice(0, 120));
check('樹上不會出現第二個遊戲王',
  [...document.querySelectorAll('#tree-out .node')].filter((n) => NAME(n.querySelector('span').textContent) === '遊戲王').length === 1,
  [...document.querySelectorAll('#tree-out .node')].map((n) => NAME(n.querySelector('span').textContent)).join('、'));
check('決鬥 在樹上是停下來的葉子',
  [...document.querySelectorAll('#tree-out li')].some((li) => {
    const label = li.querySelector(':scope > .node');
    return label && NAME(label.childNodes[0].textContent) === '決鬥' && li.querySelectorAll(':scope > ul > li').length === 0;
  }),
  document.getElementById('tree-out').textContent.slice(0, 160));

out.push('[存進待煉]');
await setAccount('A1');
await plan('地熱');
const saveBtn = () => [...document.querySelectorAll('#plan-result button')].find((b) => b.textContent.includes('存進待煉'));
check('可行的路徑有「存進待煉」可以按', !!saveBtn());
sent.length = 0;
saveBtn().click();
await wait(150);
const saveMsg = sent.find((m) => m.cmd === 'goal-path');
check('送出的是整條路徑', !!saveMsg && saveMsg.target === '地熱', JSON.stringify(saveMsg && { t: saveMsg.target, n: (saveMsg.steps || []).length }));
check('步數跟畫面上的一致', saveMsg.steps.length === readSteps().length, `${saveMsg.steps.length} vs ${readSteps().length}`);
check('每一步都帶著配方 key', saveMsg.steps.every((s) => !!s.key), JSON.stringify(saveMsg.steps.map((s) => s.key)));
check('存完會回報結果', /已存進待煉/.test(document.getElementById('plan-result').textContent), '');

await plan('遊戲王'); // 拆環之後這條也是可以照做的（決鬥要自己弄到）
check('缺材料但排得出順序的路徑照樣能存', !!saveBtn(), '按鈕不見了');

out.push('[重新整理要真的重畫「怎麼煉」]');
await setAccount('A1');
await plan('地熱');
const planBefore = document.getElementById('plan-result').textContent;
document.getElementById('plan-result').textContent = '（被清掉了）';
document.getElementById('reload').click();
await wait(500);
check('按下去會把這一頁重畫回來',
  document.getElementById('plan-result').textContent.includes('地熱'),
  document.getElementById('plan-result').textContent.slice(0, 60));
check('重畫出來的跟原本一樣', document.getElementById('plan-result').textContent === planBefore, '');
check('按鈕會給回饋，不會看起來沒反應',
  document.getElementById('reload').textContent !== '重新整理',
  document.getElementById('reload').textContent);
await wait(1400);
check('回饋過幾秒會還原', document.getElementById('reload').textContent === '重新整理' && !document.getElementById('reload').disabled,
  document.getElementById('reload').textContent);

out.push('[兩種模式都要一致]');
for (const mode of ['steps', 'missing']) {
  document.getElementById('plan-mode').value = mode;
  await plan('地熱');
  compare(`模式=${mode}`);
}

check('沒有任何 console 錯誤', log.length === 0, log.join(' | '));

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
// 上面把 body 換成儀表板了，所以自己補一個輸出區
const pre = document.createElement('pre');
pre.id = 'out';
pre.textContent = out.join('\n');
document.body.prepend(pre);
document.title = fail === 0 ? 'PASS' : 'FAIL';
