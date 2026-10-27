'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyticsItems } = require('../src/analyticsCommerce');
const mug = 'white-glossy-mug-duo-11oz', poster = 'matte-poster-30x40cm';
const revenue = rows => rows.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

test('frozen per-line net totals retain real products and quantities with exact rounding', () => {
  const items = analyticsItems([
    { productKey: mug, quantity: 3, unitAmountCents: 1107, netTotalCents: 2791, configurationId: 'private-id' },
    { productKey: poster, quantity: 2, unitAmountCents: 1957, netTotalCents: 3289, email: 'private@example.test' },
  ], 6080);
  assert.equal(revenue(items), 6080);
  assert.equal(items.filter(item=>item.productKey===mug).reduce((sum,item)=>sum+item.quantity,0),3);
  assert.equal(items.filter(item=>item.productKey===poster).reduce((sum,item)=>sum+item.quantity,0),2);
  assert.equal(revenue(items.filter(item=>item.productKey===mug)),2791);
  assert.ok(!JSON.stringify(items).includes('private'));
  assert.equal(items[0].category, 'mugs');
});

test('older tax-inclusive snapshots allocate aggregate net cents deterministically', () => {
  const rows = [{ productKey: mug, quantity: 2, unitAmountCents: 1107 },
    { productKey: poster, quantity: 1, unitAmountCents: 1957 }];
  for (let net = 3490; net < 3530; net++) {
    const items = analyticsItems(rows, net);
    assert.equal(revenue(items), net);
    assert.equal(items.reduce((sum,item)=>sum+item.quantity,0),3);
    assert.deepEqual(analyticsItems(rows, net), items);
  }
});

test('unpaid, malformed and unknown product snapshots never fabricate order items', () => {
  assert.deepEqual(analyticsItems(null, 1000), []);
  for (const row of [{productKey:'unknown',quantity:1,unitAmountCents:1000},
    {productKey:mug,quantity:0,unitAmountCents:1000}, {productKey:mug,quantity:1,unitAmountCents:-1}]) {
    assert.deepEqual(analyticsItems([row], 1000), []);
  }
  assert.deepEqual(analyticsItems([{productKey:mug,quantity:1,unitAmountCents:1000}], -1), []);
});
