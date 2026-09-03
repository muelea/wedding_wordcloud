'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeShippingRate, shippingTermsDiffer } = require('../src/printfulShipping');
const { shippingEstimate } = require('./support/printful-fixtures');

test('shipping adapter sends catalog placements and required options without creating an order', async (t) => {
  const originalFetch = global.fetch, originalKey = process.env.PRINTFUL_API_KEY;
  process.env.PRINTFUL_API_KEY = 'test_only';
  t.after(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.PRINTFUL_API_KEY; else process.env.PRINTFUL_API_KEY = originalKey; });
  const calls = [];
  const costs = { currency: 'EUR', subtotal: 25, shipping: 5, tax: 0, vat: 0, total: 30 };
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    return { ok: true, status: 200, json: async () => url.endsWith('/estimate-costs')
      ? { code: 200, result: { costs } }
      : { data: [{ shipping: 'STANDARD', rate: '5.00', currency: 'EUR',
        min_delivery_date: '2030-05-06', max_delivery_date: '2030-05-10',
        shipments: [
          { departure_country: 'LV', customs_fees_possible: false, shipment_items: [{ catalog_variant_id: 4532, quantity: 2 }] },
          { departure_country: 'US', customs_fees_possible: true, shipment_items: [{ catalog_variant_id: 12141, quantity: 1 }] },
        ] }] } };
  };
  const printful = require('../src/printful');
  const request = { recipient: { country_code: 'DE' }, items: [
    { variantId: 4532, quantity: 2, options: [{ id: 'stitch_color', value: 'invalid-client-value' }] },
    { variantId: 12141, quantity: 1 },
  ] };
  assert.deepEqual(await printful.estimateOrderCosts(request), costs);
  const result = await printful.getShippingRates(request);
  assert.deepEqual(calls[0].body.items[0].options, [{ id: 'stitch_color', value: 'white' }]);
  assert.equal(calls[0].body.items[0].files, undefined, 'current free placements need no artwork upload');
  assert.equal(calls[1].url, 'https://api.printful.com/v2/shipping-rates');
  assert.equal(calls[1].body.currency, 'EUR');
  assert.deepEqual(calls[1].body.order_items[0], { source: 'catalog', catalog_variant_id: 4532, quantity: 2,
    placements: [{ placement: 'front', technique: 'cut-sew' }, { placement: 'back', technique: 'cut-sew' }],
    product_options: [{ name: 'stitch_color', value: 'white' }] });
  assert.deepEqual(calls[1].body.order_items[1].placements,
    [{ placement: 'front', technique: 'digital' }, { placement: 'back', technique: 'digital' }]);
  assert.deepEqual(result.shipments.map(s => [s.departureCountry, s.customsFeesPossible]), [['LV', false], ['US', true]]);
  assert.equal(result.shipments[0].items[0].productKey, 'all-over-basic-pillow-18in');
  assert.equal(result.delivery.maxDate, '2030-05-10');
  assert.equal(calls.length, 2);
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  await assert.rejects(printful.getShippingRates(request), { code: 'PRINTFUL_SHIPPING_UNAVAILABLE' });
  global.fetch = async () => ({ ok: true, json: async () => ({ result: { rates: [] } }) });
  await assert.rejects(printful.getShippingRates(request), { code: 'PRINTFUL_INVALID_RESPONSE' });
});

test('shipping metadata validates item coverage and keeps missing customs data unknown', () => {
  const items = [{ catalog_variant_id: 1320, quantity: 3 }];
  const rate = { shipping: 'STANDARD', rate: '7.50', currency: 'EUR', min_delivery_date: '2030-02-30', max_delivery_date: '2030-02-31',
    shipments: [{ departure_country: null, shipment_items: items }] };
  const result = normalizeShippingRate(rate, items);
  assert.equal(result.shipments[0].departureCountry, null);
  assert.equal(result.shipments[0].customsFeesPossible, null);
  assert.deepEqual(result.delivery, { minDate: null, maxDate: null, minDays: null, maxDays: null });
  for (const shipments of [[], [{ shipment_items: [{ catalog_variant_id: 1320, quantity: 2 }] }],
    [{ shipment_items: [{ catalog_variant_id: 12141, quantity: 3 }] }], [...rate.shipments, ...rate.shipments]]) {
    assert.throws(() => normalizeShippingRate({ ...rate, shipments }, items));
  }
  const split = normalizeShippingRate({ ...rate, shipments: [1, 2].map(quantity => ({
    departure_country: 'US', customs_fees_possible: true, shipment_items: [{ catalog_variant_id: 1320, quantity }],
  })) }, items);
  assert.equal(split.shipments.length, 2);
});

test('a changed customs assessment or delivery estimate needs reconfirmation, a request timestamp does not', () => {
  const shipping = shippingEstimate({ variantId: 1320, quantity: 1 });
  const wrap = printfulShipping => [{ printfulShipping }];
  assert.equal(shippingTermsDiffer(wrap(shipping), wrap({ ...shipping, checkedAt: 'later' })), false);
  const fromDatabase = JSON.parse(JSON.stringify(shipping), (key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(shippingTermsDiffer(wrap(fromDatabase), wrap(shipping)), false, 'JSONB object key order has no semantic meaning');
  assert.equal(shippingTermsDiffer([{}], wrap(shipping)), true);
  const changed = structuredClone(shipping);
  changed.shipments[0].customsFeesPossible = true;
  assert.equal(shippingTermsDiffer(wrap(shipping), wrap(changed)), true);
  changed.shipments = shipping.shipments;
  changed.delivery.maxDate = '2030-01-19';
  assert.equal(shippingTermsDiffer(wrap(shipping), wrap(changed)), true);
});
