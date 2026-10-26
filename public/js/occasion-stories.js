(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.mount(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const COLORS = ['#528563', '#a94c77', '#a8812b', '#528563', '#6d7fb0', '#a94c77', '#b37c48', '#528563', '#a94c77', '#a8812b', '#6d7fb0', '#a94c77', '#b37c48'];
  const SIZES = [11, 16, 24, 16, 16, 30, 16, 24, 11, 24, 16, 16, 16];
  const MAX_WORDS = 24;

  function createCollection(stories) {
    const collections = new Map(stories.map(story => [story.key, story.words.map((text, index) => ({ text, color: COLORS[index % COLORS.length], size: SIZES[index % SIZES.length], index }))]));
    return {
      words(key) { return (collections.get(key) || []).map(word => ({ ...word })); },
      add(key, value) {
        const words = collections.get(key);
        const text = Array.from(String(value).trim().replace(/\s+/g, ' ')).slice(0, 26).join('');
        if (!words || !text || words.length >= MAX_WORDS) return null;
        const word = { text: text.charAt(0).toLocaleUpperCase('de') + text.slice(1), color: COLORS[words.length % COLORS.length], size: 16, index: words.length };
        words.push(word);
        return { ...word };
      },
    };
  }

  // Each product receives the same complete collection in its approved print areas.
  // Row packing is measured on the real canvas and never drops a long word.
  function planPrint(words, measure, width = 850, height = 850) {
    if (!words.length) return [];
    let scale = 5;
    for (let attempt = 0; attempt < 120; attempt++, scale *= .94) {
      const rows = []; let row = { items: [], width: 0, height: 0 };
      for (const word of words) {
        const size = word.size * scale;
        const item = { ...word, size, width: measure(word.text, size) + 12, height: size * 1.4 };
        if (row.items.length && row.width + 28 + item.width > width) { rows.push(row); row = { items: [], width: 0, height: 0 }; }
        if (row.items.length) row.width += 28;
        row.items.push(item); row.width += item.width; row.height = Math.max(row.height, item.height);
      }
      if (row.items.length) rows.push(row);
      const usedHeight = rows.reduce((sum, entry) => sum + entry.height, 0) + (rows.length - 1) * 18;
      if (usedHeight > height || rows.some(entry => entry.width > width)) continue;
      let y = (height - usedHeight) / 2;
      const result = [];
      for (const entry of rows) {
        let x = (width - entry.width) / 2;
        for (const item of entry.items) { result.push({ ...item, x: x + item.width / 2, y: y + entry.height / 2 }); x += item.width + 28; }
        y += entry.height + 18;
      }
      return result;
    }
    throw new Error('Words do not fit the demo print area');
  }

  function mount(window) {
    const document = window.document;
    const root = document.getElementById('occasion-browser');
    if (!root) return;
    const stories = JSON.parse(document.getElementById('occasion-stories-data').textContent);
    const find = name => root.querySelector('[data-occasion-' + name + ']');
    const scene = find('scene'), photo = find('photo'), cloud = find('cloud');
    const panel = find('panel'), previous = find('previous'), next = find('next');
    const cup = find('cup'), form = find('form'), input = find('input');
    const keepsake = find('keepsake'), status = find('status'), flight = find('flight');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const animations = new Set();
    let index = 0, epoch = 0, viewer = null, productVisible = false;
    const t = text => window.WolkenworteI18n ? window.WolkenworteI18n.t(text) : text;
    const localizedCollection = () => createCollection(stories.map(story => ({ ...story, words: story.words.map(t) })));
    let collection = localizedCollection();
    const current = () => stories[index];
    function announce(text, visible = false) { status.textContent = text; status.classList.toggle('occasion-sr-only', !visible); }
    function labelKeepsake(active) {
      const label = t(active ? 'Zurück zur Wortwolke' : 'Erinnerungsstück gestalten');
      keepsake.setAttribute('aria-label', label); keepsake.setAttribute('title', label);
      keepsake.setAttribute('aria-pressed', String(active));
    }
    function busy(value) { form.querySelector('button').disabled = value; keepsake.disabled = value; }
    function cancelAnimations() {
      animations.forEach(animation => animation.cancel()); animations.clear(); flight.textContent = '';
      Array.from(cloud.children).forEach(node => { node.style.visibility = ''; });
    }
    function animate(node, frames, timing) {
      if (reduced.matches || !node.animate) return Promise.resolve();
      const animation = node.animate(frames, timing); animations.add(animation);
      return animation.finished.catch(() => {}).finally(() => { if (timing.fill !== 'forwards') { animations.delete(animation); animation.cancel(); } });
    }
    function destroyCup() { viewer?.destroy(); viewer = null; cup.hidden = true; cup.tabIndex = -1; productVisible = false; cloud.classList.remove('is-product'); }
    function makeWord(word) {
      const span = document.createElement('span'); span.className = 'occasion-word occasion-word--' + (word.index % 13);
      span.textContent = word.text; span.style.color = word.color;
      if (word.index >= 13) span.style.fontSize = 'clamp(12px,1.8vw,16px)';
      span.style.animationDelay = -(word.index % 6) + 's';
      span.setAttribute('data-occasion-word', ''); span.setAttribute('data-i18n-ignore', ''); return span;
    }
    function fitTitle() {
      const box = find('title-box'), heading = find('title-heading');
      if (!window.getComputedStyle || !box.clientHeight) return;
      heading.style.fontSize = '';
      let size = parseFloat(window.getComputedStyle(heading).fontSize);
      while (size > 12 && (heading.scrollHeight > box.clientHeight || heading.scrollWidth > box.clientWidth)) {
        size -= .5; heading.style.fontSize = size + 'px';
      }
    }
    if (window.ResizeObserver) new window.ResizeObserver(fitTitle).observe(find('title-box'));
    document.fonts?.ready.then(fitTitle);
    function render() {
      epoch++; cancelAnimations(); destroyCup(); busy(false); announce('');
      const story = current(); root.dataset.storyKey = story.key;
      find('kicker').textContent = t(story.label);
      find('question').textContent = t(story.question);
      find('title').textContent = t(story.titleLines[0]); find('subtitle').textContent = t(story.titleLines[1]);
      fitTitle();
      photo.style.objectPosition = story.imagePosition || 'center 40%';
      photo.srcset = story.smallImage + ' 640w, ' + story.image + ' 1200w'; photo.src = story.image; photo.alt = t(story.alt);
      input.value = ''; input.placeholder = t(story.placeholder);
      cloud.replaceChildren(...collection.words(story.key).map(makeWord));
      labelKeepsake(false);
    }
    async function fly(text, color, start, target, ticket) {
      const bounds = scene.getBoundingClientRect();
      flight.textContent = text; flight.style.color = color; flight.style.left = start.left - bounds.left + 'px'; flight.style.top = start.top - bounds.top + 'px';
      await animate(flight, [
        { opacity: 1, transform: 'translate(0,0)' },
        { opacity: 1, offset: .5, transform: `translate(${(target.left - start.left) / 2}px,${target.top - start.top - 40}px)` },
        { opacity: 0, transform: `translate(${target.left - start.left}px,${target.top - start.top}px) scale(.8)` },
      ], { duration: 1400, easing: 'ease-in-out' });
      if (ticket === epoch) flight.textContent = '';
    }
    async function submitWord() {
      if (!input.value.trim()) { announce(t('Bitte gebt ein Wort ein.'), true); return; }
      const ticket = ++epoch; cancelAnimations();
      Array.from(cloud.children).forEach(node => { node.style.visibility = ''; });
      if (productVisible) destroyCup();
      labelKeepsake(false);
      const word = collection.add(current().key, input.value);
      if (!word) { announce(t('Probiert ein anderes Beispiel aus – diese Wolke ist schon gut gefüllt.'), true); return; }
      const span = makeWord(word), origin = input.getBoundingClientRect(); cloud.appendChild(span); input.value = '';
      span.style.visibility = 'hidden';
      // A later submission must never erase or strand an earlier arrival.
      Array.from(cloud.children).forEach(node => { if (node !== span) node.style.visibility = ''; });
      await fly(word.text, word.color, origin, span.getBoundingClientRect(), ticket);
      if (ticket === epoch) { span.style.visibility = ''; announce(t('Wort hinzugefügt') + ': ' + word.text); }
    }
    form.addEventListener('submit', event => { event.preventDefault(); stopDemo(false); return submitWord(); });
    function drawTexture(ctx, offsets = {}, back = false) {
      const product = current().product || window.wolkenworteLandingMugProduct;
      const words = collection.words(current().key);
      const layout = planPrint(words, (text, size) => {
        ctx.font = 'italic ' + size + 'px Georgia'; const metrics = ctx.measureText(text);
        return Math.max(metrics.width, (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0));
      });
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const area = product.designSafeAreas?.[back ? 'back' : 'front'] || product.designSafeAreas?.default;
      const slots = product.layoutGeometry?.['both-sides'] || (area ? [area] : product.layoutGeometry?.centered) || [{ x: 162, y: 100, side: 850 }, { x: 1687, y: 100, side: 850 }];
      for (const slot of slots) {
        const width = slot.width || slot.side, height = slot.height || slot.side;
        const scale = Math.min(width, height) / 850;
        const x = slot.x + (width - 850 * scale) / 2 + (offsets.offsetX || 0);
        const y = slot.y + (height - 850 * scale) / 2 + (offsets.offsetY || 0);
        for (const word of layout) {
          ctx.font = 'italic ' + word.size * scale + 'px Georgia'; ctx.fillStyle = word.color;
          ctx.fillText(word.text, x + word.x * scale, y + word.y * scale);
        }
      }
      cup.setAttribute('aria-label', t(product.name || 'Tasse') + ' · ' + t('Mit euren Worten') + ': ' + words.map(word => word.text).join(', '));
    }

    async function showKeepsake() {
      const ticket = ++epoch; cancelAnimations();
      if (productVisible) { destroyCup(); labelKeepsake(false); return; }
      busy(true); announce(t('Vorschau wird geladen…'), true); cup.hidden = false;
      try {
        await window.wolkenworteThreeReady;
        if (ticket !== epoch) return;
        const product = current().product || window.wolkenworteLandingMugProduct;
        if (!product || (!product.previewMesh && !product.previewModel)) throw new Error('Product mesh missing');
        viewer = window.Mug3DViewer.create({ THREE: window.THREE, host: cup, product, framingFill: () => .88, maxPixelRatio: 1.5, maxRenderPixels: 500000, drawTexture, drawBackTexture: (ctx, offsets) => drawTexture(ctx, offsets, true) });
        const ready = await viewer.ready;
        if (ticket !== epoch) return;
        if (!ready) throw new Error('Product mesh unavailable');
        announce('');
        const destination = cup.getBoundingClientRect();
        const flights = Array.from(cloud.children).map((node, i) => {
          const origin = node.getBoundingClientRect();
          return animate(node, [{ opacity: 1, transform: 'translate(0,0)' }, { opacity: 0, transform: `translate(${destination.left + destination.width * .45 - origin.left}px,${destination.top + destination.height * .5 - origin.top}px) scale(.2)` }], { duration: 1000, delay: i * 35, easing: 'ease-in-out', fill: 'forwards' });
        });
        flights.push(animate(cup, [{ opacity: 0, transform: 'translateY(15px) scale(.85)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 1500, easing: 'ease-out' }));
        await Promise.all(flights);
        if (ticket !== epoch) return;
        cloud.classList.add('is-product'); cancelAnimations(); cup.tabIndex = 0; productVisible = true; labelKeepsake(true);
      } catch {
        if (ticket === epoch) { destroyCup(); announce(t('Die Vorschau ist gerade nicht verfügbar. Bitte versucht es erneut.'), true); }
      } finally { if (ticket === epoch) busy(false); }
    }
    keepsake.addEventListener('click', () => { stopDemo(); return showKeepsake(); });
    let demoRunning = false, demoDone = false, demoGeneration = 0, demoVisible = false;
    const completedDemos = new Set();
    const send = form.querySelector('button');
    const pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
    function stopDemo(clear = true) {
      demoDone = true; demoGeneration++;
      if (!demoRunning) return;
      demoRunning = false; epoch++; cancelAnimations(); busy(false);
      send.classList.remove('is-demo-pressed'); keepsake.classList.remove('is-demo-pressed');
      root.classList.remove('is-typing-demo');
      if (clear) input.value = '';
      if (!productVisible) destroyCup();
    }
    async function runDemo() {
      if (demoDone || demoRunning || reduced.matches || document.hidden) return;
      demoRunning = true;
      const generation = ++demoGeneration;
      const active = () => demoRunning && generation === demoGeneration && !document.hidden;
      try {
        await pause(900);
        // The opening film can cover the section even while it intersects the viewport.
        while (active() && document.getElementById('intro-video')) await pause(350);
        if (!active()) return;
        for (const text of current().demoWords.filter(text => !collection.words(current().key).some(word => word.text === t(text)))) {
          root.classList.add('is-typing-demo');
          for (const letter of t(text)) {
            if (!active()) return;
            input.value += letter; await pause(85);
          }
          await pause(450); if (!active()) return;
          root.classList.remove('is-typing-demo'); send.classList.add('is-demo-pressed');
          await pause(220); if (!active()) return;
          send.classList.remove('is-demo-pressed'); await submitWord();
          await pause(500); if (!active()) return;
        }
        keepsake.classList.add('is-demo-pressed');
        await pause(450); if (!active()) return;
        keepsake.classList.remove('is-demo-pressed'); await showKeepsake();
        if (active()) { completedDemos.add(current().key); demoDone = true; demoRunning = false; }
      } finally {
        if (generation === demoGeneration && demoRunning) stopDemo();
      }
    }
    if (window.IntersectionObserver) {
      new window.IntersectionObserver(entries => {
        demoVisible = entries[0].isIntersecting;
        if (demoVisible) { demoDone = completedDemos.has(current().key); runDemo(); }
        else if (demoRunning) { stopDemo(); demoDone = completedDemos.has(current().key); }
      }, { threshold: .8 }).observe(find('question'));
    }
    document.addEventListener?.('visibilitychange', () => {
      if (document.hidden && demoRunning) stopDemo();
      else if (!document.hidden && demoVisible) { demoDone = completedDemos.has(current().key); runDemo(); }
    });
    function step(direction) {
      stopDemo();
      index = (index + direction + stories.length) % stories.length;
      render();
      demoDone = completedDemos.has(current().key);
      if (demoVisible) runDemo();
      announce(t(current().label) + ' · ' + (index + 1) + ' / ' + stories.length);
    }
    previous.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    panel.addEventListener('keydown', event => {
      if (event.target !== panel || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1);
    });
    let touchStart = null;
    scene.addEventListener('touchstart', event => {
      touchStart = null;
      if (event.touches.length !== 1 || event.target.closest?.('input, button, form, [data-occasion-cup]')) return;
      touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }, { passive: true });
    scene.addEventListener('touchend', event => {
      if (!touchStart) return;
      const start = touchStart; touchStart = null;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
      if (Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        root.classList.add('has-swiped'); step(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
    scene.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
    reduced.addEventListener?.('change', () => { stopDemo(); cancelAnimations(); });
    if (window.IntersectionObserver) new window.IntersectionObserver(entries => root.classList.toggle('is-paused', !entries[0].isIntersecting)).observe(root);
    window.addEventListener('pagehide', () => { stopDemo(); epoch++; cancelAnimations(); destroyCup(); busy(false); labelKeepsake(false); });
    window.addEventListener('wolkenworte:localechange', () => {
      stopDemo();
      collection = localizedCollection();
      completedDemos.clear();
      demoDone = false;
      render();
      if (demoVisible) runDemo();
    });
    previous.hidden = false; next.hidden = false; form.hidden = false; keepsake.hidden = false; render();
  }
  return { createCollection, planPrint, mount, MAX_WORDS };
});
