'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

const recipient = { name: 'Erste Adresse', address1: 'Testweg 1', city: 'Berlin', zip: '10115', country_code: 'DE' };
async function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('single-address checkout and paid design reorders preserve commerce snapshots', async (t) => {
  const { baseUrl, close, query } = await startTestServer();
  t.after(close);
  const db = require('../src/db');
  const printful = require('../src/printful');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  const stripe = require('../src/stripe');
  let estimates = 0, payments = 0;
  const oldCountries = printful.getShippingCountries, oldEstimate = printful.estimateOrderCosts;
  const oldCheckout = stripe.createCheckoutSession;
  printful.getShippingCountries = async () => [{ code: 'DE', name: 'Germany', states: [] }];
  printful.estimateOrderCosts = async () => {
    estimates++;
    return { currency: 'EUR', subtotal: 20, shipping: 5, vat: 4.75, tax: 0, total: 29.75 };
  };
  stripe.createCheckoutSession = async ({ persistCustomer }) => {
    payments++;
    await persistCustomer(`cus_reorder${payments}`);
    return { id: `cs_test_reordered_${payments}`, url: `https://checkout.test/reordered-${payments}` };
  };
  t.after(() => {
    printful.getShippingCountries = oldCountries;
    printful.estimateOrderCosts = oldEstimate;
    stripe.createCheckoutSession = oldCheckout;
  });

  const event = await db.getEventBySlug((await createEvent(baseUrl)).slug);
  const other = await createEvent(baseUrl);
  const api = `${baseUrl}/api/events/${event.slug}`;
  const configurations = [];
  for (const [productKey, orientation] of [
    ['white-glossy-mug-duo-11oz', 'default'], ['matte-poster-30x40cm', 'landscape'], ['cork-back-coaster', 'default'],
  ]) {
    const response = await post(`${api}/configurations`, {
      productKey, orientation, quantity: 1, theme: 'pastel', words: [['liebe', 3]],
      ...productDesignPayload(productKey, orientation),
    });
    assert.equal(response.status, 201);
    configurations.push(await response.json());
  }
  const [mug, poster] = configurations;
  const ids = configurations.map((item) => item.id);
  const shipment = { recipient, items: [{ configurationId: mug.id, quantity: 2 }, { configurationId: poster.id, quantity: 3 }] };
  const quoteResponse = await post(`${api}/cart/estimate-costs`, { configurationIds: ids, shipments: [shipment] });
  assert.equal(quoteResponse.status, 200);
  const quote = (await quoteResponse.json()).quote;
  await post(`${api}/cart/checkout`, { configurationIds: ids, quoteId: quote.id });
  const sessionId = 'cs_test_reordered_1';
  const request = { sessionId, requestId: 'a'.repeat(32), quantity: 99, recipient: { name: 'Ignored' } };

  await t.test('unpaid, foreign and invalid capabilities cannot copy designs', async () => {
    assert.equal((await post(`${api}/orders/reorder`, request)).status, 404);
    assert.equal((await post(`${api}/orders/reorder`, { ...request, requestId: 'invalid' })).status, 400);
    assert.equal((await query('SELECT count(*)::int AS count FROM configurations')).rows[0].count, 3);
  });

  const taxCents = Math.round(quote.totalCents * 0.19);
  const paidTotal = quote.totalCents + taxCents;
  await db.recordSuccessfulPayment({ stripeEventId: 'evt_reorder_original', eventType: 'checkout.session.completed',
    stripeSessionId: sessionId, paymentIntentId: 'pi_reorder_original', livemode: false,
    amountTotal: paidTotal, currency: 'eur', checkoutSession: {
      id: sessionId, customer: 'cus_reorder1', payment_status: 'paid', currency: 'eur',
      amount_subtotal: quote.itemsCents, amount_total: paidTotal,
      automatic_tax: { enabled: true, status: 'complete' },
      total_details: { amount_tax: taxCents, amount_discount: 0 },
      shipping_cost: { amount_subtotal: quote.shippingCents,
        amount_tax: 95, amount_total: quote.shippingCents + 95 },
    } });
  const originalOrder = await db.getOrderBySessionId(sessionId);
  const originalItems = await db.getOrderItems(originalOrder.id);
  const originalShipments = await db.getOrderShipments(originalOrder.id);
  let copies;
  await t.test('copies only purchased items, preserving both print surfaces and landscape dimensions', async () => {
    assert.equal((await post(`${baseUrl}/api/events/${other.slug}/orders/reorder`, request)).status, 404);
    const response = await post(`${api}/orders/reorder`, request);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ['configurations']);
    copies = result.configurations;
    assert.equal(copies.length, 2, 'the unpurchased coaster must not be copied');
    assert.deepEqual(copies.map((item) => item.quantity), [2, 3]);
    for (const [index, copy] of copies.entries()) {
      assert.ok(!ids.includes(copy.id));
      const stored = await db.getConfiguration(copy.id);
      const snapshot = JSON.parse(originalItems[index].configuration_snapshot_json);
      assert.deepEqual(JSON.parse(stored.design_json), snapshot.design);
      assert.deepEqual(JSON.parse(stored.words_json), snapshot.words);
      assert.equal(stored.orientation, snapshot.orientation);
      assert.equal(stored.print_width, snapshot.printWidth);
      assert.equal(stored.print_height, snapshot.printHeight);
      assert.equal(stored.unit_price_cents, 0);
      const original = configurations[index];
      for (const [surface, url] of Object.entries(original.printFileUrls)) {
        const originalSvg = await (await fetch(`${baseUrl}${url}`)).text();
        const copiedSvg = await (await fetch(`${baseUrl}${copy.printFileUrls[surface]}`)).text();
        assert.equal(copiedSvg, originalSvg);
      }
    }
    assert.equal((await query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 1);
    assert.equal(payments, 1, 'copying must not charge or create a checkout');
    assert.equal(estimates, 2, 'copying must not call Printful');
    assert.deepEqual(await db.getOrderById(originalOrder.id), originalOrder);
    assert.deepEqual(await db.getOrderItems(originalOrder.id), originalItems);
    assert.deepEqual(await db.getOrderShipments(originalOrder.id), originalShipments);
  });

  await t.test('concurrent retries return the same copies without duplicating designs', async () => {
    const responses = await Promise.all([post(`${api}/orders/reorder`, request), post(`${api}/orders/reorder`, request)]);
    for (const response of responses) assert.deepEqual((await response.json()).configurations, copies);
    assert.equal((await query('SELECT count(*)::int AS count FROM configurations')).rows[0].count, 5);
  });

  await t.test('reordered designs require a fresh address quote and a separate payment', async () => {
    const copyIds = copies.map((item) => item.id);
    assert.equal((await post(`${api}/cart/checkout`, { configurationIds: copyIds, quoteId: quote.id })).status, 404);
    const nextRecipient = { ...recipient, name: 'Zweite Adresse', city: 'Hamburg', zip: '20095' };
    const response = await post(`${api}/cart/estimate-costs`, { configurationIds: copyIds,
      shipments: [{ recipient: nextRecipient, items: copies.map((item) => ({ configurationId: item.id, quantity: item.quantity })) }] });
    assert.equal(response.status, 200);
    const nextQuote = (await response.json()).quote;
    assert.notEqual(nextQuote.id, quote.id);
    assert.equal((await post(`${api}/cart/checkout`, { configurationIds: copyIds, quoteId: nextQuote.id })).status, 200);
    const nextOrder = await db.getOrderBySessionId('cs_test_reordered_2');
    assert.equal(nextOrder.status, 'checkout_pending');
    assert.deepEqual(JSON.parse((await db.getOrderShipments(nextOrder.id))[0].recipient_json), nextRecipient);
    assert.deepEqual(await db.getOrderById(originalOrder.id), originalOrder);
    assert.equal(payments, 2);
    assert.equal(estimates, 4);
  });

  await t.test('multiple addresses and legacy quotes cannot enter either public checkout route', async () => {
    const before = estimates;
    const shipments = [shipment, { ...shipment, recipient: { ...recipient, city: 'Hamburg' } }];
    for (const suffix of ['cart', `configurations/${mug.id}`]) {
      const response = await post(`${api}/${suffix}/estimate-costs`, { configurationIds: ids, shipments });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'single_address_required');
    }
    const legacy = await db.createCheckoutQuote({ eventId: event.id, configurationId: mug.id,
      configurationIds: ids, shipments, quote: { currency: 'EUR', quantity: 10, itemsCents: 2000,
        shippingCents: 500, taxCents: 475, totalCents: 2975 } });
    for (const suffix of ['cart', `configurations/${mug.id}`]) {
      assert.equal((await post(`${api}/${suffix}/checkout`, { configurationIds: ids, quoteId: legacy.id })).status, 400);
      assert.equal((await fetch(`${api}/${suffix}/quotes/${legacy.id}?ids=${ids.join(',')}`)).status, 400);
    }
    assert.equal(await db.getOrderByQuoteId(legacy.id), null);
    assert.equal(estimates, before);
    const { order } = await db.createCheckoutOrder({ eventId: event.id, quote: legacy });
    await db.attachStripeSession(order.id, { id: 'cs_test_legacy_multi', url: 'https://checkout.test/legacy' });
    assert.equal((await post(`${api}/cart/checkout`, { configurationIds: ids, quoteId: legacy.id })).status, 400);
    assert.equal((await db.getOrderById(order.id)).status, 'checkout_pending', 'existing orders remain intact');
  });

  await t.test('expired events cannot create new copies of retained paid designs', async () => {
    await query("UPDATE events SET created_at = now() - interval '366 days' WHERE id = $1", [event.id]);
    assert.equal((await post(`${api}/orders/reorder`, { ...request, requestId: 'b'.repeat(32) })).status, 404);
  });
});
