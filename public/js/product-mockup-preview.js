(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteProductMockups = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const STORAGE_KEY = 'wolkenworte:product-mockups:v2';
  const PENDING_KEY = STORAGE_KEY + ':pending';
  const CACHE_MS = 12 * 60 * 60 * 1000;
  const MAX_ENTRIES = 40;
  const CUSTOMER = /^\/api\/events\/[A-Za-z0-9_-]{22}\/configurations\/[A-Za-z0-9_-]{16}\/mockups$/;
  const OPERATOR = /^\/api\/operator\/printful-mockups\/events\/[A-Za-z0-9_-]{22}\/configurations\/[A-Za-z0-9_-]{16}$/;
  const validEndpoint = value => CUSTOMER.test(value) || OPERATOR.test(value);
  const validId = value => /^[A-Za-z0-9_-]{24}$/.test(value || '');
  function trustedImageUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' &&
      (url.hostname === 'printful-upload.s3-accelerate.amazonaws.com' || url.hostname === 'printful-upload.s3.amazonaws.com' || url.hostname.endsWith('.printful.com'));
    } catch { return false; }
  }
  function statusMessage(state) {
    if (state.errorCode === 'mockup_daily_limit') return { source: 'Die Produktvorschau ist vorübergehend nicht verfügbar. Bitte versucht es später erneut.' };
    if (state.status === 'error') return { source: ['mockup_timeout','mockup_stalled'].includes(state.errorCode)
      ? 'Die Erstellung dauert ungewöhnlich lange. Bitte versucht es erneut.'
      : 'Die Produktvorschau ist gerade nicht verfügbar. Bitte versucht es erneut.' };
    if (state.retryAfter > 1 && (['queued','retrying'].includes(state.phase) || state.errorCode === 'mockup_rate_limited')) return {
      source: state.phase === 'retrying' && state.errorCode !== 'mockup_rate_limited'
        ? 'Die Vorschau wird in {{seconds}} Sekunden erneut versucht…'
        : 'Die Erstellung wird automatisch fortgesetzt. Nächster Versuch in {{seconds}} Sekunden…', params: { seconds: state.retryAfter } };
    return { source: state.phase === 'loading' ? 'Die Produktvorschau wird geladen…'
      : ['preparing','submitting'].includes(state.phase) ? 'Euer Druckdesign wird für die Produktvorschau vorbereitet…'
      : state.phase === 'retrying' ? 'Die Verbindung wurde unterbrochen. Die Vorschau wird automatisch erneut versucht…'
        : state.phase === 'queued' ? 'Die Produktvorschau wartet auf einen freien Platz…'
          : 'Eure Produktvorschau wird erstellt. Das kann etwas dauern…' };
  }

  function create({ window: browser = window, now = () => Date.now(),
    fetchImpl = (...args) => browser.fetch(...args), wait = ms => new Promise(resolve => browser.setTimeout(resolve, ms)),
  } = {}) {
    const states = new Map(), listeners = new Set();
    function validResult(result) { return Number.isFinite(result?.expiresAt) && result.expiresAt > now() &&
      result.expiresAt <= now() + CACHE_MS && Array.isArray(result.urls) && result.urls.length > 0 &&
      result.urls.length <= 16 && result.urls.every(trustedImageUrl); }
    function read(key) {
      try { return Object.fromEntries(Object.entries(JSON.parse(browser.localStorage.getItem(key) || '{}'))
        .filter(([endpoint, value]) => validEndpoint(endpoint) && Number.isFinite(value?.expiresAt) && value.expiresAt > now() &&
          value.expiresAt <= now() + CACHE_MS && (key === STORAGE_KEY ? validResult(value) : validId(value.requestId) && (!value.jobId || validId(value.jobId))))
        .sort((a,b) => b[1].expiresAt - a[1].expiresAt).slice(0, MAX_ENTRIES));
      } catch { return {}; }
    }
    function write(key, endpoint, value) {
      try { const values = read(key); if (value) values[endpoint] = value; else delete values[endpoint];
        browser.localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(values)
          .sort((a,b) => b[1].expiresAt - a[1].expiresAt).slice(0,MAX_ENTRIES))));
      } catch { /* The active request can continue when browser storage is blocked. */ }
    }
    function get(endpoint) {
      const entry = states.get(endpoint);
      if (entry?.promise) return { status: 'loading', phase: entry.phase || 'queued', errorCode: entry.errorCode,
        retryAfter: Math.max(0, Math.ceil(((entry.nextAttemptAt || now()) - now()) / 1000)), nextAttemptAt: entry.nextAttemptAt };
      const result = validResult(entry?.result) ? entry.result : read(STORAGE_KEY)[endpoint];
      if (result) return { status: 'completed', ...result };
      if (entry?.error) return { status: 'error', errorCode: entry.error.errorCode };
      return read(PENDING_KEY)[endpoint] ? { status: 'loading', phase: 'queued' } : { status: 'idle' };
    }
    function notify(endpoint) { for (const listener of listeners) { try { listener(endpoint, get(endpoint)); } catch {} } }
    async function pause(ms, endpoint, entry) {
      entry.nextAttemptAt = now() + ms;
      for (let remaining = ms; remaining > 0;) { notify(endpoint); const step = Math.min(1000,remaining); await wait(step); remaining -= step; }
    }
    async function request(url, options) {
      let response;
      try { response = await fetchImpl(url, { ...options, signal: browser.AbortSignal?.timeout?.(45_000), cache: 'no-store' }); }
      catch { throw Object.assign(new Error('mockup_unavailable'), { transient: true }); }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw Object.assign(new Error('mockup_unavailable'), {
        errorCode: data?.error, transient: response.status === 429 || (response.status >= 500 && response.status !== 501) || !data,
        retryAfter: Math.min(3600, Math.max(0, Number(data?.retryAfter || response.headers?.get?.('retry-after')) || (response.status === 429 ? 60 : 0))),
        missing: response.status === 404,
      });
      return data;
    }
    async function generate(endpoint, entry) {
      const operator = OPERATOR.test(endpoint), command = entry.command;
      let failures = 0;
      const deadline = now() + 35 * 60 * 1000;
      while (now() < deadline) {
        try {
          if (!command.jobId) {
            const created = await request(endpoint, { method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(operator ? { 'X-Wolkenworte-Operator': 'printful-mockup' } : { 'X-Wolkenworte-Preview': 'product-mockup' }) },
              body: JSON.stringify({ refresh: command.refresh, requestId: command.requestId }),
            });
            if (!validId(created.jobId)) throw Object.assign(new Error('mockup_unavailable'), { transient: true });
            command.jobId = created.jobId;
            write(PENDING_KEY, endpoint, command);
          }
          const result = await request(operator ? `/api/operator/printful-mockups/${command.jobId}` : `${endpoint}/${command.jobId}`);
          failures = 0;
          if (result.status === 'completed') {
            const cached = { expiresAt: result.expiresAt, jobId: command.jobId,
              urls: (result.mockups || []).map(item => item.url), mockupWidthPx: result.mockupWidthPx,
              resolutionFallback: result.resolutionFallback };
            if (!validResult(cached)) throw new Error('mockup_unavailable');
            return cached;
          }
          if (result.status === 'failed') {
            write(PENDING_KEY, endpoint, null);
            throw Object.assign(new Error('mockup_unavailable'), { errorCode: result.errorCode, terminal: true });
          }
          if (!['queued','preparing','submitting','pending','retrying'].includes(result.status)) throw new Error('mockup_unavailable');
          entry.phase = result.status; entry.errorCode = result.errorCode;
          await pause(Math.min(60_000, Math.max(3000, (Number(result.retryAfter) || 0) * 1000)), endpoint, entry);
        } catch (error) {
          if (error.missing) { write(PENDING_KEY, endpoint, null); error.terminal = true; }
          if (!error.transient || ++failures >= 8) throw error;
          entry.phase = 'retrying'; entry.errorCode = error.errorCode;
          await pause(Math.max((error.retryAfter || 0) * 1000, Math.min(60_000, 1000 * 2 ** failures)), endpoint, entry);
        }
      }
      throw Object.assign(new Error('mockup_unavailable'), { errorCode: 'mockup_timeout' });
    }
    function load(endpoint, { refresh = false } = {}) {
      if (!validEndpoint(endpoint)) return Promise.reject(new Error('mockup_unavailable'));
      const previous = states.get(endpoint);
      if (previous?.promise) return previous.promise;
      const cached = get(endpoint);
      if (!refresh && !previous?.refresh && cached.status === 'completed') return Promise.resolve(cached);
      const bytes = new Uint8Array(18); browser.crypto.getRandomValues(bytes);
      const requestId = browser.btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      const entry = { phase: 'queued', command: read(PENDING_KEY)[endpoint] ||
        (previous?.error && !previous.error.terminal && previous.command) || {
        requestId, jobId: null, expiresAt: now() + CACHE_MS, refresh: refresh || previous?.refresh === true,
      } };
      write(STORAGE_KEY, endpoint, null);
      write(PENDING_KEY, endpoint, entry.command);
      states.set(endpoint, entry);
      entry.promise = generate(endpoint, entry).then(result => {
        if (states.get(endpoint) === entry) { entry.result = result; write(STORAGE_KEY,endpoint,result); write(PENDING_KEY,endpoint,null); }
        return result;
      }).catch(error => { entry.error = error; throw error; }).finally(() => { entry.promise = null; notify(endpoint); });
      for (const [key,value] of states) { if (states.size <= MAX_ENTRIES) break; if (!value.promise && key !== endpoint) states.delete(key); }
      notify(endpoint);
      return entry.promise;
    }
    function invalidate(endpoint) {
      if (!validEndpoint(endpoint)) return;
      write(STORAGE_KEY, endpoint, null); write(PENDING_KEY, endpoint, null);
      states.set(endpoint, { refresh: true });
    }
    return Object.freeze({ get, load, invalidate,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
  }
  return Object.freeze({ create, STORAGE_KEY, PENDING_KEY, CACHE_MS, statusMessage });
});
