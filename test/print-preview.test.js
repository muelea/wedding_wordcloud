'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const Preview = require('../public/js/print-preview');

function harness(t, mockups) {
  const markup = fs.readFileSync(require.resolve('../views/partials/print-preview.ejs'), 'utf8');
  const dom = new JSDOM(`<form><input name="city" value="Berlin"><input name="quantity" value="3"><button type="button" id="opener">View design</button></form>${markup}`,
    { url: 'https://example.test/shipping' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const dialog = window.document.querySelector('dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  const viewport = dialog.querySelector('[data-preview-viewport]');
  Object.defineProperties(viewport, { clientWidth: { value: 648, configurable: true }, clientHeight: { value: 348, configurable: true } });
  Object.defineProperty(dialog, 'offsetHeight', { get: () => viewport.clientHeight + 68 });
  const api = Preview.create(dialog, { window, mockups, i18n: {
    t: source => source,
    setText: (node, source, params = {}) => { node.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key]); },
  } });
  const opener = window.document.getElementById('opener');
  const configuration = (id = 'saved') => ({
    product: { displayName: 'Kissen', printFile: { width: 2400, height: 1200 }, printSurfaces: [
      { key: 'front', label: 'Vorderseite' }, { key: 'back', label: 'Rückseite' },
    ] },
    printPreviewUrls: { front: `/${id}/print.png?surface=front`, back: `/${id}/print.png?surface=back` },
  });
  const query = selector => dialog.querySelector(selector);
  const image = () => query('[data-preview-artwork] img');
  function load(target = image(), { width = 2400, height = 1200 } = {}) {
    Object.defineProperties(target, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    target.dispatchEvent(new window.Event('load'));
  }
  return { api, dialog, window, opener, viewport, configuration, query, image, load };
}

test('wide print previews fit their exact proportions without adding top or bottom viewer space', t => {
  const h = harness(t);
  assert.equal(h.image(), null, 'no full-resolution image is requested before opening');
  h.api.open(h.configuration(), h.opener);
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=front');
  assert.equal(h.viewport.getAttribute('aria-busy'), 'true');
  assert.equal(h.viewport.style.height, '324px', 'saved print dimensions size the loading view');
  h.load();
  assert.equal(h.image().style.width, '648px');
  assert.equal(h.image().style.height, '324px');
  assert.equal(h.viewport.style.height, h.image().style.height);
  assert.equal(h.query('[data-preview-feedback]').hidden, true);
  Object.defineProperty(h.viewport, 'clientWidth', { value: 348 });
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(h.image().style.width, '348px');
  assert.equal(h.image().style.height, '174px');
  assert.equal(h.viewport.style.height, '174px');
});

test('customer generation disables duplicate clicks and switches between product views and print artwork', async t => {
  let resolve;
  let state = 'idle';
  let calls = 0;
  const pending = new Promise(done => { resolve = done; });
  const mockups = { get: () => ({ status: state }), load: () => { calls++; state = 'loading'; return pending; } };
  const h = harness(t, mockups);
  const item = h.configuration();
  item.mockupUrl = '/saved/mockups';
  h.api.open(item, h.opener);
  h.load();
  const button = h.query('[data-preview-mockup]');
  assert.equal(h.query('[data-preview-mockup-actions]').hidden, false);
  assert.equal(calls, 0, 'opening the print preview does not generate a mockup');
  button.click();
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(calls, 1);
  state = 'completed';
  resolve({ urls: ['https://printful.example.test/front.png', 'https://printful.example.test/back.png'] });
  await pending;
  await Promise.resolve();
  assert.equal(h.image().getAttribute('src'), 'https://printful.example.test/front.png');
  assert.equal(button.textContent, 'Druckdatei ansehen');
  assert.equal(h.query('[data-surface="mockup:1"]').textContent, 'Ansicht 2');
  h.load(undefined, { width: 1000, height: 1000 });
  button.click();
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=front');
  assert.equal(button.textContent, 'Produktvorschau ansehen');
  button.click();
  assert.equal(calls, 1, 'switching views reuses the completed result');
  h.query('[data-preview-close]').click();
  h.api.open(h.configuration('another'), h.opener);
  assert.equal(h.query('[data-preview-mockup-actions]').hidden, true);
});

test('closing a pending mockup keeps a late completion from replacing another design', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness(t, { get: () => ({ status: 'idle' }), load: () => pending });
  const item = h.configuration();
  item.mockupUrl = '/saved/mockups';
  h.api.open(item, h.opener);
  h.query('[data-preview-mockup]').click();
  h.dialog.close();
  h.api.open(h.configuration('another'), h.opener);
  resolve({ urls: ['https://printful.example.test/late.png'] });
  await pending;
  await Promise.resolve();
  assert.equal(h.image().getAttribute('src'), '/another/print.png?surface=front');
  assert.equal(h.query('[data-preview-mockup-actions]').hidden, true);
});

test('customer feedback uses server retry seconds and broken mockup links need another click', async t => {
  let calls = 0;
  let invalidated = 0;
  let state = 'idle';
  const mockups = {
    get: () => ({ status: state }),
    load: async () => {
      if (++calls === 1) throw Object.assign(new Error('busy'), { retryAfter: 40 });
      state = 'completed';
      return { urls: ['https://printful.example.test/mockup.png'] };
    },
    invalidate: () => { invalidated++; state = 'idle'; },
  };
  const h = harness(t, mockups);
  const item = h.configuration();
  item.mockupUrl = '/saved/mockups';
  h.api.open(item, h.opener);
  h.load();
  h.query('[data-preview-mockup]').click();
  await Promise.resolve();
  assert.equal(h.query('[data-preview-mockup-status]').textContent,
    'Momentan ist viel los. Bitte versucht es in etwa 40 Sekunden erneut.');
  assert.equal(h.query('[data-preview-mockup]').disabled, false);
  assert.equal(calls, 1);
  h.query('[data-preview-mockup]').click();
  await Promise.resolve();
  h.image().dispatchEvent(new h.window.Event('error'));
  assert.equal(invalidated, 1);
  assert.equal(calls, 2, 'failed image does not regenerate automatically');
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=front');
  assert.equal(h.query('[data-preview-mockup]').textContent, 'Produktvorschau erstellen');
});

test('portrait previews fit the available screen height while preserving the full print area', t => {
  const h = harness(t);
  const item = h.configuration();
  item.product.printFile = { width: 1200, height: 2400 };
  h.api.open(item, h.opener);
  h.load(undefined, item.product.printFile);
  assert.equal(h.image().style.width, '326px');
  assert.equal(h.image().style.height, '652px');
  assert.equal(h.viewport.style.height, '652px');
});

test('switching front and back preserves the selected artwork and reuses already loaded sides', t => {
  const h = harness(t);
  h.api.open(h.configuration(), h.opener);
  const front = h.image();
  h.load();
  h.query('[data-surface="back"]').click();
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=back');
  assert.equal(h.query('[data-surface="back"]').getAttribute('aria-pressed'), 'true');
  h.load();
  h.query('[data-surface="front"]').click();
  assert.equal(h.image(), front);
  assert.equal(h.query('[data-preview-feedback]').hidden, true);
});

test('a failed image can be retried without letting late image responses replace the current design', t => {
  const h = harness(t);
  h.api.open(h.configuration(), h.opener);
  const failed = h.image();
  failed.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.query('[data-preview-retry]').hidden, false);
  assert.equal(h.query('[data-preview-artwork]').hidden, true);
  assert.equal(h.viewport.getAttribute('aria-busy'), 'false');
  h.query('[data-preview-retry]').click();
  assert.notEqual(h.image(), failed);
  const retried = h.image();
  h.load(failed);
  assert.equal(h.query('[data-preview-artwork]').hidden, true, 'the failed attempt cannot reveal the retry');
  h.load(retried);
  assert.equal(h.query('[data-preview-artwork]').hidden, false);
  h.api.open(h.configuration('new-design'), h.opener);
  retried.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.query('[data-preview-retry]').hidden, true);
  assert.equal(h.image().getAttribute('src'), '/new-design/print.png?surface=front');
});

test('closing releases images and restores focus and scrolling without submitting or changing the address form', t => {
  const h = harness(t);
  let submissions = 0;
  h.window.document.querySelector('form').addEventListener('submit', event => { submissions++; event.preventDefault(); });
  h.window.document.documentElement.style.overflow = 'auto';
  h.opener.focus();
  h.api.open(h.configuration(), h.opener);
  const pending = h.image();
  assert.equal(h.window.document.documentElement.style.overflow, 'hidden');
  h.query('[data-preview-close]').click();
  assert.equal(h.window.document.documentElement.style.overflow, 'auto');
  assert.equal(h.window.document.activeElement, h.opener);
  assert.equal(h.image(), null);
  assert.equal(h.viewport.style.height, '');
  h.load(pending);
  assert.equal(h.image(), null, 'a closed preview ignores a late load');
  assert.equal(h.window.document.querySelector('[name="city"]').value, 'Berlin');
  assert.equal(h.window.document.querySelector('[name="quantity"]').value, '3');
  assert.equal(submissions, 0);
});

test('single-sided designs hide the side selector and have no custom zoom controls or keyboard zoom', t => {
  const h = harness(t);
  const item = h.configuration();
  item.product.printSurfaces.splice(1);
  h.api.open(item, h.opener);
  h.load();
  assert.equal(h.query('[data-preview-surfaces]').hidden, true);
  assert.equal(h.query('[data-preview-zoom-in]'), null);
  h.dialog.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: '+', bubbles: true }));
  assert.equal(h.image().style.width, '648px');
  h.dialog.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true }));
  assert.equal(h.image().style.width, '648px');
  h.dialog.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: '0', bubbles: true }));
  assert.equal(h.image().style.width, '648px');
});
