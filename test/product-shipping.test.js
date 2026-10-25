'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shippingRestrictions, unavailableProducts } = require('../src/productShipping');

test('published case restrictions are independent of provider quote success and variant finish', () => {
  for (const productId of [601, 686, 798]) {
    const product = { key: `case-${productId}`, printful: { productId } };
    for (const country of ['JP', 'SG', 'HK', 'TW', 'KR', ' jp ']) {
      assert.deepEqual(unavailableProducts([product, product], country), [product]);
    }
    for (const country of ['DE', 'US', 'FR', 'GB', 'CA', 'AU']) {
      assert.deepEqual(unavailableProducts([product], country), []);
    }
    assert.ok(Object.isFrozen(shippingRestrictions(productId)));
  }
});

test('unrestricted products remain available and public restrictions use the same policy', () => {
  const mug = { key: 'mug', printful: { productId: 19 } };
  const phone = { key: 'phone', shippingRestrictions: shippingRestrictions(601) };
  assert.deepEqual(unavailableProducts([mug, phone], 'JP'), [phone]);
  assert.deepEqual(unavailableProducts([mug], 'JP'), []);
});

test('case quotes, rates and fulfillment reject restricted countries before any provider request', async t => {
  const printful = require('../src/printful');
  const oldKey = process.env.PRINTFUL_API_KEY, oldFetch = global.fetch;
  process.env.PRINTFUL_API_KEY = 'catalog-test';
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error('unexpected provider call'); };
  t.after(() => { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.PRINTFUL_API_KEY; else process.env.PRINTFUL_API_KEY = oldKey; });
  for (const product of require('../src/products').PRODUCTS.filter(product => product.previewModel?.kind === 'case')) {
    const recipient = { country_code: 'JP' }, items = [{ variantId: product.printful.variantId, quantity: 1 }];
    const rejected = error => error.code === 'PRINTFUL_PRODUCT_RESTRICTED' && error.products[0].key === product.key;
    await assert.rejects(printful.estimateOrderCosts({ items, recipient }), rejected);
    await assert.rejects(printful.getShippingRates({ items, recipient }), rejected);
    const payload = { external_id: 'restricted-test', items: [{ variant_id: product.printful.variantId, quantity: 1 }], recipient };
    await assert.rejects(printful.createPrintfulOrder({ payload }), rejected);
    await assert.rejects(printful.reconcilePrintfulOrder({ payload, expectedCosts: {} }), rejected);
  }
  assert.equal(requests, 0);
});
