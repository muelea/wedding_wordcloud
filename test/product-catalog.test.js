'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCTS, getProduct, getPublicProducts } = require('../src/products');
const { catalogPrice } = require('../src/pricing');
const { refreshProductCosts } = require('../scripts/refresh-product-costs');
const fulfillment = require('./fixtures/catalog-eu-fulfillment.json');
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

test('the shared catalog offers only audited variants with EU fulfillment for Germany', () => {
  const eligible = fulfillment.variants.filter(variant =>
    variant.germanyAvailability === 'in stock' && EU_COUNTRIES.has(variant.departureCountry));
  assert.equal(eligible.length, 61);
  assert.deepEqual(PRODUCTS.map(product => product.printful.variantId).sort((a, b) => a - b),
    eligible.map(variant => variant.variantId).sort((a, b) => a - b));
  assert.deepEqual(getPublicProducts().map(product => product.key).sort(),
    eligible.map(variant => variant.productKey).sort());

  for (const variant of fulfillment.variants.filter(variant => !eligible.includes(variant))) {
    assert.equal(getProduct(variant.productKey), null, variant.productKey);
    assert.throws(() => catalogPrice(variant.variantId), /missing catalog price/);
  }
});

test('supplier cost refresh uses a German reference address for every offered variant', async () => {
  const requested = [];
  const snapshot = await refreshProductCosts({ products: PRODUCTS,
    estimate: async ({ variantId, quantity, recipient }) => {
      assert.equal(recipient.country_code, 'DE');
      assert.equal(recipient.zip, '10115');
      assert.equal(quantity, 1);
      requested.push(variantId);
      return { currency: 'EUR', total: '15.00', shipping: '5.00', tax: '0.00', vat: '0.00' };
    },
  });
  assert.deepEqual(requested, PRODUCTS.map(product => product.printful.variantId));
  assert.equal(snapshot.referenceCountry, 'DE');
  assert.equal(Object.keys(snapshot.variants).length, PRODUCTS.length);
  assert.ok(Object.values(snapshot.variants).every(variant => !variant.referenceCountry));
});
