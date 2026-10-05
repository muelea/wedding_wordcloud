'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('canvas');
require('../src/designFonts');
const Core = require('../public/js/wordcloud-core');
const Preview = require('../public/js/hero-cloud-preview');
const Transition = require('../public/js/live-cloud-transition');
const QRCode = require('qrcode');
const { normalizeWord } = require('../src/words');
const { DEFAULT_PRODUCT } = require('../src/products');

const ROOT = path.join(__dirname, '..');
const LOCALES = ['de', 'en', 'fr', 'it', 'es', 'tr'];
const demo = locale => require(`../public/assets/hero-clouds/${locale}.json`);

test('public demos match the normalized wedding seeds and shared default palette without PIN metadata', () => {
  for (const locale of LOCALES) {
    const seed = require(`../marketing/clouds/classic-wedding${locale === 'de' ? '' : '-' + locale}.json`);
    const expected = new Map();
    for (const item of seed.words) {
      const word = normalizeWord(item.word, locale);
      expected.set(word, (expected.get(word) || 0) + item.count);
    }
    assert.deepEqual(demo(locale), { title: seed.event.title, words: [...expected],
      palette: { colors: DEFAULT_PRODUCT.themes[0].colors, background: DEFAULT_PRODUCT.themes[0].background } });
    const fallback = fs.readFileSync(path.join(ROOT, `public/assets/hero-clouds/${locale}.png`));
    assert.equal(fallback.subarray(1, 4).toString(), 'PNG');
    assert.equal(fallback.readUInt32BE(16), 800);
    assert.equal(fallback.readUInt32BE(20), 860);
    const sequence = Preview.arrivalOrder(demo(locale).words, Core.isEmojiOnly);
    assert.deepEqual(new Map(sequence), expected);
    assert.ok(Core.isEmojiOnly(sequence[3][0]), 'emoji arrive early rather than only at the end');
  }
});

test('the hero QR artwork encodes the public homepage with a four-module quiet zone', async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'public/assets/hero-clouds/home-qr.svg'), 'utf8');
  assert.equal(svg, await QRCode.toString('https://wolkenworte.io', {
    type: 'svg', margin: 4, color: { dark: '#5a3e36', light: '#ffffff' },
  }));
});

test('the real engine packs progressive demo snapshots into a portrait area without drops or overlap', () => {
  const ctx = createCanvas(1, 1).getContext('2d');
  for (const locale of ['de', 'en', 'tr']) {
    const data = demo(locale);
    const sequence = Preview.arrivalOrder(data.words, Core.isEmojiOnly);
    for (const count of [8, 9, sequence.length]) {
      const words = sequence.slice(0, count);
      const width = 320, height = 360;
      const placed = Core.layoutWordsInArea(words, width, height, ctx, Core.makePaletteAssigner(data.palette.colors));
      assert.deepEqual(new Set(placed.map(item => item.word)), new Set(words.map(([word]) => word)));
      assert.equal(placed.length, count);
      for (const [index, item] of placed.entries()) {
        assert.ok(item.x1 >= 0 && item.y1 >= 0 && item.x2 <= width && item.y2 <= height, locale);
        for (const other of placed.slice(index + 1)) {
          assert.ok(item.x2 <= other.x1 || item.x1 >= other.x2 || item.y2 <= other.y1 || item.y1 >= other.y2,
            `${locale}: ${item.word} overlaps ${other.word}`);
        }
      }
    }
  }
});

function target() {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: false, dataset: {}, style: { setProperty() {} }, children: [],
    replaceChildren(...children) { this.children = children; },
    classList: { add: key => classes.add(key), remove: key => classes.delete(key),
      contains: key => classes.has(key), toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    fire: (name, event = {}) => listeners.get(name)?.(event),
    getAttribute: name => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

function harness({ reduced = false, intro = false, fetcher } = {}) {
  let id = 0, time = 0;
  const timers = new Map(), frames = new Map(), jobs = [], workers = [];
  const observers = {};
  const window = target(), document = target(), element = target();
  const toggle = target(), canvas = target(), fallback = target(), title = target(), stage = target();
  const screen = target(), motion = target();
  const highlights = target();
  let rect = { width: 340, height: 380 };
  stage.getBoundingClientRect = () => rect;
  const ctx = { clearRect() {}, save() {}, restore() {}, translate() {}, scale() {}, setTransform() {} };
  canvas.getContext = () => ctx;
  document.documentElement = target();
  if (intro) document.documentElement.classList.add('intro-fade');
  document.fonts = { load: async () => [] };
  document.createElement = () => target();
  window.document = document;
  window.devicePixelRatio = 2;
  window.performance = { now: () => time };
  window.AbortController = AbortController;
  window.fetch = fetcher || (async url => ({ ok: true, json: async () => demo(url) }));
  motion.matches = reduced;
  window.matchMedia = () => motion;
  window.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id; };
  window.clearTimeout = key => timers.delete(key);
  window.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  window.cancelAnimationFrame = key => frames.delete(key);
  for (const [name, key] of [['IntersectionObserver', 'visibility'], ['ResizeObserver', 'resize'], ['MutationObserver', 'intro']]) {
    window[name] = class {
      constructor(callback) { observers[key] = callback; }
      observe() {}
      disconnect() { delete observers[key]; }
    };
  }
  window.WolkenworteI18n = { getLocale: () => 'en', setAttribute: (node, name, value) => node.setAttribute(name, value) };
  element.dataset = { workerUrl: '/worker', coreUrl: '/core' };
  for (const locale of LOCALES) {
    element.setAttribute('data-cloud-' + locale, locale);
    element.setAttribute('data-fallback-' + locale, locale + '.png');
  }
  element.querySelector = selector => ({ canvas, '[data-preview-stage]': stage, '[data-preview-screen]': screen,
    '[data-preview-title]': title, '[data-preview-fallback]': fallback, '[data-preview-toggle]': toggle,
    '[data-preview-highlights]': highlights }[selector]);
  const core = { isEmojiOnly: Core.isEmojiOnly, makePaletteAssigner: Core.makePaletteAssigner,
    measureWords: words => words.map(([word]) => ({ word, x: 0, y: 0, x1: 0, y1: 0, x2: 40, y2: 20, fontPx: 20 })),
    spreadPaletteColors: words => words, drawPlacedWord() {} };
  const layout = { create(options) {
    let generation = 0, disposed = false;
    const worker = { dispose() { disposed = true; }, clear() { generation++; }, request(boxes, width, height) {
      const current = generation;
      jobs.push({ boxes, width, height, finish() {
        if (current === generation && !disposed) options.onLayout(boxes, { width, height });
      } });
    }, fail: options.onError };
    workers.push(worker);
    return worker;
  } };
  const api = Preview.create(element, { window, core, layout, transition: Transition,
    emoji: { preloadTexts: async () => {}, getLoadedImage() {} } });
  return { api, window, document, element, toggle, canvas, fallback, title, motion, observers, jobs, workers, timers, frames, highlights,
    resize(value) { rect = value; observers.resize(); },
    visible(on) { observers.visibility([{ isIntersecting: on }]); },
    finish() { jobs.at(-1).finish(); },
    frame(delta = 1000) { time += delta; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(item => item.callback()); },
  };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('words arrive singly, pause freezes the demo, and hidden/offscreen/intro states stop the clock', async () => {
  const h = harness({ intro: true });
  await flush();
  h.visible(true); h.finish();
  assert.equal(h.element.dataset.previewWordCount, '8');
  assert.equal(h.timers.size, 0, 'do not run through the cloud behind the intro');
  h.document.documentElement.classList.remove('intro-fade'); h.observers.intro();
  h.tick(); h.finish(); h.frame();
  assert.equal(h.element.dataset.previewWordCount, '9');
  h.toggle.fire('click');
  assert.equal(h.timers.size, 0);
  assert.equal(h.toggle.getAttribute('aria-label'), 'Vorschau abspielen');
  h.tick();
  assert.equal(h.element.dataset.previewWordCount, '9');
  h.toggle.fire('click');
  assert.equal(h.timers.size, 1);
  h.visible(false); assert.equal(h.timers.size, 0);
  h.visible(true); assert.equal(h.timers.size, 1);
  h.document.hidden = true; h.document.fire('visibilitychange');
  assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.document.fire('visibilitychange');
  h.tick(); h.finish(); h.frame();
  assert.equal(h.element.dataset.previewWordCount, '10');
  h.api.dispose();
  assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
});

test('hero arrivals use the live fade, swap invisibly, and highlight only the newly revealed word', async () => {
  const h = harness();
  await flush(); h.visible(true); h.finish();
  assert.equal(h.highlights.children.length, 0, 'existing seed words are not highlighted');
  h.tick(); h.finish();
  h.frame(60);
  assert.equal(h.element.dataset.previewWordCount, '8', 'retain the old layout until fade-out completes');
  assert.ok(Number(h.canvas.style.opacity) > 0 && Number(h.canvas.style.opacity) < 1);
  h.frame(60);
  assert.equal(h.element.dataset.previewWordCount, '9');
  assert.equal(h.canvas.style.opacity, '0');
  assert.equal(h.highlights.children.length, 0);
  h.frame(180);
  assert.equal(h.canvas.style.opacity, '1');
  assert.equal(h.highlights.children.length, 1);
  assert.equal(h.frames.size, 0);
  h.toggle.fire('click');
  assert.equal(h.highlights.children.length, 0, 'pause clears the glow as well as the arrival clock');
  assert.equal(h.timers.size, 0);
  h.api.dispose();
});

test('reduced motion renders the complete cloud and responds to changes without an animation', async () => {
  const h = harness({ reduced: true });
  await flush(); h.visible(true); h.finish();
  assert.equal(h.jobs.at(-1).boxes.length, demo('en').words.length);
  assert.equal(h.toggle.hidden, true);
  assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  h.motion.matches = false; h.motion.fire('change');
  assert.equal(h.toggle.hidden, false);
  assert.equal([...h.timers.values()][0].delay, 5500);
  h.tick(); h.finish(); h.frame();
  assert.equal(h.element.dataset.previewWordCount, '8', 'replay begins a new growing cloud');
  h.motion.matches = true; h.motion.fire('change'); h.finish();
  assert.equal(h.element.dataset.previewWordCount, String(demo('en').words.length));
  assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  h.api.dispose();
});

test('rapid language switches discard late assets and late worker results', async () => {
  const pending = new Map();
  const h = harness({ fetcher: url => new Promise(resolve => pending.set(url, resolve)) });
  h.window.fire('wolkenworte:localechange', { detail: { locale: 'de' } });
  pending.get('de')({ ok: true, json: async () => demo('de') });
  await flush(); h.finish();
  assert.ok(h.jobs.at(-1).boxes.some(item => item.word === 'Liebe'));
  pending.get('en')({ ok: true, json: async () => demo('en') });
  await flush();
  assert.equal(h.fallback.src, 'de.png');
  assert.equal(h.jobs.length, 1, 'late English response never requests a layout');
  h.window.fire('wolkenworte:localechange', { detail: { locale: 'tr' } });
  pending.get('tr')({ ok: true, json: async () => demo('tr') });
  await flush();
  const count = h.element.dataset.previewWordCount;
  h.jobs[0].finish();
  assert.equal(h.element.dataset.previewWordCount, count, 'an old layout cannot replace the new language');
  h.finish();
  assert.ok(h.jobs.at(-1).boxes.some(item => item.word === demo('tr').words[0][0]));
  h.api.dispose();
});

test('resize uses the actual portrait bounds and history restoration recreates the worker', async () => {
  const h = harness();
  await flush(); h.visible(true); h.finish(); h.frame();
  assert.equal(h.canvas.width, 640);
  h.resize({ width: 290, height: 300 });
  h.jobs[0].finish(); h.finish();
  h.frame(120); h.frame(180);
  assert.equal(h.canvas.width, 540);
  assert.equal(h.canvas.height, 560);
  assert.equal(h.jobs.at(-1).width, 270);
  h.window.fire('pagehide');
  assert.equal(h.timers.size, 0);
  h.window.fire('pageshow'); h.finish();
  assert.equal(h.workers.length, 2);
  h.workers.at(-1).fail();
  assert.equal(h.element.classList.contains('is-ready'), false, 'failed layouts reveal the static fallback');
  assert.equal(h.toggle.hidden, true);
  h.visible(false); h.visible(true);
  assert.equal(h.timers.size, 0, 'a failed preview must not keep advancing behind the fallback');
  h.resize({ width: 300, height: 320 }); h.finish();
  assert.equal(h.toggle.hidden, false, 'a recovered layout restores its pause control');
  h.api.dispose();
});

test('unavailable demo data preserves a useful localized fallback', async () => {
  const h = harness({ fetcher: async () => ({ ok: false }) });
  await flush(); h.visible(true);
  assert.equal(h.fallback.src, 'en.png');
  assert.equal(h.element.classList.contains('is-ready'), false);
  assert.equal(h.toggle.hidden, true);
  assert.equal(h.jobs.length, 0);
  assert.equal(h.timers.size, 0);
  h.api.dispose();
});
