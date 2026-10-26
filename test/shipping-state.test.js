'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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
function preparedQuote(id) {
  return { id, checkoutPrepared: true };
}
function harness(fetcher) {
  const handlers = {};
  function element() {
    const classes = new Set();
    return { disabled: false, hidden: false, textContent: '', inert: false, dataset: {},
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
    checkoutError: element(), quoteResult: element(), shipmentList: element(), findConfiguration: () => null,
    setText: (node, value) => { node.textContent = value; }, clearText: node => { node.textContent = ''; },
    setButtonLabel: (node, value) => { node.label = value; node.dataset.labelSource = value; },
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
  const functions = ['setShippingActionBusy', 'clearFieldErrors', 'updateDeliveryRestrictions', 'clearQuote'];
  for (const name of ['fetchShippingJson', 'finishShippingRequest', 'cancelShippingRequest']) {
    if (source.includes(`function ${name}(`)) functions.push(name);
  }
  vm.runInContext(functions.map(pageFunction).join('\n') + '\n' +
    listener("    form.addEventListener('submit',") + '\n' +
    listener("    checkoutButton.addEventListener('click',"), scope);
  return { scope, calls, submit: () => handlers.submit({ preventDefault() {} }), checkout: () => handlers.click() };
}

test('shipping cart review removes only the chosen item and keeps last-item removal recoverable', () => {
  for (const initial of [
    [{ id: 'a'.repeat(16) }, { id: 'b'.repeat(16) }],
    [{ id: 'a'.repeat(16) }],
  ]) {
    let items = structuredClone(initial);
    const removedFromDraft = [];
    const navigation = [];
    const scope = vm.createContext({
      slug: 'shipping-test',
      cart: { read: () => items, remove: id => { items = items.filter(item => item.id !== id); } },
      shippingDraft: { removeConfigurations: ids => removedFromDraft.push(...ids) },
      saveShippingDraft() {},
      collectShipments: () => ({ shipments: [{ items: [] }] }),
      location: { assign: url => navigation.push(url) },
      setText() {}, formError: {},
    });
    vm.runInContext(['configureHref', 'shippingHref', 'removeConfigurationFromCart']
      .map(pageFunction).join('\n'), scope);
    scope.removeConfigurationFromCart('a'.repeat(16));
    assert.deepEqual(Array.from(items, item => item.id), initial.length === 2 ? ['b'.repeat(16)] : []);
    assert.deepEqual(removedFromDraft, ['a'.repeat(16)]);
    assert.match(navigation[0], initial.length === 2
      ? /shipping\?configuration=bbbbbbbbbbbbbbbb&edit=bbbbbbbbbbbbbbbb$/
      : /configure\?edit=aaaaaaaaaaaaaaaa$/);
  }
});

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
  const requests = [];
  const page = harness((url, options) => {
    requests.push({ url, body: options?.body && JSON.parse(options.body) });
    return requests.length === 1
      ? pending.promise
      : Promise.resolve(response({ quote: preparedQuote('current-price') }));
  });
  const first = page.submit();
  const second = page.submit();
  pending.resolve(response({ quote: { id: 'current-price' } }));
  await Promise.all([first, second]);
  assert.equal(page.calls.fetches, 2, 'one estimate and one final Checkout Session preparation');
  assert.match(requests[0].url, /estimate-costs$/);
  assert.match(requests[1].url, /checkout$/);
  assert.equal(requests[1].body.intent, 'prepare');
  assert.equal(page.calls.shown.length, 1);
  assert.equal(page.scope.currentQuote.checkoutPrepared, true);
});

test('a network failure during pricing restores controls and does not blame valid address fields', async () => {
  const page = harness(async () => { throw new TypeError('network unavailable'); });
  await page.submit();
  assert.equal(page.scope.submitButton.disabled, false);
  assert.match(page.scope.formError.textContent, /Preise und Lieferung konnten gerade nicht geprüft/);
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
    assert.match(page.scope.formError.textContent, /erneut/);
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
  page.scope.currentQuote = preparedQuote('confirmed-price');
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
  page.scope.currentQuote = preparedQuote('confirmed-price');
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
  assert.equal(page.scope.checkoutButton.disabled, true);
  assert.equal(page.scope.submitButton.label, 'Neue Preise bestätigen');
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
  page.scope.currentQuote = preparedQuote('unchanged-server-idempotency-key');
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
  page.scope.currentQuote = preparedQuote('old-shipping');
  await page.checkout();
  assert.equal(page.scope.currentQuote.id, 'updated-shipping');
  assert.equal(page.scope.submitButton.label, 'Aktualisierte Lieferung bestätigen');
  assert.deepEqual(page.calls.navigation, []);
  assert.equal(page.scope.checkoutButton.disabled, true);
});

test('invalid JSON does not leave checkout busy or navigate to an undefined destination', async () => {
  const page = harness(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
  page.scope.currentQuote = preparedQuote('confirmed-price');
  await page.checkout();
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
  assert.match(page.scope.checkoutError.textContent, /Zahlungsseite konnte gerade nicht geöffnet/);
  assert.deepEqual(page.calls.navigation, []);
});

test('a failed location assignment also restores checkout controls', async () => {
  const page = harness(async () => response({ url: '/checkout' }));
  page.scope.currentQuote = preparedQuote('confirmed-price');
  page.scope.location.assign = () => { throw new Error('navigation rejected'); };
  await page.checkout();
  assert.equal(page.scope.form.inert, false);
  assert.equal(page.scope.checkoutButton.disabled, false);
});

test('an explicit Printful failure invalidates the quote and prevents another checkout click', async () => {
  for (const error of ['shipping_unavailable', 'selection_not_available', 'pricing_unavailable']) {
    const page = harness(async () => response({ error, message: 'Lieferung konnte nicht bestätigt werden.' }, 422));
    page.scope.currentQuote = preparedQuote('previously-valid');
    await page.checkout();
    assert.equal(page.scope.currentQuote, null);
    assert.equal(page.scope.checkoutButton.disabled, true);
    assert.equal(page.scope.submitButton.disabled, false);
    assert.match(page.scope.formError.textContent, /Lieferung konnte nicht bestätigt/);
    await page.checkout();
    assert.equal(page.calls.fetches, 1);
    assert.deepEqual(page.calls.navigation, []);
  }
});

test('a failed price refresh removes the previous quote and keeps checkout disabled', async () => {
  const page = harness(async () => response({ error: 'shipping_unavailable', message: 'Keine Lieferung möglich.' }, 422));
  page.scope.currentQuote = { id: 'old-price' };
  await page.submit();
  assert.equal(page.scope.currentQuote, null);
  assert.equal(page.scope.quoteResult.hidden, true);
  assert.equal(page.scope.checkoutButton.disabled, true);
  assert.match(page.scope.formError.textContent, /Keine Lieferung möglich/);
});

test('the shipping summary shows Stripe tax and gross total only for a prepared Checkout Session', () => {
  const nodes = Object.fromEntries([
    'items-label', 'items-price', 'shipping-price', 'tax-row', 'tax-price', 'total-label', 'total-price',
  ].map((id) => [id, { hidden: false, textContent: '' }]));
  const quoteResult = { hidden: true, scrollIntoView() {} };
  const checkoutButton = {
    disabled: true,
    classList: { contains: () => false },
  };
  const scope = vm.createContext({
    currentQuote: null,
    quoteResult,
    checkoutButton,
    checkoutError: { textContent: '' },
    document: { getElementById: id => nodes[id] },
    shipmentList: { querySelectorAll: () => [] },
    totalProductLabel: quantity => `${quantity} products`,
    formatMoney: (cents, currency) => `${cents} ${currency}`,
    renderDeliveryInformation() {},
    setText: (node, value) => { node.textContent = value; },
    clearText: node => { node.textContent = ''; },
    setButtonLabel: (node, value) => { node.label = value; },
    customerError: value => new Error(value),
  });
  vm.runInContext(pageFunction('showQuote'), scope);

  scope.showQuote({
    id: 'prepared', currency: 'EUR', quantity: 1, itemsCents: 800, shippingCents: 200,
    taxCents: 190, totalCents: 1190, checkoutPrepared: true,
  }, { scroll: false });
  assert.equal(nodes['tax-row'].hidden, false);
  assert.equal(nodes['tax-price'].textContent, '190 EUR');
  assert.equal(nodes['total-label'].textContent, 'Gesamtbetrag');
  assert.equal(nodes['total-price'].textContent, '1190 EUR');
  assert.equal(checkoutButton.disabled, false);

  scope.showQuote({
    id: 'estimate-only', currency: 'EUR', quantity: 1, itemsCents: 800, shippingCents: 200,
    taxCents: 0, totalCents: 1000, checkoutPrepared: false,
  }, { scroll: false });
  assert.equal(nodes['tax-row'].hidden, true);
  assert.equal(nodes['total-label'].textContent, 'Zwischensumme');
  assert.equal(nodes['total-price'].textContent, '1000 EUR');
  assert.equal(checkoutButton.disabled, true);
});

test('shipping displays compact confirmed gross lines for both tax modes and clears stale destination prices', () => {
  const nodes = Object.fromEntries(['items-label', 'items-price', 'shipping-price', 'tax-row', 'tax-label',
    'tax-price', 'total-label', 'total-price'].map(id => [id, {}]));
  const row = { dataset: { referencePrice: '22,14 €' } };
  const note = {};
  const page = harness(async () => response({}));
  Object.assign(page.scope, {
    document: { getElementById: id => nodes[id] },
    totalProductLabel: count => String(count), formatMoney: cents => String(cents), renderDeliveryInformation() {},
    t: (text, values) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]),
    WolkenworteI18n: { formatNumber: String },
  });
  page.scope.shipmentList.querySelector = () => row;
  page.scope.shipmentList.querySelectorAll = selector => selector === '[data-item-price]' ? [row]
    : selector === '[data-product-price-note]' ? [note] : [];
  vm.runInContext(pageFunction('setProductPriceNote') + '\n' + pageFunction('showQuote'), page.scope);
  for (const quote of [
    { itemsCents: 4171, shippingCents: 1484, taxCents: 903, totalCents: 5655,
      grossItemsCents: 4171, grossShippingCents: 1484, taxBehavior: 'inclusive', itemGross: 2214 },
    { itemsCents: 3505, shippingCents: 1247, taxCents: 950, totalCents: 5702,
      grossItemsCents: 4206, grossShippingCents: 1496, taxBehavior: 'exclusive', itemGross: 2232 },
  ]) {
    const prepared = { id: 'new-price', currency: 'EUR', pricingVersion: 2, quantity: 3,
      checkoutPrepared: true, ...quote,
      pricedItems: [{ configurationId: 'mug', quantity: 2, grossTotalCents: quote.itemGross }],
    };
    page.scope.showQuote(prepared, { scroll: false });
    assert.equal(nodes['items-price'].textContent, String(quote.grossItemsCents));
    assert.equal(nodes['shipping-price'].textContent, String(quote.grossShippingCents));
    assert.equal(nodes['tax-label'].textContent, 'Davon MwSt.');
    assert.equal(nodes['total-price'].textContent, String(quote.totalCents));
    assert.equal(row.textContent, String(quote.itemGross));
    assert.doesNotMatch(note.textContent, /19 %/, 'confirmed foreign prices must not claim the German reference tax rate');
    assert.equal(page.scope.quoteResult.hidden, false);
    assert.throws(() => page.scope.showQuote({ ...prepared, totalCents: quote.totalCents + 1 }, { scroll: false }));
    page.scope.clearQuote();
    assert.equal(row.textContent, row.dataset.referencePrice, 'an edited address cannot retain an old final item price');
    assert.match(note.textContent, /19 %/, 'an edited address restores the clearly identified German reference price');
    assert.equal(page.scope.quoteResult.hidden, true);
    page.scope.showQuote({ ...prepared, checkoutPrepared: false }, { scroll: false });
    assert.equal(page.scope.quoteResult.hidden, true, 'foreign net estimates are never presented as final gross totals');
  }
});

test('shipping item totals follow quantity controls and preserve zero exclusion without a separate quantity caption', t => {
  const dom = new JSDOM('<div id="items"></div>');
  t.after(() => dom.window.close());
  const { document, Event } = dom.window;
  const item = { id: 'a'.repeat(16), product: { displayName: 'Tasse', maxQuantity: 3,
    price: { unitGrossCents: 1107, currency: 'EUR' } } };
  const page = harness(async () => response({}));
  const translate = (source, values = {}) => require('../src/i18n').translate(source, 'en', values);
  Object.assign(page.scope, {
    document, shipmentList: document.getElementById('items'), findConfiguration: () => item,
    t: translate, setText: (node, source, values) => { node.textContent = translate(source, values); },
    setTranslatedAttribute: (node, name, source, values) => node.setAttribute(name, translate(source, values)),
    configurationSizeText: () => '325 ml', configureHref: id => `/configure?edit=${id}`,
    itemFieldPath: (index, id) => `${index}.${id}`,
    shipmentItemsById: shipment => new Map(shipment.items.map(item => [item.configurationId, item.quantity])),
    formatMoney: (cents, currency) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100),
    WolkenworteCartProductPreview: { createThumbnails: () => document.createElement('div') },
  });
  vm.runInContext(['setProductPriceNote', 'updateQuantityButtons', 'createShipmentProductRow'].map(pageFunction).join('\n'), page.scope);
  const row = page.scope.createShipmentProductRow(item, { items: [{ configurationId: item.id, quantity: 1 }] }, 0);
  page.scope.shipmentList.append(row);
  const price = row.querySelector('[data-item-price]'), quantity = row.querySelector('[data-item-quantity]');
  assert.equal(price.textContent, '€11.07');
  row.querySelector('[data-quantity-plus]').click();
  assert.equal(quantity.value, '2');
  assert.equal(price.textContent, '€22.14');
  assert.equal(price.dataset.referencePrice, '€22.14', 'clearing an old quote retains the updated quantity total');
  quantity.value = '0'; quantity.dispatchEvent(new Event('input'));
  assert.equal(price.textContent, '€0.00');
  assert.equal(row.querySelector('[data-quantity-excluded]').hidden, false);
  assert.equal(row.querySelector('[data-quantity-minus]').disabled, true);
  quantity.value = '3'; quantity.dispatchEvent(new Event('input'));
  assert.equal(price.textContent, '€33.21');
  assert.equal(row.querySelector('[data-quantity-excluded]').hidden, true);
  assert.equal(row.querySelector('[data-quantity-plus]').disabled, true);
  quantity.value = '1.5'; quantity.dispatchEvent(new Event('input'));
  assert.equal(price.textContent, '', 'an invalid quantity never displays a misleading partial-cent item total');
});

function deliveryLines(delivery, { shipments = [{ customsFeesPossible: false, departureCountry: 'LV', items: [] }], locale = 'de' } = {}) {
  const lines = [];
  const translate = (text, params) => require('../src/i18n').translate(text, locale, params);
  const scope = vm.createContext({
    Intl, Date, configurations: [], t: translate,
    WolkenworteI18n: { getLocale: () => locale, formatNumber: number => new Intl.NumberFormat(locale).format(number) },
    setText: (node, text, params) => { node.textContent = translate(text, params); },
    document: { getElementById: () => ({ replaceChildren() {}, appendChild: node => lines.push(node.textContent) }), createElement: () => ({}) },
  });
  vm.runInContext(pageFunction('renderDeliveryInformation'), scope);
  scope.renderDeliveryInformation({ delivery, shipments });
  return lines;
}

test('delivery shows days and a compact date range without repeating products or countries', () => {
  const lines = deliveryLines({ minDays: 5, maxDays: 7, minDate: '2026-09-10', maxDate: '2026-09-12' });
  assert.match(lines[0], /^Voraussichtliche Lieferung: 5–7 Tage \(10\.\s*–\s*12\. September 2026\)$/);
  assert.equal(lines[1], 'Die Lieferzeit ist eine Schätzung und kann sich ändern.');
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.join(' '), /Lettland|Versandland|Produkt/);
});

test('delivery handles single days, month and year boundaries, and missing API fields', () => {
  assert.match(deliveryLines({ minDays: 1, maxDays: 1, minDate: '2026-09-10', maxDate: '2026-09-10' })[0], /1 Tag \(10\. September 2026\)/);
  assert.match(deliveryLines({ minDays: 5, maxDays: 7 })[0], /5–7 Tage$/);
  assert.match(deliveryLines({ minDate: '2026-09-30', maxDate: '2026-10-02' })[0], /September.*Oktober/);
  assert.match(deliveryLines({ minDate: '2026-12-31', maxDate: '2027-01-02' })[0], /2026.*2027/);
  assert.match(deliveryLines(null)[0], /Lieferzeit.*nicht verfügbar/);
  assert.match(deliveryLines({ minDays: 5, maxDays: 7 }, { locale: 'en' })[0], /Estimated delivery: 5–7 days/);
});

test('customs warnings still identify affected products without disclosing departure countries', () => {
  const lines = deliveryLines(null, { shipments: [
    { customsFeesPossible: false, departureCountry: 'LV', items: [{ quantity: 1 }] },
    { customsFeesPossible: true, departureCountry: 'US', items: [{ quantity: 2 }] },
    { customsFeesPossible: null, departureCountry: null, items: [{ quantity: 3 }] },
  ] });
  assert.match(lines.join(' '), /2 × Produkt: Bei der Einfuhr/);
  assert.match(lines.join(' '), /3 × Produkt: Mögliche Einfuhrgebühren/);
  assert.doesNotMatch(lines.join(' '), /1 ×|Versandland|Lettland|Vereinigte/);
});

test('delivery restrictions identify the affected item and follow destination and quantity changes', () => {
  const h = harness(async()=>response({}));
  let country='JP', quantity='1';
  const notice={hidden:true,textContent:''};
  const input={get value(){return quantity;},dataset:{configurationId:'case'},closest:()=>({querySelector:()=>notice})};
  const card={querySelector:()=>({value:country}),querySelectorAll:()=>[input]};
  h.scope.shipmentList.querySelectorAll=()=>[card];
  h.scope.findConfiguration=()=>({product:{shippingRestrictions:['JP','SG']}});
  assert.equal(h.scope.updateDeliveryRestrictions(),true);
  assert.equal(notice.hidden,false);
  assert.match(notice.textContent,/nicht.*geliefert/);
  country='DE';
  assert.equal(h.scope.updateDeliveryRestrictions(),false);
  assert.equal(notice.hidden,true);
  country='JP';quantity='0';
  assert.equal(h.scope.updateDeliveryRestrictions(),false);
  assert.equal(notice.hidden,true);
});
