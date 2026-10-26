'use strict';

// Loopback fixture only. Record real wheel input; scripted scrollTo does not
// exercise Safari's scroll-blocking event regions or pauses between gestures.
(function () {
  const roots = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const rootTarget = target => target === window || target === document ||
    target === document.documentElement || target === document.body;
  const capture = options => typeof options === 'boolean' ? options : Boolean(options?.capture);
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (['wheel', 'touchmove'].includes(type) && options?.passive === false && rootTarget(this)) {
      let entry = roots.find(item => item.target === this && item.type === type &&
        item.listener === listener && item.capture === capture(options));
      if (!entry) { entry = { target: this, type, listener, capture: capture(options) }; roots.push(entry); }
      entry.active = true;
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const entry = roots.find(item => item.target === this && item.type === type &&
      item.listener === listener && item.capture === capture(options));
    if (entry) entry.active = false;
    return remove.call(this, type, listener, options);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('aside');
    panel.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;background:white;color:black;padding:12px;max-width:460px;max-height:45vh;overflow:auto;font:12px system-ui';
    const start = document.createElement('button'), stop = document.createElement('button');
    start.textContent = 'Start native wheel recording'; stop.textContent = 'Finish native wheel recording';
    const status = document.createElement('p'), output = document.createElement('pre');
    output.id = 'gallery-input-scroll-report'; output.style.whiteSpace = 'pre-wrap';
    panel.append(start, stop, status, output); document.body.append(panel);
    let gallery, stats, recording = false, frame, last, firstWheel, activeUntil, originalCreate, snapshots;
    const restores = [], wrapped = new WeakSet();
    const painted = () => gallery.cards.filter(card => card.stage.dataset.ready === 'true').length;
    const ready = () => gallery.cards.filter(card => card.snapshot).length;
    function wrap(viewer) {
      if (wrapped.has(viewer)) return;
      wrapped.add(viewer);
      const destroy = viewer.destroy;
      viewer.destroy = function () { if (recording) stats.destroys++; return destroy.apply(this, arguments); };
      restores.push(() => { viewer.destroy = destroy; wrapped.delete(viewer); });
    }
    function tick(now) {
      if (!recording) return;
      if (last !== undefined) {
        const gap = now - last;
        stats.frames++; stats.maxFrameGapMs = Math.max(stats.maxFrameGapMs, gap);
        if (gap > 50) stats.gapsOver50++;
        // Report this separately from startup/idle main-thread frame gaps.
        if (last >= firstWheel && last <= activeUntil) {
          stats.maxInputFrameGapMs = Math.max(stats.maxInputFrameGapMs, gap);
          if (gap > 50) stats.inputGapsOver50++;
        }
      }
      last = now; frame = requestAnimationFrame(tick);
    }
    document.addEventListener('wheel', event => {
      if (!recording || !event.isTrusted) return;
      const now = performance.now();
      const stamp = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
      if (!stats.wheels) { stats.firstWheelReady = ready(); firstWheel = now; }
      activeUntil = now + 800;
      stats.wheels++; stats.cancelableWheels += Number(event.cancelable);
      stats.maxWheelAgeMs = Math.max(stats.maxWheelAgeMs, now - stamp);
    }, { capture: true, passive: true });
    window.addEventListener('scroll', () => { if (recording) stats.scrollEvents++; }, { passive: true });
    start.addEventListener('click', () => {
      if (recording || typeof productGallery === 'undefined' || !productGallery) return;
      gallery = productGallery; recording = true; last = undefined; firstWheel = Infinity; activeUntil = 0;
      stats = { startReady: ready(), startPainted: painted(), wheels: 0, cancelableWheels: 0,
        scrollEvents: 0, creates: 0, destroys: 0, createMs: 0, maxWheelAgeMs: 0,
        frames: 0, maxFrameGapMs: 0, gapsOver50: 0, maxInputFrameGapMs: 0, inputGapsOver50: 0 };
      snapshots = JSON.stringify(gallery.cards.map(card => card.snapshot));
      gallery.cards.filter(card => card.viewer).forEach(card => wrap(card.viewer));
      originalCreate = gallery.createMug;
      gallery.createMug = function (...args) {
        const start = performance.now(), viewer = originalCreate.apply(this, args);
        stats.creates++; stats.createMs += performance.now() - start; wrap(viewer); return viewer;
      };
      output.textContent = 'Recording native mouse-wheel input'; frame = requestAnimationFrame(tick);
    });
    stop.addEventListener('click', () => {
      if (!recording) return;
      recording = false; cancelAnimationFrame(frame); gallery.createMug = originalCreate;
      restores.splice(0).forEach(restore => restore());
      stats.ready = ready(); stats.paintedCards = painted();
      stats.liveViewers = gallery.cards.filter(card => card.viewer).length;
      stats.cachedBitmaps = gallery.cards.filter(card => !card.previousPreview.hidden && card.cachedPreviewVersion === card.version).length;
      stats.rootBlockingListeners = roots.filter(entry => entry.active).map(entry => entry.type);
      stats.sameDesigns = stats.startReady === gallery.cards.length
        ? snapshots === JSON.stringify(gallery.cards.map(card => card.snapshot)) : null;
      output.textContent = JSON.stringify(stats, null, 2);
    });
    let autoStarted = false;
    setInterval(() => {
      if (typeof productGallery === 'undefined' || !productGallery) return;
      gallery = productGallery;
      status.textContent = `Ready designs: ${ready()}; painted cards: ${painted()}; live viewers: ${gallery.cards.filter(card => card.viewer).length}`;
      if (!autoStarted && new URLSearchParams(location.search).has('recordOnLoad')) { autoStarted = true; start.click(); }
    }, 250);
  }, { once: true });
})();
