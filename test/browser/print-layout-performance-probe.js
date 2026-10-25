'use strict';

// Installed immediately after the print-layout client by the loopback-only
// configurator fixture. No measurements or test controls ship with the app.
(function () {
  const observationStarted = performance.now();
  const audit = { optimizerCalculations: 0, workerJobs: 0, hashes: [], fills: [], longTasks: [] };
  let firstLayout = null, finished = false;
  let observer;
  if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) audit.longTasks.push({ start: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
  const NativeWorker = window.Worker;
  if (NativeWorker) window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.measuredPacking = String(url).includes('/js/cloud-layout-worker.js');
    }
    postMessage(...args) {
      if (this.measuredPacking) audit.workerJobs++;
      return super.postMessage(...args);
    }
  };
  const create = PrintLayoutClient.create;
  const forcedWorkers = Number(new URLSearchParams(location.search).get('workers'));
  if ([1, 2, 3, 4].includes(forcedWorkers)) PrintLayoutClient.parallelism = () => forcedWorkers;
  PrintLayoutClient.create = options => {
    audit.workerCount = options.workerCount;
    const optimize = options.layout.optimizeDesignAsync;
    const client = create({ ...options, layout: { ...options.layout,
      optimizeDesignAsync(...args) { audit.optimizerCalculations++; return optimize(...args); },
    } });
    const automatic = client.automatic;
    client.automatic = async (...args) => {
      const start = performance.now();
      firstLayout ??= start;
      const result = await automatic(...args);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(result)));
      audit.hashes.push({ slots: args[1], sha256: [...new Uint8Array(hash)]
        .map(byte => byte.toString(16).padStart(2, '0')).join('') });
      audit.fills.push(performance.now() - start);
      return result;
    };
    return client;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const report = document.createElement('pre');
    report.id = 'print-layout-performance-report';
    report.style.cssText = 'white-space:pre-wrap;padding:16px;background:white;color:black';
    report.textContent = 'Measuring automatic product layouts…';
    const verify = document.createElement('button');
    verify.type = 'button'; verify.disabled = true;
    verify.textContent = 'Verify exact layouts and cached reuse';
    document.body.append(verify, report);
    verify.addEventListener('click', async () => {
      verify.disabled = true;
      try {
        const round = design => design.map(item => {
          const result = { ...item };
          for (const key of ['x', 'y', 'angle', 'fontSize', 'layoutFontSize', 'size', 'width', 'height']) {
            if (Number.isFinite(result[key])) result[key] = Math.round(result[key] * 10) / 10;
          }
          return result;
        });
        let parity = true;
        for (const card of productGallery.cards) for (const surface of card.product.printSurfaces) {
          await new Promise(resolve => setTimeout(resolve, 0));
          const snapshot = card.snapshot;
          const expected = buildAutomaticDesign(surface.key, { product: card.product,
            orientation: snapshot.orientation, words: snapshot.words, colors: getPalette(snapshot.theme).colors });
          parity &&= JSON.stringify(round(expected)) === JSON.stringify(snapshot.designs[surface.key]);
        }
        const before = audit.workerJobs;
        const card = productGallery.cards[0], snapshot = card.snapshot, start = performance.now();
        await buildAutomaticDesign(card.product.printSurfaces[0].key, { product: card.product,
          orientation: snapshot.orientation, words: snapshot.words, colors: getPalette(snapshot.theme).colors,
          background: true });
        audit.cachedReuseMs = performance.now() - start;
        audit.cachedReuseCreatedNoWorkerJobs = before === audit.workerJobs;
        audit.syncParity = parity;
        audit.passed &&= parity && audit.cachedReuseCreatedNoWorkerJobs;
      } catch (error) { audit.passed = false; audit.error = error.message; }
      report.textContent = JSON.stringify(audit, null, 2);
      verify.disabled = false;
    });
    const timer = setInterval(() => {
      if (finished) return;
      const cards = [...document.querySelectorAll('.product-gallery-card')];
      if (cards.some(card => !card.querySelector('.product-gallery-select').disabled)) {
        audit.firstCardReadyMs ??= performance.now() - observationStarted;
      }
      if (!cards.length || cards.some(card => card.querySelector('.product-gallery-select').disabled)) return;
      finished = true; clearInterval(timer);
      for (const entry of observer?.takeRecords() || []) {
        audit.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
      observer?.disconnect();
      audit.allReadyMs = performance.now() - observationStarted;
      audit.layoutWindowMs = performance.now() - firstLayout;
      audit.longTasksSupported = Boolean(observer);
      audit.longestLayoutTaskMs = observer ? Math.max(0, ...audit.longTasks.filter(task =>
        task.start + task.duration >= firstLayout).map(task => task.duration)) : null;
      audit.passed = audit.hashes.length === 10 && audit.optimizerCalculations === 9 && audit.workerJobs > 0;
      report.textContent = JSON.stringify(audit, null, 2);
      verify.disabled = false;
    }, 100);
  }, { once: true });
})();
