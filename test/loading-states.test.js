'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { translate } = require('../src/i18n');
const { renderPage } = require('../src/pageRenderer');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const configurator = read('views/configure.ejs');
const shipping = read('views/shipping.ejs');
const display = read('views/display.ejs');
function pageFunction(source, name, indent = '    ') {
  const start = source.search(new RegExp(indent + '(?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  const end = source.indexOf('\n' + indent + '}', start);
  return source.slice(start, end + indent.length + 2);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function restoredEntry() {
  return { URLSearchParams, location: { search: '?edit=existing-design' },
    directDesign: false, words: [['Liebe', 1]],
    WolkenworteProductGallery: require('../public/js/product-gallery'), updateProductBackLink() {}, analyticsEditorView() {} };
}

const messages = [
  'Euer Design wird geöffnet…', 'Euer Design wird wiederhergestellt…', 'Euer Design wird aktualisiert…',
  'Euer Design wird geladen…', 'Euer Design wird in den Warenkorb gelegt…', 'Eure Änderungen werden gespeichert…',
  'Warenkorb und Lieferangaben werden geladen…', 'Preise und Lieferung werden geprüft…',
  'Die Zahlungsseite wird geöffnet…', 'Wir warten auf die Zahlungsbestätigung.',
  'Designs werden in den Warenkorb übernommen…', 'Die aktuellen Wörter werden geladen…', 'Eure Wortwolke wird geladen…',
  'Eure Produktübersicht wird geladen…', 'Eure Produktvorschau wird vorbereitet…', 'Die Produktvorschau wird geladen…',
];

test('every new loading state has an explicit translation in every supported language', () => {
  for (const locale of ['en', 'fr', 'it', 'es', 'tr']) {
    const catalog = JSON.parse(read('public/locales/' + locale + '.json'));
    for (const source of messages) {
      assert.ok(Object.hasOwn(catalog, source), `${locale}: ${source}`);
      assert.ok(catalog[source].trim());
      assert.equal(translate(source, locale), catalog[source]);
      assert.notEqual(translate(source, locale), source, `${locale}: no German fallback`);
    }
  }
});

test('both configurator entry paths and shipping render the destination loader in all six languages', async () => {
  for (const locale of ['de', 'en', 'fr', 'it', 'es', 'tr']) {
    for (const [view, directDesign, source, editorEntry] of [
      ['configure', false, 'Eure Produktübersicht wird geladen…', false],
      ['configure', true, 'Eure Produktübersicht wird geladen…', false],
      ['configure', false, messages[0], true], ['shipping', false, messages[6], false],
    ]) {
      let html;
      await renderPage({ query: { lang: locale }, headers: {}, originalUrl: '/' }, {
        cookie() {}, status() {}, set() {}, vary() {}, send(value) { html = value; },
      }, view, { pageData: { directDesign, editorEntry } });
      const loader = html.match(/<div class="loading"[\s\S]*?<\/div>/)?.[0];
      assert.ok(loader.includes(translate(source, locale)), `${locale}/${view}/${directDesign}`);
      assert.match(loader, /role="status"/);
    }
  }
});

test('the configurator remains hidden until restoration finishes and paints before dismissing its loader', async () => {
  const pending = deferred();
  const events = [];
  const scope = vm.createContext({
    ...restoredEntry(),
    content: { hidden: true }, loading: { hidden: false },
    initializeWorkspace: () => pending.promise,
    refreshWorkspaceLayout() { assert.equal(scope.content.hidden, false); events.push('measure'); },
    renderAll() { assert.equal(scope.loading.hidden, false); events.push('paint'); },
  });
  vm.runInContext(pageFunction(configurator, 'showReadyWorkspace'), scope);
  const ready = scope.showReadyWorkspace();
  await Promise.resolve();
  assert.equal(scope.content.hidden, true);
  assert.equal(scope.loading.hidden, false);
  assert.deepEqual(events, []);
  pending.resolve();
  await ready;
  assert.equal(scope.content.hidden, false);
  assert.equal(scope.loading.hidden, true);
  assert.deepEqual(events, ['measure', 'paint']);
});

test('an unexpected initialization failure leaves the loader visible for startup error handling', async () => {
  const scope = vm.createContext({
    ...restoredEntry(),
    content: { hidden: true }, loading: { hidden: false },
    initializeWorkspace: async () => { throw new Error('initialization_failed'); },
    refreshWorkspaceLayout() { assert.fail('must not reveal a partial workspace'); }, renderAll() {},
  });
  vm.runInContext(pageFunction(configurator, 'showReadyWorkspace'), scope);
  await assert.rejects(scope.showReadyWorkspace(), /initialization_failed/);
  assert.equal(scope.content.hidden, true);
  assert.equal(scope.loading.hidden, false);
});

test('shipping progress restores the prior label while preserving newer success or retry actions', () => {
  const scope = vm.createContext({
    setButtonLabel(button, source) { button.dataset.labelSource = source; },
    WolkenworteActions: { setBusy(button, busy) { button.busy = busy; } },
  });
  vm.runInContext(pageFunction(shipping, 'setShippingActionBusy'), scope);
  for (const [idle, progress] of [
    ['Preise aktualisieren', 'Preise und Lieferung werden geprüft…'],
    ['Weiter zur Zahlung', 'Die Zahlungsseite wird geöffnet…'],
  ]) {
    const button = { dataset: { labelSource: idle } };
    scope.setShippingActionBusy(button, true, progress);
    assert.equal(button.dataset.labelSource, progress);
    scope.setShippingActionBusy(button, false);
    assert.equal(button.dataset.labelSource, idle);
    assert.equal(button.busy, false);
    scope.setShippingActionBusy(button, true, progress);
    button.dataset.labelSource = 'Neue Preise bestätigen';
    scope.setShippingActionBusy(button, false);
    assert.equal(button.dataset.labelSource, 'Neue Preise bestätigen');
    assert.equal(button.dataset.idleLabelSource, undefined);
  }
});

test('configurator progress survives cart refreshes and resets both button and workspace messages', () => {
  function element() {
    const classes = new Set();
    return { hidden: true, disabled: false, textContent: '',
      classList: { contains: key => classes.has(key), toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } },
    };
  }
  const statuses = [element(), element()];
  const scope = vm.createContext({
    document: { querySelectorAll: selector => selector === '[data-configurator-progress]' ? statuses : [] },
    saveDesignButton: element(), continueOrderButton: element(), continueOrderLabel: element(), designAnotherButton: element(), productInfoButton: element(),
    checkoutPanel: { setAttribute() {} }, content: { querySelectorAll: () => [] }, orderList: { querySelectorAll: () => [] },
    loadOrderItems: () => [{ id: 'a'.repeat(16) }], editingOrderItemId: null,
    directDesign: false, words: [['liebe', 1]], updateCloudNotice() {},
    updateAccountSaveState() {}, updateCartDraftMarkers() {},
    orderActionPending: true, fitAreaPending: false, workspaceReady: true, restorationFailed: false, currentDesignNeedsSave: true,
    setText: (element, source) => { element.textContent = translate(source, 'en'); },
    clearText: element => { element.textContent = ''; },
    WolkenworteActions: { setBusy(element, busy) { element.classList.toggle('ww-is-busy', busy); } },
  });
  vm.runInContext(['setOrderActionsBusy', 'updateCartActions'].map(name => pageFunction(configurator, name)).join('\n'), scope);
  scope.setOrderActionsBusy(true, scope.continueOrderButton, 'Eure Änderungen werden gespeichert…');
  scope.updateCartActions();
  assert.equal(scope.continueOrderLabel.textContent, 'Saving your changes…');
  assert.ok(statuses.every(status => status.hidden));
  scope.orderActionPending = false;
  scope.setOrderActionsBusy(false);
  assert.equal(scope.continueOrderLabel.textContent, 'Continue to shipping');
  scope.setOrderActionsBusy(true, null, 'Euer Design wird aktualisiert…');
  assert.ok(statuses.every(status => !status.hidden && status.textContent === 'Updating your design…'));
  scope.setOrderActionsBusy(false);
  assert.ok(statuses.every(status => status.hidden && status.textContent === ''));
});

test('returning through browser history clears shipping progress labels', () => {
  const start = shipping.indexOf("    window.addEventListener('pageshow'");
  const source = shipping.slice(start, shipping.indexOf('\n    });', start) + 8);
  let onShow;
  const scope = vm.createContext({
    window: { addEventListener: (_, callback) => { onShow = callback; } },
    submitButton: { dataset: { labelSource: 'Preise und Lieferung werden geprüft…', idleLabelSource: 'Preise aktualisieren' } },
    checkoutButton: { dataset: { labelSource: 'Die Zahlungsseite wird geöffnet…', idleLabelSource: 'Weiter zur Zahlung' } },
    setButtonLabel(button, value) { button.dataset.labelSource = value; },
    WolkenworteActions: { setBusy(button, busy) { button.busy = busy; } },
    shippingReturnIsStale: () => false,
  });
  vm.runInContext(pageFunction(shipping, 'setShippingActionBusy') + '\n' + source, scope);
  onShow({ persisted: true });
  assert.equal(scope.submitButton.dataset.labelSource, 'Preise aktualisieren');
  assert.equal(scope.checkoutButton.dataset.labelSource, 'Weiter zur Zahlung');
  assert.equal(scope.checkoutButton.busy, false);
});

test('word-cloud loading appears only for a slow initial render and is cancelled on completion or reset', () => {
  let id = 0, visible = false;
  const timers = new Map();
  const fire = () => { const callback = timers.get(id); timers.delete(id); callback(); };
  const scope = vm.createContext({
    cloudLoading: { hidden: true }, cloudLoadingTimer: null, currentWords: [['Love', 1]],
    canvas: { classList: { contains: () => visible } },
    setTimeout(callback, delay) { assert.equal(delay, 150); timers.set(++id, callback); return id; },
    clearTimeout(key) { timers.delete(key); },
  });
  vm.runInContext(['showCloudLoading', 'hideCloudLoading'].map(name => pageFunction(display, name, '  ')).join('\n'), scope);
  scope.showCloudLoading();
  scope.showCloudLoading();
  assert.equal(timers.size, 1);
  assert.equal(scope.cloudLoading.hidden, true);
  fire();
  assert.equal(scope.cloudLoading.hidden, false);
  scope.hideCloudLoading();
  assert.equal(scope.cloudLoading.hidden, true);
  visible = true;
  scope.showCloudLoading();
  assert.equal(timers.size, 0, 'live updates keep their existing cloud visible');
  visible = false;
  scope.showCloudLoading();
  scope.currentWords = [];
  fire();
  assert.equal(scope.cloudLoading.hidden, true, 'an empty cloud keeps its invitation instead');
  scope.hideCloudLoading();
  assert.equal(timers.size, 0);
});
