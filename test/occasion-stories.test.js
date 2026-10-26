'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createCollection, planPrint, MAX_WORDS } = require('../public/js/occasion-stories');
const stories = require('../src/occasionStories.json');
const { MUG_11, getProduct, getPublicProduct } = require('../src/products');

test('consecutive wishes accumulate and stay isolated between examples', () => {
  const collection = createCollection(stories);
  const first = stories[0], second = stories[1];
  collection.add(first.key, '  sonnenschein  ');
  collection.add(first.key, 'lange Gespräche');
  assert.deepEqual(collection.words(first.key).slice(-2).map(word => word.text), ['Sonnenschein', 'Lange Gespräche']);
  assert.equal(collection.words(second.key).length, second.words.length);
  const snapshot = collection.words(first.key); snapshot[0].text = 'changed';
  assert.equal(collection.words(first.key)[0].text, first.words[0]);
});

test('demo collections bound input and memory without replacing an existing wish', () => {
  const collection = createCollection(stories), key = stories[0].key;
  assert.equal(collection.add(key, '   '), null);
  const long = collection.add(key, 'a'.repeat(50));
  assert.equal(Array.from(long.text).length, 26);
  for (let i = 0; i < 100; i++) collection.add(key, 'Wunsch ' + i);
  assert.equal(collection.words(key).length, MAX_WORDS);
  assert.equal(collection.words(key)[stories[0].words.length].text, long.text);
});

test('every current word and its color fit the print area without overlap', () => {
  for (const story of stories) {
    const collection = createCollection(stories);
    for (let i = 0; i < 11; i++) collection.add(story.key, 'Lieblingsmenschen ' + i);
    const words = collection.words(story.key);
    const layout = planPrint(words, (text, size) => text.length * size * .62);
    assert.deepEqual(layout.map(item => item.text), words.map(item => item.text));
    assert.deepEqual(layout.map(item => item.color), words.map(item => item.color));
    for (const item of layout) {
      assert.ok(item.x - item.width / 2 >= -1e-6 && item.x + item.width / 2 <= 850 + 1e-6);
      assert.ok(item.y - item.height / 2 >= -1e-6 && item.y + item.height / 2 <= 850 + 1e-6);
    }
    for (let i = 0; i < layout.length; i++) for (let j = i + 1; j < layout.length; j++) {
      const a = layout[i], b = layout[j];
      assert.ok(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2);
    }
  }
});

test('all occasion photos are tracked local files and the homepage mug uses the provider GLB', () => {
  assert.equal(new Set(stories.map(story => story.key)).size, 18);
  for (const story of stories) for (const asset of [story.image, story.smallImage]) {
    assert.ok(asset.startsWith('/assets/inspiration/stories/'));
    assert.ok(fs.statSync(path.join(__dirname, '../public', asset)).size > 1000);
  }
  const product = getPublicProduct(MUG_11);
  assert.equal(product.previewMesh.id, 'mug-325');
  assert.ok(fs.existsSync(path.join(__dirname, '../public', product.previewMesh.file)));
});

function mountedDemo({ modelReady = true, reduced = false, autoplay = false, titleMetrics = false } = {}) {
  const { mount } = require('../public/js/occasion-stories');
  const animations = [], models = [], fields = new Map(), timers = [], observers = [];
  function node() {
    const listeners = new Map(), classes = new Set(), attrs = new Map();
    return { children: [], style: {}, dataset: {}, textContent: '', value: '', hidden: false,
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); }, toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
      setAttribute(key, value) { attrs.set(key, value); }, getAttribute(key) { return attrs.get(key); },
      addEventListener(key, callback) { listeners.set(key, callback); },
      fire(key, event = {}) { return listeners.get(key)?.({ preventDefault() {}, ...event }); },
      focus() { this.focused = true; }, scrollIntoView() {}, showModal() { this.open = true; }, close() { this.open = false; },
      querySelector() { return this.button ||= node(); }, appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
      getBoundingClientRect() { return { left: 10, top: 10, width: 300, height: 250 }; },
      animate() {
        let resolve, reject;
        const animation = { finished: new Promise((yes, no) => { resolve = yes; reject = no; }), complete() { resolve(); }, cancel() { reject(new Error('cancelled')); } };
        animations.push(animation); return animation;
      },
    };
  }
  const root = node();
  root.querySelector = selector => {
    const key = selector.match(/data-occasion-([^\]]+)/)[1];
    if (!fields.has(key)) fields.set(key, node());
    return fields.get(key);
  };
  const data = node(); data.textContent = JSON.stringify(stories.map(story => ({ ...story, product: getPublicProduct(getProduct(story.productKey)) })));
  const window = { document: { getElementById: id => id === 'occasion-browser' ? root : id === 'intro-video' ? null : data, createElement: node },
    matchMedia: () => ({ matches: reduced, addEventListener() {} }), addEventListener() {},
    wolkenworteThreeReady: Promise.resolve(), wolkenworteLandingMugProduct: getPublicProduct(MUG_11), PrintfulProductModel: {}, THREE: {},
    Mug3DViewer: { create(options) {
      const model = { options, ready: Promise.resolve(modelReady), destroy() { this.destroyed = true; } };
      const ctx = { measureText(text) { return { width: text.length * parseFloat(this.font.match(/[\d.]+/)[0]) * .6 }; }, fillText() {} };
      options.drawTexture(ctx); models.push(model); return model;
    } },
  };
  if (autoplay) {
    window.setTimeout = callback => { timers.push(callback); };
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(node) { this.node = node; } disconnect() {}
    };
  }
  if (titleMetrics) {
    window.getComputedStyle = () => ({ fontSize: '39px' });
    const box = root.querySelector('[data-occasion-title-box]'); box.clientWidth = 300; box.clientHeight = 96;
    const heading = root.querySelector('[data-occasion-title-heading]');
    Object.defineProperty(heading, 'scrollHeight', { get() {
      const size = parseFloat(heading.style.fontSize || 39);
      const length = (fields.get('title')?.textContent.length || 0) + (fields.get('subtitle')?.textContent.length || 0);
      return Math.ceil(length * size * .55 / box.clientWidth) * size * 1.22;
    } });
    heading.scrollWidth = 300;
  }
  mount(window);
  return { fields, root, models, window, animations, timers, observers,
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
    async finish() { for (const animation of animations) animation.complete(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('rapid submissions and an immediate cup transition retain every word on return', async () => {
  const h = mountedDemo(), input = h.fields.get('input'), form = h.fields.get('form');
  input.value = 'Sonnenschein'; const first = form.fire('submit');
  input.value = 'Küchentanz'; const second = form.fire('submit');
  const cup = h.fields.get('keepsake').fire('click');
  await h.flush(); await h.finish(); await Promise.all([first, second, cup]);
  assert.equal(h.models[0].options.product.key, stories[0].productKey);
  assert.equal(h.models[0].options.product.previewMesh.id, 'mug-325');
  assert.match(h.fields.get('cup').getAttribute('aria-label'), /Sonnenschein, Küchentanz/);
  assert.equal(h.fields.get('cloud').classList.contains('is-product'), true);
  assert.equal(h.fields.get('keepsake').getAttribute('aria-pressed'), 'true');
  assert.equal(h.fields.get('keepsake').getAttribute('aria-label'), 'Zurück zur Wortwolke');
  await h.fields.get('keepsake').fire('click');
  assert.equal(h.fields.get('keepsake').getAttribute('aria-pressed'), 'false');
  assert.ok(h.fields.get('cloud').children.every(word => word.style.visibility !== 'hidden'));
  assert.deepEqual(h.fields.get('cloud').children.slice(-2).map(word => word.textContent), ['Sonnenschein', 'Küchentanz']);
});

test('switching stories while a mesh loads fences its late result and releases its viewer', async () => {
  const h = mountedDemo(); let ready;
  h.window.Mug3DViewer.create = options => {
    const model = { options, ready: new Promise(resolve => { ready = resolve; }), destroy() { this.destroyed = true; } };
    h.models.push(model); return model;
  };
  const pending = h.fields.get('keepsake').fire('click'); await h.flush();
  h.fields.get('next').fire('click');
  ready(true); await pending;
  assert.equal(h.models[0].destroyed, true);
  assert.equal(h.root.dataset.storyKey, stories[1].key);
  assert.equal(h.fields.get('cloud').classList.contains('is-product'), false);
  assert.equal(h.fields.get('cup').hidden, true);
});

test('a failed provider model keeps the cloud and permits a retry', async () => {
  const h = mountedDemo({ modelReady: false, reduced: true });
  await h.fields.get('keepsake').fire('click');
  assert.equal(h.models[0].destroyed, true);
  assert.equal(h.fields.get('cup').hidden, true);
  assert.equal(h.fields.get('cloud').classList.contains('is-product'), false);
  assert.equal(h.fields.get('keepsake').disabled, false);
  assert.ok(h.fields.get('status').textContent.length > 0);
});

test('server-rendered examples escape JSON script terminators and retain their data', async () => {
  const ejs = require('ejs');
  const example = { ...stories[0], question: '</script><script>unexpected()</script>' };
  const html = await ejs.renderFile(path.join(__dirname, '../views/partials/occasion-stories.ejs'), { occasionStories: [example] });
  const raw = html.match(/id="occasion-stories-data">(.*?)<\/script>/s)[1];
  assert.ok(!raw.includes('</script>'));
  assert.equal(JSON.parse(raw)[0].question, example.question);
  assert.ok(html.includes('&lt;/script&gt;'));
});

test('arrows and keyboard cycle through every occasion and wrap', () => {
  const h = mountedDemo(), panel = h.fields.get('panel');
  h.fields.get('previous').fire('click');
  assert.equal(h.root.dataset.storyKey, stories.at(-1).key);
  panel.fire('keydown', { target: panel, key: 'ArrowRight' });
  assert.equal(h.root.dataset.storyKey, stories[0].key);
  for (let i = 1; i < stories.length; i++) {
    h.fields.get('next').fire('click');
    assert.equal(h.root.dataset.storyKey, stories[i].key);
    assert.equal(h.fields.get('kicker').textContent, stories[i].label);
  }
  panel.fire('keydown', { target: h.fields.get('input'), key: 'ArrowLeft' });
  assert.equal(h.root.dataset.storyKey, stories.at(-1).key);
});

test('horizontal swipes navigate while vertical scroll, controls and cancelled gestures do not', () => {
  const h = mountedDemo(), scene = h.fields.get('scene');
  const start = (x, y, interactive = false) => scene.fire('touchstart', { target: { closest: () => interactive }, touches: [{ clientX: x, clientY: y }] });
  const end = (x, y) => scene.fire('touchend', { changedTouches: [{ clientX: x, clientY: y }] });
  start(200, 100); end(100, 105);
  assert.equal(h.root.dataset.storyKey, stories[1].key);
  assert.equal(h.root.classList.contains('has-swiped'), true);
  start(200, 100); end(100, 250);
  start(200, 100, true); end(100, 100);
  start(200, 100); scene.fire('touchcancel'); end(100, 100);
  assert.equal(h.root.dataset.storyKey, stories[1].key);
  start(100, 100); end(200, 100);
  assert.equal(h.root.dataset.storyKey, stories[0].key);
});

test('cycling occasions retains added words', async () => {
  const h = mountedDemo({ reduced: true });
  h.fields.get('input').value = 'Zusammenhalt'; await h.fields.get('form').fire('submit');
  h.fields.get('next').fire('click'); h.fields.get('previous').fire('click');
  assert.equal(h.fields.get('cloud').children.at(-1).textContent, 'Zusammenhalt');
});

test('every occasion previews its distinct catalog keepsake with the complete word collection', async () => {
  assert.equal(new Set(stories.map(story => story.productKey)).size, stories.length);
  const h = mountedDemo({ reduced: true });
  for (const story of stories) {
    const product = getPublicProduct(getProduct(story.productKey));
    assert.ok(product.previewMesh || product.previewModel);
    await h.fields.get('keepsake').fire('click');
    assert.equal(h.models.at(-1).options.product.key, story.productKey);
    for (const word of story.words) assert.ok(h.fields.get('cup').getAttribute('aria-label').includes(word));
    assert.ok(h.fields.get('cup').getAttribute('aria-label').startsWith(product.name));
    h.fields.get('next').fire('click');
  }
});

test('landing loads blanket simulation before the product renderer for blanket occasions', () => {
  const landing = fs.readFileSync(path.join(__dirname, '../views/landing.ejs'), 'utf8');
  const scripts = [...landing.matchAll(/<script src="<%= asset\('([^']+)'\) %>"[^>]*>/g)].map(match => match[1]);
  for (const asset of ['/js/blanket-cloth.js', '/js/product-3d-geometry.js', '/js/mug-3d-viewer.js', '/js/occasion-stories.js']) {
    assert.ok(scripts.includes(asset));
    assert.ok(fs.existsSync(path.join(__dirname, '../public', asset)));
  }
  assert.ok(scripts.indexOf('/js/blanket-cloth.js') < scripts.indexOf('/js/product-3d-geometry.js'));
  assert.equal(getProduct(stories.find(story => story.key === 'getwell').productKey).previewModel.kind, 'blanket');
});

test('visible demo types three words, sends each to the cloud and creates the keepsake', async () => {
  const h = mountedDemo({ autoplay: true });
  h.observers.find(observer => observer.node === h.fields.get('question')).callback([{ isIntersecting: true }]);
  for (let i = 0; i < 150 && !h.models.length; i++) {
    h.timers.shift()?.(); await h.flush(); await h.finish();
  }
  await h.finish();
  assert.equal(h.models.length, 1);
  assert.deepEqual(h.fields.get('cloud').children.slice(-3).map(word => word.textContent), stories[0].demoWords);
  assert.equal(h.fields.get('keepsake').getAttribute('aria-pressed'), 'true');
  assert.equal(h.fields.get('input').value, '');
});

test('navigation stops demo typing without adding a partial word', async () => {
  const h = mountedDemo({ autoplay: true });
  h.observers.find(observer => observer.node === h.fields.get('question')).callback([{ isIntersecting: true }]);
  h.timers.shift()(); await h.flush();
  assert.equal(h.fields.get('input').value, stories[0].demoWords[0][0]);
  h.observers.find(observer => observer.node === h.fields.get('question')).callback([{ isIntersecting: false }]);

  while (h.timers.length) { h.timers.shift()(); await h.flush(); }
  assert.equal(h.fields.get('input').value, '');
  assert.equal(h.models.length, 0);
  assert.equal(h.fields.get('cloud').children.length, stories[0].words.length);
});

test('quote fitting shrinks long titles into their fixed box and restores size for short titles', () => {
  const h = mountedDemo({ titleMetrics: true });
  const heading = h.fields.get('title-heading'), box = h.fields.get('title-box');
  let shrunk = false;
  for (let i = 0; i < stories.length; i++) {
    assert.ok(heading.scrollHeight <= box.clientHeight);
    if (parseFloat(heading.style.fontSize || 39) < 39) shrunk = true;
    h.fields.get('next').fire('click');
  }
  assert.equal(shrunk, true);
  for (let i = 0; i < stories.findIndex(story => story.key === 'birthday'); i++) h.fields.get('next').fire('click');
  assert.equal(heading.style.fontSize, '');
});

test('occasion typing retains an inert readonly input without a keyboard or form', async () => {
  const html = await require('ejs').renderFile(path.join(__dirname, '../views/partials/occasion-stories.ejs'), { occasionStories: stories });
  assert.ok(!/<(?:textarea|form)\b/.test(html));
  assert.match(html, /type="text" readonly tabindex="-1" inputmode="none"/);
  assert.match(html, /class="occasion-composer" aria-hidden="true" inert/);
  assert.match(html, /class="occasion-demo-input" data-occasion-input/);
});

test('demo starts for the next occasion and resumes after scrolling back without duplicate words', async () => {
  const h = mountedDemo({ autoplay: true });
  const observer = h.observers.find(observer => observer.node === h.fields.get('question'));
  observer.callback([{ isIntersecting: true }]);
  h.timers.shift()(); await h.flush();
  observer.callback([{ isIntersecting: false }]);
  while (h.timers.length) { h.timers.shift()(); await h.flush(); }
  h.fields.get('next').fire('click');
  observer.callback([{ isIntersecting: true }]);
  for (let i = 0; i < 180 && !h.models.length; i++) { h.timers.shift()?.(); await h.flush(); await h.finish(); }
  await h.finish();
  assert.deepEqual(h.fields.get('cloud').children.slice(-3).map(word => word.textContent), stories[1].demoWords);
  assert.equal(h.models.length, 1);
  h.fields.get('next').fire('click');
  for (let i = 0; i < 180 && h.models.length < 2; i++) { h.timers.shift()?.(); await h.flush(); await h.finish(); }
  await h.finish();
  assert.deepEqual(h.fields.get('cloud').children.slice(-3).map(word => word.textContent), stories[2].demoWords);
  assert.equal(h.models.length, 2);
});
