// MAIN world：掛在遊戲頁面的 window 上，旁聽遊戲自己發出的 fetch。
// 遊戲的 API 包裝是 fetch(`/api${path}`, { method, body, credentials:'include' })。
//
// 除了煉製動作，也旁聽持有物與配方查詢——你在遊戲裡點開一個造物看配方時，
// 擴充套件就順手把那些配方收進知識庫，等於逛遊戲就會自動長知識。
//
// 這裡不能用 chrome.* API，資料一律用 postMessage 丟給 ISOLATED world 的 content.js。
(() => {
  if (window.__IA_TRACKER_HOOKED__) return;
  window.__IA_TRACKER_HOOKED__ = true;

  // [kind, method, 路徑比對]
  const WATCH = [
    ['attempt', 'POST', /\/api\/(combine|refine)(?:[?#]|$)/],
    ['me', 'GET', /\/api\/me(?:[?#]|$)/],
    ['discoveries', 'GET', /\/api\/me\/discoveries(?:[?#]|$)/],
    ['discoveries-delete', 'POST', /\/api\/me\/discoveries\/delete-batch(?:[?#]|$)/],
    ['seeds', 'GET', /\/api\/me\/seeds(?:[?#]|$)/],
    ['node-recipes', 'GET', /\/api\/nodes\/([^/?#]+)\/recipes(?:\/mine)?(?:[?#]|$)/],
    ['node', 'GET', /\/api\/nodes\/([^/?#]+)(?:[?#]|$)/],
    ['combine-log', 'GET', /\/api\/combine-log(?:[?#]|$)/],
  ];

  function send(payload) {
    try {
      window.postMessage({ __iaTracker: 1, payload }, window.location.origin);
    } catch (_) {
      /* 忽略：追蹤失敗不能影響遊戲 */
    }
  }

  function toUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function parseJson(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  async function readRequestBody(input, init) {
    const body = init && init.body;
    if (typeof body === 'string') return parseJson(body);
    if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
    if (input instanceof Request && !body) {
      try {
        return parseJson(await input.clone().text());
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function match(url, method) {
    for (const [kind, m, re] of WATCH) {
      if (m !== method) continue;
      const hit = re.exec(url);
      if (hit) return { kind, param: hit[1] ? decodeURIComponent(hit[1]) : null };
    }
    return null;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = toUrl(input);
    const method = String(
      (init && init.method) || (input instanceof Request && input.method) || 'GET'
    ).toUpperCase();
    const startedAt = Date.now();
    // 遊戲是以裸呼叫 fetch(...) 發請求（模組是嚴格模式，this 會是 undefined），補回 window
    const promise = origFetch.apply(this || window, arguments);

    const hit = url ? match(url, method) : null;
    if (hit) {
      // 一律不阻擋、不改寫回應，只旁聽 clone()
      promise
        .then(async (res) => {
          try {
            const data = parseJson(await res.clone().text());
            if (data == null) return;
            send({
              kind: hit.kind,
              param: hit.param,
              url,
              status: res.status,
              ok: res.ok,
              ts: startedAt,
              dur: Date.now() - startedAt,
              req: hit.kind === 'attempt' || hit.kind === 'discoveries-delete'
                ? await readRequestBody(input, init)
                : null,
              res: data,
            });
          } catch (_) {
            /* 忽略 */
          }
        })
        .catch(() => {});
    }
    return promise;
  };
})();
