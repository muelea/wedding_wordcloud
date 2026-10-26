'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const Preview = require('../public/js/print-preview');

function harness(t, mockups, options = {}) {
  const markup = fs.readFileSync(require.resolve('../views/partials/print-preview.ejs'), 'utf8');
  const dom = new JSDOM(`<form><input name="city" value="Berlin"><input name="quantity" value="3"><button type="button" id="opener">View design</button></form>${markup}`,
    { url: 'https://example.test/shipping' });
  t.after(() => dom.window.close());
  const { window } = dom;
  let locale = 'de';
  const dialog = window.document.querySelector('dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  const viewport = dialog.querySelector('[data-preview-viewport]');
  Object.defineProperties(viewport, { clientWidth: { value: 648, configurable: true }, clientHeight: { value: 348, configurable: true } });
  Object.defineProperty(dialog, 'offsetHeight', { get: () => viewport.clientHeight + 68 });
  const api = Preview.create(dialog, { window, mockups, allowMockups: true, ...options, i18n: {
    t: source => source,
    getLocale: () => locale,
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
  return { api, dialog, window, opener, viewport, configuration, query, image, load,
    setLocale: value => { locale = value; window.dispatchEvent(new window.Event('wolkenworte:localechange')); },
    photo: () => query('[data-preview-photo-artwork] img'),
    mockupImage: () => query('[data-preview-mockup-artwork] img'),
  };
}

test('wide designs fit their panel without cropping or changing their proportions', t => {
  const h = harness(t);
  assert.equal(h.image(), null, 'no full-resolution image is requested before opening');
  h.api.open(h.configuration(), h.opener);
  assert.equal(h.window.document.activeElement, h.query('[data-preview-title]'));
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=front');
  assert.equal(h.viewport.getAttribute('aria-busy'), 'true');
  h.load();
  assert.equal(h.image().style.width, '648px');
  assert.equal(h.image().style.height, '324px');
  assert.equal(h.query('[data-preview-feedback]').hidden, true);
  Object.defineProperty(h.viewport, 'clientWidth', { value: 348 });
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(h.image().style.width, '348px');
  assert.equal(h.image().style.height, '174px');
});

test('the fourth panel shows localized product information as safe text and updates without changing the accepted artwork', t => {
  const h = harness(t);
  const item = h.configuration();
  item.product.information = { de: 'Keramiktasse\n\n• Keramik\n• 444 ml', en: 'Ceramic mug\n\n• Ceramic\n• 444 ml',
    tr: '<img src=x onerror=alert(1)>\n\n• Seramik' };
  h.api.open(item, h.opener);
  const description = h.query('[data-preview-description]'), image = h.image();
  assert.match(description.textContent, /Keramiktasse/);
  assert.equal(description.querySelectorAll('li').length, 2);
  h.setLocale('en');
  assert.match(description.textContent, /Ceramic mug/);
  assert.doesNotMatch(description.textContent, /Keramiktasse/);
  assert.equal(h.image(), image);
  h.setLocale('tr');
  assert.match(description.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(description.querySelector('img'), null, 'supplier copy is never injected as HTML');
  h.dialog.close();
  h.api.open(h.configuration('other'), h.opener);
  assert.equal(description.textContent, '', 'another product never inherits the previous description');
});

test('explicit mockup generation adds its own result while all three previews remain available', async t => {
  let resolve, state = 'idle', calls = 0;
  const pending = new Promise(done => { resolve = done; });
  const h = harness(t, {
    get: () => ({ status: state }),
    load: () => { calls++; state = 'loading'; return pending; },
  });
  const item = h.configuration();
  item.mockupUrl = '/saved/mockups';
  h.api.open(item, h.opener);
  h.load();
  const artwork = h.image();
  const button = h.query('[data-preview-mockup]');
  assert.equal(h.query('[data-preview-mockup-actions]').hidden, false);
  assert.equal(calls, 0, 'opening the overview does not generate a mockup');
  button.click(); button.click();
  assert.equal(button.disabled, true);
  assert.equal(calls, 1);
  state = 'completed';
  resolve({ urls: ['https://printful.example.test/front.png', 'https://printful.example.test/back.png'] });
  await pending;
  await Promise.resolve();
  assert.equal(h.mockupImage().getAttribute('src'), 'https://printful.example.test/front.png');
  assert.equal(h.image(), artwork, 'the immutable design stays visible beside the photo and 3D preview');
  assert.equal(button.textContent, 'Produktvorschau ansehen');
  assert.equal(h.query('[data-preview-mockup-card]').hidden, false);
  h.query('[data-surface="mockup:1"]').click();
  assert.equal(h.mockupImage().getAttribute('src'), 'https://printful.example.test/back.png');
  assert.equal(calls, 1);
  h.dialog.close();
  h.api.open(h.configuration('another'), h.opener);
  assert.equal(h.query('[data-preview-mockup-card]').hidden, true);
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
  h.mockupImage().dispatchEvent(new h.window.Event('error'));
  assert.equal(invalidated, 1);
  assert.equal(h.query('[data-preview-mockup-card]').hidden, true);
  assert.equal(calls, 2, 'failed image does not regenerate automatically');
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=front');
  assert.equal(h.query('[data-preview-mockup]').textContent, 'Produktvorschau erstellen');
});

test('portrait designs fit their panel height while preserving the full print area', t => {
  const h = harness(t);
  const item = h.configuration();
  item.product.printFile = { width: 1200, height: 2400 };
  h.api.open(item, h.opener);
  h.load(undefined, item.product.printFile);
  assert.equal(h.image().style.width, '174px');
  assert.equal(h.image().style.height, '348px');
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

test('closing releases images and restores focus without changing shared scroll state or the address form', t => {
  const h = harness(t);
  let submissions = 0;
  h.window.document.querySelector('form').addEventListener('submit', event => { submissions++; event.preventDefault(); });
  h.window.document.documentElement.style.overflow = 'auto';
  h.opener.focus();
  h.api.open(h.configuration(), h.opener);
  const pending = h.image();
  assert.equal(h.window.document.documentElement.style.overflow, 'auto', 'the shared :modal stylesheet owns scroll locking');
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

test('cart and shipping show photo, exact artwork and a local 3D preview together without generating mockups', async t => {
  let calls = 0, destroyed = 0;
  const renders = [];
  const h = harness(t, { get: () => ({ status: 'idle' }), load: () => { calls++; } }, {
    allowMockups: false,
    render3D: async options => { renders.push(options); return { resize() {}, destroy() { destroyed++; } }; },
  });
  const item = h.configuration();
  Object.assign(item.product, { previewType: '3d', variantLabel: '444 ml · Blau', productPhoto: '/blue.jpg' });
  item.mockupUrl = '/saved/mockups';
  h.api.open(item, h.opener);
  await Promise.resolve();
  h.load(); h.load(h.photo());
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=front');
  assert.equal(h.photo().getAttribute('src'), '/blue.jpg');
  assert.equal(h.query('[data-preview-detail]').textContent, '444 ml · Blau');
  assert.equal(h.query('[data-preview-mockup-actions]').hidden, true);
  assert.equal(renders[0].item, item, '3D receives the accepted snapshot and both exact surface URLs');
  assert.equal(h.query('[data-preview-model-card]').hidden, false);
  assert.equal(h.query('[data-preview-photo-card]').hidden, false);
  assert.equal(h.query('[data-preview-model-feedback]').hidden, true);
  assert.equal(h.query('[data-preview-artwork]').hidden, false);
  assert.equal(h.query('[data-preview-photo-artwork]').hidden, false);
  assert.equal(h.query('[data-preview-views]'), null, 'there is no view switcher');
  const photo = h.photo();
  h.query('[data-surface="back"]').click();
  assert.equal(h.image().getAttribute('src'), '/saved/print.png?surface=back');
  assert.equal(h.photo(), photo);
  assert.equal(renders.length, 1, 'changing the flat print side keeps the rotatable model alive');
  assert.equal(destroyed, 0);
  h.query('[data-preview-mockup]').click();
  assert.equal(calls, 0, 'even a programmatic click cannot generate a cart mockup');
  h.dialog.close();
  assert.equal(destroyed, 1);
});

test('a product-photo error and retry leave the loaded design and interactive model in place', async t => {
  let renders = 0;
  const h = harness(t, undefined, { render3D: async () => {
    renders++;
    return { resize() {}, destroy() {} };
  } });
  const item = h.configuration();
  Object.assign(item.product, { previewType: '3d', productPhoto: '/product.jpg' });
  h.api.open(item, h.opener);
  await Promise.resolve();
  h.load();
  const design = h.image(), failed = h.photo();
  failed.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.query('[data-preview-photo-retry]').hidden, false);
  assert.equal(h.query('[data-preview-artwork]').hidden, false);
  assert.equal(h.query('[data-preview-model-feedback]').hidden, true);
  h.query('[data-preview-photo-retry]').click();
  assert.notEqual(h.photo(), failed);
  h.load(failed);
  assert.equal(h.query('[data-preview-photo-artwork]').hidden, true, 'a late failed response cannot reveal the retry');
  h.load(h.photo());
  assert.equal(h.query('[data-preview-photo-artwork]').hidden, false);
  assert.equal(h.image(), design);
  assert.equal(renders, 1);
});

test('replacing a design fences late model responses and 3D failures can be retried independently', async t => {
  let complete, destroyed = 0, attempt = 0;
  const h = harness(t, undefined, { render3D: () => {
    if (++attempt === 1) return new Promise(resolve => { complete = resolve; });
    return Promise.reject(new Error('WebGL unavailable'));
  } });
  const item = h.configuration();
  item.product.previewType = '3d';
  h.api.open(item, h.opener);
  h.api.open(h.configuration('another'), h.opener);
  complete({ destroy() { destroyed++; } });
  await Promise.resolve();
  assert.equal(destroyed, 1);
  assert.equal(h.image().getAttribute('src'), '/another/print.png?surface=front');
  h.api.open(item, h.opener);
  await Promise.resolve();
  assert.equal(h.query('[data-preview-model-retry]').hidden, false);
  h.load();
  assert.equal(h.query('[data-preview-artwork]').hidden, false, 'a model failure leaves the design usable');
  h.query('[data-preview-model-retry]').click();
  await Promise.resolve();
  assert.equal(attempt, 3);
  h.dialog.close();
});

test('closing during local model initialization disposes the late renderer without reopening the dialog', async t => {
  let complete, destroyed = 0;
  const h = harness(t, undefined, { render3D: () => new Promise(resolve => { complete = resolve; }) });
  const item = h.configuration();
  item.product.previewType = '3d';
  h.api.open(item, h.opener);
  h.dialog.close();
  complete({ destroy() { destroyed++; } });
  await Promise.resolve();
  assert.equal(destroyed, 1);
  assert.equal(h.dialog.open, false);
  assert.equal(h.query('[data-preview-model]').children.length, 0);
});

test('reopening a pending mockup rejoins its promise while keeping the three-panel overview', async t => {
  let complete, state = 'idle', requests = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const h = harness(t, {
    get: () => ({ status: state }),
    load: () => { if (state === 'idle') { requests++; state = 'loading'; } return pending; },
  });
  const item = h.configuration();
  item.mockupUrl = '/saved/mockups';
  item.product.productPhoto = '/original.jpg';
  h.api.open(item, h.opener);
  h.query('[data-preview-mockup]').click();
  h.dialog.close();
  h.api.open(item, h.opener);
  state = 'completed';
  complete({ urls: ['https://printful.example.test/front.png'] });
  await pending;
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.equal(h.photo().getAttribute('src'), '/original.jpg');
  assert.equal(h.query('[data-preview-mockup-card]').hidden, true);
  assert.equal(h.query('[data-preview-mockup]').disabled, false);
  h.query('[data-preview-mockup]').click();
  await Promise.resolve();
  assert.equal(h.mockupImage().getAttribute('src'), 'https://printful.example.test/front.png');
  assert.equal(requests, 1);
});
