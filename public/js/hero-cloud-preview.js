(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.create(root.document.querySelector('[data-hero-preview]'), { window: root });
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Keep the source's weighting while giving emoji turns throughout the demo.
  function arrivalOrder(words, isEmoji) {
    const text = words.filter(([word]) => !isEmoji(word));
    const emoji = words.filter(([word]) => isEmoji(word));
    for (let index = 0; index < emoji.length; index++) {
      text.splice(Math.min(3 + index * 8, text.length), 0, emoji[index]);
    }
    return text;
  }

  function create(element, { window, core = window?.WordCloudCore,
    layout = window?.LiveCloudLayout, emoji = window?.WolkenworteEmoji,
    transition = window?.LiveCloudTransition } = {}) {
    if (!element || !core || !layout || !emoji || !transition) return null;
    const document = window.document;
    const canvas = element.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const stage = element.querySelector('[data-preview-stage]');
    const screen = element.querySelector('[data-preview-screen]');
    const title = element.querySelector('[data-preview-title]');
    const fallback = element.querySelector('[data-preview-fallback]');
    const toggle = element.querySelector('[data-preview-toggle]');
    const highlights = element.querySelector('[data-preview-highlights]');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let words = [], count = 0, placed = [], size, getColor, worker;
    let timer = null, highlightTimer = null, request = null, revision = 0;
    let inView = !window.IntersectionObserver, paused = false, suspended = false, disposed = false;
    const fontReady = document.fonts?.load
      ? document.fonts.load('16px "Wolkenworte Classic"', 'Wolkenworte')
      : Promise.resolve();
    const presentation = transition.create({
      commit: paint,
      highlight: highlightWords,
      clearHighlights,
      setOpacity: value => { canvas.style.opacity = String(value); },
      isValid: validSnapshot,
      // The initial seeded cloud appears immediately, without highlighting
      // its existing words. Later arrivals use the live page's transition.
      motionAllowed: () => playing() && placed.length > 0,
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: id => window.cancelAnimationFrame(id),
      now: () => window.performance.now(),
    });

    function playing() {
      return !disposed && !suspended && !paused && !reducedMotion.matches && inView &&
        !document.hidden && !document.documentElement.classList.contains('intro-fade');
    }

    function cancel() {
      window.clearTimeout(timer);
      timer = null;
    }

    function validSnapshot({ placed: items, size: job }) {
      if (disposed || suspended || job.width !== size?.width || job.height !== size?.height) return false;
      const expected = new Map(words.slice(0, count));
      return items.length === expected.size && items.every(item => expected.get(item.word) === item.count);
    }

    function paint({ placed: items, size: job }) {
      const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      canvas.width = Math.max(1, Math.round(job.width * ratio));
      canvas.height = Math.max(1, Math.round(job.height * ratio));
      canvas.style.width = job.width + 'px';
      canvas.style.height = job.height + 'px';
      ctx.setTransform(canvas.width / job.width, 0, 0, canvas.height / job.height, 0, 0);
      placed = items;
      ctx.clearRect(0, 0, size.width, size.height);
      for (const item of items) {
        core.drawPlacedWord(ctx, item, { emojiImage: run => emoji.getLoadedImage(run) });
      }
      element.classList.add('is-ready');
      toggle.hidden = reducedMotion.matches;
      element.dataset.previewWordCount = String(placed.length);
      schedule();
    }

    function clearHighlights() {
      window.clearTimeout(highlightTimer);
      highlightTimer = null;
      highlights.replaceChildren();
    }

    function highlightWords({ placed: items, size: job }, changed) {
      highlights.style.width = job.width + 'px';
      highlights.style.height = job.height + 'px';
      const glows = items.filter(item => changed.has(item.word)).slice(0, 12).map(item => {
        const glow = document.createElement('span');
        const padding = Math.min(12, Math.max(5, item.fontPx * .2));
        glow.className = 'cloud-word-highlight';
        glow.style.left = (item.x1 - padding) + 'px';
        glow.style.top = (item.y1 - padding) + 'px';
        glow.style.width = (item.x2 - item.x1 + padding * 2) + 'px';
        glow.style.height = (item.y2 - item.y1 + padding * 2) + 'px';
        glow.style.setProperty('--word-glow', item.color);
        return glow;
      });
      highlights.replaceChildren(...glows);
      highlightTimer = window.setTimeout(clearHighlights, 1000);
    }

    function schedule() {
      window.clearTimeout(timer);
      timer = null;
      if (!playing() || !placed.length) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (!playing()) return;
        if (count === words.length) {
          count = Math.min(8, words.length);
          getColor = core.makePaletteAssigner(getColor.palette);
        } else count++;
        render();
      }, count === words.length ? 5500 : 1250);
    }

    function draw(next, job) {
      if (!validSnapshot({ placed: next, size: job })) return;
      cancel();
      presentation.present({ placed: core.spreadPaletteColors(next, getColor.palette), size: job });
      schedule();
    }

    function fail() {
      cancel();
      presentation.reset();
      canvas.style.opacity = '';
      placed = [];
      element.classList.remove('is-ready');
      toggle.hidden = true;
    }

    function render() {
      if (!words.length || disposed || suspended) return;
      const rect = stage.getBoundingClientRect();
      size = { width: Math.floor(rect.width - 20), height: Math.floor(rect.height - 20) };
      if (size.width < 1 || size.height < 1) return;
      worker ||= layout.create({ core, workerUrl: element.dataset.workerUrl,
        coreUrl: element.dataset.coreUrl, onLayout: draw, onError: fail });
      worker.clear();
      const current = words.slice(0, count), counts = new Map(current);
      worker.request(core.measureWords(current, ctx, getColor).map(item => ({ ...item, count: counts.get(item.word) })),
        size.width, size.height);
    }

    function sync() {
      cancel();
      presentation.finish();
      schedule();
    }

    async function load(locale) {
      const dataUrl = element.getAttribute('data-cloud-' + locale);
      const imageUrl = element.getAttribute('data-fallback-' + locale);
      if (!dataUrl || !imageUrl) return;
      const current = ++revision;
      request?.abort();
      request = new window.AbortController();
      cancel();
      presentation.reset();
      canvas.style.opacity = '';
      worker?.clear();
      words = []; placed = [];
      element.classList.remove('is-ready');
      fallback.src = imageUrl;
      try {
        const response = await window.fetch(dataUrl, { signal: request.signal });
        if (!response.ok) throw new Error('preview_unavailable');
        const data = await response.json();
        await Promise.all([fontReady, emoji.preloadTexts(data.words.map(([word]) => word))]);
        if (disposed || current !== revision) return;
        words = arrivalOrder(data.words, core.isEmojiOnly);
        getColor = core.makePaletteAssigner(data.palette.colors);
        title.textContent = data.title;
        data.palette.background.forEach((value, index) => {
          screen.style.setProperty(['--preview-bg', '--preview-bg2', '--preview-rad1', '--preview-rad2'][index], value);
        });
        screen.style.setProperty('--preview-primary', data.palette.colors[0]);
        count = reducedMotion.matches ? words.length : Math.min(8, words.length);
        toggle.hidden = reducedMotion.matches;
        render();
      } catch (error) {
        if (current === revision && error.name !== 'AbortError' && !disposed) fail();
      }
    }

    function onToggle() {
      paused = !paused;
      element.classList.toggle('is-paused', paused);
      window.WolkenworteI18n.setAttribute(toggle, 'aria-label',
        paused ? 'Vorschau abspielen' : 'Vorschau pausieren');
      sync();
    }
    function onMotion() {
      toggle.hidden = reducedMotion.matches;
      if (reducedMotion.matches && words.length) { count = words.length; render(); }
      sync();
    }
    function onLocale(event) { load(event.detail.locale); }
    function onPageHide() {
      suspended = true;
      cancel();
      presentation.invalidate();
      worker?.dispose();
      worker = null;
    }
    function onPageShow() { suspended = false; render(); }
    toggle.addEventListener('click', onToggle);
    reducedMotion.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('wolkenworte:localechange', onLocale);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    const visibility = window.IntersectionObserver ? new window.IntersectionObserver(entries => {
      inView = entries[0].isIntersecting;
      sync();
    }, { threshold: .15 }) : null;
    visibility?.observe(element);
    const resize = new window.ResizeObserver(render);
    resize.observe(stage);
    const intro = new window.MutationObserver(sync);
    intro.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    load(window.WolkenworteI18n.getLocale());

    return {
      dispose() {
        disposed = true;
        ++revision;
        cancel(); presentation.dispose(); request?.abort(); worker?.dispose();
        visibility?.disconnect(); resize.disconnect(); intro.disconnect();
        toggle.removeEventListener('click', onToggle);
        reducedMotion.removeEventListener('change', onMotion);
        document.removeEventListener('visibilitychange', sync);
        window.removeEventListener('wolkenworte:localechange', onLocale);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
      },
    };
  }
  return { create, arrivalOrder };
});
