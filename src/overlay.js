// 遊戲內浮層：合成之前先告訴你這組材料有沒有人試過。
//
// 自動偵測讀的是煉製台上那兩個格子：
//   <div class="workbench"><div class="slots">
//     <div class="slot filled"><div class="chip r{星等}"><span>{emoji}</span><span>{詞}</span></div>…</div>
//     <span class="op">＋</span>
//     <div class="slot">…</div>          ← 沒放東西的格子沒有 filled
//   </div></div>
// 你在遊戲裡點材料，格子一填上，兩個輸入框就自動跟著填、判定跟著出來。
// 想查還沒放進去的組合，直接在框裡打字也行。
//
// 兩格都有＝煉成，只有一格＝萃取——跟遊戲那顆按鈕的判斷一模一樣。

const HOST_ID = 'ia-tracker-overlay';
// 由準到寬：先找煉製台，再退而求其次找材料列表選中的那幾顆
const SLOT_SCOPES = ['.workbench .slots', '.slots'];
const TRAY_SELECTORS = ['button.chip.selected', '.chip.selected'];

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
.verdict { border-radius: 8px; padding: 6px 9px; border: 1px solid; font-size: 12.5px; }
.verdict.ok   { color: #a9e6b4; border-color: #3f6f47; background: rgba(116,207,130,.09); }
.verdict.pray { color: #c9b4ff; border-color: #5b46a0; background: rgba(168,131,255,.09); }
.verdict.bad  { color: #ffb0a3; border-color: #7a3226; background: rgba(226,112,95,.09); }
.verdict.dim  { color: #b39c76; border-color: #3a2c1c; background: rgba(255,255,255,.02); }
.verdict .res { color: #f7d183; font-weight: 600; }
.verdict .line { display: flex; align-items: flex-start; gap: 6px; }
.verdict .line span { flex: 1; }
.sub { color: #806b4c; font-size: 11.5px; margin-top: 3px; }
.star {
  all: unset; flex: none; cursor: pointer; line-height: 1;
  color: #6b5a3e; font-size: 14px; padding: 0 1px; border-radius: 4px;
}
.star:hover { color: #e0b155; }
.star.on { color: #f7d183; }
.star:focus-visible { outline: 1px solid #e0b155; }
.goals { margin-top: 8px; }
.goals .gh {
  display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none;
  color: #b39c76; font-size: 11.5px; padding: 3px 0;
}
.goals .gh:hover { color: #f2e6cf; }
.goals .caret { display: inline-block; width: 9px; }
.goals ul { margin: 2px 0 0; padding: 0; list-style: none; max-height: 176px; overflow-y: auto; }
.goals li {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 5px 0; border-top: 1px solid rgba(74,57,37,.4); font-size: 12px;
}
.goals li:first-child { border-top: none; }
.goals li .what { flex: 1; min-width: 0; }
.goals li .gm { display: block; color: #f2e6cf; }
.goals li .say { color: #b39c76; font-size: 11.5px; }
.goals li .say .res { color: #f7d183; }
.goals li .say.ok { color: #a9e6b4; }
.goals li .say.pray { color: #c9b4ff; }
.goals li .say.bad { color: #ffb0a3; }
.goals .del {
  all: unset; flex: none; cursor: pointer; color: #6b5a3e; font-size: 12px; padding: 0 2px; border-radius: 4px;
}
.goals .del:hover { color: #ffb0a3; }
.goals .empty { color: #806b4c; font-size: 11.5px; padding: 5px 0; }
.mats { display: flex; align-items: center; gap: 5px; margin-bottom: 7px; }
.mats input {
  all: unset; flex: 1; min-width: 0; background: #1c1610; border: 1px solid #4a3925;
  border-radius: 7px; padding: 4px 8px; color: #f2e6cf; font-size: 12.5px;
}
.mats input:focus { border-color: #e0b155; }
.mats input.auto { border-color: #6b5330; background: #241b12; }
.mats .op { color: #806b4c; flex: none; }
.feed {
  display: flex; align-items: center; gap: 6px;
  margin-top: 9px; padding-top: 8px; border-top: 1px solid rgba(74,57,37,.55);
}
.feed .lbl { flex: 1; color: #b39c76; font-size: 11.5px; cursor: pointer; }
.feed .st { color: #806b4c; font-size: 11px; }
.sw { position: relative; display: inline-block; flex: none; width: 30px; height: 16px; cursor: pointer; }
.sw input { all: unset; position: absolute; width: 0; height: 0; opacity: 0; }
.sw i {
  position: absolute; inset: 0; border-radius: 999px;
  background: #1c1610; border: 1px solid #4a3925; transition: background .15s, border-color .15s;
}
.sw i::after {
  content: ''; position: absolute; left: 2px; top: 2px; width: 10px; height: 10px;
  border-radius: 50%; background: #806b4c; transition: transform .15s, background .15s;
}
.sw input:checked + i { background: rgba(224,177,85,.25); border-color: #e0b155; }
.sw input:checked + i::after { transform: translateX(14px); background: #f7d183; }
.sw input:focus-visible + i { border-color: #f7d183; }
.upd { margin-top: 8px; }
.upd button {
  all: unset; display: block; box-sizing: border-box; width: 100%; text-align: center; cursor: pointer;
  padding: 5px 8px; border-radius: 8px; font-size: 12px;
  color: #ffd9a3; border: 1px solid #7a5a22; background: rgba(224,177,85,.13);
}
.upd button:hover { background: rgba(224,177,85,.22); }
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
      <div class="mats">
        <input class="ma" placeholder="材料 A" /><span class="op">＋</span><input class="mb" placeholder="材料 B" />
      </div>
      <div class="verdict dim">在遊戲裡點材料，這裡就會顯示結果</div>
      <div class="goals">
        <div class="gh"><span class="caret">▸</span><span class="gt">目標</span></div>
        <ul class="glist hide"></ul>
      </div>
      <div class="prog hide"><span class="ptext"></span><span class="bar"><i></i></span></div>
      <div class="upd hide"><button class="updbtn"></button></div>
      <div class="feed">
        <span class="lbl" title="開啟後每 30 秒讀一次全服最新的合成紀錄，把別人的配方也收進共用配方表。只進配方表，不會進你的軌跡。">全服動態收集</span>
        <span class="st">關閉</span>
        <label class="sw"><input type="checkbox" class="fd" /><i></i></label>
      </div>
    </div>`;
  root.appendChild(wrap);
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const els = {
    ma: $('.ma'),
    mb: $('.mb'),
    verdict: $('.verdict'),
    prog: $('.prog'),
    ptext: $('.ptext'),
    bar: $('.bar i'),
    fold: $('.fold'),
    goalHead: $('.gh'),
    goalCaret: $('.caret'),
    goalTitle: $('.gt'),
    goalList: $('.glist'),
    upd: $('.upd'),
    updBtn: $('.updbtn'),
    feedBox: $('.fd'),
    feedState: $('.feed .st'),
    feedLabel: $('.feed .lbl'),
  };

  let lastDetected = null; // 上一次從遊戲讀到的組合（null＝還沒讀到過煉製台）

  // ── 收合狀態（浮層本身、目標清單各記各的；目標預設收合）──
  chrome.storage?.local?.get?.(['overlayCollapsed', 'goalsOpen'], (v) => {
    if (v && v.overlayCollapsed) setCollapsed(true);
    if (v && v.goalsOpen) setGoalsOpen(true, false); // 讀回來的不用再寫回去
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
    if (p.update) showUpdate(p.update);
    els.prog.classList.remove('hide');
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    els.bar.style.width = `${pct}%`;
    if (p.phase === 'done') {
      const s = p.stats || {};
      els.ptext.textContent = `更新完成：素材櫃 ${s.discoveries ?? 0} 種、軌跡 +${
        (s.logAdded ?? 0) + (s.myRecipesAdded ?? 0)
      }、配方表 +${s.learned ?? 0}`;
      refreshGoals(); // 配方表剛長大，目標的結果可能從「尚無紀錄」變成有答案
      setTimeout(() => els.prog.classList.add('hide'), 6000);
    } else if (p.phase === 'error') {
      els.ptext.textContent = `同步失敗：${p.error || '未知錯誤'}`;
    } else if (p.phase === 'cancelled') {
      els.ptext.textContent = '已取消';
    } else {
      els.ptext.textContent = `${p.label || '同步中'}${p.total ? `（${p.done}/${p.total}）` : ''}`;
    }
  });

  // ── 目標：想試但還沒魔力試的組合 ──
  //
  // 星星掛在判定那一行的最右邊，點亮就是「等一下要試這組」。
  // 清單只存材料，結果每次展開都用當下的共用配方表重算——
  // 匯入別人的配方之後，本來「尚無紀錄」的目標會自己變成有結果。
  function makeStar(action, words, on) {
    const b = document.createElement('button');
    b.className = `star${on ? ' on' : ''}`;
    b.textContent = on ? '★' : '☆';
    b.title = on ? '已設為目標，點一下取消' : '設為目標：之後想試這一組';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await ctx.sendAsync({ type: 'ia-cmd', cmd: 'goal-toggle', action, inputs: words });
      if (!r || !r.ok) return;
      b.classList.toggle('on', r.starred);
      b.textContent = r.starred ? '★' : '☆';
      b.title = r.starred ? '已設為目標，點一下取消' : '設為目標：之後想試這一組';
      b.setAttribute('aria-pressed', r.starred ? 'true' : 'false');
      refreshGoals();
    });
    return b;
  }

  function goalLine(g) {
    const li = document.createElement('li');
    const what = document.createElement('div');
    what.className = 'what';

    const mats = document.createElement('span');
    mats.className = 'gm';
    mats.textContent = g.inputs.join(' ＋ ');
    what.appendChild(mats);

    const v = VERDICT[g.prediction.status] || VERDICT.unknown;
    const say = document.createElement('span');
    say.className = `say ${v.tone === 'dim' ? '' : v.tone}`.trim();
    say.textContent = `${v.icon} ${g.action === 'refine' ? '萃取・' : ''}${v.text}`;
    if (g.prediction.result) {
      const res = document.createElement('span');
      res.className = 'res';
      res.textContent = ` → ${g.prediction.emoji ? g.prediction.emoji + ' ' : ''}${g.prediction.result}`;
      say.appendChild(res);
    }
    what.appendChild(say);
    li.appendChild(what);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '從目標移除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await ctx.sendAsync({ type: 'ia-cmd', cmd: 'goal-toggle', action: g.action, inputs: g.inputs });
      refreshGoals();
      // 移掉的正好是現在選著的那組，星星要跟著暗下去
      const cur = [els.ma.value.trim(), els.mb.value.trim()].filter(Boolean);
      if (cur.join('|') === g.inputs.join('|')) evaluate(cur);
    });
    li.appendChild(del);
    return li;
  }

  async function refreshGoals() {
    const r = await ctx.sendAsync({ type: 'ia-cmd', cmd: 'goals' });
    const items = (r && r.ok && r.items) || [];
    els.goalTitle.textContent = items.length ? `目標（${items.length}）` : '目標';
    if (els.goalList.classList.contains('hide')) return; // 收合著就不用畫清單
    els.goalList.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '還沒有。在判定那一行點☆，就會記到這裡。';
      els.goalList.appendChild(li);
      return;
    }
    for (const g of items) els.goalList.appendChild(goalLine(g));
  }

  function setGoalsOpen(open, persist = true) {
    els.goalList.classList.toggle('hide', !open);
    els.goalCaret.textContent = open ? '▾' : '▸';
    if (persist) {
      try {
        chrome.storage.local.set({ goalsOpen: open });
      } catch (_) {
        /* 記不住展開狀態也無所謂 */
      }
    }
    if (open) refreshGoals();
  }
  els.goalHead.addEventListener('click', (e) => {
    e.stopPropagation();
    setGoalsOpen(els.goalList.classList.contains('hide'));
  });
  refreshGoals(); // 收合著也要先數一次，標題才顯示得出有幾個

  // ── 有新版本時浮出來的那顆 ──
  // 按下去就開 GitHub 的發布頁，要不要更新自己決定
  function showUpdate(u) {
    if (!u || !u.hasUpdate) return;
    els.upd.classList.remove('hide');
    els.updBtn.textContent = `⬆ 有新版本 v${u.latest}（目前 v${u.current}）`;
  }
  els.updBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.sendAsync({ type: 'ia-cmd', cmd: 'open-release' });
  });
  ctx.sendAsync({ type: 'ia-cmd', cmd: 'check-update', opts: { cachedOnly: true } }).then(showUpdate);

  // ── 偵測煉製台上放了什麼 ──
  //
  // 回傳 null 代表「這頁上沒有煉製台」——不是「什麼都沒選」。
  // 這兩者一定要分開：前者要放著不動（別擦掉使用者自己打的字），後者才清空。
  function chipWord(chip) {
    // chip 的結構是 <span>emoji</span><span>詞</span>；收藏過的還會多一個空的 .chip-fav
    const spans = [...chip.querySelectorAll('span')].filter(
      (s) => !s.classList.contains('chip-fav') && s.textContent.trim()
    );
    const node = spans.length ? spans[spans.length - 1] : chip;
    return node.textContent.trim();
  }

  function readWorkbench() {
    for (const sel of SLOT_SCOPES) {
      let box;
      try {
        box = document.querySelector(sel);
      } catch (_) {
        continue;
      }
      if (!box) continue;
      const slots = box.querySelectorAll('.slot');
      if (!slots.length) continue;
      const words = [];
      for (const s of slots) {
        const chip = s.querySelector('.chip');
        const w = chip ? chipWord(chip) : '';
        if (w) words.push(w);
      }
      return words.slice(0, 2);
    }
    return null;
  }

  // 退路：遊戲改版把煉製台換掉時，改看材料列表裡被點亮的那幾顆
  function readTray() {
    for (const sel of TRAY_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      if (!nodes.length) continue;
      const words = [];
      for (const n of nodes) {
        const w = chipWord(n);
        if (w) words.push(w);
      }
      if (words.length) return words.slice(0, 2);
    }
    return null;
  }

  const readSelected = () => readWorkbench() ?? readTray();

  function fillInputs(words) {
    els.ma.value = words[0] || '';
    els.mb.value = words[1] || '';
    // 淡淡的框線代表「這是從遊戲讀來的」，自己打的字就是一般框線
    els.ma.classList.toggle('auto', !!words[0]);
    els.mb.classList.toggle('auto', !!words[1]);
  }

  function showVerdict(pred, action, words, starred) {
    const v = VERDICT[pred.status] || VERDICT.unknown;
    els.verdict.className = `verdict ${v.tone}`;
    els.verdict.textContent = '';
    const line = document.createElement('div');
    line.className = 'line';
    const text = document.createElement('span');
    // 只放一樣材料時遊戲那顆按鈕會變成「萃取」，這裡也標出來，免得看成煉成的結果
    text.textContent = `${v.icon} ${action === 'refine' ? '萃取：' : ''}${v.text}`;
    line.appendChild(text);
    line.appendChild(makeStar(action, words, starred));
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
  }

  async function evaluate(words) {
    if (words.length < 1) {
      els.verdict.className = 'verdict dim';
      els.verdict.textContent = '在遊戲裡點材料，這裡就會顯示結果';
      return;
    }
    const action = words.length === 1 ? 'refine' : 'combine';
    const r = await ctx.sendAsync({ type: 'ia-cmd', cmd: 'predict', action, inputs: words });
    if (r && r.ok) showVerdict(r.prediction, action, r.inputs || words, r.starred);
  }

  // 只在「遊戲那邊真的變了」時才動輸入框，否則自己打到一半的字會被擦掉
  function tick() {
    const words = readSelected();
    if (words === null) return;
    const key = words.join('|');
    if (key === lastDetected) return;
    lastDetected = key;
    fillInputs(words);
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

  // content script 跑在 document_start，遊戲通常還沒畫出來；MutationObserver 會接手，
  // 這兩次只是保險：萬一浮層掛好時畫面早就靜止了，也要讀得到現況
  tick();
  setTimeout(tick, 1200);

  // 想查還沒放進煉製台的組合，直接在框裡打字
  let typeTimer = null;
  const onType = () => {
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      const words = [els.ma.value.trim(), els.mb.value.trim()].filter(Boolean);
      els.ma.classList.remove('auto');
      els.mb.classList.remove('auto');
      evaluate(words);
    }, 250);
  };
  els.ma.addEventListener('input', onType);
  els.mb.addEventListener('input', onType);

  // ── 全服動態收集開關 ──
  //
  // 狀態存在 chrome.storage.local.globalFeed，content.js 的輪詢器與儀表板都聽同一把鑰匙，
  // 所以這裡撥一下，另外兩邊會立刻跟上，不會各說各話。
  function paintFeed(on) {
    els.feedBox.checked = on;
    els.feedState.textContent = on ? '開啟中' : '關閉';
  }
  els.feedBox.addEventListener('change', () => {
    const on = els.feedBox.checked;
    paintFeed(on);
    try {
      chrome.storage.local.set({ globalFeed: on });
    } catch (_) {
      els.feedState.textContent = '無法儲存';
    }
  });
  els.feedLabel.addEventListener('click', () => {
    els.feedBox.checked = !els.feedBox.checked;
    els.feedBox.dispatchEvent(new Event('change'));
  });
  try {
    chrome.storage.local.get(['globalFeed'], (v) => paintFeed(!!(v && v.globalFeed)));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.globalFeed) paintFeed(!!changes.globalFeed.newValue);
    });
  } catch (_) {
    /* 沒有 storage 權限就維持顯示「關閉」 */
  }
}
