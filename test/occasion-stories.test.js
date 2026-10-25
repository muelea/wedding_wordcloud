'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createCollection, planPrint, MAX_WORDS } = require('../public/js/occasion-stories');
const stories = require('../src/occasionStories.json');
const { MUG_11, getPublicProduct } = require('../src/products');

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

function mountedDemo({ modelReady = true, reduced = false } = {}) {
  const { mount } = require('../public/js/occasion-stories');
  const animations = [], models = [], fields = new Map();
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
  const tabs = ['wedding', 'birthday', 'besties', 'family', 'farewell'].map(key => {
    const tab = node(); tab.dataset.occasionTab = key; tab.id = 'occasion-tab-' + key; return tab;
  });
  const extra = node(); extra.hidden = true; extra.id = 'occasion-tab-extra'; extra.dataset.occasionTab = ''; fields.set('extra-tab', extra); tabs.push(extra);
  const choices = stories.map(story => { const choice = node(); choice.dataset.occasionChoice = story.key; return choice; });
  root.querySelectorAll = selector => selector === '[data-occasion-tab]' ? tabs : selector === '[data-occasion-choice]' ? choices : [];
  const data = node(); data.textContent = JSON.stringify(stories);
  const window = { document: { getElementById: id => id === 'occasion-browser' ? root : data, createElement: node },
    matchMedia: () => ({ matches: reduced, addEventListener() {} }), addEventListener() {},
    wolkenworteThreeReady: Promise.resolve(), wolkenworteLandingMugProduct: getPublicProduct(MUG_11), PrintfulProductModel: {}, THREE: {},
    Mug3DViewer: { create(options) {
      const model = { options, ready: Promise.resolve(modelReady), destroy() { this.destroyed = true; } };
      const ctx = { measureText(text) { return { width: text.length * parseFloat(this.font.match(/[\d.]+/)[0]) * .6 }; }, fillText() {} };
      options.drawTexture(ctx); models.push(model); return model;
    } },
  };
  mount(window);
  return { fields, root, models, window, animations, tabs, choices,
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
  assert.equal(h.models[0].options.product, h.window.wolkenworteLandingMugProduct);
  assert.equal(h.models[0].options.product.previewMesh.id, 'mug-325');
  assert.match(h.fields.get('cup').getAttribute('aria-label'), /Sonnenschein, Küchentanz/);
  assert.equal(h.fields.get('cloud').classList.contains('is-product'), true);
  await h.fields.get('keepsake').fire('click');
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
  h.tabs.find(tab => tab.dataset.occasionTab === stories[1].key).fire('click');
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

test('occasion tabs support arrow, Home and End navigation with one keyboard stop', () => {
  const h = mountedDemo();
  h.tabs[0].fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.root.dataset.storyKey, 'birthday');
  assert.equal(h.tabs.filter(tab => tab.tabIndex === 0).length, 1);
  assert.equal(h.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(h.tabs[1].focused, true);
  h.tabs[1].fire('keydown', { key: 'End' });
  assert.equal(h.root.dataset.storyKey, 'farewell');
  h.tabs[4].fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.root.dataset.storyKey, 'wedding');
  h.tabs[0].fire('keydown', { key: 'End' }); h.tabs[4].fire('keydown', { key: 'Home' });
  assert.equal(h.root.dataset.storyKey, 'wedding');
});

test('photo gallery selects a non-featured occasion and exposes its active tab', () => {
  const h = mountedDemo();
  h.fields.get('all').fire('click');
  assert.equal(h.fields.get('gallery').open, true);
  assert.equal(h.fields.get('close').focused, true);
  assert.equal(h.fields.get('gallery-grid').scrollTop, 0);
  h.choices.find(choice => choice.dataset.occasionChoice === 'baby').fire('click');
  assert.equal(h.fields.get('gallery').open, false);
  assert.equal(h.root.dataset.storyKey, 'baby');
  const extra = h.fields.get('extra-tab');
  assert.equal(extra.hidden, false);
  assert.equal(extra.getAttribute('aria-selected'), 'true');
  assert.equal(extra.focused, true);
  assert.equal(h.fields.get('panel').getAttribute('aria-labelledby'), extra.id);
  h.tabs[0].fire('click');
  assert.equal(extra.hidden, true);
});

test('closing the picker keeps the story, and gallery navigation retains added words', async () => {
  const h = mountedDemo({ reduced: true });
  h.fields.get('input').value = 'Zusammenhalt'; await h.fields.get('form').fire('submit');
  h.fields.get('all').fire('click'); h.fields.get('close').fire('click');
  assert.equal(h.root.dataset.storyKey, 'wedding');
  assert.equal(h.fields.get('gallery').open, false);
  h.fields.get('all').fire('click');
  h.choices.find(choice => choice.dataset.occasionChoice === 'baby').fire('click');
  h.tabs[0].fire('click');
  assert.equal(h.fields.get('cloud').children.at(-1).textContent, 'Zusammenhalt');
});
