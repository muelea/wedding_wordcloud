'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { renderPage } = require('../src/pageRenderer');
const { translate } = require('../src/i18n');

const template = fs.readFileSync(path.join(__dirname, '../views/display.ejs'), 'utf8');
const declarations = template.match(/  const shareButton[\s\S]*?  const shareFeedback[^\n]+/)[0];
const sharingSource = template.slice(template.indexOf('  function eventShareData()'),
  template.indexOf('  // ── Socket'));
const slug = '-_AbCdEf0123456789xyZQ';

async function harness(t, { nativeShare = true, locale = 'de', secureClipboard = true } = {}) {
  let html;
  await renderPage({ query: { lang: locale }, headers: {}, originalUrl: `/e/${slug}` }, {
    cookie() {}, status() {}, set() {}, vary() {}, send(value) { html = value; },
  }, 'display', {
    header: { variant: 'display' },
    pageData: { cloudTitle: 'Lea & Max 💛', eventUrl: `https://example.test/e/${slug}`,
      qrSvg: '<svg viewBox="0 0 1 1"><path d="M0 0h1v1H0z" /></svg>' },
  });
  const dom = new JSDOM(html, { url: `https://example.test/e/${slug}?lang=${locale}`, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const win = dom.window;
  const get = (id) => win.document.getElementById(id);
  const dialog = get('share-dialog');
  let opens = 0;
  dialog.showModal = () => { dialog.open = true; opens++; };
  dialog.close = () => { dialog.open = false; };
  const tracked = [], copied = [], nativeData = [], timers = new Map();
  let timerId = 0, nativeCalls = 0;
  Object.assign(win, {
    cloudTitle: get('cloud-title').textContent.trim(),
    eventUrl: get('event-qr').dataset.eventUrl,
    slug,
    t: (source, params) => translate(source, locale, params),
    setText(element, source) { element.textContent = translate(source, locale); },
    clearText(element) { element.textContent = ''; },
    WolkenworteAnalytics: { track(...args) { tracked.push(structuredClone(args)); } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  if (nativeShare) {
    win.navigator.canShare = () => true;
    win.navigator.share = async data => { nativeCalls++; nativeData.push(structuredClone(data)); };
  }
  Object.defineProperty(win, 'isSecureContext', { value: secureClipboard });
  if (secureClipboard) win.navigator.clipboard = { async writeText(value) { copied.push(value); } };
  vm.runInContext(`${declarations}\n${sharingSource}`, dom.getInternalVMContext());
  return { win, get, dialog, tracked, copied, nativeData, timers, opens: () => opens, nativeCalls: () => nativeCalls,
    flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('sharing opens the custom dialog with or without native browser sharing', async t => {
  for (const nativeShare of [true, false]) {
    const h = await harness(t, { nativeShare });
    assert.equal(h.get('share-native').hidden, true, 'native sharing starts hidden before feature detection');
    h.get('share-cloud').click();
    assert.equal(h.dialog.open, true);
    assert.equal(h.nativeCalls(), 0, 'the operating-system share menu must not intercept the custom dialog');
    assert.equal(h.get('share-native').hidden, !nativeShare);
    assert.equal(h.opens(), 1);
    assert.deepEqual(h.tracked, [['share_open']]);
    assert.equal(h.win.document.querySelectorAll('.footer-actions button').length, 1);
    assert.equal(h.get('copy-cloud-link'), null, 'copying belongs inside the dialog');
    assert.ok(h.dialog.querySelector('.qr-code svg'));
    h.get('share-cloud').click();
    assert.equal(h.opens(), 1, 'an open dialog is not opened or tracked twice');
  }
});

test('only the additional option invokes native sharing, with the current localized invitation', async t => {
  const h = await harness(t, { locale: 'fr' });
  h.get('share-cloud').click();
  h.win.cloudTitle = 'Fête & amis 💛';
  h.get('share-native').click();
  assert.equal(h.nativeCalls(), 1, 'sharing is invoked synchronously from the user click');
  assert.deepEqual(h.nativeData, [{
    title: translate('{{name}} – Wolkenworte', 'fr', { name: h.win.cloudTitle }),
    text: translate('Ihr seid eingeladen, die Wortwolke „{{name}}“ mitzugestalten. Fügt ein Wort hinzu und erlebt live, wie sie gemeinsam wächst.', 'fr', { name: h.win.cloudTitle }),
    url: `https://example.test/e/${slug}?lang=fr`,
  }]);
  assert.equal(h.get('share-native').disabled, true);
  h.get('share-native').click();
  assert.equal(h.nativeCalls(), 1, 'a pending system share cannot be opened twice');
  await h.flush();
  assert.equal(h.get('share-native').disabled, false);
  assert.equal(h.dialog.open, true);
  assert.deepEqual(h.tracked, [['share_open'], ['share', { method: 'native' }]]);
});

test('unsupported or denied native shares stay hidden without affecting the other options', async t => {
  for (const canShare of [() => false, () => { throw new Error('not allowed'); }]) {
    const h = await harness(t);
    h.win.navigator.canShare = canShare;
    h.get('share-cloud').click();
    assert.equal(h.get('share-native').hidden, true);
    h.get('share-native').click();
    assert.equal(h.nativeCalls(), 0);
    h.get('share-dialog-copy-link').click();
    await h.flush();
    assert.deepEqual(h.copied, [h.win.eventUrl]);
    assert.equal(h.dialog.open, true);
  }
});

test('native sharing remains available in browsers without canShare', async t => {
  const h = await harness(t);
  delete h.win.navigator.canShare;
  h.get('share-cloud').click();
  assert.equal(h.get('share-native').hidden, false);
  h.get('share-native').click();
  await h.flush();
  assert.equal(h.nativeCalls(), 1);
});

test('cancelling the system menu quietly returns to the custom share options', async t => {
  const h = await harness(t);
  h.win.navigator.share = async () => { throw new h.win.DOMException('cancelled', 'AbortError'); };
  h.get('share-cloud').click();
  h.get('share-native').click();
  await h.flush();
  assert.equal(h.dialog.open, true);
  assert.equal(h.get('share-native').disabled, false);
  assert.equal(h.get('share-feedback').textContent, '');
  assert.deepEqual(h.tracked, [['share_open']]);
});

test('a native share failure explains the fallback and leaves copying available', async t => {
  const h = await harness(t, { locale: 'en' });
  h.win.navigator.share = async () => { throw new Error('unavailable'); };
  h.get('share-cloud').click();
  h.get('share-native').click();
  await h.flush();
  assert.equal(h.dialog.open, true);
  assert.equal(h.get('share-native').disabled, false);
  assert.equal(h.get('share-feedback').textContent,
    translate('Das Teilen-Menü konnte nicht geöffnet werden. Bitte nutzt eine der anderen Optionen.', 'en'));
  assert.deepEqual(h.tracked, [['share_open']]);
  h.get('share-dialog-copy-link').click();
  await h.flush();
  assert.deepEqual(h.copied, [h.win.eventUrl]);
});

test('WhatsApp and email invitations retain the exact localized event URL and current title', async t => {
  const h = await harness(t, { locale: 'fr' });
  h.win.cloudTitle = 'Fête & amis 💛';
  h.get('share-cloud').click();
  const whatsapp = new URL(h.get('share-whatsapp').href);
  const email = new URL(h.get('share-email').href);
  const message = whatsapp.searchParams.get('text');
  assert.equal(whatsapp.origin, 'https://wa.me');
  assert.equal(email.protocol, 'mailto:');
  assert.equal(email.searchParams.get('subject'), translate('{{name}} – Wolkenworte', 'fr', { name: h.win.cloudTitle }));
  assert.equal(email.searchParams.get('body'), message);
  assert.ok(message.includes(h.win.cloudTitle));
  assert.ok(message.endsWith(`https://example.test/e/${slug}?lang=fr`));
});

test('the dialog copies the event link and clears its success feedback', async t => {
  const h = await harness(t, { locale: 'en' });
  h.get('share-cloud').click();
  h.get('share-dialog-copy-link').click();
  await h.flush();
  assert.deepEqual(h.copied, [`https://example.test/e/${slug}?lang=en`]);
  assert.equal(h.get('share-feedback').textContent, translate('Link kopiert ✓', 'en'));
  assert.equal(h.get('share-dialog-copy-link').textContent.trim(), translate('Link kopiert ✓', 'en'));
  assert.deepEqual(h.tracked, [['share_open'], ['share', { method: 'copy_link' }]]);
  for (const callback of h.timers.values()) callback();
  assert.equal(h.get('share-feedback').textContent, '');
  assert.equal(h.get('share-dialog-copy-link').textContent.trim(), translate('Link kopieren', 'en'));
});

test('clipboard failures keep the share options available and show an actionable error', async t => {
  const h = await harness(t);
  h.win.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  h.get('share-cloud').click();
  h.get('share-dialog-copy-link').click();
  await h.flush();
  assert.equal(h.dialog.open, true);
  assert.equal(h.opens(), 1);
  assert.equal(h.get('share-feedback').textContent, translate('Der Link konnte nicht automatisch kopiert werden.', 'de'));
  assert.deepEqual(h.tracked, [['share_open']]);
});

test('copying without the clipboard API removes its temporary input', async t => {
  const h = await harness(t, { secureClipboard: false });
  h.win.document.execCommand = command => {
    assert.equal(command, 'copy');
    assert.equal(h.win.document.querySelector('textarea').value, h.win.eventUrl);
    return true;
  };
  h.get('share-cloud').click();
  h.get('share-dialog-copy-link').click();
  await h.flush();
  assert.equal(h.win.document.querySelector('textarea'), null);
  assert.equal(h.get('share-feedback').textContent, translate('Link kopiert ✓', 'de'));
});

test('dialog content stays open while a backdrop click closes it', async t => {
  const h = await harness(t);
  h.get('share-cloud').click();
  h.dialog.querySelector('.share-dialog-qr strong').click();
  assert.equal(h.dialog.open, true);
  h.dialog.click();
  assert.equal(h.dialog.open, false);
});
