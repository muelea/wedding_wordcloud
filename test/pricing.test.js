'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCustomerQuote, buildCustomerQuoteForShipments } = require('../src/pricing');

test('catalog-wide pricing adds a 50% markup and payment reserve to Printful product costs', () => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.15';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  const quote = buildCustomerQuote({
    currency: 'EUR', subtotal: 10, shipping: 4, tax: 0, vat: 2.8, total: 16.8,
  }, 2);
  assert.deepEqual({ ...quote, shipmentQuotes: undefined }, {
    currency: 'EUR', quantity: 2, itemsCents: 1601, paymentReserveCents: 101,
    shippingCents: 400, taxCents: 400, totalCents: 2401, shipmentQuotes: undefined,
  });
});

test('inexpensive products use the same markup rule', () => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.15';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  const quote = buildCustomerQuote({
    currency: 'EUR', subtotal: 2, shipping: 4, tax: 0, vat: 1.2, total: 7.2,
  }, 1);
  assert.equal(quote.itemsCents, 354);
  assert.equal(quote.paymentReserveCents, 54);
  assert.equal(quote.taxCents, 151);
  assert.equal(quote.totalCents, 905);
});

test('split shipments apply the markup to the combined product subtotal', () => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.15';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  const quote = buildCustomerQuoteForShipments([
    { quantity: 2, costs: { currency: 'EUR', shipping: 4, tax: 0, vat: 1, total: 6 } },
    { quantity: 1, costs: { currency: 'EUR', shipping: 5, tax: 0, vat: 1.4, total: 8.4 } },
  ]);
  assert.deepEqual({ ...quote, shipmentQuotes: undefined }, {
    currency: 'EUR',
    quantity: 3,
    itemsCents: 530,
    paymentReserveCents: 80,
    shippingCents: 900,
    taxCents: 286,
    totalCents: 1716,
    shipmentQuotes: undefined,
  });
  assert.deepEqual(quote.shipmentQuotes.map((shipment) => shipment.taxCents), [115, 171]);
});

test('customer VAT is calculated on marked-up product subtotal plus shipping', () => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.15';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  const quote = buildCustomerQuote({
    currency: 'EUR', shipping: 6.24, tax: 0, vat: 3.28, total: 20.50,
  }, 2);
  assert.equal(quote.itemsCents, 1762);
  assert.equal(quote.paymentReserveCents, 115);
  assert.equal(quote.shippingCents, 624);
  assert.equal(quote.taxCents, 453);
  assert.equal(quote.totalCents, 2839);
});

test('a lower quantity-discounted Printful subtotal automatically lowers the customer unit price', () => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.15';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '25';
  const regular = buildCustomerQuote({ currency: 'EUR', shipping: 0, tax: 0, vat: 0, total: 50 }, 10);
  const discounted = buildCustomerQuote({ currency: 'EUR', shipping: 0, tax: 0, vat: 0, total: 40 }, 10);
  assert.equal(regular.itemsCents, 7770);
  assert.equal(discounted.itemsCents, 6221);
  assert.ok(discounted.itemsCents / 10 < regular.itemsCents / 10);
});

test('reserve fallback returns a quote instead of failing on pathological convergence', () => {
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '20';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '500';
  const quote = buildCustomerQuote({
    currency: 'EUR',
    shipping: 0,
    tax: 0,
    vat: 3.9,
    total: 4.9,
  }, 1);
  assert.ok(Number.isSafeInteger(quote.paymentReserveCents));
  assert.ok(quote.paymentReserveCents > 0);
  assert.ok(Number.isSafeInteger(quote.totalCents));
});
