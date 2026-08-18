'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent } = require('./helpers');

async function saveConfiguration(baseUrl, slug, quantity = 3) {
  const response = await fetch(`${baseUrl}/api/events/${slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity,
      theme: 'pastel',
      placement: 'single',
      words: [['liebe', 3], ['glück', 2]],
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('shipping page uses the immutable configuration and returns a server-side Printful quote', async (t) => {
  process.env.SHOP_SURCHARGE_PER_MUG_CENTS = '250';
  t.after(() => { delete process.env.SHOP_SURCHARGE_PER_MUG_CENTS; });

  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Preis Paula & Porto Paul' });
  const configuration = await saveConfiguration(baseUrl, event.slug, 3);

  const shippingPage = await fetch(`${baseUrl}/e/${event.slug}/shipping?configuration=${configuration.id}`);
  assert.equal(shippingPage.status, 200);
  assert.match(await shippingPage.text(), /Wohin dürfen eure Tassen reisen\?/);

  const printful = require('../src/printful');
  const originalCountries = printful.getShippingCountries;
  const originalEstimate = printful.estimateOrderCosts;
  let captured = null;
  printful.getShippingCountries = async () => [
    { code: 'DE', name: 'Germany', region: 'europe', states: [] },
    { code: 'US', name: 'United States', region: 'americas', states: [{ code: 'NY', name: 'New York' }] },
  ];
  printful.estimateOrderCosts = async (options) => {
    captured = options;
    return {
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
        // them and use the immutable configuration instead.
        quantity: 99,
        variantId: 999999,
        recipient: {
          name: 'Paula Beispiel',
          address1: 'Alexanderplatz 1',
          address2: '',
          city: 'Berlin',
          zip: '10178',
          country_code: 'de',
        },
      }),
    }
  );
  assert.equal(estimateResponse.status, 200);
  const { quote } = await estimateResponse.json();
  assert.deepEqual(quote, {
    currency: 'EUR',
    quantity: 3,
    itemsCents: 1750,
    shippingCents: 449,
    taxCents: 275,
    totalCents: 2474,
  });
  assert.equal(captured.variantId, 1320);
  assert.equal(captured.quantity, 3);
  assert.deepEqual(captured.recipient, {
    name: 'Paula Beispiel',
    address1: 'Alexanderplatz 1',
    city: 'Berlin',
    zip: '10178',
    country_code: 'DE',
  });

  captured = null;
  const missingState = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/estimate-costs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: {
          name: 'New York Nora', address1: '350 Fifth Avenue', city: 'New York',
          zip: '10118', country_code: 'US',
        },
      }),
    }
  );
  assert.equal(missingState.status, 400);
  assert.deepEqual((await missingState.json()).fields, ['state_code']);
  assert.equal(captured, null, 'invalid addresses must not reach Printful');
});

test('a configuration can never be quoted through another event slug', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const first = await createEvent(baseUrl, { coupleName: 'Erstes Paar' });
  const second = await createEvent(baseUrl, { coupleName: 'Zweites Paar' });
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
