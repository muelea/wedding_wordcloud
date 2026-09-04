'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCustomerQuote, buildCustomerQuoteForShipments, paymentReservePercent } = require('../src/pricing');

test.beforeEach((t) => {
  const settings = {
    SHOP_PRODUCT_MARKUP_PERCENT: '50',
    SHOP_PAYMENT_RESERVE_PERCENT: '3.65',
    SHOP_PAYMENT_RESERVE_FIXED_CENTS: '25',
  };
  for (const [name, value] of Object.entries(settings)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});

test('catalog-wide pricing adds a 50% markup and payment reserve to Printful product costs', () => {
  const quote = buildCustomerQuote({
    currency: 'EUR', subtotal: 10, shipping: 4, tax: 0, vat: 2.8, total: 16.8,
  }, 2);
  assert.deepEqual({ ...quote, shipmentQuotes: undefined }, {
    currency: 'EUR', quantity: 2, itemsCents: 1614, paymentReserveCents: 114,
    shippingCents: 400, taxCents: 403, totalCents: 2417, shipmentQuotes: undefined,
  });
});

test('inexpensive products use the same markup rule', () => {
  const quote = buildCustomerQuote({
    currency: 'EUR', subtotal: 2, shipping: 4, tax: 0, vat: 1.2, total: 7.2,
  }, 1);
  assert.equal(quote.itemsCents, 359);
  assert.equal(quote.paymentReserveCents, 59);
  assert.equal(quote.taxCents, 152);
  assert.equal(quote.totalCents, 911);
});

test('split shipments apply the markup to the combined product subtotal', () => {
  const quote = buildCustomerQuoteForShipments([
    { quantity: 2, costs: { currency: 'EUR', shipping: 4, tax: 0, vat: 1, total: 6 } },
    { quantity: 1, costs: { currency: 'EUR', shipping: 5, tax: 0, vat: 1.4, total: 8.4 } },
  ]);
  assert.deepEqual({ ...quote, shipmentQuotes: undefined }, {
    currency: 'EUR',
    quantity: 3,
    itemsCents: 538,
    paymentReserveCents: 88,
    shippingCents: 900,
    taxCents: 288,
    totalCents: 1726,
    shipmentQuotes: undefined,
  });
  assert.deepEqual(quote.shipmentQuotes.map((shipment) => shipment.taxCents), [116, 172]);
  const combined = buildCustomerQuote({ currency: 'EUR', shipping: 9, vat: 2.4, total: 14.4 }, 3);
  assert.equal(quote.paymentReserveCents, combined.paymentReserveCents, 'charge the fixed fee once per purchase');
});

test('legacy customer VAT remains separate from the fixed reserve tax assumption', () => {
  const quote = buildCustomerQuote({
    currency: 'EUR', shipping: 6.24, tax: 0, vat: 3.28, total: 20.50,
  }, 2);
  assert.equal(quote.itemsCents, 1778);
  assert.equal(quote.paymentReserveCents, 131);
  assert.equal(quote.shippingCents, 624);
  assert.equal(quote.taxCents, 456);
  assert.equal(quote.totalCents, 2858);
});

test('a lower quantity-discounted Printful subtotal automatically lowers the customer unit price', () => {
  const regular = buildCustomerQuote({ currency: 'EUR', shipping: 0, tax: 0, vat: 0, total: 50 }, 10);
  const discounted = buildCustomerQuote({ currency: 'EUR', shipping: 0, tax: 0, vat: 0, total: 40 }, 10);
  assert.equal(regular.itemsCents, 7870);
  assert.equal(discounted.itemsCents, 6301);
  assert.ok(discounted.itemsCents / 10 < regular.itemsCents / 10);
});

test('reserve uses 20% internally whether Printful returns no tax, zero tax, VAT or sales tax', () => {
  const variants = [{}, { tax: 0, vat: 0 }, { vat: 2.85 }, { tax: 1.2 }, { tax: 2, vat: 3 }];
  for (const taxes of variants) {
    const supplierTax = (taxes.tax || 0) + (taxes.vat || 0);
    const quote = buildCustomerQuote({
      currency: 'EUR', subtotal: 10, shipping: 5, ...taxes, total: 15 + supplierTax,
    }, 2);
    assert.equal(quote.paymentReserveCents, 118, JSON.stringify(taxes));
    assert.equal(quote.itemsCents, 1618);
    assert.equal(quote.shippingCents, 500);
    assert.equal(quote.shipmentQuotes[0].supplierTaxCents, Math.round(supplierTax * 100));
    if (!supplierTax) assert.equal(quote.taxCents, 0, 'the internal 20% must not become customer tax');
  }
});

test('reserve covers fees on its own amount, shipping and the assumed tax after cent rounding', () => {
  const quote = buildCustomerQuote({ currency: 'EUR', shipping: 5, total: 15 }, 1);
  // 15.00 product + 5.00 shipping + 1.18 reserve, with 20% assumed tax:
  // 25.42 gross * 3.65% + 0.25 = 1.17783, rounded up to 1.18.
  assert.equal(quote.paymentReserveCents, 118);
  const assumedGrossCents = 2542;
  assert.ok(quote.paymentReserveCents >= Math.ceil(assumedGrossCents * 0.0365 + 25));
});

test('missing or invalid reserve configuration defaults to 3.65% plus 25 cents', () => {
  delete process.env.SHOP_PAYMENT_RESERVE_PERCENT;
  delete process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS;
  assert.equal(paymentReservePercent(), 3.65);
  assert.equal(buildCustomerQuote({ currency: 'EUR', shipping: 5, total: 15 }, 1).paymentReserveCents, 118);
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = 'invalid';
  assert.equal(paymentReservePercent(), 3.65);
});

test('reserve fallback returns the twentieth estimate if it has not converged', () => {
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '20';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '500';
  // An artificially large but safe-integer amount keeps the reserve growing
  // after 20 iterations, exercising the fallback without a supplier tax input.
  const quote = buildCustomerQuote({
    currency: 'EUR',
    shipping: 0,
    tax: 0,
    vat: 0,
    total: 1_000_000_000_000,
  }, 1);
  assert.ok(Number.isSafeInteger(quote.paymentReserveCents));
  assert.equal(quote.paymentReserveCents, 47_368_421_053_271);
  const assumedGrossCents = quote.itemsCents + Math.round(quote.itemsCents * 0.2);
  assert.ok(Math.ceil(assumedGrossCents * 0.2 + 500) > quote.paymentReserveCents);
  assert.ok(Number.isSafeInteger(quote.totalCents));
});
