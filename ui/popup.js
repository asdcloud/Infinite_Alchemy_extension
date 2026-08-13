import { allAttempts, getMeta, countKnowledge, getInventory } from '../src/db.js';

const GAME_URL = 'https://pillars-of-creation.funtuan.work/';

function card(k, v, sub) {
  const d = document.createElement('div');
  d.className = 'card';
  const kk = document.createElement('div');
  kk.className = 'k';
  kk.textContent = k;
  const vv = document.createElement('div');
  vv.className = 'v';
  vv.textContent = String(v);
  d.append(kk, vv);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    d.appendChild(s);
  }
  return d;
}

const fmt = (n) => Number(n || 0).toLocaleString('zh-TW');

try {
  const m = chrome.runtime.getManifest();
  document.getElementById('ver').textContent = m.version_name || `v${m.version}`;
} catch (_) {
  /* 用 HTML 裡的備援 */
}

(async () => {
  const account = await getMeta('account', null);
  const known = !!(account && account.id != null);
  const [all, kb, inv] = await Promise.all([
    allAttempts(),
    countKnowledge(),
    getInventory(known ? String(account.id) : 'unknown'),
  ]);

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const mine = known ? all.filter((r) => String(r.accountId) === String(account.id)) : all;
  const today = mine.filter((r) => r.ts >= start.getTime()).length;

  document.getElementById('cards').append(
    card('共用配方表', fmt(kb), '跨帳號共用'),
    card('持有造物', inv ? fmt(inv.count ?? 0) : '—', '此帳號'),
    card('今日煉製', fmt(today), ''),
    card('軌跡總筆數', fmt(mine.length), '此帳號')
  );

  const who = known || (account && account.name)
    ? `${account.isGuest ? '訪客・' : ''}${account.name || '#' + account.id}`
    : null;
  const label = document.getElementById('who');
  label.textContent = who ? `目前帳號：${who}` : '尚未偵測到帳號';

  document.getElementById('hint').textContent = inv
    ? '在遊戲裡選材料時，右下角浮層會直接告訴你結果。'
    : '還沒抓過素材櫃。按下面的「更新」把目前狀態讀回來。';
})();

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') });
  window.close();
});

document.getElementById('play').addEventListener('click', () => {
  chrome.tabs.create({ url: GAME_URL });
  window.close();
});

document.getElementById('sync').addEventListener('click', () => {
  const msg = document.getElementById('syncmsg');
  msg.textContent = '開始更新…';
  chrome.runtime.sendMessage({ type: 'ia-cmd', cmd: 'sync-start', opts: {} }, (r) => {
    const le = chrome.runtime.lastError;
    if (r && r.ok) {
      msg.textContent = '更新中，進度顯示在儀表板。';
    } else if (r === undefined) {
      msg.textContent = `背景服務沒有回應。請到 chrome://extensions 按「重新載入」再試。${le ? `（${le.message}）` : ''}`;
    } else if (r.error === 'no-tab') {
      msg.textContent = '找不到遊戲分頁，請先開啟遊戲並登入。';
    } else if (r.error === 'stale-tab') {
      msg.textContent = '請重新整理遊戲分頁（F5）後再試。';
    } else {
      msg.textContent = `無法更新：${r.error || '未知錯誤'}`;
    }
  });
});
