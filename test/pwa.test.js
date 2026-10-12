'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createCanvas, loadImage } = require('canvas');
const { parse } = require('parse5');
const { renderPage } = require('../src/pageRenderer');
const { staticCacheMiddleware } = require('../src/httpCache');
const { publicAssetUrl } = require('../src/publicAssets');
const { SUPPORTED_LOCALES, getCatalog } = require('../src/i18n');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const runtime = fs.readFileSync(path.join(PUBLIC, 'js/pwa-install.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

function target(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    async emit(name, event = {}) {
      await Promise.all((listeners.get(name) || []).map(handler => handler(event)));
    },
  };
}

function browser({ userAgent = 'Desktop browser', maxTouchPoints = 0,
  secure = true, standalone = false, appleStandalone = false } = {}) {
  const button = target({ hidden: true });
  const close = target();
  const dialog = {
    open: false, opened: 0,
    showModal() { this.open = true; this.opened++; },
    close() { this.open = false; },
    querySelector() { return close; },
  };
  const media = target({ matches: standalone });
  const window = target({ isSecureContext: secure, matchMedia: () => media });
  const navigator = { userAgent, maxTouchPoints, standalone: appleStandalone };
  Object.defineProperty(navigator, 'serviceWorker', {
    get() { throw new Error('The installation runtime must not access service workers'); },
  });
  let movedDialog;
  const document = {
    querySelectorAll: () => [button], querySelector: () => dialog,
    body: { append: value => { movedDialog = value; } },
  };
  vm.runInNewContext(runtime, { window, document, navigator });
  return { window, button, dialog, close, media, get movedDialog() { return movedDialog; } };
}

function promptEvent(outcome = 'dismissed') {
  return {
    prevented: false, calls: 0,
    preventDefault() { this.prevented = true; },
    async prompt() { this.calls++; return { outcome }; },
  };
}

function elements(html) {
  const found = [];
  function visit(node) {
    if (node.tagName) found.push({ tag: node.tagName,
      attrs: Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value])) });
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(html));
  return found;
}

test('one standalone app identity covers the homepage and every event route', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.name, 'Wolkenworte');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  for (const size of ['192x192', '512x512']) {
    assert.ok(manifest.icons.some(icon => icon.sizes === size && icon.purpose === 'any'));
  }
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
});

test('install icons decode at their advertised sizes, with an opaque maskable safe area', async () => {
  for (const icon of [...manifest.icons,
    { src: '/assets/pwa/apple-touch-icon.png', sizes: '180x180' }]) {
    const image = await loadImage(path.join(PUBLIC, icon.src));
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(image.width, width, icon.src);
    assert.equal(image.height, height, icon.src);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    let markPixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        assert.equal(pixels[offset + 3], 255, 'home-screen icons have no transparent edges');
        const background = pixels[offset] === 255 && pixels[offset + 1] === 253 && pixels[offset + 2] === 250;
        if (!background) markPixels++;
        if (icon.purpose === 'maskable' && Math.hypot(x + .5 - width / 2, y + .5 - height / 2) > width * .4) {
          assert.ok(background, 'OS icon masking cannot clip the logo');
        }
      }
    }
    assert.ok(markPixels > width * height * .1, 'the icon contains a visible brand mark');
  }
});

test('all public pages publish the same manifest and exactly one optional install action', async () => {
  const pages = ['landing', 'display', 'configure', 'shipping', 'order-confirmation',
    '404', 'impressum', 'datenschutz', 'bestellinformationen'];
  for (const page of pages) {
    const response = { status() {}, set() {}, vary() {}, send: html => html };
    const html = await renderPage({ query: {}, headers: {}, originalUrl: '/' }, response, page, {
      header: { variant: page === 'display' ? 'display' : page === 'landing' ? 'landing' : 'back' },
      pageData: { cloudTitle: 'Test cloud', eventUrl: 'https://example.test/e/test', qrSvg: '<svg></svg>',
        paletteOptions: [], purchaseTerms: require('../src/purchaseTerms'), seller: require('../src/emailTemplates').SELLER },
    });
    const nodes = elements(html);
    const links = nodes.filter(node => node.tag === 'link' && node.attrs.rel === 'manifest');
    assert.deepEqual(links.map(node => node.attrs.href), ['/manifest.webmanifest'], page);
    assert.equal(nodes.filter(node => Object.hasOwn(node.attrs, 'data-ww-install')).length, 1, page);
    assert.equal(nodes.filter(node => Object.hasOwn(node.attrs, 'data-ww-install-dialog')).length, 1, page);
    assert.ok(nodes.some(node => node.attrs.rel === 'apple-touch-icon' &&
      node.attrs.href === publicAssetUrl('/assets/pwa/apple-touch-icon.png')), page);
    assert.ok(nodes.some(node => node.tag === 'script' &&
      node.attrs.src === publicAssetUrl('/js/pwa-install.js') && Object.hasOwn(node.attrs, 'defer')), page);
  }
});

test('the actual static-serving stack serves the manifest and icons with revalidation', async t => {
  const app = express();
  app.use(staticCacheMiddleware, express.static(PUBLIC));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/manifest\+json/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.deepEqual(await response.json(), manifest);
  const revalidated = await new Promise((resolve, reject) => {
    http.get(`${baseUrl}/manifest.webmanifest`, {
      headers: { 'If-None-Match': response.headers.get('etag') },
    }, result => {
      result.resume();
      result.once('end', () => resolve(result.statusCode));
    }).once('error', reject);
  });
  assert.equal(revalidated, 304);
  for (const icon of manifest.icons) {
    const iconResponse = await fetch(`${baseUrl}${icon.src}`);
    assert.equal(iconResponse.status, 200);
    assert.match(iconResponse.headers.get('content-type'), /^image\/png/);
    await iconResponse.arrayBuffer();
  }
});

test('installation is optional and native prompts run only after a click, once per event', async () => {
  const page = browser();
  assert.equal(page.button.hidden, true, 'unsupported browsers have no dead install button');
  const prompt = promptEvent();
  await page.window.emit('beforeinstallprompt', prompt);
  assert.equal(prompt.prevented, true);
  assert.equal(prompt.calls, 0, 'availability does not open a prompt');
  assert.equal(page.button.hidden, false);
  await page.button.emit('click');
  assert.equal(prompt.calls, 1);
  assert.equal(page.button.hidden, true, 'dismissed native prompts cannot be reused');
  await page.button.emit('click');
  assert.equal(prompt.calls, 1);
  await page.window.emit('beforeinstallprompt', promptEvent());
  assert.equal(page.button.hidden, false, 'a fresh browser prompt is usable');
});

test('acceptance and external installation hide the action after history restoration', async () => {
  const page = browser();
  const prompt = promptEvent();
  prompt.userChoice = Promise.resolve({ outcome: 'accepted' });
  await page.window.emit('beforeinstallprompt', prompt);
  await page.button.emit('click');
  await page.window.emit('pageshow');
  assert.equal(page.button.hidden, true);
  const latePrompt = promptEvent();
  await page.window.emit('beforeinstallprompt', latePrompt);
  assert.equal(latePrompt.prevented, false);
  assert.equal(page.button.hidden, true);

  const external = browser();
  await external.window.emit('beforeinstallprompt', promptEvent());
  await external.window.emit('appinstalled');
  await external.window.emit('pageshow');
  assert.equal(external.button.hidden, true);
});

test('withdrawn prompts and rapid double clicks do not strand or repeat the action', async () => {
  const page = browser();
  const prompt = promptEvent();
  prompt.prompt = async function () { this.calls++; throw new Error('Install no longer available'); };
  await page.window.emit('beforeinstallprompt', prompt);
  await Promise.all([page.button.emit('click'), page.button.emit('click')]);
  assert.equal(prompt.calls, 1);
  assert.equal(page.button.hidden, true);
});

test('iPhone and desktop-mode iPad show dismissible instructions only after a click', async () => {
  for (const options of [{ userAgent: 'iPhone Safari' }, { userAgent: 'Macintosh Safari', maxTouchPoints: 5 }]) {
    const page = browser(options);
    assert.equal(page.button.hidden, false);
    assert.equal(page.dialog.opened, 0);
    assert.equal(page.movedDialog, page.dialog, 'the modal is outside the collapsed page menu');
    await page.button.emit('click');
    assert.equal(page.dialog.open, true);
    await page.close.emit('click');
    assert.equal(page.dialog.open, false);
    await page.button.emit('click');
    await page.window.emit('appinstalled');
    assert.equal(page.dialog.open, false);
    assert.equal(page.button.hidden, true);
  }
});

test('insecure pages and installed app windows never offer installation', async () => {
  for (const options of [{ secure: false }, { standalone: true }, { appleStandalone: true }]) {
    const page = browser({ userAgent: 'iPhone Safari', ...options });
    await page.window.emit('beforeinstallprompt', promptEvent());
    await page.button.emit('click');
    assert.equal(page.button.hidden, true);
    assert.equal(page.dialog.open, false);
  }
  const page = browser({ userAgent: 'iPhone Safari' });
  page.media.matches = true;
  await page.media.emit('change');
  assert.equal(page.button.hidden, true);
});

test('installation labels and iPhone instructions are available in every supported language', () => {
  const source = fs.readFileSync(path.join(ROOT, 'views/partials/pwa-install.ejs'), 'utf8');
  const messages = [...source.matchAll(/data-i18n-source="([^"]+)"/g)].map(match => match[1]);
  for (const locale of SUPPORTED_LOCALES.filter(value => value !== 'de')) {
    const catalog = getCatalog(locale);
    for (const message of messages) assert.ok(catalog[message]?.trim(), `${locale}: ${message}`);
  }
});
