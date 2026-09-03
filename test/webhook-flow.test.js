'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

async function saveConfiguration(baseUrl, slug) {
  const response = await fetch(`${baseUrl}/api/events/${slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 2,
      theme: 'pastel',
      words: [['füreinander', 3], ['liebe', 2]],
      ...productDesignPayload(),
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('signed Stripe test webhook marks one trusted order paid exactly once and never calls Printful', async (t) => {
  process.env.APP_ENVIRONMENT = 'local';
  process.env.STRIPE_PAYMENT_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET = 'whsec_test_dummy';
  process.env.PRINTFUL_FULFILLMENT_MODE = 'live';
  process.env.PRINTFUL_ALLOW_ORDER_WRITES = 'true';
  process.env.PRINTFUL_CONFIRM_LIVE_ORDERS = 'true';
  delete require.cache[require.resolve('../src/stripe')];
  t.after(() => {
    delete process.env.STRIPE_TEST_SECRET_KEY;
    delete process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET;
    delete process.env.PRINTFUL_FULFILLMENT_MODE;
    delete process.env.PRINTFUL_ALLOW_ORDER_WRITES;
    delete process.env.PRINTFUL_CONFIRM_LIVE_ORDERS;
    delete require.cache[require.resolve('../src/stripe')];
  });

  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Webhook Wanda & Signed Sven' });
  const configuration = await saveConfiguration(baseUrl, event.slug);

  const printful = require('../src/printful');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  const originalCreate = printful.createPrintfulOrder;
  let fulfillmentCalls = 0;
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
  ];
  printful.estimateOrderCosts = async () => ({
    currency: 'EUR', subtotal: 10.98, shipping: 4.49, tax: 0, vat: 2.94, total: 18.41,
  });
  printful.createPrintfulOrder = async () => {
    fulfillmentCalls += 1;
    throw new Error('Printful must remain disabled in test checkout');
  };
  t.after(() => {
    printful.getShippingCountries = originalCountries;
    printful.estimateOrderCosts = originalEstimate;
    printful.createPrintfulOrder = originalCreate;
  });

  const estimateResponse = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/estimate-costs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: {
          name: 'Webhook Wanda', address1: 'Teststraße 1', city: 'Berlin',
          zip: '10115', country_code: 'DE',
        },
      }),
    }
  );
  assert.equal(estimateResponse.status, 200);
  const { quote } = await estimateResponse.json();

  const db = require('../src/db');
  const eventRow = await db.getEventBySlug(event.slug);
  const quoteRow = await db.getCheckoutQuote(quote.id);
  const { order } = await db.createCheckoutOrder({
    eventId: eventRow.id,
    configurationId: configuration.id,
    quote: quoteRow,
  });
  const stripeSessionId = 'cs_test_webhook_flow';
  await db.attachStripeSession(order.id, { id: stripeSessionId, url: 'https://checkout.stripe.test/session' });

  const payload = JSON.stringify({
    id: 'evt_test_paid_once',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: stripeSessionId,
        amount_total: quote.totalCents,
        currency: 'eur',
        payment_status: 'paid',
        payment_intent: 'pi_test_paid_once',
        metadata: {
          eventSlug: event.slug,
          configurationId: configuration.id,
          configurationIds: configuration.id,
          quoteId: quote.id,
          orderId: String(order.id),
          checkoutMode: 'test',
        },
      },
    },
  });
  const signer = Stripe(process.env.STRIPE_TEST_SECRET_KEY);
  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET,
  });

  for (const expectedDuplicate of [false, true]) {
    const response = await fetch(`${baseUrl}/webhook/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, expectedDuplicate);
  }

  let paidOrder = await db.getOrderBySessionId(stripeSessionId);
  for (let attempt = 0; attempt < 30 && paidOrder.fulfillment_status !== 'mocked'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    paidOrder = await db.getOrderBySessionId(stripeSessionId);
  }
  assert.equal(paidOrder.status, 'paid_test');
  assert.equal(paidOrder.stripe_payment_intent_id, 'pi_test_paid_once');
  assert.equal(paidOrder.fulfillment_status, 'mocked');
  assert.equal(paidOrder.fulfillment_mode, 'mock');
  assert.equal(paidOrder.printful_order_id, `MOCK-WC-${order.id}`);
  assert.equal(fulfillmentCalls, 0, 'successful test payments must never create a Printful order');

  const statusResponse = await fetch(
    `${baseUrl}/api/events/${event.slug}/orders/status?session_id=${stripeSessionId}`
  );
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    status: 'paid_test',
    paymentConfirmed: true,
    configurationIds: [configuration.id],
    fulfillmentCreated: false,
    fulfillmentStatus: 'mocked',
    mode: 'test',
    currency: 'EUR',
    totalCents: quote.totalCents,
    quantity: 2,
    shipmentCount: 1,
    configurationCount: 1,
    product: {
      name: 'Wortwolken-Tasse',
      unit: { singular: 'Tasse', plural: 'Tassen' },
    },
    paidAt: paidOrder.paid_at,
  });
});
