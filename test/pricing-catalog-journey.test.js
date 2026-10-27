'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { JSDOM } = require('jsdom');
const { Gallery } = require('../public/js/product-gallery');
const { PRODUCTS } = require('../src/products');
const costs = require('../src/productCostSnapshot.json');
const { startTestServer, createEvent, productDesignPayload, stubMockupApproval } = require('./helpers');

// Independent integer arithmetic: no production pricing helpers or floating
// point calculations are used to establish expected catalog and shipping prices.
const ceil = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
function component(base) {
  return {
    net: Number(ceil((BigInt(base) + 49n) * 1000000n, 956089n)),
    gross: Number(ceil((BigInt(base) + 49n) * 1190000n, 956089n)),
  };
}
function expectedPrice(product) {
  const reference = costs.variants[product.printful.variantId];
  return component(ceil(BigInt(reference.productCents) * 3n, 2n) + BigInt(reference.supplierTaxCents));
}

// Tax is rounded across the transaction and allocated back to its lines. This
// exercises one-cent allocations that independent per-line rounding can miss.
function allocateTax(amounts, rate, inclusive) {
  const denominator = BigInt(inclusive ? 100 + rate : 100);
  const entries = amounts.map((amount, index) => {
    const numerator = BigInt(amount) * BigInt(rate);
    return { index, floor: numerator / denominator, remainder: numerator % denominator };
  });
  const numerator = amounts.reduce((sum, amount) => sum + BigInt(amount) * BigInt(rate), 0n);
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  let remaining = rounded - entries.reduce((sum, entry) => sum + entry.floor, 0n);
  for (const entry of [...entries].sort((a, b) => Number(b.remainder - a.remainder) || a.index - b.index)) {
    if (remaining > 0n) { entry.floor++; remaining--; }
  }
  return entries.map(entry => Number(entry.floor));
}

test('every offered variant retains its gallery price through tax, payment and immutable email', async t => {
  const hosted = await startTestServer();
  t.after(hosted.close);
  stubMockupApproval(t);
  process.env.STRIPE_PAYMENT_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_complete_catalog';
  process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET = 'whsec_complete_catalog';
  const db = require('../src/db');
  const printful = require('../src/printful');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  const destinations = [
    { code: 'DE', rate: 19, city: 'Berlin', zip: '10115' },
    { code: 'FR', rate: 20, city: 'Paris', zip: '75001' },
    { code: 'HU', rate: 27, city: 'Budapest', zip: '1051' },
    { code: 'GB', rate: 20, city: 'London', zip: 'SW1A 1AA' },
    { code: 'US', rate: 0, city: 'New York', zip: '10001' },
  ];
  t.mock.method(printful, 'getShippingCountries', async () => destinations.map(({ code }) => ({
    code, name: code, states: code === 'US' ? [{ code: 'NY', name: 'New York' }] : [],
  })));
  let supplierDiscount = 0;
  t.mock.method(printful, 'estimateOrderCosts', async ({ items, variantId, quantity }) => {
    const basket = items || [{ variantId, quantity }];
    const subtotal = basket.reduce((sum, item) => sum + costs.variants[item.variantId].productCents * item.quantity, 0);
    return { currency: 'EUR', subtotal: subtotal / 100, discount: supplierDiscount / 100,
      shipping: 11.43, tax: 0, vat: .99, total: (subtotal - supplierDiscount + 1143 + 99) / 100 };
  });
  const sdk = new Stripe('sk_test_mock');
  const customers = new Map(), sessions = new Map(), requests = new Map();
  let pageReads = 0;
  t.mock.method(Object.getPrototypeOf(sdk.customers), 'create', async params => {
    const id = 'cus_complete' + (customers.size + 1);
    customers.set(id, params);
    return { id };
  });
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async params => {
    const country = customers.get(params.customer).shipping.address.country;
    const inclusive = country === 'DE';
    const amounts = params.line_items.map(item => item.quantity * item.price_data.unit_amount);
    const shipping = params.shipping_options[0].shipping_rate_data.fixed_amount.amount;
    const taxes = allocateTax([...amounts, shipping], destinations.find(d => d.code === country).rate, inclusive);
    const shippingTax = taxes.at(-1);
    const tax = taxes.reduce((sum, value) => sum + value, 0);
    const id = 'cs_test_complete_' + (sessions.size + 1);
    const lines = params.line_items.map((item, index) => ({ quantity: item.quantity,
      amount_subtotal: amounts[index], amount_total: amounts[index] + (inclusive ? 0 : taxes[index]) }));
    const subtotal = amounts.reduce((sum, amount) => sum + amount, 0);
    const session = {
      id, url: 'https://checkout.stripe.test/' + id, customer: params.customer, currency: 'eur',
      automatic_tax: { enabled: true, status: 'complete' },
      amount_subtotal: subtotal, amount_total: subtotal + shipping + (inclusive ? 0 : tax),
      total_details: { amount_discount: 0, amount_tax: tax },
      shipping_cost: { amount_subtotal: shipping, amount_tax: shippingTax,
        amount_total: shipping + (inclusive ? 0 : shippingTax) },
      line_items: { data: lines.slice(0, 10), has_more: lines.length > 10 },
    };
    sessions.set(id, { session, lines }); requests.set(id, params);
    return session;
  });
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'listLineItems', async (id, params) => {
    assert.equal(params.limit, 100); pageReads++;
    return { data: sessions.get(id).lines, has_more: false };
  });
  const money = cents => new Intl.NumberFormat('de', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const inspected = new Set();
  let catalog;
  for (let offset = 0; offset < PRODUCTS.length; offset += 20) {
    const batch = PRODUCTS.slice(offset, offset + 20), batchIndex = offset / 20;
    const destination = destinations[batchIndex % destinations.length];
    await t.test(`${destination.code}: variants ${offset + 1}–${offset + batch.length}`, async () => {
      const event = await createEvent(hosted.baseUrl);
      const headers = { 'Content-Type': 'application/json', 'X-Wolkenworte-Test-Client-IP': `192.0.2.${batchIndex + 1}` };
      async function post(path, body, status = 200) {
        const response = await fetch(hosted.baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
        const result = await response.json();
        const diagnostic = response.status === status ? '' :
          JSON.stringify((await hosted.query('SELECT checkout_error FROM orders ORDER BY id DESC LIMIT 1')).rows);
        assert.equal(response.status, status, JSON.stringify(result) + diagnostic);
        return result;
      }
      if (!catalog) {
        catalog = await (await fetch(`${hosted.baseUrl}/api/events/${event.slug}/configurator?restore=1`)).json();
        assert.equal(catalog.products.length, PRODUCTS.length);
        for (const product of PRODUCTS) {
          const published = catalog.products.find(entry => entry.key === product.key).price;
          const expected = expectedPrice(product);
          assert.equal(published.unitNetCents, expected.net, product.key);
          assert.equal(published.unitGrossCents, expected.gross, product.key);
        }
        const dom = new JSDOM('<section><div data-gallery-filters></div><div data-gallery-grid></div></section>', { pretendToBeVisual: true });
        const translate = (source, values = {}) => source.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
        const gallery = new Gallery({ element: dom.window.document.querySelector('section'), products: catalog.products,
          prepare: async product => ({ productKey: product.key, orientation: product.defaultOrientation,
            designs: Object.fromEntries(product.printSurfaces.map(surface => [surface.key, []])) }),
          getView: product => product, configureFlat() {}, paintFlat() {},
          createMug: () => ({ resize() {}, destroy() {} }), createPhoto: () => ({ resize() {}, destroy() {} }),
          onChoose() {}, onAdd() {},
          i18n: { t: translate, setText: (node, text, values) => { node.textContent = translate(text, values); },
            setAttribute: (node, key, text, values) => node.setAttribute(key, translate(text, values)) },
        });
        try {
          await gallery.queue;
          for (const card of gallery.cards) for (const product of card.variants) {
            await gallery.load(card, product);
            assert.equal(card.price.textContent, money(expectedPrice(PRODUCTS.find(entry => entry.key === product.key)).gross));
          }
        } finally { gallery.destroy(); dom.window.close(); }
      }
      const ids = [];
      for (const product of batch) {
        const result = await post(`/api/events/${event.slug}/configurations`, {
          productKey: product.key, quantity: 1, theme: 'pastel', words: [['liebe', 3]], ...productDesignPayload(product.key),
        }, 201);
        ids.push(result.id); inspected.add(product.key);
      }
      const api = `/api/events/${event.slug}/cart/`;
      const items = ids.map((configurationId, index) => ({ configurationId, quantity: index % 2 + 1 }));
      const recipient = { name: 'Catalog Price Audit', address1: 'Musterweg 1', country_code: destination.code,
        city: destination.city, zip: destination.zip, ...(destination.code === 'US' ? { state_code: 'NY' } : {}) };
      const initial = (await post(api + 'estimate-costs', { configurationIds: ids, shipments: [{ items, recipient }],
        itemsCents: 1, shippingCents: 1, totalCents: 1 })).quote;
      const inclusive = destination.code === 'DE';
      const expectedItems = batch.reduce((sum, product, index) => sum +
        expectedPrice(product)[inclusive ? 'gross' : 'net'] * items[index].quantity, 0);
      assert.equal(initial.itemsCents, expectedItems);
      assert.equal(initial.shippingCents, component(1143)[inclusive ? 'gross' : 'net']);
      supplierDiscount = 100;
      const prepared = (await post(api + 'checkout', { configurationIds: ids, quoteId: initial.id, intent: 'prepare' })).quote;
      supplierDiscount = 0;
      assert.equal(prepared.checkoutPrepared, true);
      assert.equal(prepared.itemsCents, expectedItems, 'supplier discounts never reprice catalog units');
      assert.equal(prepared.grossItemsCents + prepared.grossShippingCents, prepared.totalCents);
      const countBefore = sessions.size;
      const checkout = await post(api + 'checkout', { configurationIds: ids, quoteId: initial.id });
      assert.equal(sessions.size, countBefore, 'pay opens the exact previewed Checkout Session');
      const sessionId = checkout.url.split('/').at(-1);
      const { session, lines } = sessions.get(sessionId), params = requests.get(sessionId);
      assert.equal(prepared.totalCents, session.amount_total);
      assert.equal(prepared.taxCents, session.total_details.amount_tax);
      assert.equal(prepared.pricedItems.length, batch.length, 'every page of Stripe line items is preserved');
      for (let index = 0; index < batch.length; index++) {
        const product = batch[index], line = params.line_items[index];
        assert.equal(line.price_data.unit_amount, expectedPrice(product)[inclusive ? 'gross' : 'net']);
        assert.equal(line.quantity, items[index].quantity);
        assert.equal(line.price_data.tax_behavior, inclusive ? 'inclusive' : 'exclusive');
        assert.equal(line.price_data.product_data.tax_code, product.familyKey === 'clothing' ? 'txcd_30011000' : 'txcd_99999999');
        assert.equal(prepared.pricedItems[index].grossTotalCents, lines[index].amount_total);
      }
      async function webhook(object, suffix) {
        const payload = JSON.stringify({ id: 'evt_complete_' + batchIndex + '_' + suffix,
          type: 'checkout.session.completed', livemode: false, data: { object: { ...object,
            payment_status: 'paid', payment_intent: 'pi_complete_' + batchIndex,
            customer_details: { email: 'catalog@example.invalid' }, metadata: params.metadata } } });
        const response = await fetch(hosted.baseUrl + '/webhook/stripe', { method: 'POST', headers: {
          'Content-Type': 'application/json', 'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({
            payload, secret: process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET,
          }),
        }, body: payload });
        assert.equal(response.status, 200);
        return response.json();
      }
      assert.equal((await webhook({ ...session, amount_total: session.amount_total + 1 }, 'changed')).ignored, 'order_mismatch');
      const pending = await db.getOrderBySessionId(sessionId);
      assert.equal(pending.status, 'checkout_pending');
      assert.equal((await db.getEmailJobsForOrder(pending.id)).length, 0);
      await webhook(session, 'paid');
      await webhook(session, 'paid');
      const paid = await db.getOrderBySessionId(sessionId);
      assert.equal(paid.status, 'paid_test');
      assert.equal(paid.total_cents, prepared.totalCents);
      assert.equal(paid.tax_cents, prepared.taxCents);
      const frozen = JSON.parse(paid.checkout_request_json);
      assert.deepEqual(frozen.expectedPricedItems, prepared.pricedItems);
      assert.equal(frozen.pricing.taxBehavior, inclusive ? 'inclusive' : 'exclusive');
      const jobs = await db.getEmailJobsForOrder(paid.id);
      assert.equal(jobs.length, 1, 'duplicate payment webhooks never duplicate confirmations');
      for (const [label, amount] of [['Produktzwischensumme', prepared.grossItemsCents], ['Versand', prepared.grossShippingCents],
        ['Davon MwSt.', prepared.taxCents], ['Gesamtbetrag', prepared.totalCents]]) {
        assert.ok(jobs[0].text_body.includes(`${label}: ${money(amount)}`), `${label} must match the paid Session`);
      }
    });
  }
  assert.equal(inspected.size, PRODUCTS.length);
  assert.equal(pageReads, Math.floor(PRODUCTS.length / 20) + (PRODUCTS.length % 20 > 10 ? 1 : 0));
});
