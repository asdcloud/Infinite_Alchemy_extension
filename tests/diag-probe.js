// 確認 diagnose() 的報告格式：欄位名不同、端點失敗時要看得出來
const o = document.getElementById('out');
window.chrome = { runtime: { id:'t', onMessage:{addListener(f){window.__csListener=f}}, sendMessage(){}, getURL:(p)=>p }, storage:{local:{get(k,cb){cb&&cb({})},set(){}}} };
const real = window.fetch;
window.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/api/me/inventions')) return new Response(JSON.stringify({ creations: [{ word: '間歇泉' }] }), { status: 200 });
  if (u.includes('/api/me/recipes')) return new Response('{"error":"尚未登入"}', { status: 401 });
  if (u.includes('/api/me/discoveries')) return new Response(JSON.stringify({ nodes: [{ word: '水', emoji: '💧' }] }), { status: 200 });
  if (u.includes('/api/')) return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  return real(url, init);
};
await import('/src/content.js');
await new Promise((r) => setTimeout(r, 200));
const report = await new Promise((resolve) => {
  window.__csListener({ type: 'ia-diagnose' }, {}, (r) => resolve(r));
});
o.textContent = report && report.ok ? report.report : 'FAILED: ' + JSON.stringify(report);
