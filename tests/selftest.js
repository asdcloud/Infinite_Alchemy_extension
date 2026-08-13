// analysis.js（族譜與深度）的離線自我測試。
// 用瀏覽器開 selftest.html，或：
//   msedge --headless=new --allow-file-access-from-files --dump-dom "…/tests/selftest.html"
import { computeDepths, buildTree, classify, PRIMORDIALS } from '../src/analysis.js';
import { recipesByResult } from '../src/knowledge.js';

const out = [];
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    out.push(`  ok   ${name}`);
  } else {
    fail++;
    out.push(`  FAIL ${name} → ${extra}`);
  }
}

// 直接組出 knowledge 紀錄，再用 recipesByResult 轉成族譜要吃的形狀，
// 跟正式程式走的是同一條路。
let seq = 1000;
const arm = (outcome) => ({ outcome, success: outcome === 'success' ? 1 : 0, fail: outcome === 'fail' ? 1 : 0, firstTs: seq, lastTs: seq });
function K(action, inputs, result, opts = {}) {
  const norm = action === 'refine' ? inputs.slice(0, 1) : [...inputs].sort();
  return {
    key: action === 'refine' ? `refine:${norm[0]}` : `combine:${norm.join('|')}`,
    action,
    inputs: norm,
    result,
    emoji: opts.emoji || null,
    normal: opts.pray ? arm(null) : arm('success'),
    pray: opts.pray ? arm('success') : arm(null),
    discoveredBy: null,
    finders: [],
    globalFirst: !!opts.first,
    sources: ['local'],
    createdAt: seq,
    updatedAt: seq++,
  };
}

const KB = [
  K('combine', ['水', '火'], '蒸氣', { emoji: '💨' }),
  K('combine', ['蒸氣', '土'], '溫泉'),
  K('combine', ['溫泉', '雷'], '間歇泉', { pray: true, first: true }),
  K('refine', ['火'], '燃燒'),
  K('combine', ['燃燒', '間歇泉'], '地熱'),
  K('combine', ['水', '水'], '海'), // 同材料組合是合法的
  K('combine', ['水', '水'], '水'), // 退化配方，產物等於材料
  K('combine', ['隕鐵', '燃燒'], '熔爐'), // 隕鐵沒人煉得出來
  K('combine', ['土', '火'], '熔爐'), // 同一產物的第二條配方（比較短）
];

const recipes = recipesByResult(KB);
const { depth, best } = computeDepths(recipes);

out.push('[recipesByResult]');
check('退化配方（水＋水→水）被排除', !recipes.has('水'));
check('水＋水→海 保留（同材料組合合法）', (recipes.get('海') || []).length === 1, JSON.stringify(recipes.get('海')));
check('熔爐有兩條配方', (recipes.get('熔爐') || []).length === 2, String((recipes.get('熔爐') || []).length));
check('萃取也算配方', (recipes.get('燃燒') || [])[0]?.action === 'refine');
check('需祈禱的配方有標記', (recipes.get('間歇泉') || [])[0]?.needsPray === true);

out.push('[computeDepths]');
check('蒸氣深度 1', depth.get('蒸氣') === 1, String(depth.get('蒸氣')));
check('溫泉深度 2', depth.get('溫泉') === 2, String(depth.get('溫泉')));
check('間歇泉深度 3', depth.get('間歇泉') === 3, String(depth.get('間歇泉')));
check('地熱深度 4', depth.get('地熱') === 4, String(depth.get('地熱')));
check('海深度 1（水＋水）', depth.get('海') === 1, String(depth.get('海')));
check('熔爐取較短的那條（土＋火 → 1）', depth.get('熔爐') === 1, String(depth.get('熔爐')));

out.push('[classify]');
check('水是原質', classify('水', recipes) === 'primordial');
check('隕鐵來源不明', classify('隕鐵', recipes) === 'unknown');
check('地熱是煉成的', classify('地熱', recipes) === 'crafted');
check('五原質剛好五種', PRIMORDIALS.length === 5 && PRIMORDIALS.includes('雷'));

out.push('[buildTree]');
const tree = buildTree('地熱', recipes, best);
check('地熱樹根正確', tree.word === '地熱' && tree.children.length === 2);
const leaves = [];
(function walk(n) {
  if (n.kind !== 'crafted') leaves.push(n.word);
  n.children.forEach(walk);
})(tree);
check('地熱的起始材料只有原質', leaves.every((w) => PRIMORDIALS.includes(w)), leaves.join(','));
const seaTree = buildTree('海', recipes, best);
check('水＋水→海 的樹有兩個水節點', seaTree.children.length === 2 && seaTree.children.every((c) => c.word === '水'), JSON.stringify(seaTree.children.map((c) => c.word)));

out.push('[buildTree：停在已持有的東西]');
// 傳入持有物後，樹要停在你手上有的節點——這樣畫出來的才跟規劃器算的路徑一致
const stopped = buildTree('地熱', recipes, best, { stopAt: new Set(['間歇泉']) });
const stoppedWords = [];
(function walk(n) {
  stoppedWords.push(`${n.word}:${n.kind}`);
  n.children.forEach(walk);
})(stopped);
check('已持有的節點標成 owned 且不再展開', stoppedWords.includes('間歇泉:owned'), stoppedWords.join(','));
check('停下來之後就不會再往下追溫泉', !stoppedWords.some((s) => s.startsWith('溫泉')), stoppedWords.join(','));
check('根節點不會被 stopAt 擋掉', buildTree('地熱', recipes, best, { stopAt: new Set(['地熱']) }).children.length === 2);

out.push('[循環保護]');
const cyc = recipesByResult([K('combine', ['甲', '水'], '乙'), K('combine', ['乙', '火'], '甲')]);
const cycD = computeDepths(cyc);
let cycOk = true;
try {
  buildTree('甲', cyc, cycD.best);
} catch (_) {
  cycOk = false;
}
check('互相循環的配方不會爆堆疊', cycOk);

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
document.getElementById('out').textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
