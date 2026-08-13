// knowledge.js 與 planner.js 的離線測試（不需要遊戲、不碰 IndexedDB）。
import {
  recipeKey,
  normalizeInputs,
  fromAttempt,
  fromGameRecipe,
  fromGameLogEntry,
  fromForeignKnowledge,
  predict,
  recipesByResult,
  SOURCE,
} from '../src/knowledge.js';
import { plan, solve, knownCombosFromOwned } from '../src/planner.js';
import { computeDepths, buildTree } from '../src/analysis.js';

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

// 迷你知識庫：用 upsert 的方式把 entry 套進 Map，模擬 db.upsertKnowledgeBatch
const KB = new Map();
function apply(entry) {
  const next = entry.merge(KB.get(entry.key));
  if (next) KB.set(entry.key, next);
  return next;
}

let t = 1000;
function attempt(o) {
  const action = o.action || 'combine';
  const inputs = o.inputs;
  return {
    ts: o.ts ?? t++,
    action,
    inputs,
    prayed: !!o.prayed,
    outcome: o.outcome || 'success',
    result: (o.outcome || 'success') === 'success' ? o.result : null,
    emoji: o.emoji || null,
    type: o.type || null,
    rarity: o.rarity || null,
    isGlobalFirst: !!o.first,
    accountId: o.acc === undefined ? 'A1' : o.acc,
    accountName: o.accName === undefined ? '主號' : o.accName,
  };
}

// ── 主鍵正規化 ──
out.push('[recipeKey]');
check('材料順序不影響主鍵', recipeKey('combine', ['火', '水']) === recipeKey('combine', ['水', '火']));
check('萃取只看第一個材料', recipeKey('refine', ['火']) === 'refine:火');
check('合成與萃取不會撞鍵', recipeKey('combine', ['火']) !== recipeKey('refine', ['火']));
check('水＋水 有自己的主鍵', recipeKey('combine', ['水', '水']) === 'combine:水|水');
check('水＋水 不等於單一個水', recipeKey('combine', ['水', '水']) !== recipeKey('combine', ['水']));
check('normalizeInputs 保留重複材料', normalizeInputs('combine', ['水', '水']).length === 2);

// ── 普通／祈禱分軌 ──
out.push('[fromAttempt：普通與祈禱分軌]');
apply(fromAttempt(attempt({ inputs: ['溫泉', '雷'], outcome: 'fail' })));
apply(fromAttempt(attempt({ inputs: ['溫泉', '雷'], outcome: 'fail' })));
let rec = KB.get(recipeKey('combine', ['溫泉', '雷']));
check('普通失敗記在 normal', rec.normal.fail === 2 && rec.normal.outcome === 'fail', JSON.stringify(rec.normal));
check('祈禱那一軌還是空的', rec.pray.outcome === null);
check('此時判定為「已知會崩解」', predict(rec).status === 'fail', predict(rec).status);

apply(fromAttempt(attempt({ inputs: ['溫泉', '雷'], prayed: true, result: '間歇泉', emoji: '⛲', first: true })));
rec = KB.get(recipeKey('combine', ['溫泉', '雷']));
check('祈禱成功記在 pray', rec.pray.outcome === 'success');
check('普通那一軌不受影響', rec.normal.outcome === 'fail');
check('判定變成 pray-only', predict(rec).status === 'pray-only', predict(rec).status);
check('產物與發現者都記下了', rec.result === '間歇泉' && rec.discoveredBy.accountName === '主號');
check('全服首煉有標記', rec.globalFirst === true);

out.push('[fromAttempt：其他]');
apply(fromAttempt(attempt({ inputs: ['水', '火'], result: '蒸氣', emoji: '💨' })));
check('普通成功 → success', predict(KB.get(recipeKey('combine', ['水', '火']))).status === 'success');
const before = KB.size;
apply(fromAttempt(attempt({ inputs: ['暴風', '水'], outcome: 'error', reason: '魔力不足' })));
check('被伺服器擋下的請求不進知識庫', KB.size === before, `${KB.size} vs ${before}`);

// ── 水＋水 是合法配方 ──
out.push('[水＋水]');
apply(fromAttempt(attempt({ inputs: ['水', '水'], result: '海', emoji: '🌊' })));
check('水＋水→海 有記進去', KB.get('combine:水|水').result === '海');
apply(fromAttempt(attempt({ inputs: ['水', '水'], result: '水' })));
const degen = recipesByResult([...KB.values()]).get('水');
check('退化配方（水＋水→水）不列入配方表', !degen, JSON.stringify(degen));

// ── 從遊戲回填 ──
out.push('[fromGameRecipe]');
apply(
  fromGameRecipe('熔爐', { action: 'combine', a: '土', aEmoji: '⛰️', b: '火', bEmoji: '🔥', finderName: '別人', prayed: false }, { ts: 5000 })
);
rec = KB.get(recipeKey('combine', ['土', '火']));
check('回填的配方判定為可成', predict(rec).status === 'success');
check('回填不會灌水嘗試次數', rec.normal.success === 0, String(rec.normal.success));
check('記下遊戲回報的發現者', rec.finders[0].name === '別人');
check('來源標記為 sync', rec.sources.includes(SOURCE.SYNC));

// ── 匯入別人的知識 ──
out.push('[fromGameLogEntry：失敗也是知識]');
const KBL = new Map();
function applyL(entry) {
  const next = entry.merge(KBL.get(entry.key));
  if (next) KBL.set(entry.key, next);
  return next;
}
// 同一組材料：普通崩解 → 祈禱成功。這正是「省魔力」最有價值的一種知識。
applyL(fromGameLogEntry({ action: 'combine', a: '風', b: '火', failed: true, prayed: false, createdAt: 900 }, {}));
let logRec = KBL.get(recipeKey('combine', ['風', '火']));
check('失敗的紀錄有進知識庫', !!logRec, '沒有');
check('普通那一軌標成 fail', logRec.normal.outcome === 'fail', JSON.stringify(logRec.normal));
check('此時判定為已知會崩解', predict(logRec).status === 'fail', predict(logRec).status);

applyL(
  fromGameLogEntry(
    { action: 'combine', a: '風', b: '火', resultWord: '野火', resultEmoji: '🔥', failed: false, prayed: true, createdAt: 950 },
    { accountId: 'A1', accountName: '我' }
  )
);
logRec = KBL.get(recipeKey('combine', ['風', '火']));
check('祈禱成功記在 pray 軌', logRec.pray.outcome === 'success', JSON.stringify(logRec.pray));
check('普通那一軌沒被蓋掉', logRec.normal.outcome === 'fail');
check('判定變成「普通會崩解，祈禱可成」', predict(logRec).status === 'pray-only', predict(logRec).status);
check('產物有記下來（可判斷值不值得煉）', logRec.result === '野火' && logRec.emoji === '🔥');

// 失敗的紀錄沒有產物，不能污染 result
applyL(fromGameLogEntry({ action: 'refine', a: '水', failed: true, prayed: false, createdAt: 960 }, {}));
const refFail = KBL.get(recipeKey('refine', ['水']));
check('失敗的萃取不會亂填產物', refFail.result === null, String(refFail.result));
check('失敗的萃取材料只有一個', refFail.inputs.length === 1);

// 成功之後再遇到一筆失敗，不能把已知的成功降級
applyL(fromGameLogEntry({ action: 'combine', a: '風', b: '火', failed: true, prayed: true, createdAt: 999 }, {}));
check(
  '已知成功不會被之後的失敗蓋掉',
  KBL.get(recipeKey('combine', ['風', '火'])).pray.outcome === 'success',
  JSON.stringify(KBL.get(recipeKey('combine', ['風', '火'])).pray)
);

out.push('[fromForeignKnowledge]');
apply(
  fromForeignKnowledge(
    {
      action: 'combine',
      inputs: ['鐵', '火'],
      result: '鋼',
      normal: { outcome: 'success', success: 3, fail: 1, firstTs: 100, lastTs: 200 },
      pray: { outcome: null, success: 0, fail: 0 },
      discoveredBy: { accountName: '朋友甲', ts: 100 },
    },
    '朋友甲的紀錄'
  )
);
rec = KB.get(recipeKey('combine', ['鐵', '火']));
check('匯入的配方可查到', rec && rec.result === '鋼');
check('匯入來源標記正確', rec.sources.includes(SOURCE.IMPORT));
check('匯入保留發現者名字', rec.discoveredBy.accountName === '朋友甲');
check('匯入不會帶進別人的帳號 id', rec.discoveredBy.accountId === null);

out.push('[匯入：與我既有的配方合併]');
// 情境一：我試過崩解，別人試出來可成 → 併完要變成可成（這就是分享的價值）
const sizeBefore = KB.size;
apply(fromAttempt(attempt({ inputs: ['沙', '火'], outcome: 'fail' })));
check('先確認我這邊是崩解', predict(KB.get(recipeKey('combine', ['沙', '火']))).status === 'fail');
apply(
  fromForeignKnowledge(
    {
      action: 'combine',
      inputs: ['火', '沙'], // 材料順序不同，但主鍵一樣 → 必須併進同一筆
      result: '玻璃',
      emoji: '🪟',
      normal: { outcome: 'success', success: 5, fail: 0 },
      pray: { outcome: null, success: 0, fail: 0 },
      discoveredBy: { accountName: '朋友乙', ts: 50 },
    },
    '朋友乙'
  )
);
let merged = KB.get(recipeKey('combine', ['沙', '火']));
check('材料順序不同也併進同一筆（沒變成兩筆）', KB.size === sizeBefore + 1, `${KB.size} vs ${sizeBefore + 1}`);
check('別人的成功蓋過我的崩解', predict(merged).status === 'success', predict(merged).status);
check('產物從對方那邊補上', merged.result === '玻璃' && merged.emoji === '🪟');
// 次數是累加的（畫面上標「一共嘗試過 N 次」）：對方 5 成 + 我 1 敗
check('對方的成功次數併進來', merged.normal.success === 5, String(merged.normal.success));
check('我自己的崩解次數保留著', merged.normal.fail === 1, String(merged.normal.fail));
check('來源同時有自己煉的與他人分享', merged.sources.includes(SOURCE.LOCAL) && merged.sources.includes(SOURCE.IMPORT), merged.sources.join(','));

// 情境二：再匯入第二個人的檔案 → 次數繼續累加，判定不變
apply(
  fromForeignKnowledge(
    {
      action: 'combine',
      inputs: ['火', '沙'],
      result: '玻璃',
      normal: { outcome: 'success', success: 3, fail: 2 },
      pray: {},
      discoveredBy: { accountName: '朋友丙', ts: 700 },
    },
    '朋友丙'
  )
);
merged = KB.get(recipeKey('combine', ['沙', '火']));
check('第二個來源的次數繼續累加', merged.normal.success === 8 && merged.normal.fail === 3, JSON.stringify(merged.normal));
check('判定仍是可成', predict(merged).status === 'success');
check('發現者仍是時間最早的那位', merged.discoveredBy.accountName === '朋友乙', merged.discoveredBy.accountName);

// 情境三：我已經成功過，對方說崩解 → 不能把我的成功降級
apply(
  fromForeignKnowledge(
    { action: 'combine', inputs: ['水', '火'], normal: { outcome: 'fail', success: 0, fail: 9 }, pray: {} },
    '朋友丙'
  )
);
check(
  '別人的崩解不會蓋掉我已知的成功',
  predict(KB.get(recipeKey('combine', ['水', '火']))).status === 'success',
  predict(KB.get(recipeKey('combine', ['水', '火']))).status
);

// 情境四：我自己的產物與發現者不被對方覆蓋
apply(
  fromForeignKnowledge(
    {
      action: 'combine',
      inputs: ['溫泉', '雷'],
      result: '別的東西',
      emoji: '❌',
      normal: {},
      pray: { outcome: 'success' },
      discoveredBy: { accountName: '後來的人', ts: 999999 },
    },
    '朋友丁'
  )
);
const mine = KB.get(recipeKey('combine', ['溫泉', '雷']));
check('我自己煉到的產物不被對方覆蓋', mine.result === '間歇泉', mine.result);
check('較早的發現者保留（不被後來的人取代）', mine.discoveredBy.accountName === '主號', mine.discoveredBy.accountName);

out.push('[predict：未知]');
check('沒紀錄的組合是 unknown', predict(undefined).status === 'unknown');
// 呼叫端會無條件讀 normal / pray，形狀必須永遠完整
check('未知時仍有 normal/pray 形狀', predict(undefined).normal.success === 0 && predict(undefined).pray.fail === 0);
check('未知時 finders 是陣列', Array.isArray(predict(null).finders));

// ── 規劃器 ──
out.push('[planner]');
const KB2 = new Map();
function apply2(entry) {
  const next = entry.merge(KB2.get(entry.key));
  if (next) KB2.set(entry.key, next);
}
[
  [['水', '火'], '蒸氣'],
  [['蒸氣', '土'], '溫泉'],
  [['溫泉', '雷'], '間歇泉', { prayed: true }],
  [['火'], '燃燒', { action: 'refine' }],
  [['燃燒', '間歇泉'], '地熱'],
  [['水', '水'], '海'],
  [['海', '風'], '浪'],
  [['隕鐵', '燃燒'], '熔爐'], // 隕鐵沒人煉得出來 → 缺料
  [['土', '土'], '山'],
].forEach(([inputs, result, opts]) => apply2(fromAttempt(attempt({ inputs, result, ...(opts || {}) }))));

const byResult = recipesByResult([...KB2.values()]);
const owned = new Set(['水', '火', '土', '風', '雷']);

const p1 = plan('地熱', owned, byResult, 'steps');
check('地熱規劃成功', p1.ok === true, JSON.stringify(p1.missing));
check('地熱需要 5 步', p1.stepCount === 5, String(p1.stepCount));
check('步驟順序合法（材料先於產物）', (() => {
  const have = new Set(owned);
  for (const s of p1.steps) {
    if (!s.inputs.every((i) => have.has(i))) return false;
    have.add(s.result);
  }
  return have.has('地熱');
})(), JSON.stringify(p1.steps.map((s) => s.result)));
check('標出路徑中需要祈禱的步驟', p1.needsPray === true);
// 每一步都要帶 key，路徑樹才認得出「這一步用的是哪一條配方」。
// 少了它，樹只能照全域最短深度自己挑，畫出來的路徑就跟步驟表對不起來。
check('每一步都帶著配方 key', p1.steps.every((s) => !!s.key), JSON.stringify(p1.steps.map((s) => s.key)));
check(
  'key 對得回共用配方表裡的那一條',
  p1.steps.every((s) => (byResult.get(s.result) || []).some((r) => r.key === s.key)),
  JSON.stringify(p1.steps.map((s) => [s.result, s.key]))
);

const p2 = plan('海', owned, byResult, 'steps');
check('水＋水→海 只要 1 步', p2.stepCount === 1 && p2.ok, JSON.stringify(p2));
check('水＋水 的步驟材料是兩個水', p2.steps[0].inputs.join('+') === '水+水', JSON.stringify(p2.steps[0]));

const p3 = plan('浪', owned, byResult, 'steps');
check('浪要 2 步（海→浪）', p3.stepCount === 2 && p3.ok, String(p3.stepCount));

const p4 = plan('熔爐', owned, byResult, 'steps');
check('缺料時 ok=false', p4.ok === false);
check('缺料清單指出隕鐵', p4.missing.includes('隕鐵'), JSON.stringify(p4.missing));
check('缺料時仍給得出步驟', p4.steps.length > 0);

const p5 = plan('水', owned, byResult, 'steps');
check('已持有的東西直接回報', p5.alreadyOwned === true && p5.stepCount === 0);

const p6 = plan('不存在的東西', owned, byResult, 'steps');
check('知識庫沒有的目標會說明原因', p6.ok === false && !!p6.reason);

// 有了中間產物之後步數要變少
const owned2 = new Set([...owned, '間歇泉', '燃燒']);
const p7 = plan('地熱', owned2, byResult, 'steps');
check('手上有中間產物時只剩 1 步', p7.stepCount === 1, String(p7.stepCount));

out.push('[knownCombosFromOwned：現在手上就能煉]');
const combos = knownCombosFromOwned(owned, [...KB2.values()]);
const comboWords = combos.map((c) => c.result).sort();
// 燃燒是「萃取自火」，火在手上，所以一步就能拿到
check('現在就能煉：山、海、燃燒、蒸氣', comboWords.join(',') === '山,海,燃燒,蒸氣', comboWords.join(','));
check('不含已持有的產物', !combos.some((c) => owned.has(c.result)));
check('不含材料還沒湊齊的（浪要先有海）', !comboWords.includes('浪'), comboWords.join(','));
check('會標出需祈禱', combos.every((c) => typeof c.needsPray === 'boolean'));

out.push('[循環配方]');
const KB3 = new Map();
for (const e of [
  fromAttempt(attempt({ inputs: ['甲', '水'], result: '乙' })),
  fromAttempt(attempt({ inputs: ['乙', '火'], result: '甲' })),
]) {
  const next = e.merge(KB3.get(e.key));
  if (next) KB3.set(e.key, next);
}
let cycOk = true;
try {
  solve(new Set(['水', '火']), recipesByResult([...KB3.values()]), 'steps');
} catch (_) {
  cycOk = false;
}
check('互相循環的配方不會無限迴圈', cycOk);

out.push('[局部搜尋：撿回貪婪漏掉的共用]');
// 己 有兩條配方：丙＋丁 自己算比較便宜（3 步），甲＋庚 自己算比較貴（4 步）。
// 但辛 本來就要煉甲與乙，所以走比較「貴」的那條反而總步數更少。
// 貪婪只看「這一條自己多貴」，看不到「用它就順便省掉別的」——局部搜尋要能撿回來。
const KB4 = new Map();
const put4 = (inputs, result) => {
  const e = fromAttempt(attempt({ inputs, result }));
  const next = e.merge(KB4.get(e.key));
  if (next) KB4.set(e.key, next);
};
put4(['水', '火'], '甲');
put4(['土', '風'], '乙');
put4(['水', '土'], '丙');
put4(['火', '風'], '丁');
put4(['甲', '乙'], '戊');
put4(['乙', '雷'], '庚');
put4(['丙', '丁'], '己'); // 己 的第一條：3 步
put4(['甲', '庚'], '己'); // 己 的第二條：4 步，但跟戊共用甲、乙
put4(['戊', '己'], '辛');

const by4 = recipesByResult([...KB4.values()]);
const ownedC = new Set(['水', '火', '土', '風', '雷']);
check('己 真的有兩條配方', (by4.get('己') || []).length === 2, String((by4.get('己') || []).length));
const p9 = plan('辛', ownedC, by4, 'steps');
check('辛 規劃成功', p9.ok === true, JSON.stringify(p9.missing));
// 走 丙＋丁 那條：甲乙戊丙丁己辛 ＝ 7 步；走 甲＋庚 那條：甲乙戊庚己辛 ＝ 6 步
check('選到會共用材料的那條（6 步而不是 7 步）', p9.stepCount === 6, String(p9.stepCount));
check(
  '步驟裡沒有白煉的丙、丁',
  !p9.steps.some((s) => s.result === '丙' || s.result === '丁'),
  JSON.stringify(p9.steps.map((s) => s.result))
);

out.push('[環：一律當作那條配方不存在]');
// 癸 有兩條配方：一條繞回自己（透過子），一條老老實實用得到的材料。
// 推薦出來的那條**絕對不能**是繞回自己的那條。
const KB6 = new Map();
const put6 = (inputs, result) => {
  const e = fromAttempt(attempt({ inputs, result }));
  const next = e.merge(KB6.get(e.key));
  if (next) KB6.set(e.key, next);
};
put6(['水', '火'], '甲');
put6(['土', '風'], '乙');
put6(['甲', '癸'], '子'); // 子 要用到癸
put6(['子', '雷'], '癸'); // 癸 又要用到子 → 這一對互相循環
put6(['甲', '乙'], '癸'); // 癸 的另一條：正常做得出來
const by6 = recipesByResult([...KB6.values()]);
const ownedP = new Set(['水', '火', '土', '風', '雷']);
const p10 = plan('癸', ownedP, by6, 'steps');
check('癸 規劃成功', p10.ok === true, JSON.stringify(p10));
check('選的是不繞回自己的那條（甲＋乙）', p10.steps.some((s) => s.result === '癸' && s.inputs.sort().join('+') === '乙+甲'), JSON.stringify(p10.steps));
check('路徑裡不會出現子（那是環的另一半）', !p10.steps.some((s) => s.result === '子'), JSON.stringify(p10.steps.map((s) => s.result)));

// 使用者提的那個情境：
//   目標 X ← D＋F、F ← A＋X（F 要用到 X）、D ← C＋B、C ← A＋B
// 「把最後接成環的那一步拔掉」＝ 當作 A＋X＝F 不存在，F 降級成自己想辦法弄到的材料。
// 期望的路徑：A＋B＝C、C＋B＝D、D＋F＝X，F 標成缺料。
const KB8 = new Map();
const put8 = (inputs, result) => {
  const e = fromAttempt(attempt({ inputs, result }));
  const next = e.merge(KB8.get(e.key));
  if (next) KB8.set(e.key, next);
};
put8(['水', '火'], 'C'); // A＝水、B＝火
put8(['C', '火'], 'D');
put8(['水', 'X'], 'F'); // ← 會繞回目標的那條
put8(['D', 'F'], 'X');
const by8 = recipesByResult([...KB8.values()]);
const p11 = plan('X', ownedP, by8, 'steps');
check('拆掉會繞回目標的那條之後，路徑還是給得出來', p11.ok === false && p11.steps.length === 3, JSON.stringify(p11));
check(
  '給的就是 C、D、X 三步',
  p11.steps.map((s) => s.result).join(',') === 'C,D,X',
  JSON.stringify(p11.steps.map((s) => s.result))
);
check('F 變成要自己想辦法弄到的材料', p11.missing.join(',') === 'F', JSON.stringify(p11.missing));
check('每一步都排得出順序（沒有卡住的）', !p11.steps.some((s) => s.unresolved), JSON.stringify(p11.steps.map((s) => [s.result, !!s.unresolved])));

// 樹也要停在 F，不能照著 F ← 水＋X 又畫回目標
const { best: best8 } = computeDepths(by8);
const chosen8 = new Map(best8);
for (const s of p11.steps) {
  const r = (by8.get(s.result) || []).find((x) => x.key === s.key);
  if (r) chosen8.set(s.result, r);
}
const t8 = buildTree('X', by8, chosen8, { stopAt: ownedP, missing: new Set(p11.missing) });
const flat8 = [];
(function walk(n) { flat8.push(n); n.children.forEach(walk); })(t8);
check('樹上沒有任何一個節點被標成循環', !flat8.some((n) => n.cycle), JSON.stringify(flat8.filter((n) => n.cycle).map((n) => n.word)));
check('F 在樹上是缺料的葉子', flat8.some((n) => n.word === 'F' && n.kind === 'unknown' && !n.children.length), JSON.stringify(flat8.map((n) => [n.word, n.kind])));
check('樹上不會再出現目標自己', flat8.filter((n) => n.word === 'X').length === 1, JSON.stringify(flat8.map((n) => n.word)));

// 兩個造物只能互相做出對方 → 拆掉一邊，另一邊還是給得出路徑
const KB9 = new Map();
const put9 = (inputs, result) => {
  const e = fromAttempt(attempt({ inputs, result }));
  const next = e.merge(KB9.get(e.key));
  if (next) KB9.set(e.key, next);
};
put9(['午', '水'], '巳');
put9(['巳', '火'], '午');
const by9 = recipesByResult([...KB9.values()]);
const p12 = plan('巳', ownedP, by9, 'steps');
check('互相依賴時，拆掉另一邊就給得出路徑', p12.steps.length === 1 && p12.steps[0].result === '巳', JSON.stringify(p12.steps));
check('被拆掉的那個變成缺料', p12.missing.join(',') === '午', JSON.stringify(p12.missing));

// buildTree 自己的最後一道防線：拿不到「該用哪條配方」時**不准**隨便抓一條。
// 以前這裡會退而求其次抓 recipes 的第一條，那正是把環畫上樹的元凶。
// 走完整流程時規劃器會先把這些標成缺料，所以這裡直接餵一個空的 best 來打它。
const { best: best9 } = computeDepths(by9);
check('深度算不出來的造物不會進 best', !best9.has('巳') && !best9.has('午'), JSON.stringify([...best9.keys()]));
const t9 = buildTree('巳', by9, best9, { stopAt: ownedP });
check('拿不到配方時標成 unreachable，不亂抓一條', t9.kind === 'unreachable', JSON.stringify({ kind: t9.kind, recipe: t9.recipe }));
check('而且不會往下展開成一條環', t9.children.length === 0, JSON.stringify(t9.children.map((c) => c.word)));

out.push('[最少未知不該比最短路徑還缺]');
// 丑 有兩條做法：一條 2 步但缺 2 樣，一條 3 步只缺 1 樣。
const KB7 = new Map();
const put7 = (inputs, result) => {
  const e = fromAttempt(attempt({ inputs, result }));
  const next = e.merge(KB7.get(e.key));
  if (next) KB7.set(e.key, next);
};
put7(['缺甲', '缺乙'], '寅'); // 兩樣都沒人煉得出來 → 缺 2
put7(['水', '火'], '卯');
put7(['卯', '缺丙'], '辰'); // 缺 1
put7(['寅', '水'], '丑');
put7(['辰', '火'], '丑');
const by7 = recipesByResult([...KB7.values()]);
const steps7 = plan('丑', ownedP, by7, 'steps');
const miss7 = plan('丑', ownedP, by7, 'missing');
check('兩種模式都算得出來', steps7.ok === false && miss7.ok === false, JSON.stringify([steps7.ok, miss7.ok]));
check(
  '最少未知缺的不會比最短路徑多',
  miss7.missing.length <= steps7.missing.length,
  `最短路徑缺 ${steps7.missing.length}（${steps7.missing}）／最少未知缺 ${miss7.missing.length}（${miss7.missing}）`
);
check('最少未知真的挑到只缺一樣的那條', miss7.missing.length === 1, JSON.stringify(miss7.missing));

out.push('[同一份資料要給同一個答案；換資料要重建 Map]');
// solve 的結果以容器識別碼快取。保證的是：同一組容器問幾次都一樣，
// 換了資料重建一個新的 Map 就會反映出來。
// （不保證的是「就地修改一定看不到」——局部搜尋找替代配方時讀的是當下的 Map。
//   所以換資料請重建，儀表板本來就是每次重建。）
const before4 = plan('辛', ownedC, by4, 'steps').stepCount;
check('同一組容器問三次都一樣', [1, 2, 3].every(() => plan('辛', ownedC, by4, 'steps').stepCount === before4), String(before4));
check('步驟內容也一樣', plan('辛', ownedC, by4, 'steps').steps.map((s) => s.result).join(',') === plan('辛', ownedC, by4, 'steps').steps.map((s) => s.result).join(','), '');
put4(['水', '雷'], '己'); // 己 多一條一步就好的捷徑
const by5 = recipesByResult([...KB4.values()]);
check(
  '重建一個新的 Map 會反映新資料（多了捷徑，步數變少）',
  plan('辛', ownedC, by5, 'steps').stepCount < before4,
  `${plan('辛', ownedC, by5, 'steps').stepCount} vs ${before4}`
);

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
document.getElementById('out').textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
