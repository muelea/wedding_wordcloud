'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { createCanvas } = require('canvas');
const ImageData = require('../public/js/design-image-data');
function photo(color = '#123456', mime = 'image/png') {
  const canvas = createCanvas(32, 24);
  canvas.getContext('2d').fillStyle = color;
  canvas.getContext('2d').fillRect(0, 0, 32, 24);
  return { type: 'image', src: canvas.toDataURL(mime) };
}
function fixture(t) {
  const dom = new JSDOM('<html lang="de"><div class="editor-add-controls"><span data-image-usage></span><p data-image-feedback hidden></p></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const root = dom.window, element = root.document.querySelector('.editor-add-controls');
  root.DesignImageData = ImageData;
  root.eval(fs.readFileSync(require.resolve('../public/js/design-image-usage'), 'utf8'));
  let designs = [];
  const controller = root.DesignImageUsage.create({ element, getDesigns: () => designs });
  return { root, controller, element, setDesigns(value) { designs = value; },
    counter: element.querySelector('[data-image-usage]'), feedback: element.querySelector('[data-image-feedback]') };
}
test('image usage counts optimized source bytes once across sides and retained artwork', () => {
  const png = photo(), jpeg = photo('#abcdef', 'image/jpeg');
  const design = [{ front: [png, png, { type: 'text', text: 'Bild' }], back: [jpeg, png] },
    { surfaces: [{ design: [png, jpeg] }], layouts: [{ type: 'image', id: 'geometry-only' }] }];
  const expectedBytes = [png, jpeg].reduce((n, item) => n + Buffer.from(item.src.split(',')[1], 'base64').length, 0);
  const cache = new Map();
  assert.deepEqual(ImageData.usage(design, cache), { count: 2, bytes: expectedBytes, pixels: 1536 });
  assert.equal(cache.size, 2);
  assert.deepEqual(ImageData.usage({ back: [png] }, cache), { count: 1, bytes: Buffer.from(png.src.split(',')[1], 'base64').length, pixels: 768 });
  assert.equal(cache.size, 1, 'old source strings are released when removed');
  assert.deepEqual(ImageData.usage([], cache), { count: 0, bytes: 0, pixels: 0 });
  assert.equal(cache.size, 0);
});
test('the subtle counter updates after restore, side changes, removal and Undo', t => {
  const h = fixture(t), png = photo(), jpeg = photo('#abcdef', 'image/jpeg');
  h.controller.update(); assert.match(h.counter.textContent, /^0\/20/);
  h.setDesigns({ front: [png], back: [jpeg, png] });
  assert.equal(h.controller.update().count, 2); assert.match(h.counter.textContent, /^2\/20/);
  h.setDesigns({ back: [jpeg, png], front: [png] });
  assert.equal(h.controller.update().count, 2);
  h.setDesigns({ front: [], back: [jpeg] });
  assert.equal(h.controller.update().count, 1);
  h.setDesigns({ front: [png], back: [jpeg] });
  assert.equal(h.controller.update().count, 2);
});
test('actionable image errors stay visible through time and unrelated edits, and clear on an image change', t => {
  const h = fixture(t), png = photo();
  h.setDesigns([png]); h.controller.update();
  const timers = []; h.root.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.controller.showError(ImageData.MESSAGES.images);
  for (const callback of timers) callback();
  assert.equal(h.feedback.hidden, false, 'upload errors do not disappear on a short timer');
  h.setDesigns([png, { type: 'text', text: 'Liebe' }]); h.controller.update();
  assert.equal(h.feedback.hidden, false);
  h.root.dispatchEvent(new h.root.Event('wolkenworte:localechange'));
  assert.equal(h.feedback.hidden, false);
  h.setDesigns([photo('#ff0000')]); h.controller.update();
  assert.equal(h.feedback.hidden, true, 'even same-size source replacements are a new relevant action');
  h.controller.showError('Upload fehlgeschlagen');
  h.controller.clearError();
  assert.equal(h.feedback.hidden, true);
  assert.equal(h.feedback.textContent, '');
});
test('usage formatting follows the selected language without mutating the design', t => {
  const h = fixture(t), design = [photo()];
  h.setDesigns(design); const before = JSON.stringify(design);
  const messages = [];
  h.root.WolkenworteI18n = { getLocale: () => 'en', setText: (node, source, params = {}) => {
    messages.push(source); node.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
  } };
  h.root.dispatchEvent(new h.root.Event('wolkenworte:localechange'));
  assert.ok(messages.some(source => source.includes('{{size}}')));
  assert.equal(JSON.stringify(design), before);
});
test('editor change delivery refreshes usage after publishing the current print side, including a flush', t => {
  const h = fixture(t); let callback, current = [photo()], delivered = [];
  h.root.requestAnimationFrame = fn => { callback = fn; return 1; };
  h.root.cancelAnimationFrame = () => {};
  h.root.eval(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'));
  const editor = Object.create(h.root.MugPrintEditor.prototype);
  editor.getDesign = () => current;
  editor.onChange = items => { delivered = items; h.setDesigns({ front: items, back: [] }); };
  editor.imageUsage = h.controller;
  editor.emitChange(); callback();
  assert.match(h.counter.textContent, /^1\/20/);
  assert.equal(delivered[0].src, current[0].src);
  current = []; editor.emitChange(); editor.flushPendingChange();
  assert.match(h.counter.textContent, /^0\/20/);
  assert.equal(delivered.length, 0);
});
test('every supported language contains the image and account limit explanations', () => {
  const keys = ['{{count}}/20 Bilder · {{size}}/10 MB', 'Bildlimits anzeigen', 'Bilder & Limits',
    'JPG oder PNG · bis 15 MB und 40 Megapixel pro Originaldatei.',
    'Bilder werden beim Hinzufügen automatisch optimiert.',
    'Pro Design: bis zu 20 verschiedene Bilder, zusammen 10 MB nach Optimierung und 64 Megapixel.',
    'Die Grenzen gelten für das gesamte Design über alle Druckseiten. Mehrfach verwendete Bilder zählen einmal.',
    '20 Designs · 100 MB insgesamt · 20 MB pro Design inklusive Vorschau', ImageData.MESSAGES.pixels];
  for (const locale of ['en', 'fr', 'es', 'it', 'tr']) {
    const catalog = require(`../public/locales/${locale}.json`);
    for (const key of keys) assert.ok(catalog[key], `${locale}: ${key}`);
  }
});
