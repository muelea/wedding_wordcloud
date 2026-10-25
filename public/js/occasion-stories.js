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

  // The same complete collection is painted into both approved mug print areas.
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
    const collection = createCollection(stories);
    const find = name => root.querySelector('[data-occasion-' + name + ']');
    const scene = find('scene'), photo = find('photo'), cloud = find('cloud');
    const tabs = Array.from(root.querySelectorAll('[data-occasion-tab]'));
    const choices = Array.from(root.querySelectorAll('[data-occasion-choice]'));
    const extraTab = find('extra-tab'), gallery = find('gallery'), allButton = find('all');
    const featuredKeys = tabs.filter(tab => tab !== extraTab).map(tab => tab.dataset.occasionTab);
    const cup = find('cup'), form = find('form'), input = find('input'), replay = find('replay');
    const keepsake = find('keepsake'), status = find('status'), flight = find('flight');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const animations = new Set();
    let index = 0, epoch = 0, viewer = null, productVisible = false;
    const t = text => window.WolkenworteI18n ? window.WolkenworteI18n.t(text) : text;
    const current = () => stories[index];
    function announce(text, visible = false) { status.textContent = text; status.classList.toggle('occasion-sr-only', !visible); }
    function busy(value) { form.querySelector('button').disabled = value; input.disabled = value; replay.disabled = value; keepsake.disabled = value; }
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
      span.setAttribute('data-occasion-word', ''); return span;
    }
    function render() {
      epoch++; cancelAnimations(); destroyCup(); busy(false); announce('');
      const story = current(); root.dataset.storyKey = story.key;
      extraTab.hidden = featuredKeys.includes(story.key); extraTab.dataset.occasionTab = story.key; extraTab.textContent = t(story.label);
      for (const tab of tabs) {
        const active = !tab.hidden && tab.dataset.occasionTab === story.key;
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
        if (active) find('panel').setAttribute('aria-labelledby', tab.id);
      }
      for (const choice of choices) choice.setAttribute('aria-current', String(choice.dataset.occasionChoice === story.key));
      for (const name of ['kicker', 'question', 'bridge', 'quote', 'names']) find(name).textContent = t(story[name]);
      find('title').textContent = t(story.titleLines[0]); find('subtitle').textContent = t(story.titleLines[1]);
      photo.style.objectPosition = story.imagePosition || 'center 40%';
      photo.srcset = story.smallImage + ' 640w, ' + story.image + ' 1200w'; photo.src = story.image; photo.alt = t(story.alt);
      input.value = ''; input.placeholder = t(story.placeholder);
      cloud.replaceChildren(...collection.words(story.key).map(makeWord));
      keepsake.textContent = t('Erinnerungsstück gestalten');
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
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!input.value.trim()) { announce(t('Bitte gebt ein Wort ein.'), true); return; }
      const ticket = ++epoch; cancelAnimations();
      Array.from(cloud.children).forEach(node => { node.style.visibility = ''; });
      if (productVisible) destroyCup();
      keepsake.textContent = t('Erinnerungsstück gestalten');
      const word = collection.add(current().key, input.value);
      if (!word) { announce(t('Probiert ein anderes Beispiel aus – diese Wolke ist schon gut gefüllt.'), true); return; }
      const span = makeWord(word), origin = input.getBoundingClientRect(); cloud.appendChild(span); input.value = '';
      span.style.visibility = 'hidden';
      // A later submission must never erase or strand an earlier arrival.
      Array.from(cloud.children).forEach(node => { if (node !== span) node.style.visibility = ''; });
      await fly(word.text, word.color, origin, span.getBoundingClientRect(), ticket);
      if (ticket === epoch) { span.style.visibility = ''; announce(t('Wort hinzugefügt') + ': ' + word.text); }
    });
    replay.addEventListener('click', async () => {
      const ticket = ++epoch; cancelAnimations(); destroyCup(); keepsake.textContent = t('Erinnerungsstück gestalten'); busy(true);
      const words = collection.words(current().key);
      for (let i = 0; i < Math.min(3, words.length); i++) {
        if (ticket !== epoch) return;
        const target = cloud.children[i];
        await fly(words[i].text, words[i].color, input.getBoundingClientRect(), target.getBoundingClientRect(), ticket);
      }
      if (ticket === epoch) busy(false);
    });
    function drawTexture(ctx) {
      const words = collection.words(current().key);
      const layout = planPrint(words, (text, size) => {
        ctx.font = 'italic ' + size + 'px Georgia'; const metrics = ctx.measureText(text);
        return Math.max(metrics.width, (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0));
      });
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const left of [162, 1687]) for (const word of layout) {
        ctx.font = 'italic ' + word.size + 'px Georgia'; ctx.fillStyle = word.color; ctx.fillText(word.text, left + word.x, 100 + word.y);
      }
      cup.setAttribute('aria-label', t('Tasse mit euren Worten') + ': ' + words.map(word => word.text).join(', '));
    }
    keepsake.addEventListener('click', async () => {
      const ticket = ++epoch; cancelAnimations();
      if (productVisible) { destroyCup(); keepsake.textContent = t('Erinnerungsstück gestalten'); return; }
      busy(true); announce(t('Vorschau wird geladen…'), true); cup.hidden = false;
      try {
        await window.wolkenworteThreeReady;
        if (ticket !== epoch) return;
        const product = window.wolkenworteLandingMugProduct;
        if (!product?.previewMesh || !window.PrintfulProductModel) throw new Error('Product mesh missing');
        viewer = window.Mug3DViewer.create({ THREE: window.THREE, host: cup, product, framingFill: () => .88, maxPixelRatio: 1.5, maxRenderPixels: 500000, drawTexture });
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
        cloud.classList.add('is-product'); cancelAnimations(); cup.tabIndex = 0; productVisible = true; keepsake.textContent = t('Zurück zur Wortwolke');
      } catch {
        if (ticket === epoch) { destroyCup(); announce(t('Die Vorschau ist gerade nicht verfügbar. Bitte versucht es erneut.'), true); }
      } finally { if (ticket === epoch) busy(false); }
    });
    function chooseStory(key, focus = true) {
      const next = stories.findIndex(story => story.key === key);
      if (next < 0) return;
      if (next !== index) { index = next; render(); }
      if (focus) {
        const active = tabs.find(tab => !tab.hidden && tab.dataset.occasionTab === key);
        active?.focus({ preventScroll: true });
        active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
    for (const tab of tabs) {
      tab.addEventListener('click', () => chooseStory(tab.dataset.occasionTab, false));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const visible = tabs.filter(button => !button.hidden);
        const position = visible.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
          : (position + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
        chooseStory(visible[next].dataset.occasionTab);
      });
    }
    allButton.addEventListener('click', () => {
      gallery.showModal();
      find('gallery-grid').scrollTop = 0;
      find('close').focus({ preventScroll: true });
    });
    find('close').addEventListener('click', () => gallery.close());
    gallery.addEventListener('click', event => {
      if (event.target !== gallery) return;
      const rect = gallery.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.left + rect.width || event.clientY < rect.top || event.clientY > rect.top + rect.height) gallery.close();
    });
    for (const choice of choices) choice.addEventListener('click', () => {
      gallery.close(); chooseStory(choice.dataset.occasionChoice);
    });
    reduced.addEventListener?.('change', cancelAnimations);
    if (window.IntersectionObserver) new window.IntersectionObserver(entries => root.classList.toggle('is-paused', !entries[0].isIntersecting)).observe(root);
    window.addEventListener('pagehide', () => { epoch++; cancelAnimations(); destroyCup(); busy(false); keepsake.textContent = t('Erinnerungsstück gestalten'); });
    find('picker').hidden = false; form.hidden = false; find('actions').hidden = false; render();
  }
  return { createCollection, planPrint, mount, MAX_WORDS };
});
