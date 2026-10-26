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
    const scroll = document.createElement('button');
    scroll.type = 'button'; scroll.textContent = 'Measure scripted gallery scrolling';
    scroll.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:10000;padding:10px;background:white;color:black';
    const scrollReport = document.createElement('pre');
    scrollReport.id = 'gallery-scroll-performance-report';
    scrollReport.style.cssText = report.style.cssText;
    document.body.append(scroll, scrollReport);
    scroll.addEventListener('click', async () => {
      scroll.disabled = true;
      const gallery = productGallery;
      await gallery.queue;
      const snapshots = JSON.stringify(gallery.cards.map(card => card.snapshot));
      const jobs = audit.workerJobs;
      const stats = { input: 'scripted scrollTo; does not test native wheel handling', creates: 0, destroys: 0, createMs: 0, renderMs: 0,
        frames: 0, gapsOver50: 0, maxGapMs: 0, longTasks: [] };
      const create = gallery.createMug, render = gallery.render;
      const releases = [];
      let tasks;
      try {
        if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
          tasks = new PerformanceObserver(list => stats.longTasks.push(...list.getEntries()
            .map(entry => ({ start: entry.startTime, duration: entry.duration }))));
          tasks.observe({ type: 'longtask' });
        }
        gallery.createMug = function (...args) {
          const start = performance.now(), viewer = create.apply(this, args);
          stats.creates++; stats.createMs += performance.now() - start;
          const destroy = viewer.destroy;
          viewer.destroy = function () { stats.destroys++; return destroy.apply(this, arguments); };
          releases.push(() => { viewer.destroy = destroy; });
          return viewer;
        };
        gallery.render = function (...args) {
          const start = performance.now(), result = render.apply(this, args);
          stats.renderMs += performance.now() - start;
          return result;
        };
        window.scrollTo(0, 0);
        const range = Math.max(0, gallery.element.querySelector('[data-gallery-grid]')
          .getBoundingClientRect().bottom + window.scrollY - window.innerHeight);
        let start, previous;
        await new Promise(resolve => {
          function frame(now) {
            start ??= now;
            if (previous !== undefined) {
              const gap = now - previous;
              stats.frames++; stats.maxGapMs = Math.max(stats.maxGapMs, gap);
              if (gap > 50) stats.gapsOver50++;
            }
            previous = now;
            const progress = Math.min(1, (now - start) / 12000);
            window.scrollTo(0, range * (progress < .5 ? progress * 2 : 2 - progress * 2));
            if (progress < 1) requestAnimationFrame(frame); else resolve();
          }
          requestAnimationFrame(frame);
        });
        await new Promise(resolve => setTimeout(resolve, 500));
        stats.sameDesigns = snapshots === JSON.stringify(gallery.cards.map(card => card.snapshot));
        stats.noNewLayoutJobs = jobs === audit.workerJobs;
        stats.previewErrors = gallery.cards.filter(card => card.failed).map(card => card.product.key);
        stats.retainedViewers = gallery.cards.filter(card => card.viewer).length;
        stats.passed = stats.sameDesigns && stats.noNewLayoutJobs && !stats.previewErrors.length;
      } catch (error) { stats.passed = false; stats.error = error.message; }
      finally {
        tasks?.disconnect(); gallery.createMug = create; gallery.render = render;
        releases.forEach(release => release());
        scrollReport.textContent = JSON.stringify(stats, null, 2);
        scroll.disabled = false;
      }
    });
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
        const checks = [];
        for (const card of productGallery.cards) for (const surface of card.product.printSurfaces) {
          await new Promise(resolve => setTimeout(resolve, 0));
          const snapshot = card.snapshot;
          if (!snapshot) throw new Error(`No completed design: ${card.product.key}`);
          const expected = buildAutomaticDesign(surface.key, { product: card.product,
            orientation: snapshot.orientation, words: snapshot.words, colors: getPalette(snapshot.theme).colors });
          const design = snapshot.designs[surface.key];
          const same = JSON.stringify(round(expected)) === JSON.stringify(design);
          const view = productView(card.product, snapshot.orientation, surface.key);
          const readable = TextPrintQuality.findings(design, view.printFile.dpi).length === 0;
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(design)));
          checks.push({ product: card.product.key, surface: surface.key, same, readable,
            sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') });
          parity &&= same && readable;
        }
        const before = audit.workerJobs;
        // The bounded LRU can evict the first product in a large catalog.
        // Reuse a recently completed entry to test the cache contract.
        const card = productGallery.cards.at(-1), snapshot = card.snapshot, start = performance.now();
        await buildAutomaticDesign(card.product.printSurfaces[0].key, { product: card.product,
          orientation: snapshot.orientation, words: snapshot.words, colors: getPalette(snapshot.theme).colors,
          background: true });
        audit.cachedReuseMs = performance.now() - start;
        audit.cachedReuseCreatedNoWorkerJobs = before === audit.workerJobs;
        audit.syncParity = parity;
        audit.checks = checks;
        audit.passed &&= parity && audit.cachedReuseCreatedNoWorkerJobs;
      } catch (error) { audit.passed = false; audit.error = error.message; }
      report.textContent = JSON.stringify(audit, null, 2);
      verify.disabled = false;
    });
    const timer = setInterval(() => {
      if (finished) return;
      const cards = [...document.querySelectorAll('.product-gallery-card')];
      const ready = cards.filter(card => card.querySelector('.product-gallery-customize')?.disabled === false).length;
      if (ready) {
        audit.firstCardReadyMs ??= performance.now() - observationStarted;
      }
      if (!cards.length || typeof productGallery === 'undefined' || !productGallery ||
          !productGallery.cards.every(card => card.snapshot || card.capacity || card.failed ||
            card.stage.dataset.ready === 'error')) return;
      finished = true; clearInterval(timer);
      for (const entry of observer?.takeRecords() || []) {
        audit.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
      observer?.disconnect();
      audit.allSettledMs = performance.now() - observationStarted;
      audit.allReadyMs = ready === cards.length ? audit.allSettledMs : null;
      audit.cards = cards.length;
      audit.readyCards = ready;
      audit.capacityProducts = productGallery.cards.filter(card => card.capacity).map(card => card.product.key);
      audit.failedProducts = productGallery.cards.filter(card => !card.snapshot && !card.capacity).map(card => card.product.key);
      audit.expectedSurfaces = productGallery.cards.reduce((sum, card) => sum + card.product.printSurfaces.length, 0);
      audit.layoutWindowMs = performance.now() - firstLayout;
      audit.longTasksSupported = Boolean(observer);
      audit.longestLayoutTaskMs = observer ? Math.max(0, ...audit.longTasks.filter(task =>
        task.start + task.duration >= firstLayout).map(task => task.duration)) : null;
      audit.passed = ready === cards.length && audit.hashes.length === audit.expectedSurfaces &&
        audit.optimizerCalculations > 0 && audit.workerJobs > 0;
      report.dataset.finished = 'true';
      report.textContent = JSON.stringify(audit, null, 2);
      verify.disabled = false;
    }, 100);
  }, { once: true });
})();
