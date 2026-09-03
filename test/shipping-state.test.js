'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../views/shipping.ejs'), 'utf8');
function pageFunction(name) {
  const start = source.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
}
function listener(prefix) {
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, prefix);
  return source.slice(start, source.indexOf('\n    });', start) + 8);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(result, status = 200) {
  return { ok: status < 400, status, json: async () => result };
}
function harness(fetcher) {
  const handlers = {};
  function element() {
    const classes = new Set();
    return { disabled: false, hidden: false, textContent: '', inert: false,
      classList: { contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
      addEventListener: (name, action) => { handlers[name] = action; },
      querySelectorAll: () => [], reportValidity: () => true,
    };
  }
  const calls = { fetches: 0, shown: [], navigation: [] };
  const scope = vm.createContext({
    AbortController, AbortSignal, setTimeout, clearTimeout,
    slug: 'shipping-test', guestId: 'a'.repeat(32), configurationIds: ['a'.repeat(16)],
    configurations: [], currentQuote: null, shippingRevision: 0, activeShippingRequest: null,
    submitButton: element(), checkoutButton: element(), form: element(), formError: element(),
    checkoutError: element(), quoteResult: element(), quotePlaceholder: element(),
    setText: (node, value) => { node.textContent = value; }, clearText: node => { node.textContent = ''; },
    setButtonLabel: (node, value) => { node.label = value; },
    customerErrorSource: (result, fallback) => result.message || fallback,
    customerError: customerSource => Object.assign(new Error(customerSource), { customerSource }),
    markInvalidFields() {}, saveShippingDraft() {},
    collectShipments: () => ({ shipments: [{ recipient: { city: 'Berlin' }, items: [] }], totalQuantity: 1 }),
    WolkenworteI18n: { getLocale: () => 'de' },
    WolkenworteActions: { setBusy: (node, busy) => { node.disabled = busy; node.classList.toggle('ww-is-busy', busy); } },
    location: { assign: url => calls.navigation.push(url) },
    fetch: (...args) => { calls.fetches++; return fetcher(...args); },
  });
  scope.showQuote = quote => { scope.currentQuote = quote; calls.shown.push(quote); };
  const functions = ['clearFieldErrors', 'clearQuote'];
  for (const name of ['fetchShippingJson', 'finishShippingRequest', 'cancelShippingRequest']) {
    if (source.includes(`function ${name}(`)) functions.push(name);
  }
  vm.runInContext(functions.map(pageFunction).join('\n') + '\n' +
    listener("    form.addEventListener('submit',") + '\n' +
    listener("    checkoutButton.addEventListener('click',"), scope);
  return { scope, calls, submit: () => handlers.submit({ preventDefault() {} }), checkout: () => handlers.click() };
}

test('editing an address while pricing is pending cannot display the old address quote', async () => {
  const pending = deferred();
  const page = harness(() => pending.promise);
  const action = page.submit();
  page.scope.clearQuote(); // Actual input/change handler, while response is delayed.
  pending.resolve(response({ quote: { id: 'old-address-price' } }));
  await action;
  assert.equal(page.calls.shown.length, 0);
  assert.equal(page.scope.currentQuote, null);
  assert.equal(page.scope.submitButton.disabled, false);
});

test('repeated form submit during one pricing request does not send a second request', async () => {
  const pending = deferred();
  const page = harness(() => pending.promise);
  const first = page.submit();
  const second = page.submit();
  pending.resolve(response({ quote: { id: 'current-price' } }));
  await Promise.all([first, second]);
  assert.equal(page.calls.fetches, 1);
  assert.equal(page.calls.shown.length, 1);
});

test('a network failure during pricing restores controls and does not blame valid address fields', async () => {
  const page = harness(async () => { throw new TypeError('network unavailable'); });
  await page.submit();
  assert.equal(page.scope.submitButton.disabled, false);
  assert.match(page.scope.formError.textContent, /Gesamtpreis konnte gerade nicht berechnet/);
  assert.equal(page.scope.currentQuote, null);
});

test('a cancelled-checkout quote never replaces newer address or quantity edits on reload', async () => {
  const oldShipments = [{ recipient: { name: 'Test', city: 'Berlin', zip: '10115' },
    items: [{ configurationId: 'a'.repeat(16), quantity: 1 }] }];
  const page = harness(async () => response({ shipments: oldShipments, quote: { id: 'old-price' } }));
  Object.assign(page.scope, {
    savedQuoteId: 'a'.repeat(24), checkoutWasCancelled: true,
    renderShipments: shipments => { page.calls.rendered = shipments; },
  });
  vm.runInContext(pageFunction('shippingSnapshot') + '\n' + pageFunction('restoreSavedQuote'), page.scope);
  for (const change of ['address', 'quantity']) {
    const draft = structuredClone(oldShipments);
    if (change === 'address') draft[0].recipient.city = 'Hamburg';
    else draft[0].items[0].quantity = 2;
    await page.scope.restoreSavedQuote(draft);
    assert.equal(page.calls.rendered, undefined, 'The newer form must remain untouched');
    assert.equal(page.scope.currentQuote, null);
    assert.match(page.scope.formError.textContent, /neu berechnet/);
  }
  await page.scope.restoreSavedQuote(structuredClone(oldShipments));
  assert.equal(page.scope.currentQuote.id, 'old-price', 'An unchanged draft may resume its quote');
  assert.match(page.scope.checkoutError.textContent, /Zahlung abgebrochen/);
  page.calls.rendered = undefined;
  await page.scope.restoreSavedQuote(null);
  assert.deepEqual(page.calls.rendered, oldShipments, 'A browser without a draft can restore the saved quote');
});

test('checkout locks address editing and rejects duplicate payment and pricing actions', async () => {
  const pending = deferred();
  const page = harness(() => pending.promise);
  page.scope.currentQuote = { id: 'confirmed-price' };
  const first = page.checkout();
  await page.checkout();
  await page.submit();
  assert.equal(page.scope.form.inert, true);
  assert.equal(page.scope.submitButton.disabled, true);
  assert.equal(page.calls.fetches, 1);
  pending.resolve(response({ message: 'Vorübergehend nicht verfügbar' }, 503));
  await first;
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
  assert.equal(page.scope.submitButton.disabled, false);
});

test('leaving aborts an old request and its late result cannot unlock or navigate a new action', async () => {
  const responses = [deferred(), deferred()];
  const signals = [];
  const page = harness((url, options) => {
    signals.push(options.signal);
    return responses[signals.length - 1].promise;
  });
  page.scope.currentQuote = { id: 'confirmed-price' };
  const old = page.checkout();
  page.scope.cancelShippingRequest();
  assert.equal(signals[0].aborted, true);
  assert.equal(page.scope.form.inert, false);
  const latest = page.checkout();
  responses[0].resolve(response({ url: '/must-not-open' }));
  await old;
  assert.deepEqual(page.calls.navigation, []);
  assert.equal(page.scope.form.inert, true);
  assert.equal(page.scope.checkoutButton.disabled, true);
  responses[1].resolve(response({ error: 'quote_changed', message: 'Neuer Preis', quote: { id: 'new-price' } }, 409));
  await latest;
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
  assert.equal(page.scope.checkoutButton.label, 'Neuen Gesamtpreis bestätigen');
});

test('deadline covers response body stalls and permits a safe retry after a checkout timeout', async () => {
  let expire;
  let canceled = 0;
  let savedSignal;
  const bodyStarted = deferred();
  const page = harness(async (url, options) => {
    savedSignal = options.signal;
    return { ok: true, json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      bodyStarted.resolve();
    }) };
  });
  page.scope.setTimeout = (callback, delay) => { assert.equal(delay, 20000); expire = callback; return 42; };
  page.scope.clearTimeout = handle => { assert.equal(handle, 42); canceled++; };
  page.scope.currentQuote = { id: 'unchanged-server-idempotency-key' };
  const action = page.checkout();
  await bodyStarted.promise;
  expire();
  await action;
  assert.equal(savedSignal.aborted, true);
  assert.equal(canceled, 1);
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
  assert.equal(page.scope.currentQuote.id, 'unchanged-server-idempotency-key');
  assert.deepEqual(page.calls.navigation, []);
});

test('updated delivery terms remain visible and require an explicit second checkout action', async () => {
  const page = harness(async () => response({ error: 'quote_shipping_changed',
    message: 'Die Lieferangaben haben sich geändert.', quote: { id: 'updated-shipping' } }, 409));
  page.scope.currentQuote = { id: 'old-shipping' };
  await page.checkout();
  assert.equal(page.scope.currentQuote.id, 'updated-shipping');
  assert.equal(page.scope.checkoutButton.label, 'Aktualisierte Lieferung bestätigen');
  assert.deepEqual(page.calls.navigation, []);
  assert.equal(page.scope.checkoutButton.disabled, false);
});

test('invalid JSON does not leave checkout busy or navigate to an undefined destination', async () => {
  const page = harness(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
  page.scope.currentQuote = { id: 'confirmed-price' };
  await page.checkout();
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
  assert.match(page.scope.checkoutError.textContent, /Zahlungsseite konnte gerade nicht geöffnet/);
  assert.deepEqual(page.calls.navigation, []);
});

test('a failed location assignment also restores checkout controls', async () => {
  const page = harness(async () => response({ url: '/checkout' }));
  page.scope.currentQuote = { id: 'confirmed-price' };
  page.scope.location.assign = () => { throw new Error('navigation rejected'); };
  await page.checkout();
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
});
