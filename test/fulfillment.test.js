'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent } = require('./helpers');

test('fulfillment is immutable, idempotent and only writes a draft behind all live safety gates', async (t) => {
  const previous = {};
  for (const name of [
    'PUBLIC_URL',
    'STRIPE_ALLOW_LIVE_PAYMENTS',
    'PRINTFUL_FULFILLMENT_MODE',
    'PRINTFUL_ALLOW_ORDER_WRITES',
    'PRINTFUL_CONFIRM_LIVE_ORDERS',
  ]) {
    previous[name] = process.env[name];
  }
  process.env.PUBLIC_URL = 'https://shop.weddingcloud.example';
  process.env.STRIPE_ALLOW_LIVE_PAYMENTS = 'true';
  process.env.PRINTFUL_FULFILLMENT_MODE = 'draft';
  process.env.PRINTFUL_ALLOW_ORDER_WRITES = 'true';
  process.env.PRINTFUL_CONFIRM_LIVE_ORDERS = 'false';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const createdEvent = await createEvent(baseUrl, { coupleName: 'Draft Dora & Sicher Sven' });

  const db = require('../src/db');
  const event = db.getEventBySlug(createdEvent.slug);
  const configuration = db.createConfiguration({
    eventId: event.id,
    productKey: 'white-glossy-mug-duo-11oz',
    printfulVariantId: 1320,
    quantity: 4,
    unitPriceCents: 0,
    theme: 'pastel',
    placement: 'single',
    words: [['liebe', 3]],
    design: null,
    printWidth: 2700,
    printHeight: 1050,
  });
  const quote = db.createCheckoutQuote({
    eventId: event.id,
    configurationId: configuration.id,
    recipient: {
      name: 'Dora Beispiel',
      address1: 'Blumenstraße 7',
      city: 'Berlin',
      zip: '10115',
      country_code: 'DE',
    },
    printfulCosts: { currency: 'EUR', subtotal: 20, shipping: 5, vat: 5, total: 30 },
    quote: {
      currency: 'EUR', quantity: 4, itemsCents: 3600,
      shippingCents: 500, taxCents: 500, totalCents: 4600,
    },
  });
  const { order } = db.createCheckoutOrder({
    eventId: event.id,
    configurationId: configuration.id,
    quote,
    mode: 'live',
  });
  db.attachStripeSession(order.id, {
    id: 'cs_live_fulfillment_test',
    url: 'https://checkout.stripe.example/session',
  });
  db.recordSuccessfulPayment({
    stripeEventId: 'evt_live_fulfillment_test',
    eventType: 'checkout.session.completed',
    stripeSessionId: 'cs_live_fulfillment_test',
    paymentIntentId: 'pi_live_fulfillment_test',
    livemode: true,
  });

  const printful = require('../src/printful');
  const fulfillment = require('../src/fulfillment');
  const originalCreate = printful.createPrintfulOrder;
  let calls = 0;
  let captured = null;
  printful.createPrintfulOrder = async (options) => {
    calls += 1;
    captured = options;
    return { printfulOrderId: '987654', status: 'draft', mocked: false, confirmed: false };
  };
  t.after(() => { printful.createPrintfulOrder = originalCreate; });

  assert.equal(
    fulfillment.resolveMode({ mode: 'test', status: 'paid_test' }),
    'mock',
    'a Stripe test payment must remain mocked even when draft writes are enabled'
  );

  const completed = await fulfillment.processOrder(order.id);
  await fulfillment.processOrder(order.id);
  assert.equal(calls, 1, 'a completed fulfillment cannot be claimed a second time');
  assert.equal(completed.fulfillment_status, 'draft');
  assert.equal(completed.fulfillment_mode, 'draft');
  assert.equal(completed.printful_order_id, '987654');
  assert.equal(captured.confirm, false, 'draft mode must never confirm the Printful order');
  const externalId = `weddingcloud-${order.id}-${quote.id}`;
  assert.equal(captured.payload.external_id, externalId);
  assert.deepEqual(captured.payload.recipient, {
    name: 'Dora Beispiel', address1: 'Blumenstraße 7', city: 'Berlin',
    zip: '10115', country_code: 'DE',
  });
  assert.deepEqual(captured.payload.items, [{
    external_id: `${externalId}-item-1`,
    variant_id: 1320,
    quantity: 4,
    files: [{
      type: 'default',
      url: `https://shop.weddingcloud.example/api/events/${createdEvent.slug}` +
        `/configurations/${configuration.id}/print.svg`,
    }],
  }]);

  const splitQuote = db.createCheckoutQuote({
    eventId: event.id,
    configurationId: configuration.id,
    shipments: [
      {
        quantity: 2,
        recipient: {
          name: 'Adresse A',
          address1: 'Rosenweg 1',
          city: 'Berlin',
          zip: '10115',
          country_code: 'DE',
        },
        printfulCosts: { currency: 'EUR', subtotal: 12, shipping: 5, vat: 3, total: 20 },
      },
      {
        quantity: 1,
        recipient: {
          name: 'Adresse B',
          address1: 'Tulpenweg 2',
          city: 'Wien',
          zip: '1010',
          country_code: 'AT',
        },
        printfulCosts: { currency: 'EUR', subtotal: 7, shipping: 6, vat: 2.6, total: 15.6 },
      },
    ],
    quote: {
      currency: 'EUR', quantity: 3, itemsCents: 3455,
      shippingCents: 1100, taxCents: 560, totalCents: 5115,
    },
  });
  const { order: splitOrder } = db.createCheckoutOrder({
    eventId: event.id,
    configurationId: configuration.id,
    quote: splitQuote,
    mode: 'live',
  });
  db.attachStripeSession(splitOrder.id, {
    id: 'cs_live_split_fulfillment_test',
    url: 'https://checkout.stripe.example/split-session',
  });
  db.recordSuccessfulPayment({
    stripeEventId: 'evt_live_split_fulfillment_test',
    eventType: 'checkout.session.completed',
    stripeSessionId: 'cs_live_split_fulfillment_test',
    paymentIntentId: 'pi_live_split_fulfillment_test',
    livemode: true,
  });

  const splitCalls = [];
  printful.createPrintfulOrder = async (options) => {
    splitCalls.push(options);
    return { printfulOrderId: `draft-${splitCalls.length}`, status: 'draft', mocked: false, confirmed: false };
  };
  const completedSplit = await fulfillment.processOrder(splitOrder.id);
  assert.equal(splitCalls.length, 2, 'one Printful draft is created per delivery address');
  assert.equal(completedSplit.fulfillment_status, 'draft');
  assert.equal(completedSplit.printful_order_id, 'draft-1,draft-2');
  assert.deepEqual(splitCalls.map((call) => call.payload.external_id), [
    `weddingcloud-${splitOrder.id}-${splitQuote.id}-shipment-1`,
    `weddingcloud-${splitOrder.id}-${splitQuote.id}-shipment-2`,
  ]);
  assert.deepEqual(splitCalls.map((call) => call.payload.items[0].quantity), [2, 1]);
  assert.deepEqual(splitCalls.map((call) => call.payload.recipient.name), ['Adresse A', 'Adresse B']);
  assert.deepEqual(db.getOrderShipments(splitOrder.id).map((shipment) => shipment.fulfillment_status), ['draft', 'draft']);

  const notebookPayload = fulfillment.buildPrintfulPayload({
    mode: 'draft',
    order: {
      id: 42,
      quote_id: 'notebook-quote',
      shipping_json: JSON.stringify({
        name: 'Nora Notiz',
        address1: 'Papierweg 5',
        city: 'Berlin',
        zip: '10115',
        country_code: 'DE',
      }),
    },
    event: { slug: createdEvent.slug },
    configuration: {
      id: 'notebook-configuration',
      product_key: 'spiral-notebook-dotted',
      printful_variant_id: 12141,
      quantity: 2,
    },
  });
  const notebookPrintUrl = `https://shop.weddingcloud.example/api/events/${createdEvent.slug}` +
    '/configurations/notebook-configuration/print.svg';
  assert.deepEqual(notebookPayload.items[0].files, [
    { type: 'front', url: `${notebookPrintUrl}?surface=front` },
    { type: 'back', url: `${notebookPrintUrl}?surface=back` },
  ], 'the EU notebook sends each immutable cover design to its matching placement');

  const pillowPayload = fulfillment.buildPrintfulPayload({
    mode: 'draft',
    order: {
      id: 43,
      quote_id: 'pillow-quote',
      shipping_json: JSON.stringify({
        name: 'Karla Kissen',
        address1: 'Wolkenweg 8',
        city: 'Berlin',
        zip: '10115',
        country_code: 'DE',
      }),
    },
    event: { slug: createdEvent.slug },
    configuration: {
      id: 'pillow-configuration',
      product_key: 'all-over-basic-pillow-18in',
      printful_variant_id: 4532,
      quantity: 1,
    },
  });
  const pillowPrintUrl = `https://shop.weddingcloud.example/api/events/${createdEvent.slug}` +
    '/configurations/pillow-configuration/print.svg';
  assert.deepEqual(pillowPayload.items[0].files, [
    { type: 'front', url: `${pillowPrintUrl}?surface=front` },
    { type: 'back', url: `${pillowPrintUrl}?surface=back` },
  ]);
  assert.deepEqual(pillowPayload.items[0].options, [
    { id: 'stitch_color', value: 'white' },
  ], 'the pillow keeps its curated white zipper and stitch color without a storefront selector');
});
