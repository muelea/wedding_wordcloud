(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteOrderPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const IMAGE_TIMEOUT_MS = 45000;
  const REQUEST_TIMEOUT_MS = 20000;
  const DEADLINE_MS = 35 * 60000;
  const IMAGE_RETRIES = 2;
  function create(root, { window: browser = window, endpoint, guestId, i18n, onChange = () => {}, now = () => Date.now() } = {}) {
    const list = root.querySelector('[data-order-previews]');
    const consent = root.querySelector('[data-order-preview-consent]');
    const progress = root.querySelector('[data-order-preview-progress]');
    const states = new Map();
    const waits = new Set(), requests = new Set();
    let expiryTimer;
    let selected = [], selectionKey = '', closed = false, generation = 0;
    const setText = (node, source, params) => i18n.setText(node, source, params);
    const selectedStates = () => selected.map(item => states.get(item.id)).filter(Boolean);
    const isReady = state => state?.status === 'ready' && state.terminal && state.expiresAt > now();
    function ready() { return selected.length > 0 && selected.every(item => isReady(states.get(item.id))); }
    function update() {
      consent.disabled = !ready();
      if (consent.disabled) consent.checked = false;
      setText(progress, '{{ready}} von {{total}} Produktvorschauen fertig', {
        ready: selected.filter(item => isReady(states.get(item.id))).length, total: selected.length,
      });
      browser.clearTimeout(expiryTimer);
      const expiries = selectedStates().map(state => state.expiresAt).filter(Number.isFinite);
      if (!closed && expiries.length) expiryTimer = browser.setTimeout(refreshExpired, Math.max(0, Math.min(...expiries) - now() + 1));
      onChange();
    }
    function message(state, seconds = 0) {
      const working = state.status === 'loading' || (state.status === 'ready' && !state.terminal);
      state.spinner.hidden = !working;
      state.element.setAttribute('aria-busy', String(working));
      if (state.status === 'error') return setText(state.feedback, state.errorCode === 'mockup_daily_limit'
        ? 'Die Produktvorschau ist vorübergehend nicht verfügbar. Bitte versucht es später erneut.'
        : 'Die Produktvorschau konnte nicht erstellt werden. Bitte versucht es erneut.');
      if (state.status === 'ready' && state.terminal) return setText(state.feedback, 'Produktvorschau bereit');
      const text = browser.WolkenworteProductMockups.statusMessage({ status: 'loading', phase: state.phase,
        errorCode: state.errorCode, retryAfter: seconds });
      setText(state.feedback, text.source, text.params);
    }
    function card(item) {
      const element = browser.document.createElement('article');
      element.className = 'order-preview-item';
      element.dataset.configurationId = item.id;
      const heading = browser.document.createElement('h3');
      setText(heading, item.product.displayName);
      const variant = browser.document.createElement('p');
      variant.className = 'order-preview-variant';
      setText(variant, item.product.variantLabel || item.product.size?.label || '');
      const images = browser.document.createElement('div');
      images.className = 'order-preview-images';
      const feedback = browser.document.createElement('p');
      feedback.setAttribute('role', 'status');
      const status = browser.document.createElement('div');
      status.className = 'order-preview-status';
      const spinner = browser.document.createElement('span');
      spinner.className = 'order-preview-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      status.append(spinner, feedback);
      const retry = browser.document.createElement('button');
      retry.type = 'button'; retry.hidden = true;
      setText(retry, 'Erneut versuchen');
      const state = { item, element, images, feedback, spinner, retry, status: 'loading', phase: 'queued', imageRetries: 0 };
      retry.addEventListener('click', () => restart([state], true));
      element.append(heading, variant, images, status, retry);
      message(state);
      return state;
    }
    function fail(state, errorCode) {
      browser.clearTimeout(state.imageTimer);
      state.imageAttempt = null;
      state.expiresAt = null;
      state.errorCode = errorCode;
      state.status = 'error'; state.retry.hidden = false;
      message(state); update();
    }
    function show(state, item, jobId, retryImage = false) {
      if (state.displayedJob === jobId && !retryImage) return;
      browser.clearTimeout(state.imageTimer);
      if (state.displayedJob !== jobId) state.imageRetries = 0;
      const attempt = {};
      state.imageAttempt = attempt;
      state.displayedJob = jobId; state.jobId = jobId;
      state.status = 'loading'; state.phase = 'loading'; message(state);
      state.images.replaceChildren();
      const mockups = item?.mockups || [];
      if (!mockups.length || state.item.product.printSurfaces.some(surface => !mockups.some(image => image.surfaceKey === surface.key))) return fail(state);
      function imageFailed() {
        if (closed || state.imageAttempt !== attempt || state.status !== 'loading') return;
        browser.clearTimeout(state.imageTimer);
        state.imageAttempt = null; // Fence both late load and error events immediately.
        if (state.imageRetries++ >= IMAGE_RETRIES) return fail(state, 'mockup_image_failed');
        const command = state.command;
        state.imageTimer = browser.setTimeout(() => {
          if (!closed && state.command === command && state.status === 'loading') show(state, item, jobId, true);
        }, state.imageRetries * 1000);
      }
      state.imageTimer = browser.setTimeout(imageFailed, IMAGE_TIMEOUT_MS);
      let loaded = 0;
      for (const mockup of mockups) {
        const figure = browser.document.createElement('figure');
        const button = browser.document.createElement('button');
        button.type = 'button'; button.className = 'order-preview-image';
        const image = browser.document.createElement('img');
        const surface = state.item.product.printSurfaces.find(surface => surface.key === mockup.surfaceKey);
        i18n.setAttribute(image, 'alt', surface?.label || 'Produktvorschau');
        image.onload = () => {
          if (closed || state.imageAttempt !== attempt || state.status !== 'loading') return;
          image.onload = null;
          if (++loaded === mockups.length) {
            browser.clearTimeout(state.imageTimer);
            state.status = 'ready'; message(state); update();
          }
        };
        image.onerror = imageFailed;
        button.addEventListener('click', () => {
          const dialog = root.querySelector('[data-order-preview-large]');
          const large = dialog.querySelector('img');
          large.src = image.src; large.alt = image.alt;
          dialog.showModal();
        });
        image.src = mockup.url;
        const caption = browser.document.createElement('figcaption');
        setText(caption, surface?.label || 'Produktvorschau');
        button.append(image); figure.append(button, caption); state.images.append(figure);
      }
    }
    async function pause(ms, entries, currentGeneration, command, interruptible = false) {
      const until = Math.min(command.deadline, now() + ms);
      let interrupted = false;
      while (now() < until && !interrupted && !closed && generation === currentGeneration && entries.some(state => state.command === command)) {
        for (const state of entries) if (state.command === command && state.status === 'loading') message(state, Math.ceil((until - now()) / 1000));
        await new Promise(resolve => {
          const wait = { interruptible, finish(wake = false) {
            browser.clearTimeout(timer); waits.delete(wait); interrupted = wake; resolve();
          } };
          const timer = browser.setTimeout(() => wait.finish(), Math.min(1000, until - now()));
          waits.add(wait);
        });
      }
    }
    async function request(url, options) {
      const controller = browser.AbortController ? new browser.AbortController() : null;
      let timer, cancel;
      // The race also bounds stalled JSON bodies and fetch implementations that
      // ignore abort. It does not depend on AbortSignal.timeout support.
      const timeout = new Promise((resolve, reject) => {
        cancel = () => { controller?.abort(); reject(Object.assign(new Error('offline'), { transient: true })); };
        timer = browser.setTimeout(cancel, REQUEST_TIMEOUT_MS);
      });
      requests.add(cancel);
      try {
        return await Promise.race([timeout, (async () => {
          let response;
          try { response = await browser.fetch(url, { ...options, cache: 'no-store', signal: controller?.signal }); }
          catch { throw Object.assign(new Error('offline'), { transient: true }); }
          const data = await response.json().catch(() => null);
          if (!response.ok || !data) {
            const raw = data?.retryAfter || response.headers?.get?.('retry-after');
            const seconds = Number(raw) || (raw ? (Date.parse(raw) - now()) / 1000 : 0);
            throw Object.assign(new Error('preview_failed'), {
              transient: response.status === 429 || (response.status >= 500 && response.status !== 501) || (response.ok && !data),
              missing: response.status === 404,
              cooldown: response.status === 429,
              retryAfter: Math.min(3600, Math.max(0, seconds || (response.status === 429 ? 60 : 0))),
            });
          }
          return data;
        })()]);
      } finally { browser.clearTimeout(timer); requests.delete(cancel); }
    }
    function requestId() {
      const bytes = new Uint8Array(18);
      browser.crypto.getRandomValues(bytes);
      return browser.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }
    function restart(entries, refresh = false) {
      if (closed || !entries.length) return;
      consent.checked = false;
      for (const state of entries) {
        browser.clearTimeout(state.imageTimer);
        Object.assign(state, { status: 'loading', phase: 'queued', errorCode: null, displayedJob: null,
          imageAttempt: null, imageRetries: 0, expiresAt: null, terminal: false });
        state.retry.hidden = true; state.images.replaceChildren(); message(state);
      }
      void generate(entries, refresh);
      update();
    }
    function refreshExpired() {
      const expired = selectedStates().filter(state => Number.isFinite(state.expiresAt) && state.expiresAt <= now());
      if (expired.length) restart(expired);
    }
    async function generate(entries, refresh = false) {
      const currentGeneration = generation, command = { deadline: now() + DEADLINE_MS };
      entries.forEach(state => { state.command = command; });
      const active = () => !closed && generation === currentGeneration && entries.some(state => state.command === command);
      let commandId, jobs = null, failures = 0, reconciled = false;
      try { commandId = requestId(); }
      catch { entries.forEach(state => fail(state)); return; }
      while (active() && now() < command.deadline) {
        try {
          if (!jobs) {
            const data = await request(endpoint, { method: 'POST', headers: {
              'Content-Type': 'application/json', 'X-Wolkenworte-Preview': 'product-mockup',
              ...(guestId ? { 'X-Wolkenworte-Guest-Id': guestId } : {}),
            }, body: JSON.stringify({ configurationIds: entries.map(state => state.item.id), requestId: commandId, refresh }) });
            if (!active()) return;
            jobs = data.jobs;
            if (!Array.isArray(jobs) || !jobs.length) throw new Error('invalid_jobs');
          }
          const data = await request(endpoint + '?jobs=' + encodeURIComponent(jobs.map(job => job.jobId).join(',')));
          if (!active()) return;
          if (!Array.isArray(data.jobs) || data.jobs.length !== jobs.length || jobs.some(expected =>
            !data.jobs.some(job => job.jobId === expected.jobId)) || data.jobs.some(job =>
              !['queued','preparing','submitting','pending','retrying','completed','failed'].includes(job.status) ||
              !Number.isFinite(job.expiresAt) || !Array.isArray(job.configurationIds) || !Array.isArray(job.items))) throw new Error('invalid_jobs');
          failures = 0;
          for (const job of data.jobs) {
            for (const state of entries.filter(state => state.command === command && job.configurationIds.includes(state.item.id))) {
              const item = job.items.find(item => item.configurationId === state.item.id);
              state.expiresAt = job.expiresAt;
              state.terminal = ['completed','failed'].includes(job.status);
              if (item?.mockups?.length) show(state, item, job.jobId);
              else if (state.terminal) fail(state, job.errorCode);
              else { state.phase = job.status; state.errorCode = job.errorCode; message(state, job.retryAfter); }
              if (state.status === 'ready') { state.phase = job.status; message(state); }
            }
          }
          update();
          if (data.jobs.every(job => ['completed','failed'].includes(job.status))) {
            entries.filter(state => state.command === command && state.status === 'loading' && !state.displayedJob).forEach(state => fail(state));
            return;
          }
          const pending = data.jobs.filter(job => !['completed','failed'].includes(job.status));
          await pause(Math.min(60000, Math.max(3000, Math.min(...pending.map(job => Number(job.retryAfter) || 3)) * 1000)), entries, currentGeneration, command, true);
        } catch (error) {
          if (!active()) return;
          // A cached job may expire while another item is still pending. Rejoin
          // valid cached jobs with a new command, without regenerating them.
          if (error.missing && jobs && !reconciled) {
            reconciled = true; jobs = null; commandId = requestId(); refresh = false;
            continue;
          }
          if (!error.transient) break;
          failures++;
          entries.forEach(state => { if (state.command === command && state.status === 'loading') state.phase = 'retrying'; });
          await pause(Math.max(3000, error.retryAfter * 1000 || Math.min(60000, 5000 * 2 ** Math.min(failures - 1, 4))),
            entries, currentGeneration, command, !error.cooldown);
        }
      }
      if (active()) entries.forEach(state => { if (state.command === command && (state.status === 'loading' || !state.terminal)) fail(state); });
    }
    consent.addEventListener('change', () => { refreshExpired(); update(); });
    root.querySelector('[data-order-preview-close]').addEventListener('click', () => root.querySelector('[data-order-preview-large]').close());
    browser.addEventListener('pagehide', () => {
      closed = true; generation++;
      browser.clearTimeout(expiryTimer);
      states.forEach(state => { state.imageAttempt = null; browser.clearTimeout(state.imageTimer); });
      waits.forEach(wait => wait.finish(true));
      requests.forEach(cancel => cancel());
    });
    browser.addEventListener('pageshow', event => { if (event.persisted) { closed = false; consent.checked = false; states.clear(); selectionKey = ''; sync(selected); } });
    function resume() {
      if (closed || browser.document.visibilityState === 'hidden') return;
      refreshExpired();
      waits.forEach(wait => { if (wait.interruptible) wait.finish(true); });
    }
    browser.addEventListener('online', resume);
    browser.addEventListener('focus', resume);
    browser.document.addEventListener('visibilitychange', resume);
    function sync(items) {
      const key = items.map(item => item.id).sort().join(',');
      selected = items;
      if (key === selectionKey) { refreshExpired(); return; }
      selectionKey = key; consent.checked = false;
      const missing = [];
      list.replaceChildren();
      for (const item of items) {
        let state = states.get(item.id);
        if (!state) { state = card(item); states.set(item.id, state); missing.push(state); }
        list.append(state.element);
      }
      update();
      if (missing.length) void generate(missing);
    }
    return { sync, value() { return consent.checked && ready() ? {
      accepted: true, version: 1, jobIds: [...new Set(selected.map(item => states.get(item.id).jobId))],
    } : null; }, reset() { restart(selectedStates(), true); } };
  }
  return { create, IMAGE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, DEADLINE_MS, IMAGE_RETRIES };
});
