// 版本比較與 GitHub release 回應的解析。
import { parseVersion, isNewer, parseRelease, RELEASE_PAGE } from '/src/update.js';

const o = document.getElementById('out');
const out = [];
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; out.push('  ok   ' + n); } else { fail++; out.push('  FAIL ' + n + ' → ' + e); }
};

out.push('[版本字串]');
check('去掉開頭的 v', parseVersion('v1.2.3').join('.') === '1.2.3');
check('前後空白不影響', parseVersion('  1.2.3 ').join('.') === '1.2.3');
check('看不懂的段落當 0', parseVersion('1.x.3').join('.') === '1.0.3');
check('空字串不會爆', parseVersion('').join('.') === '0');
check('null 不會爆', parseVersion(null).join('.') === '0');

out.push('[誰比較新]');
check('1.1.3 比 1.1.2 新', isNewer('1.1.3', '1.1.2'));
check('v1.1.3 比 1.1.2 新（帶 v 也行）', isNewer('v1.1.3', '1.1.2'));
check('1.1.2 不比 1.1.2 新', !isNewer('1.1.2', '1.1.2'));
check('1.1.1 不比 1.1.2 新', !isNewer('1.1.1', '1.1.2'));
check('1.2.0 比 1.1.9 新', isNewer('1.2.0', '1.1.9'));
check('2.0.0 比 1.9.9 新', isNewer('2.0.0', '1.9.9'));
check('1.10.0 比 1.9.0 新（不是字串比大小）', isNewer('1.10.0', '1.9.0'));
check('1.2 等於 1.2.0，不算新', !isNewer('1.2', '1.2.0'));
check('1.2.1 比 1.2 新', isNewer('1.2.1', '1.2'));
check('查不到版本時不會誤報有更新', !isNewer('', '1.1.2'));

out.push('[解析 GitHub 的回應]');
const rel = parseRelease({
  tag_name: 'v1.1.3',
  html_url: 'https://github.com/asdcloud/Infinite_Alchemy_helper/releases/tag/v1.1.3',
  draft: false,
  prerelease: false,
});
check('讀到版本號（去掉 v）', rel && rel.latest === '1.1.3', JSON.stringify(rel));
check('讀到發布頁網址', rel && rel.page.endsWith('/tag/v1.1.3'), JSON.stringify(rel));
check('沒有 html_url 就退回 releases/latest',
  parseRelease({ tag_name: 'v1.1.3' }).page === RELEASE_PAGE);
check('草稿不算數', parseRelease({ tag_name: 'v9.9.9', draft: true }) === null);
check('預發布不算數', parseRelease({ tag_name: 'v9.9.9', prerelease: true }) === null);
check('沒有 tag 不算數', parseRelease({ html_url: 'x' }) === null);
check('空回應不會爆', parseRelease(null) === null);

out.unshift(fail === 0 ? `RESULT: ALL PASS (${pass})` : `RESULT: ${fail} FAILED / ${pass} passed`);
o.textContent = out.join('\n');
document.title = fail === 0 ? 'PASS' : 'FAIL';
