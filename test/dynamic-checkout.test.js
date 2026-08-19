'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent } = require('./helpers');

async function saveConfiguration(baseUrl, slug, quantity = 2) {
  const response = await fetch(`${baseUrl}/api/events/${slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz', quantity, theme: 'pastel', placement: 'single',
      words: [['liebe', 3], ['glück', 2]],
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function calculateQuote(baseUrl, slug, configurationId) {
  const response = await fetch(
    `${baseUrl}/api/events/${slug}/configurations/${configurationId}/estimate-costs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: {
          name: 'Checkout Clara', address1: 'Blumenstraße 12', address2: '2. OG',
          city: 'Berlin', zip: '10115', country_code: 'DE',
        },
      }),
    }
  );
  assert.equal(response.status, 200);
  return (await response.json()).quote;
}

test('checkout revalidates Printful, creates one dynamic Stripe Session and reuses it on double click', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Checkout Clara & Cent Carl' });
  const configuration = await saveConfiguration(baseUrl, event.slug, 2);

  const printful = require('../src/printful');
  const stripe = require('../src/stripe');
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  const originalCheckout = stripe.createCheckoutSession;
  let estimateCalls = 0;
  let checkoutCalls = 0;
  let capturedCheckout = null;
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
  ];
  printful.estimateOrderCosts = async () => {
    estimateCalls += 1;
    return { currency: 'EUR', subtotal: 10.98, shipping: 4.49, tax: 0, vat: 2.94, total: 18.41 };
  };
  stripe.createCheckoutSession = async (options) => {
    checkoutCalls += 1;
    capturedCheckout = options;
    return { id: 'cs_test_dynamic_1', url: 'https://checkout.stripe.test/cs_test_dynamic_1' };
  };
  t.after(() => {
    printful.getShippingCountries = originalCountries;
    printful.estimateOrderCosts = originalEstimate;
    stripe.createCheckoutSession = originalCheckout;
  });

  const quote = await calculateQuote(baseUrl, event.slug, configuration.id);
  assert.equal(quote.totalCents, 2740);

  const checkoutUrl = `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/checkout`;
  const first = await fetch(checkoutUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }),
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { url: 'https://checkout.stripe.test/cs_test_dynamic_1' });
  assert.equal(estimateCalls, 2, 'one estimate for display and one immediately before Stripe');
  assert.equal(checkoutCalls, 1);
  assert.equal(capturedCheckout.order.total_cents, quote.totalCents);
  assert.equal(capturedCheckout.order.currency, 'EUR');
  assert.equal(capturedCheckout.quantity, 2);
  assert.equal(capturedCheckout.quoteId, quote.id);

  const second = await fetch(checkoutUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }),
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {
    url: 'https://checkout.stripe.test/cs_test_dynamic_1',
    reused: true,
  });
  assert.equal(estimateCalls, 2, 'reusing an already revalidated Stripe Session must not create another quote');
  assert.equal(checkoutCalls, 1, 'double click must never create a second Stripe Session');

  const db = require('../src/db');
  const order = db.getOrderBySessionId('cs_test_dynamic_1');
  assert.equal(order.status, 'checkout_pending');
  assert.equal(order.quote_id, quote.id);
  assert.deepEqual(JSON.parse(order.shipping_json), {
    name: 'Checkout Clara', address1: 'Blumenstraße 12', address2: '2. OG',
    city: 'Berlin', zip: '10115', country_code: 'DE',
  });

  const restoredResponse = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/quotes/${quote.id}`
  );
  assert.equal(restoredResponse.status, 200);
  assert.match(restoredResponse.headers.get('cache-control'), /no-store/);
  const restored = await restoredResponse.json();
  assert.equal(restored.quote.id, quote.id);
  assert.deepEqual(restored.recipient, {
    name: 'Checkout Clara', address1: 'Blumenstraße 12', address2: '2. OG',
    city: 'Berlin', zip: '10115', country_code: 'DE',
  });
});

test('a changed Printful price must be shown and confirmed before Stripe is created', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Preis Pia & Update Uwe' });
  const configuration = await saveConfiguration(baseUrl, event.slug, 2);

  const printful = require('../src/printful');
  const stripe = require('../src/stripe');
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  const originalCheckout = stripe.createCheckoutSession;
  let productSubtotal = 10.98;
  let checkoutCalls = 0;
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
  ];
  printful.estimateOrderCosts = async () => ({
    currency: 'EUR', subtotal: productSubtotal, shipping: 4.49, tax: 0, vat: 2.94,
    total: productSubtotal + 4.49 + 2.94,
  });
  stripe.createCheckoutSession = async () => {
    checkoutCalls += 1;
    return { id: 'cs_test_updated_1', url: 'https://checkout.stripe.test/cs_test_updated_1' };
  };
  t.after(() => {
    printful.getShippingCountries = originalCountries;
    printful.estimateOrderCosts = originalEstimate;
    stripe.createCheckoutSession = originalCheckout;
  });

  const quote = await calculateQuote(baseUrl, event.slug, configuration.id);
  productSubtotal = 12;
  const checkoutUrl = `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/checkout`;
  const changed = await fetch(checkoutUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }),
  });
  assert.equal(changed.status, 409);
  const changedBody = await changed.json();
  assert.equal(changedBody.error, 'quote_changed');
  assert.equal(changedBody.quote.id, quote.id);
  assert.equal(changedBody.quote.totalCents, 2925);
  assert.equal(checkoutCalls, 0);

  const confirmed = await fetch(checkoutUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).url, 'https://checkout.stripe.test/cs_test_updated_1');
  assert.equal(checkoutCalls, 1);
});

test('expired quotes cannot start a Stripe Checkout Session', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Ablauf Anna & Sicher Sven' });
  const configuration = await saveConfiguration(baseUrl, event.slug, 1);

  const printful = require('../src/printful');
  const stripe = require('../src/stripe');
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  const originalCheckout = stripe.createCheckoutSession;
  let checkoutCalls = 0;
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
  ];
  printful.estimateOrderCosts = async () => ({
    currency: 'EUR', subtotal: 5.49, shipping: 4.49, tax: 0, vat: 1.9, total: 11.88,
  });
  stripe.createCheckoutSession = async () => { checkoutCalls += 1; };
  t.after(() => {
    printful.getShippingCountries = originalCountries;
    printful.estimateOrderCosts = originalEstimate;
    stripe.createCheckoutSession = originalCheckout;
  });

  const quote = await calculateQuote(baseUrl, event.slug, configuration.id);
  const db = require('../src/db');
  db.db.prepare('UPDATE checkout_quotes SET expires_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', quote.id);

  const response = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/checkout`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }) }
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'quote_expired');
  assert.equal(checkoutCalls, 0);
});
