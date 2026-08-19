'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCustomerQuote } = require('../src/pricing');

test('catalog-wide pricing targets a 45% gross margin on Printful product costs', () => {
  process.env.SHOP_TARGET_MARGIN_PERCENT = '45';
  process.env.SHOP_MIN_PROFIT_PER_ORDER_CENTS = '500';
  const quote = buildCustomerQuote({
    currency: 'EUR', subtotal: 10, shipping: 4, tax: 0, vat: 2, total: 16,
  }, 2);
  assert.deepEqual(quote, {
    currency: 'EUR', quantity: 2, itemsCents: 1819, shippingCents: 400,
    taxCents: 200, totalCents: 2419,
  });
});

test('minimum contribution protects inexpensive future products', () => {
  process.env.SHOP_TARGET_MARGIN_PERCENT = '45';
  process.env.SHOP_MIN_PROFIT_PER_ORDER_CENTS = '500';
  const quote = buildCustomerQuote({
    currency: 'EUR', subtotal: 2, shipping: 4, tax: 0, vat: 1, total: 7,
  }, 1);
  assert.equal(quote.itemsCents, 700, '2,00 € cost + 5,00 € minimum contribution');
  assert.equal(quote.totalCents, 1200);
});

test('a lower quantity-discounted Printful subtotal automatically lowers the customer unit price', () => {
  process.env.SHOP_TARGET_MARGIN_PERCENT = '45';
  process.env.SHOP_MIN_PROFIT_PER_ORDER_CENTS = '500';
  const regular = buildCustomerQuote({ currency: 'EUR', shipping: 0, tax: 0, vat: 0, total: 50 }, 10);
  const discounted = buildCustomerQuote({ currency: 'EUR', shipping: 0, tax: 0, vat: 0, total: 40 }, 10);
  assert.equal(regular.itemsCents, 9091);
  assert.equal(discounted.itemsCents, 7273);
  assert.ok(discounted.itemsCents / 10 < regular.itemsCents / 10);
});
