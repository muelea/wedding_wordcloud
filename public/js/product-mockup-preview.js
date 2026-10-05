(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteProductMockups = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STORAGE_KEY = 'wolkenworte:product-mockups:v1';
  const CACHE_MS = 12 * 60 * 60 * 1000;
  const MAX_ENTRIES = 40;
  const ENDPOINT = /^\/api\/events\/[A-Za-z0-9_-]{22}\/configurations\/[A-Za-z0-9_-]{16}\/mockups$/;

  function trustedImageUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        (url.hostname === 'printful-upload.s3-accelerate.amazonaws.com' ||
         url.hostname === 'printful-upload.s3.amazonaws.com' || url.hostname.endsWith('.printful.com'));
    } catch { return false; }
  }

  function create({ window: browser = window, now = () => Date.now(),
    fetchImpl = (...args) => browser.fetch(...args),
    wait = ms => new Promise(resolve => browser.setTimeout(resolve, ms)),
  } = {}) {
    const states = new Map();

    function validResult(result) {
      return Number.isFinite(result?.expiresAt) && result.expiresAt > now() &&
        result.expiresAt <= now() + CACHE_MS && Array.isArray(result.urls) &&
        result.urls.length > 0 && result.urls.length <= 16 && result.urls.every(trustedImageUrl);
    }

    function readCache() {
      try {
        const data = JSON.parse(browser.localStorage.getItem(STORAGE_KEY) || '{}');
        return Object.fromEntries(Object.entries(data)
          .filter(([key, result]) => ENDPOINT.test(key) && validResult(result))
          .sort((a, b) => b[1].expiresAt - a[1].expiresAt).slice(0, MAX_ENTRIES));
      } catch { return {}; }
    }

    function writeCache(endpoint, result) {
      try {
        const data = readCache();
        if (result) data[endpoint] = result;
        else delete data[endpoint];
        const entries = Object.entries(data).sort((a, b) => b[1].expiresAt - a[1].expiresAt);
        browser.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, MAX_ENTRIES))));
      } catch { /* Memory caching still works when browser storage is unavailable. */ }
    }

    function get(endpoint) {
      const state = states.get(endpoint);
      if (state?.promise) return { status: 'loading' };
      const result = validResult(state?.result) ? state.result : readCache()[endpoint];
      return result ? { status: 'completed', ...result } : { status: 'idle' };
    }

    async function request(url, options = {}) {
      const response = await fetchImpl(url, {
        ...options, signal: browser.AbortSignal?.timeout?.(45_000), cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) {
        const retryAfter = Math.min(3600, Math.max(0, Math.ceil(Number(data.retryAfter ||
          response.headers?.get('retry-after')) || (response.status === 429 ? 60 : 0))));
        throw Object.assign(new Error('mockup_unavailable'), { retryAfter });
      }
      return data;
    }

    async function generate(endpoint, refresh) {
      const created = await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wolkenworte-Preview': 'product-mockup' },
        body: JSON.stringify({ refresh }),
      });
      if (!/^[A-Za-z0-9_-]{24}$/.test(created.jobId)) throw new Error('mockup_unavailable');
      const deadline = now() + 10 * 60 * 1000;
      while (now() < deadline) {
        const result = await request(`${endpoint}/${encodeURIComponent(created.jobId)}`);
        if (result.status === 'completed') {
          const cached = { expiresAt: result.expiresAt, urls: (result.mockups || []).map(mockup => mockup.url) };
          if (!validResult(cached)) throw new Error('mockup_unavailable');
          writeCache(endpoint, cached);
          return cached;
        }
        if (result.status !== 'pending') throw new Error('mockup_unavailable');
        await wait(3000);
      }
      throw new Error('mockup_unavailable');
    }

    function load(endpoint) {
      if (!ENDPOINT.test(endpoint)) return Promise.reject(new Error('mockup_unavailable'));
      const state = states.get(endpoint);
      if (state?.promise) return state.promise;
      const cached = get(endpoint);
      if (cached.status === 'completed') return Promise.resolve(cached);
      const entry = { refresh: state?.refresh === true };
      entry.promise = generate(endpoint, entry.refresh).then(result => {
        entry.result = result;
        entry.refresh = false;
        return result;
      }).finally(() => { entry.promise = null; });
      states.set(endpoint, entry);
      for (const [key, value] of states) {
        if (states.size <= MAX_ENTRIES) break;
        if (!value.promise && key !== endpoint) states.delete(key);
      }
      return entry.promise;
    }

    function invalidate(endpoint) {
      writeCache(endpoint, null);
      states.set(endpoint, { refresh: true });
    }

    return Object.freeze({ get, load, invalidate });
  }

  return Object.freeze({ create, STORAGE_KEY, CACHE_MS });
});
