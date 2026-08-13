// 檢查 GitHub 上有沒有新版本。
//
// 只負責「告訴你有新版本」，按下按鈕會開發布頁，下載與安裝由使用者自己決定。
// （擴充套件本來也沒辦法自己覆蓋自己：Chrome 不允許改寫自己的檔案，
//   chrome.runtime.requestUpdateCheck() 也只對從商店安裝的擴充套件有效。）

const REPO = 'asdcloud/Infinite_Alchemy_helper';
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;

/** 'v1.2.3' → [1,2,3]；看不懂的段落一律當 0，不會丟例外 */
export function parseVersion(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
}

/** latest 是否比 current 新。位數不同的補 0 比（1.2 === 1.2.0） */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * GitHub 的 releases/latest 回應 → 版本號與發布頁網址。
 * 草稿或預發布不算數（latest 本來就不會回那些，這裡再擋一次）。
 */
export function parseRelease(data) {
  const d = data || {};
  if (d.draft || d.prerelease) return null;
  const latest = String(d.tag_name || '').replace(/^v/i, '');
  if (!latest) return null;
  return { latest, page: d.html_url || RELEASE_PAGE };
}
