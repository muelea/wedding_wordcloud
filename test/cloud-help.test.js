'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const CloudHelp = require('../public/js/cloud-help');
const { getCatalog } = require('../src/i18n');
const { renderPage } = require('../src/pageRenderer');

function harness(t, { fragment = '', width = 390, height = 844 } = {}) {
  const markup = ejs.render(fs.readFileSync('views/partials/cloud-help.ejs', 'utf8'));
  const dom = new JSDOM(`<body><details data-ww-site-menu><summary data-ww-site-menu-trigger>Menu</summary>
    <div class="ww-display-menu-actions"><div class="ww-display-organizer-tools"><button id="draft-settings-button">PIN</button><button id="presentation-mode-button">Present</button></div><button id="menu-help" data-cloud-tour-start>Help</button></div></details>
    <div class="display-word-entry-row"><form class="display-word-entry"><input id="display-word-input" aria-describedby="display-guest-guidance"><button>Add</button></form></div>
    <button id="memory-cta" disabled>Keepsake</button><button id="cloud-help-button" data-cloud-tour-start>Help</button><button id="share-cloud">Invite</button>
    <dialog id="share-dialog"><button>Close</button></dialog><dialog id="pin-dialog"></dialog>${markup}</body>`, {
    url: `https://example.test/e/-_AbCdEf0123456789xyZQ?lang=de${fragment}`, pretendToBeVisual: true,
  });
  const win = dom.window, doc = win.document;
  Object.defineProperties(win, { innerWidth: { value: width, writable: true }, innerHeight: { value: height, writable: true } });
  const viewport = new win.EventTarget();
  Object.assign(viewport, { width, height, offsetLeft: 0, offsetTop: 0 });
  Object.defineProperty(win, 'visualViewport', { value: viewport });
  const frames = new Map(); let frameId = 0;
  let resized;
  win.ResizeObserver = class { constructor(callback) { resized = callback; } observe() {} disconnect() {} };
  win.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]; };
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    let left = 16, top = height - 210, w = width - 32, h = 52;
    if (this.id === 'share-cloud') { top = height - 65; w = 150; h = 48; }
    if (this.classList.contains('ww-display-organizer-tools')) { left = Math.max(16, width - 300); top = 180; w = Math.min(280, width - 32); h = 90; }
    if (this.id === 'memory-cta') { left = width - 155; top = 10; w = 95; h = 44; }
    if (this.id === 'cloud-tour-tip') { left = 0; top = 0; w = 360; h = 235; }
    return { left, top, right: left + w, bottom: top + h, width: w, height: h };
  };
  let locale = 'de';
  win.WolkenworteI18n = { setText(element, source, params = {}) {
    element.dataset.i18nSource = source;
    element.textContent = (getCatalog(locale)[source] || source).replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
  } };
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('storage blocked'); } });
  Object.defineProperty(win, 'sessionStorage', { get() { throw new Error('storage blocked'); } });
  win.fetch = () => assert.fail('help must not call an organizer endpoint');
  doc.getElementById('presentation-mode-button').addEventListener('click', () => doc.body.classList.toggle('presentation-mode'));
  const api = CloudHelp.create({ window: win });
  t.after(() => { api.destroy(); dom.window.close(); });
  const get = (id) => doc.getElementById(id);
  const click = (id) => get(id).click();
  async function flush() {
    await Promise.resolve();
    for (let pass = 0; pass < 4 && frames.size; pass++) {
      const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn());
      await Promise.resolve();
    }
  }
  return { api, win, doc, get, click, flush, viewport, resize: () => resized(),
    setLocale(value) { locale = value; win.dispatchEvent(new win.Event('wolkenworte:localechange')); } };
}

test('creation starts the four-step spotlight once while guests start without it', t => {
  const creator = harness(t, { fragment: '#willkommen' });
  assert.equal(creator.get('cloud-tour-tip').hidden, false);
  assert.match(creator.get('cloud-tour-progress').textContent, /1.*4/);
  assert.equal(creator.doc.activeElement, creator.get('cloud-tour-title'), 'automatic onboarding must not open the keyboard');
  assert.equal(creator.win.location.hash, '');
  assert.equal(creator.win.location.search, '?lang=de');
  assert.equal(creator.win.location.pathname, '/e/-_AbCdEf0123456789xyZQ');
  for (const fragment of ['', '#other']) assert.equal(harness(t, { fragment }).get('cloud-tour-tip').hidden, true);
});

test('How it works starts or replays the same tour directly from page and menu', t => {
  const h = harness(t);
  h.get('display-word-input').value = 'Freude'; h.click('cloud-help-button');
  assert.equal(h.get('cloud-tour-tip').hidden, false);
  assert.equal(h.get('display-word-input').value, 'Freude');
  h.click('cloud-tour-close');
  assert.equal(h.doc.activeElement, h.get('cloud-help-button'));
  h.doc.querySelector('details').open = true; h.click('menu-help');
  assert.match(h.get('cloud-tour-progress').textContent, /1.*4/);
  assert.equal(h.get('cloud-tour-tip').hidden, false);
});

test('Continue and Back visit all four real controls without forcing a contribution', t => {
  const h = harness(t); let submissions = 0;
  h.doc.querySelector('form').addEventListener('submit', event => { event.preventDefault(); submissions++; });
  h.click('cloud-help-button');
  assert.equal(h.get('cloud-tour-back').hidden, true);
  assert.equal(h.get('cloud-tour-skip'), null);
  h.click('cloud-tour-next');
  assert.match(h.get('cloud-tour-progress').textContent, /2.*4/);
  h.click('cloud-tour-back');
  assert.match(h.get('cloud-tour-progress').textContent, /1.*4/);
  h.click('cloud-tour-next'); h.click('cloud-tour-next');
  assert.match(h.get('cloud-tour-progress').textContent, /3.*4/);
  assert.equal(h.doc.querySelector('details').open, true);
  h.click('cloud-tour-next');
  assert.match(h.get('cloud-tour-progress').textContent, /4.*4/);
  assert.equal(h.doc.querySelector('details').open, false);
  assert.equal(h.get('memory-cta').getAttribute('aria-describedby'), 'cloud-tour-description');
  assert.equal(h.get('memory-cta').disabled, true, 'the tour never enables an empty-cloud purchase path');
  assert.equal(h.get('cloud-tour-tip').hidden, false, 'disabled Keepsake still has a spotlight');
  h.click('cloud-tour-back');
  assert.match(h.get('cloud-tour-progress').textContent, /3.*4/);
  assert.equal(h.doc.querySelector('details').open, true);
  h.click('cloud-tour-next'); h.click('cloud-tour-next');
  assert.equal(h.get('cloud-tour-tip').hidden, true);
  assert.equal(h.get('memory-cta').hasAttribute('aria-describedby'), false);
  assert.equal(submissions, 0);
});

test('only a committed contribution advances the interactive first step', t => {
  const h = harness(t); h.api.startTour(); h.get('display-word-input').value = 'Freude';
  assert.match(h.get('cloud-tour-progress').textContent, /1.*4/);
  h.doc.dispatchEvent(new h.win.Event('wolkenworte:wordaccepted'));
  assert.match(h.get('cloud-tour-progress').textContent, /2.*4/);
});

test('Escape restores focus and descriptions; keyboard navigation excludes disabled Keepsake', t => {
  const h = harness(t); h.click('cloud-help-button');
  assert.equal(h.get('display-word-input').getAttribute('aria-describedby'), 'display-guest-guidance cloud-tour-description');
  h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(h.doc.activeElement, h.get('display-word-input'));
  h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.get('cloud-tour-tip').hidden, true);
  assert.equal(h.get('display-word-input').getAttribute('aria-describedby'), 'display-guest-guidance');
  assert.equal(h.doc.activeElement, h.get('cloud-help-button'));
  h.click('cloud-help-button');
  for (let index = 0; index < 3; index++) h.click('cloud-tour-next');
  h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(h.doc.activeElement, h.get('cloud-tour-close'));
});

test('sharing hides the spotlight until the dialog closes and resumes the same step', async t => {
  const h = harness(t); h.api.startTour(); h.click('cloud-tour-next');
  h.get('share-dialog').showModal(); await h.flush();
  assert.equal(h.get('cloud-tour-tip').hidden, true);
  assert.equal(h.get('cloud-tour-shade').hidden, true);
  h.get('share-dialog').close(); await h.flush();
  assert.equal(h.get('cloud-tour-tip').hidden, false);
  assert.match(h.get('cloud-tour-progress').textContent, /2.*4/);
});

test('PIN dialogs, presentation mode and page exit dismiss the tour cleanly', async t => {
  const h = harness(t); h.api.startTour(); h.get('pin-dialog').showModal(); await h.flush();
  assert.equal(h.get('cloud-tour-tip').hidden, true);
  h.get('pin-dialog').close(); h.api.startTour();
  h.doc.body.classList.add('presentation-mode'); await h.flush();
  assert.equal(h.get('cloud-tour-tip').hidden, true);
  h.click('menu-help'); await h.flush();
  assert.equal(h.doc.body.classList.contains('presentation-mode'), false);
  assert.equal(h.get('cloud-tour-tip').hidden, false);
  h.win.dispatchEvent(new h.win.Event('pagehide'));
  assert.equal(h.get('cloud-tour-tip').hidden, true);
  assert.equal(h.get('cloud-tour-ring').hidden, true);
});

test('language changes preserve the step and translate the progress and Continue control', t => {
  const h = harness(t); h.api.startTour(); h.click('cloud-tour-next'); h.setLocale('en');
  assert.equal(h.get('cloud-tour-title').textContent, 'Invite others');
  assert.equal(h.get('cloud-tour-progress').textContent, 'Step 2 of 4');
  assert.equal(h.get('cloud-tour-next').textContent, 'Continue');
  h.setLocale('tr');
  assert.equal(h.get('cloud-tour-title').textContent, 'Başkalarını davet et');
  assert.equal(h.get('cloud-tour-next').textContent, 'Devam et');
});

test('spotlight placement follows keyboard changes and organizer controls appearing later', async t => {
  for (const width of [320, 390, 1024]) {
    const h = harness(t, { width }); h.api.startTour(); const tip = h.get('cloud-tour-tip');
    assert.ok(parseFloat(tip.style.left) >= 8);
    assert.ok(parseFloat(tip.style.left) + parseFloat(tip.style.width) <= width - 8);
    h.get('display-word-input').focus(); h.viewport.height = 480;
    h.viewport.dispatchEvent(new h.win.Event('resize')); await h.flush();
    assert.equal(h.doc.body.classList.contains('cloud-keyboard-open'), true);
    h.get('display-word-input').blur(); await h.flush();
    assert.equal(h.doc.body.classList.contains('cloud-keyboard-open'), false);
    h.viewport.height = 844; h.click('cloud-tour-next'); h.click('cloud-tour-next');
    const group = h.doc.querySelector('.ww-display-organizer-tools');
    const before = parseFloat(h.get('cloud-tour-ring').style.height), rect = group.getBoundingClientRect();
    group.getBoundingClientRect = () => ({ ...rect, height: rect.height + 44, bottom: rect.bottom + 44 });
    h.resize(); await h.flush();
    assert.equal(parseFloat(h.get('cloud-tour-ring').style.height), before + 44);
  }
});

test('the rendered page has one direct tour with translated controls and an always-present Keepsake', async t => {
  for (const hasWords of [false, true]) {
    let html;
    await renderPage({ query: {}, headers: {}, originalUrl: '/e/-_AbCdEf0123456789xyZQ' }, {
      status() {}, set() {}, vary() {}, send(value) { html = value; },
    }, 'display', { eventLocale: 'en', header: { variant: 'display', hasWords }, pageData: {
      eventUrl: 'https://example.test/e/-_AbCdEf0123456789xyZQ', cloudTitle: 'Test', qrSvg: '<svg></svg>', initialWords: hasWords ? [['Freude', 1]] : [],
    } });
    const dom = new JSDOM(html); t.after(() => dom.window.close()); const doc = dom.window.document;
    assert.equal(doc.querySelector('#memory-cta').disabled, !hasWords);
    assert.equal(doc.querySelector('#memory-cta').closest('[hidden]'), null);
    assert.ok(doc.querySelector('#cloud-help-button[data-cloud-tour-start]'));
    assert.equal(doc.querySelector('#cloud-help-button').textContent, 'How it works');
    assert.equal(doc.querySelector('#cloud-tour-next').textContent, 'Continue');
    assert.equal(doc.querySelector('#cloud-tour-back').textContent, 'Back');
    assert.equal(doc.querySelector('#cloud-tour-close').getAttribute('aria-label'), 'Close introduction');
    assert.equal(doc.querySelector('#cloud-welcome, #cloud-help-dialog, #cloud-overview-button, #cloud-tour-skip, [data-cloud-welcome-open]'), null);
  }
});
