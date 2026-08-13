// 遊戲內浮層：合成之前先告訴你這組材料有沒有人試過。
//
// 自動偵測的依據是工坊裡的材料格：
//   <button class="chip r{星等} selected"><span>{emoji}</span><span>{詞}</span></button>
// 選中的格子會多一個 selected class。遊戲改版導致抓不到時會自動切回手動輸入，
// 不會影響記錄功能，也不會干擾遊戲本身。

const HOST_ID = 'ia-tracker-overlay';
const CHIP_SELECTORS = [
  'button.chip.selected',
  '.chip.selected',
  '[class*="chip"][class*="selected"]',
];

const VERDICT = {
  success: { icon: '✅', tone: 'ok', text: '已知可成' },
  'pray-only': { icon: '🙏', tone: 'pray', text: '普通會崩解，祈禱可成' },
  'pray-known': { icon: '🙏', tone: 'pray', text: '祈禱煉得出來' },
  fail: { icon: '⚠️', tone: 'bad', text: '已知會崩解' },
  dead: { icon: '⛔', tone: 'bad', text: '普通與祈禱都失敗過' },
  unknown: { icon: '❓', tone: 'dim', text: '尚無紀錄——可能是全新配方' },
};

const CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;
  width: 268px; font-family: -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  font-size: 13px; line-height: 1.55; color: #f2e6cf;
  background: #221a12; border: 1px solid #4a3925; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.5); overflow: hidden;
}
.wrap.collapsed .body { display: none; }
.head {
  display: flex; align-items: center; gap: 6px; padding: 7px 10px;
  background: #2c2217; border-bottom: 1px solid #3a2c1c; cursor: pointer; user-select: none;
}
.head .t { font-size: 13px; color: #f7d183; flex: 1; letter-spacing: .5px; }
.head button {
  all: unset; cursor: pointer; color: #b39c76; padding: 0 5px; font-size: 13px; border-radius: 4px;
}
.head button:hover { color: #f2e6cf; }
.body { padding: 9px 10px 10px; }
.pair { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-bottom: 7px; }
.mat {
  background: #34281a; border: 1px solid #4a3925; border-radius: 7px; padding: 1px 8px; font-size: 13px;
}
.op { color: #806b4c; }
.verdict { border-radius: 8px; padding: 6px 9px; border: 1px solid; font-size: 12.5px; }
.verdict.ok   { color: #a9e6b4; border-color: #3f6f47; background: rgba(116,207,130,.09); }
.verdict.pray { color: #c9b4ff; border-color: #5b46a0; background: rgba(168,131,255,.09); }
.verdict.bad  { color: #ffb0a3; border-color: #7a3226; background: rgba(226,112,95,.09); }
.verdict.dim  { color: #b39c76; border-color: #3a2c1c; background: rgba(255,255,255,.02); }
.verdict .res { color: #f7d183; font-weight: 600; }
.sub { color: #806b4c; font-size: 11.5px; margin-top: 3px; }
.manual { display: flex; gap: 5px; margin-bottom: 7px; }
.manual input {
  all: unset; flex: 1; min-width: 0; background: #1c1610; border: 1px solid #4a3925;
  border-radius: 7px; padding: 4px 8px; color: #f2e6cf; font-size: 12.5px;
}
.manual input:focus { border-color: #e0b155; }
.list { margin: 8px 0 0; padding: 0; list-style: none; max-height: 168px; overflow-y: auto; }
.list li { padding: 3px 0; border-top: 1px solid rgba(74,57,37,.4); font-size: 12.5px; }
.list li:first-child { border-top: none; }
.list .to { color: #f7d183; }
.tag { font-size: 10.5px; border: 1px solid #5b46a0; color: #c9b4ff; border-radius: 999px; padding: 0 5px; margin-left: 4px; }
.h2 { color: #b39c76; font-size: 11.5px; margin: 9px 0 0; letter-spacing: .5px; }
.prog { margin-top: 8px; font-size: 11.5px; color: #b39c76; }
.bar { height: 3px; background: #1c1610; border-radius: 2px; overflow: hidden; margin-top: 3px; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg,#ff7f38,#e0b155); width: 0; }
.hide { display: none; }
`;

export function mountOverlay(ctx) {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="head">
      <span>⚗️</span><span class="t">煉製軌跡</span>
      <button class="sync" title="更新這個帳號的狀態">⟳</button>
      <button class="dash" title="開啟儀表板">▤</button>
      <button class="fold" title="收合">－</button>
    </div>
    <div class="body">
      <div class="pair"></div>
      <div class="manual hide">
        <input class="ma" placeholder="材料 A" /><input class="mb" placeholder="材料 B" />
      </div>
      <div class="verdict dim">選兩個材料，這裡會顯示已知結果</div>
      <div class="prog hide"><span class="ptext"></span><span class="bar"><i></i></span></div>
      <p class="h2">現在手上就能煉（已知配方）</p>
      <ul class="list"></ul>
    </div>`;
  root.appendChild(wrap);
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const els = {
    wrap,
    pair: $('.pair'),
    manual: $('.manual'),
    ma: $('.ma'),
    mb: $('.mb'),
    verdict: $('.verdict'),
    list: $('.list'),
    prog: $('.prog'),
    ptext: $('.ptext'),
    bar: $('.bar i'),
    fold: $('.fold'),
  };

  let lastKey = '';
  let manualMode = false;

  // ── 收合狀態 ──
  chrome.storage?.local?.get?.(['overlayCollapsed'], (v) => {
    if (v && v.overlayCollapsed) setCollapsed(true);
  });
  function setCollapsed(on) {
    wrap.classList.toggle('collapsed', on);
    els.fold.textContent = on ? '＋' : '－';
    try {
      chrome.storage.local.set({ overlayCollapsed: on });
    } catch (_) {
      /* 忽略 */
    }
  }
  $('.head').addEventListener('click', (e) => {
    if (e.target.closest('button') && !e.target.closest('.fold')) return;
    setCollapsed(!wrap.classList.contains('collapsed'));
  });
  window.addEventListener('ia-overlay-toggle', () => setCollapsed(!wrap.classList.contains('collapsed')));

  $('.dash').addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.sendAsync({ type: 'ia-cmd', cmd: 'open-dashboard' });
  });

  $('.sync').addEventListener('click', (e) => {
    e.stopPropagation();
    els.prog.classList.remove('hide');
    ctx.runSync({});
  });

  window.addEventListener('ia-sync-progress', (e) => {
    const p = e.detail || {};
    els.prog.classList.remove('hide');
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    els.bar.style.width = `${pct}%`;
    if (p.phase === 'done') {
      const s = p.stats || {};
      els.ptext.textContent = `更新完成：素材櫃 ${s.discoveries ?? 0} 種、軌跡 +${
        (s.logAdded ?? 0) + (s.myRecipesAdded ?? 0)
      }、配方表 +${s.learned ?? 0}`;
      refreshSuggestions();
      setTimeout(() => els.prog.classList.add('hide'), 6000);
    } else if (p.phase === 'error') {
      els.ptext.textContent = `同步失敗：${p.error || '未知錯誤'}`;
    } else if (p.phase === 'cancelled') {
      els.ptext.textContent = '已取消';
    } else {
      els.ptext.textContent = `${p.label || '同步中'}${p.total ? `（${p.done}/${p.total}）` : ''}`;
    }
  });

  // ── 偵測選中的材料 ──
  function readSelected() {
    for (const sel of CHIP_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      if (!nodes.length) continue;
      const words = [];
      for (const n of nodes) {
        const spans = n.querySelectorAll('span');
        // chip 的結構是 <span>emoji</span><span>詞</span>，取最後一個
        const w = (spans.length ? spans[spans.length - 1].textContent : n.textContent) || '';
        const t = w.trim();
        if (t) words.push(t);
      }
      if (words.length) return words.slice(0, 2);
    }
    return [];
  }

  function renderPair(words) {
    els.pair.textContent = '';
    words.forEach((w, i) => {
      if (i > 0) {
        const op = document.createElement('span');
        op.className = 'op';
        op.textContent = '＋';
        els.pair.appendChild(op);
      }
      const m = document.createElement('span');
      m.className = 'mat';
      m.textContent = w;
      els.pair.appendChild(m);
    });
  }

  function showVerdict(pred, words) {
    const v = VERDICT[pred.status] || VERDICT.unknown;
    els.verdict.className = `verdict ${v.tone}`;
    els.verdict.textContent = '';
    const line = document.createElement('div');
    line.textContent = `${v.icon} ${v.text}`;
    els.verdict.appendChild(line);

    if (pred.result && (pred.status === 'success' || pred.status === 'pray-only' || pred.status === 'pray-known')) {
      const res = document.createElement('div');
      res.innerHTML = '→ ';
      const strong = document.createElement('span');
      strong.className = 'res';
      strong.textContent = `${pred.emoji ? pred.emoji + ' ' : ''}${pred.result}`;
      res.appendChild(strong);
      els.verdict.appendChild(res);
    }
    const bits = [];
    const finder =
      (pred.discoveredBy && (pred.discoveredBy.accountName || pred.discoveredBy.finderName)) || null;
    if (finder) bits.push(`由 ${finder} 發現`);
    const tries = (pred.normal?.success || 0) + (pred.normal?.fail || 0) + (pred.pray?.success || 0) + (pred.pray?.fail || 0);
    if (tries) bits.push(`一共嘗試過 ${tries} 次`);
    if (pred.globalFirst) bits.push('全服首煉');
    if (bits.length) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = bits.join('・');
      els.verdict.appendChild(sub);
    }
    void words;
  }

  async function evaluate(words) {
    if (words.length < 1) {
      els.verdict.className = 'verdict dim';
      els.verdict.textContent = '選兩個材料，這裡會顯示已知結果';
      return;
    }
    const action = words.length === 1 ? 'refine' : 'combine';
    const r = await ctx.sendAsync({ type: 'ia-cmd', cmd: 'predict', action, inputs: words });
    if (r && r.ok) showVerdict(r.prediction, words);
  }

  function tick() {
    if (manualMode) return;
    const words = readSelected();
    const key = words.join('|');
    if (key === lastKey) return;
    lastKey = key;
    renderPair(words);
    evaluate(words);
  }

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, 160);
  });
  try {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  } catch (_) {
    /* 忽略 */
  }

  // 開場先試一次；若一直抓不到選取狀態，就切成手動輸入
  setTimeout(() => {
    tick();
    if (!readSelected().length) enableManualFallback();
  }, 2500);

  function enableManualFallback() {
    if (manualMode) return;
    manualMode = true;
    els.manual.classList.remove('hide');
    const run = () => {
      const words = [els.ma.value.trim(), els.mb.value.trim()].filter(Boolean);
      renderPair(words);
      evaluate(words);
    };
    let t = null;
    for (const input of [els.ma, els.mb]) {
      input.addEventListener('input', () => {
        if (t) clearTimeout(t);
        t = setTimeout(run, 250);
      });
    }
  }

  // 只要偵測得到就退出手動模式
  const autoWatch = setInterval(() => {
    if (manualMode && readSelected().length) {
      manualMode = false;
      els.manual.classList.add('hide');
      clearInterval(autoWatch);
    }
  }, 4000);

  // ── 現在就能煉 ──
  async function refreshSuggestions() {
    const r = await ctx.sendAsync({ type: 'ia-cmd', cmd: 'suggest', limit: 30 });
    els.list.textContent = '';
    if (!r || !r.ok || !r.items.length) {
      const li = document.createElement('li');
      li.className = 'sub';
      li.textContent = r && r.ok ? '共用配方表裡沒有你手上材料能直接做的新東西。按 ⟳ 更新，或匯入別人分享的配方。' : '尚無資料';
      els.list.appendChild(li);
      return;
    }
    for (const it of r.items.slice(0, 30)) {
      const li = document.createElement('li');
      li.textContent = `${it.inputs.join(' ＋ ')} → `;
      const to = document.createElement('span');
      to.className = 'to';
      to.textContent = `${it.emoji ? it.emoji + ' ' : ''}${it.result}`;
      li.appendChild(to);
      if (it.needsPray) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '需祈禱';
        li.appendChild(tag);
      }
      els.list.appendChild(li);
    }
  }
  refreshSuggestions();
  setInterval(refreshSuggestions, 60000);
}
