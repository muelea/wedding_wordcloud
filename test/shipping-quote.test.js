'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

async function saveConfiguration(baseUrl, slug, quantityOrOptions = 3) {
  const options = typeof quantityOrOptions === 'object'
    ? quantityOrOptions
    : { quantity: quantityOrOptions };
  const response = await fetch(`${baseUrl}/api/events/${slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: options.productKey || 'white-glossy-mug-duo-11oz',
      quantity: options.quantity,
      theme: options.theme || 'pastel',
      words: [['liebe', 3], ['glück', 2]],
      ...productDesignPayload(options.productKey || 'white-glossy-mug-duo-11oz'),
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('shipping page uses the immutable configuration and returns a server-side Printful quote', async (t) => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.65';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  t.after(() => {
    delete process.env.SHOP_PRODUCT_MARKUP_PERCENT;
    delete process.env.SHOP_PAYMENT_RESERVE_PERCENT;
    delete process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS;
  });

  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Preis Paula & Porto Paul' });
  const configuration = await saveConfiguration(baseUrl, event.slug, 3);

  const shippingPage = await fetch(`${baseUrl}/e/${event.slug}/shipping?configuration=${configuration.id}`);
  assert.equal(shippingPage.status, 200);
  assert.match(await shippingPage.text(), /Wohin darf eure Erinnerung reisen\?/);

  const printful = require('../src/printful');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  const captured = [];
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
    {
      code: 'US',
      name: 'United States',
      region: 'americas',
      states: [{ code: 'CA', name: 'California' }, { code: 'NY', name: 'New York' }],
    },
  ];
  printful.estimateOrderCosts = async (options) => {
    captured.push(options);
    return options.recipient.country_code === 'US'
      ? {
          currency: 'EUR',
          subtotal: 6,
          shipping: 6,
          tax: 0,
          vat: 2.28,
          total: 14.28,
        }
      : {
          currency: 'EUR',
          subtotal: 10,
          shipping: 4.49,
          tax: 0,
          vat: 2.75,
          digitization: 0,
          additional_fee: 0,
          fulfillment_fee: 0,
          retail_delivery_fee: 0,
          total: 17.24,
        };
  };
  t.after(() => {
    printful.getShippingCountries = originalCountries;
    printful.estimateOrderCosts = originalEstimate;
  });

  const countriesResponse = await fetch(`${baseUrl}/api/shipping/countries`);
  assert.equal(countriesResponse.status, 200);
  assert.deepEqual((await countriesResponse.json()).countries.map((country) => country.code), ['DE', 'US']);

  const summaryResponse = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}`
  );
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.quantity, 3);
  assert.equal(summary.product.name, 'Wortwolken-Tasse');
  assert.equal(summary.unitPriceCents, undefined);
  assert.equal(summary.totalPriceCents, undefined);
  assert.match(summary.printFileUrl, /\/print\.svg$/);

  const estimateResponse = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/estimate-costs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Deliberately include untrusted product fields. The route must ignore
        // them and use the immutable configuration plus shipment quantities.
        variantId: 999999,
        shipments: [
          {
            quantity: 2,
            recipient: {
              name: 'Max Mustermann',
              address1: 'Münzerstraße 6',
              address2: '',
              city: 'Heilbronn',
              zip: '74080',
              country_code: 'Deutschland',
            },
          },
        ],
      }),
    }
  );
  assert.equal(estimateResponse.status, 200);
  const { quote } = await estimateResponse.json();
  assert.match(quote.id, /^[A-Za-z0-9_-]{24}$/);
  assert.ok(Date.parse(quote.expiresAt) > Date.now());
  assert.deepEqual({ ...quote, id: undefined, expiresAt: undefined, shippingDetails: undefined }, {
    id: undefined,
    currency: 'EUR',
    quantity: 2,
    configurationCount: 1,
    shipmentCount: 1,
    shippingDetails: undefined,
    itemsCents: 1616,
    paymentReserveCents: 116,
    shippingCents: 449,
    taxCents: 0,
    totalCents: 2065,
    expiresAt: undefined,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].variantId, 1320);
  assert.equal(captured[0].quantity, 2);
  assert.deepEqual(captured[0].recipient, {
    name: 'Max Mustermann',
    address1: 'Münzerstraße 6',
    city: 'Heilbronn',
    zip: '74080',
    country_code: 'DE',
  });
  const usEstimate = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/estimate-costs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipments: [{ quantity: 1, recipient: {
        name: 'Elke Musterfrau', address1: '702 Clara Dr', city: 'Palo Alto', zip: '94303',
        country_code: 'Vereinigte Staaten', state_code: 'California',
      } }] }),
    }
  );
  assert.equal(usEstimate.status, 200);
  assert.equal((await usEstimate.json()).quote.shipmentCount, 1);
  assert.equal(captured[1].quantity, 1);
  assert.equal(captured[1].recipient.country_code, 'US');
  assert.equal(captured[1].recipient.state_code, 'CA');

  captured.length = 0;
  const missingState = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/estimate-costs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shipments: [{
          quantity: 1,
          recipient: {
            name: 'New York Nora', address1: '350 Fifth Avenue', city: 'New York',
            zip: '10118', country_code: 'US',
          },
        }],
      }),
    }
  );
  assert.equal(missingState.status, 400);
  assert.deepEqual((await missingState.json()).fields, ['shipments.0.state_code']);
  assert.equal(captured.length, 0, 'invalid addresses must not reach Printful');
});

test('cart quote estimates mixed products for one address as one Printful shipment', async (t) => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.65';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  t.after(() => {
    delete process.env.SHOP_PRODUCT_MARKUP_PERCENT;
    delete process.env.SHOP_PAYMENT_RESERVE_PERCENT;
    delete process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS;
  });

  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Cart Carla & Mix Max' });
  const mug = await saveConfiguration(baseUrl, event.slug, { productKey: 'white-glossy-mug-duo-11oz' });
  const coaster = await saveConfiguration(baseUrl, event.slug, {
    productKey: 'cork-back-coaster',
  });

  const printful = require('../src/printful');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  const captured = [];
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
  ];
  printful.estimateOrderCosts = async (options) => {
    captured.push(options);
    return {
      currency: 'EUR',
      subtotal: 20,
      shipping: 6,
      tax: 0,
      vat: 4.94,
      total: 30.94,
    };
  };
  t.after(() => {
    printful.getShippingCountries = originalCountries;
    printful.estimateOrderCosts = originalEstimate;
  });

  const response = await fetch(`${baseUrl}/api/events/${event.slug}/cart/estimate-costs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationIds: [mug.id, coaster.id],
      shipments: [{
        items: [
          { configurationId: mug.id, quantity: 2 },
          { configurationId: coaster.id, quantity: 3 },
        ],
        recipient: {
          name: 'Mix Max',
          address1: 'Blumenstraße 12',
          city: 'Berlin',
          zip: '10115',
          country_code: 'DE',
        },
      }],
    }),
  });

  assert.equal(response.status, 200);
  const { quote } = await response.json();
  assert.equal(quote.quantity, 5);
  assert.equal(quote.shipmentCount, 1);
  assert.equal(quote.configurationCount, 2);
  assert.equal(quote.productCount, 2);
  assert.equal(quote.itemsCents, 3192);
  assert.equal(quote.paymentReserveCents, 192);
  assert.equal(quote.shippingCents, 600);
  assert.equal(quote.taxCents, 0);
  assert.equal(quote.totalCents, 3792);
  assert.equal(captured.length, 1, 'mixed items for one address must use one Printful estimate');
  assert.deepEqual(captured[0].items, [
    { configurationId: mug.id, variantId: 1320, quantity: 2 },
    { configurationId: coaster.id, variantId: 15662, quantity: 3 },
  ]);
  assert.equal(captured[0].variantId, undefined);
  assert.equal(captured[0].quantity, undefined);
  assert.equal(quote.shippingDetails.delivery.maxDate, '2030-01-17');
  assert.equal(quote.shippingDetails.shipments[0].customsFeesPossible, false);
  assert.deepEqual(quote.shippingDetails.shipments[0].items.map(item => item.productKey),
    ['white-glossy-mug-duo-11oz', 'cork-back-coaster']);
  const restored = await (await fetch(`${baseUrl}/api/events/${event.slug}/cart/quotes/${quote.id}?ids=${mug.id},${coaster.id}`)).json();
  assert.deepEqual(restored.quote.shippingDetails, quote.shippingDetails, 'restore keeps the exact provider assessment');

  printful.getShippingRates = async (options) => {
    const result = require('./support/printful-fixtures').shippingEstimate(options);
    result.shipments[0].departureCountry = 'US';
    result.shipments[0].customsFeesPossible = true;
    return result;
  };
  const recheck = await fetch(`${baseUrl}/api/events/${event.slug}/cart/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configurationIds: [mug.id, coaster.id], quoteId: quote.id,
      shippingDetails: { shipments: [{ customsFeesPossible: false }] } }),
  });
  assert.equal(recheck.status, 409, 'changed import risk requires review even when the amount is unchanged');
  const updated = await recheck.json();
  assert.equal(updated.error, 'quote_shipping_changed');
  assert.equal(updated.quote.shippingDetails.shipments[0].customsFeesPossible, true);
  assert.equal(await require('../src/db').getOrderByQuoteId(quote.id), null, 'no payment created before review');

  for (const [code, status, error] of [
    ['PRINTFUL_UNAVAILABLE', 502, 'pricing_unavailable'],
    ['PRINTFUL_SHIPPING_UNAVAILABLE', 422, 'shipping_unavailable'],
    ['PRINTFUL_REQUEST_REJECTED', 422, 'selection_not_available'],
    ['PRINTFUL_INVALID_RESPONSE', 502, 'pricing_unavailable'],
  ]) {
    printful.getShippingRates = async () => { throw new printful.PrintfulApiError(code, 'Provider details must stay private', status); };
    const unavailable = await fetch(`${baseUrl}/api/events/${event.slug}/cart/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configurationIds: [mug.id, coaster.id], quoteId: quote.id }),
    });
    assert.equal(unavailable.status, status, 'failed shipping recheck cannot start payment');
    const failure = await unavailable.json();
    assert.equal(failure.error, error);
    assert.doesNotMatch(failure.message, /Provider details/);
    assert.equal(await require('../src/db').getOrderByQuoteId(quote.id), null);
  }
});

test('a configuration can never be quoted through another event slug', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const first = await createEvent(baseUrl, { title: 'Erste Cloud' });
  const second = await createEvent(baseUrl, { title: 'Zweite Cloud' });
  const configuration = await saveConfiguration(baseUrl, first.slug, 1);

  const response = await fetch(
    `${baseUrl}/api/events/${second.slug}/configurations/${configuration.id}/estimate-costs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: {} }),
    }
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'configuration_not_found');
});
