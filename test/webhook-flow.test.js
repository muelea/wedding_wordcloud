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

test('Stripe Tax payment stores the final gross amount atomically in the order and confirmation email', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_tax_webhook';
  process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET = 'whsec_tax_webhook';
  const sdk = new Stripe('sk_test_mock');
  let sessionParams;
  t.mock.method(Object.getPrototypeOf(sdk.customers), 'create', async () => ({ id: 'cus_taxwebhook' }));
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async (params) => {
    sessionParams = params;
    return { id: 'cs_test_tax_webhook', url: 'https://checkout.stripe.test/tax' };
  });
  const printful = require('../src/printful');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  t.mock.method(printful, 'getShippingCountries', async () => [{ code: 'DE', name: 'Germany', states: [] }]);
  t.mock.method(printful, 'estimateOrderCosts', async () => ({
    currency: 'EUR', subtotal: 10.98, shipping: 4.49, tax: 0, vat: 2.94, total: 18.41,
  }));
  const event = await createEvent(baseUrl, { title: 'Tax Test' });
  const configuration = await saveConfiguration(baseUrl, event.slug);
  const path = `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}`;
  const quoteResponse = await fetch(`${path}/estimate-costs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: {
      name: 'Tax Test', address1: 'Musterweg 1', city: 'Berlin', zip: '10115', country_code: 'DE',
    } }),
  });
  assert.equal(quoteResponse.status, 200);
  const { quote } = await quoteResponse.json();
  assert.equal(quote.taxCents, 0);
  const checkoutResponse = await fetch(`${path}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }),
  });
  assert.equal(checkoutResponse.status, 200, await checkoutResponse.text());
  const db = require('../src/db');
  const order = await db.getOrderBySessionId('cs_test_tax_webhook');
  assert.equal(JSON.parse(order.checkout_request_json).customerId, 'cus_taxwebhook');
  const taxCents = Math.round(quote.itemsCents * 0.19) + Math.round(quote.shippingCents * 0.19);
  const session = {
    id: 'cs_test_tax_webhook', customer: 'cus_taxwebhook',
    currency: 'eur', payment_status: 'paid', payment_intent: 'pi_test_tax_webhook',
    amount_subtotal: quote.itemsCents, amount_total: quote.totalCents + taxCents,
    total_details: { amount_tax: taxCents, amount_discount: 0 },
    shipping_cost: {
      amount_subtotal: quote.shippingCents, amount_tax: 85, amount_total: quote.shippingCents + 85,
    },
    automatic_tax: { enabled: true, status: 'complete' },
    customer_details: { email: 'buyer@example.test', address: { country: 'US' } },
    metadata: sessionParams.metadata,
  };
  const send = async (object, id) => {
    const payload = JSON.stringify({ id, type: 'checkout.session.completed', livemode: false, data: { object } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET });
    const response = await fetch(`${baseUrl}/webhook/stripe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const wrongSession = { ...session, amount_subtotal: quote.itemsCents - 1, amount_total: session.amount_total - 1 };
  assert.equal((await send(wrongSession, 'evt_tax_invalid')).ignored, 'order_mismatch');
  assert.equal((await db.getOrderById(order.id)).status, 'checkout_pending');
  assert.equal((await db.getEmailJobsForOrder(order.id)).length, 0);
  await assert.rejects(db.recordSuccessfulPayment({
    stripeEventId: 'evt_db_tax_invalid', eventType: 'checkout.session.completed',
    stripeSessionId: session.id, paymentIntentId: session.payment_intent, livemode: false,
    amountTotal: wrongSession.amount_total, currency: 'eur', checkoutSession: wrongSession,
  }), /does not match trusted/);
  assert.equal((await send(session, 'evt_tax_valid')).duplicate, false);
  assert.equal((await send(session, 'evt_tax_valid')).duplicate, true);
  assert.equal((await send(session, 'evt_tax_valid_later')).duplicate, true);
  const paid = await db.getOrderById(order.id);
  assert.equal(paid.status, 'paid_test');
  assert.equal(paid.fulfillment_mode, 'mock');
  assert.equal(paid.tax_cents, 421);
  assert.equal(paid.total_cents, 2640);
  assert.equal(paid.items_cents, quote.itemsCents);
  assert.equal((await db.getOrderShipments(order.id))[0].tax_cents, 421);
  const jobs = await db.getEmailJobsForOrder(order.id);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].text_body, /26,40\s*€/);
  assert.match(jobs[0].text_body, /4,21\s*€/);
  assert.equal((await send({ ...session, amount_total: 2641, total_details: { amount_tax: 422, amount_discount: 0 } },
    'evt_tax_changed_after_payment')).ignored, 'order_mismatch');
  assert.equal((await db.getOrderById(order.id)).total_cents, 2640);
});

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
