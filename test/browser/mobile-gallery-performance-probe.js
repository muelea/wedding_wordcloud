'use strict';

// Loopback fixture only. Mobile signals and viewport are not a phone CPU or
// network simulation. Scripted jumps do not establish native touch smoothness.
(function () {
  const audit = { input: 'scripted jump; local desktop CPU, mobile signals, two workers',
    preparations: [], previews: [], longTasks: [], frameGaps: [] };
  const query = new URLSearchParams(location.search);
  const prototype = WolkenworteProductGallery.Gallery.prototype;
  const prepared = prototype.prepared, ready = prototype.previewReady;
  prototype.prepared = function (product, ...args) {
    audit.preparations.push({ key: product.key, start: performance.now() });
    return prepared.call(this, product, ...args);
  };
  prototype.previewReady = function (card) {
    if (!audit.previews.some(item => item.key === card.product.key)) {
      audit.previews.push({ key: card.product.key, ready: performance.now() });
    }
    return ready.call(this, card);
  };
  let tasks;
  if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    tasks = new PerformanceObserver(list => audit.longTasks.push(...list.getEntries()
      .map(entry => ({ start: entry.startTime, duration: entry.duration }))));
    tasks.observe({ type: 'longtask', buffered: true });
  }
  const report = document.createElement('pre');
  report.id = 'mobile-gallery-performance-report';
  report.hidden = query.get('controls') === 'hidden';
  report.style.cssText = 'position:fixed;bottom:0;left:0;z-index:10001;max-height:100px;max-width:100%;overflow:auto;font-size:9px;background:white';
  document.body.append(report);
  const verify = document.createElement('button');
  verify.type = 'button'; verify.textContent = 'Check mobile gallery handoff';
  verify.hidden = report.hidden;
  verify.style.cssText = 'position:fixed;right:8px;bottom:110px;z-index:10001;font-size:10px';
  document.body.append(verify);
  verify.addEventListener('click', async () => {
    verify.disabled = true;
    const result = {};
    try {
      const gallery = productGallery;
      const card = gallery.cards.find(card => card.product.key === 'mouse-pad');
      card.element.scrollIntoView({ block: 'start' });
      const deadline = performance.now() + 15000;
      while (!card.snapshot || card.stage.dataset.ready !== 'true') {
        if (performance.now() > deadline) throw new Error('preview_timeout');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const fingerprint = designs => WolkenworteConfiguratorSession.designFingerprint({ designs }, true);
      const expected = fingerprint(card.snapshot.designs);
      await gallery.choose(card);
      result.editor = workspaceReady && galleryElement.hidden && workspace.mobileCanvas.active;
      result.exactHandoff = expected === fingerprint(getAllSurfaceDesigns());
      await returnToGallery();
      result.returned = !galleryElement.hidden && editorElement.hidden && !workspace.mobileCanvas.active;
      result.exactReturn = expected === fingerprint(card.snapshot.designs);
      await gallery.add(card);
      result.accepted = card.inCart && card.snapshot.needsCartUpdate === false;
      const saved = await (await fetch(`/api/events/${slug}/configurations/${card.snapshot.editingOrderItemId}/edit`)).json();
      result.exactCart = expected === fingerprint(saved.designs);
      result.passed = Object.values(result).every(value => value === true);
    } catch (error) { result.passed = false; result.error = error.message; }
    verify.textContent = JSON.stringify(result);
    verify.dataset.finished = 'true';
  });
  let previous, stopped = false, jumped = false;
  function frame(now) {
    if (stopped) return;
    if (previous !== undefined && now - previous > 50) audit.frameGaps.push({ start: previous, duration: now - previous });
    previous = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  const timer = setInterval(async () => {
    if (typeof productGallery === 'undefined' || !productGallery) return;
    audit.galleryShown ??= performance.now();
    const cards = productGallery.cards;
    audit.firstArtwork ??= cards.some(card => card.snapshot) ? performance.now() : undefined;
    if (!jumped && query.get('jump') === '1' && performance.now() >= 3000) {
      jumped = true;
      audit.jumped = performance.now();
      cards.find(card => card.product.key === 'mouse-pad').element.scrollIntoView({ block: 'start' });
    }
    const target = cards.find(card => card.product.key === 'mouse-pad');
    if (jumped && target.stage.dataset.ready === 'true') audit.targetReady ??= performance.now();
    if (performance.now() < 10000) return;
    stopped = true; clearInterval(timer); tasks?.disconnect();
    audit.preparedCards = cards.filter(card => card.snapshot).length;
    audit.liveViewers = cards.filter(card => card.viewer).length;
    audit.fabricRequested = performance.getEntriesByType('resource').some(entry => entry.name.includes('/vendor/fabric.min.js'));
    audit.errors = cards.filter(card => card.failed || card.stage.dataset.ready === 'error').map(card => card.product.key);
    audit.hashes = [];
    for (const card of cards.filter(card => card.snapshot)) {
      const bytes = new TextEncoder().encode(JSON.stringify(card.snapshot.designs));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      audit.hashes.push({ key: card.product.key, hash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') });
    }
    report.textContent = JSON.stringify(audit);
    report.dataset.finished = 'true';
  }, 50);
})();
