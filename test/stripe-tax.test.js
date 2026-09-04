'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { paymentAmounts } = require('../src/checkoutTax');

function fixture() {
  const order = {
    id: 42, mode: 'test', currency: 'EUR', items_cents: 1770,
    shipping_cents: 449, tax_cents: 0, total_cents: 2219, status: 'checkout_pending',
    checkout_request_json: JSON.stringify({ taxMode: 'stripe', customerId: 'cus_testtax' }),
    checkout_session_expires_at: new Date(Date.now() + 31 * 60 * 1000).toISOString(),
    stripe_idempotency_key: 'quote-test-key',
  };
  const session = {
    id: 'cs_test_tax', customer: 'cus_testtax', currency: 'eur', payment_status: 'paid',
    amount_subtotal: 1770, amount_total: 2640,
    total_details: { amount_tax: 421, amount_discount: 0 },
    shipping_cost: { amount_subtotal: 449, amount_tax: 85, amount_total: 534 },
    automatic_tax: { enabled: true, status: 'complete' },
  };
  return { order, session };
}

test('payment accepts the exact Stripe tax result without calculating its own rate', () => {
  const { order, session } = fixture();
  assert.deepEqual(paymentAmounts(order, session), { taxCents: 421, totalCents: 2640 });
  session.amount_total = 2219;
  session.total_details.amount_tax = 0;
  session.shipping_cost = { amount_subtotal: 449, amount_tax: 0, amount_total: 449 };
  assert.deepEqual(paymentAmounts(order, session), { taxCents: 0, totalCents: 2219 });
});

test('automatic-tax payment rejects altered net amounts, currency, customer or incomplete tax', () => {
  const mutations = [
    (s) => { s.amount_subtotal -= 1; s.amount_total -= 1; },
    (s) => { s.shipping_cost.amount_subtotal -= 1; },
    (s) => { s.currency = 'usd'; },
    (s) => { s.customer = 'cus_someoneelse'; },
    (s) => { s.automatic_tax.status = 'failed'; },
    (s) => { s.automatic_tax.enabled = false; },
    (s) => { s.total_details.amount_discount = 1; },
    (s) => { s.total_details.amount_tax = null; },
    (s) => { s.total_details.amount_tax = -1; },
    (s) => { s.amount_total = 2219; },
    (s) => { s.shipping_cost = null; },
  ];
  for (const mutate of mutations) {
    const { order, session } = fixture();
    mutate(session);
    assert.equal(paymentAmounts(order, session), null, mutate.toString());
  }
  const { order, session } = fixture();
  order.status = 'paid_test'; order.tax_cents = 422; order.total_cents = 2641;
  assert.equal(paymentAmounts(order, session), null, 'later events cannot change paid totals');
  order.checkout_request_json = '{}';
  session.amount_total = 2641;
  assert.equal(paymentAmounts(order, session).totalCents, 2641, 'existing legacy payments retain gross validation');
});

test('hosted Checkout pins shipping, separates net products and shipping, and retries identical Stripe inputs', async (t) => {
  process.env.STRIPE_PAYMENT_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_tax_unit';
  delete require.cache[require.resolve('../src/stripe')];
  const integration = require('../src/stripe');
  const sdk = new Stripe('sk_test_sdk_mock');
  const customerCalls = [];
  const sessionCalls = [];
  let persistedCustomer = null;
  t.mock.method(Object.getPrototypeOf(sdk.customers), 'create', async (...args) => {
    customerCalls.push(args); return { id: 'cus_testtax' };
  });
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async (...args) => {
    assert.equal(persistedCustomer, 'cus_testtax', 'customer is durable before a Session can be paid');
    sessionCalls.push(args);
    if (sessionCalls.length === 1) throw new Error('ambiguous connection timeout');
    return { id: 'cs_test_tax', url: 'https://checkout.stripe.test/tax' };
  });
  const product = { key: 'mug', name: 'Weiße Tasse', unit: { singular: 'Tasse', plural: 'Tassen' }, size: { label: '11 oz' } };
  const request = integration.freezeCheckoutRequest({
    product, configurationId: 'design1', quoteId: 'quote1', quantity: 2,
    slug: 'tax-test', baseUrl: 'https://example.test', locale: 'en',
    shipments: [{ quantity: 2, recipient: {
      name: 'Tax Test', address1: 'Musterweg 1', city: 'Berlin', zip: '10115', country_code: 'DE',
    } }],
  });
  const { order } = fixture();
  const persistCustomer = async (id) => { persistedCustomer = id; };
  await assert.rejects(integration.createCheckoutSession({ order, ...request, persistCustomer }), /timeout/);
  await integration.createCheckoutSession({ order, ...request, customerId: persistedCustomer, persistCustomer });
  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0][0].shipping.address.country, 'DE');
  assert.equal(customerCalls[0][0].shipping.address.postal_code, '10115');
  assert.equal(customerCalls[0][1].idempotencyKey, 'wolkenworte-test-quote-quote1-customer');
  assert.deepEqual(sessionCalls[0], sessionCalls[1], 'recovered Session uses the original idempotent payload');
  const [params, options] = sessionCalls[1];
  assert.equal(params.customer, 'cus_testtax');
  assert.deepEqual(params.automatic_tax, { enabled: true });
  assert.deepEqual(params.adaptive_pricing, { enabled: false }, 'preserve the trusted EUR quote currency');
  assert.equal(params.shipping_address_collection, undefined);
  assert.equal(params.customer_update, undefined, 'billing input cannot overwrite validated shipping');
  assert.equal(params.line_items[0].price_data.unit_amount, 1770);
  assert.equal(params.line_items[0].price_data.tax_behavior, 'exclusive');
  assert.equal(params.line_items[0].price_data.product_data.tax_code, 'txcd_99999999');
  assert.equal(params.line_items[0].price_data.product_data.name, '2 × White mug');
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 449);
  assert.equal(params.shipping_options[0].shipping_rate_data.tax_behavior, 'exclusive');
  assert.equal(params.shipping_options[0].shipping_rate_data.display_name, 'Shipping');
  assert.equal(options.idempotencyKey, order.stripe_idempotency_key);
  assert.equal(params.payment_intent_data.metadata.orderId, '42');
});
