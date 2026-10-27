'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { paymentAmounts } = require('../src/checkoutTax');

function fixture() {
  const order = {
    id: 42, mode: 'test', currency: 'EUR', items_cents: 1770,
    shipping_cents: 449, tax_cents: 0, total_cents: 2219, status: 'checkout_pending',
    checkout_request_json: JSON.stringify({ customerId: 'cus_testtax' }),
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
  assert.equal(paymentAmounts(order, session), null, 'a checkout without its pinned Stripe customer is invalid');
});

test('payment keeps the tax and gross total preview pinned until the signed payment arrives', () => {
  const { order, session } = fixture();
  order.checkout_request_json = JSON.stringify({
    customerId: 'cus_testtax', expectedTaxCents: 421, expectedTotalCents: 2640,
  });
  assert.deepEqual(paymentAmounts(order, session), { taxCents: 421, totalCents: 2640 });
  session.amount_total += 1;
  assert.equal(paymentAmounts(order, session), null);
  const partial = fixture();
  partial.order.checkout_request_json = JSON.stringify({ customerId: 'cus_testtax', expectedTaxCents: 421 });
  assert.equal(paymentAmounts(partial.order, partial.session), null);
});

test('inclusive payments extract tax without adding it again and reject changed shipping tax', () => {
  const { order, session } = fixture();
  order.checkout_request_json = JSON.stringify({ customerId: 'cus_testtax',
    pricing: { version: 2, country: 'DE', taxBehavior: 'inclusive', itemsCents: 1770, shippingCents: 449 },
    expectedTaxCents: 354, expectedTotalCents: 2219, expectedShippingTaxCents: 72,
  });
  session.amount_total = 2219;
  session.total_details.amount_tax = 354;
  session.shipping_cost = { amount_subtotal: 449, amount_tax: 72, amount_total: 449 };
  assert.deepEqual(paymentAmounts(order, session), { taxCents: 354, totalCents: 2219 });
  session.amount_total += 354;
  assert.equal(paymentAmounts(order, session), null, 'included VAT cannot be charged twice');
  session.amount_total = 2219;
  session.shipping_cost.amount_tax++;
  assert.equal(paymentAmounts(order, session), null, 'shipping tax stays pinned with the preview');
});

test('catalog Checkout preserves unit prices, paginates large carts and rejects incomplete line amounts', async t => {
  process.env.STRIPE_PAYMENT_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_catalog_unit';
  delete require.cache[require.resolve('../src/stripe')];
  const integration = require('../src/stripe');
  const { buildCustomerQuoteForShipments } = require('../src/pricing');
  const { getProduct } = require('../src/products');
  const sdk = new Stripe('sk_test_sdk_mock');
  let returnedLines, mutation = null, listCalls = 0, submitted;
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async params => {
    submitted = params;
    const inclusive = params.line_items[0].price_data.tax_behavior === 'inclusive';
    const subtotal = params.line_items.reduce((sum, item) => sum + item.quantity * item.price_data.unit_amount, 0);
    const shipping = params.shipping_options[0].shipping_rate_data.fixed_amount.amount;
    const factor = inclusive ? .19 / 1.19 : .20;
    const shippingTax = Math.round(shipping * factor);
    returnedLines = params.line_items.map(item => {
      const amount_subtotal = item.quantity * item.price_data.unit_amount;
      return { quantity: item.quantity, amount_subtotal,
        amount_total: amount_subtotal + (inclusive ? 0 : Math.round(amount_subtotal * factor)) };
    });
    const tax = shippingTax + returnedLines.reduce((sum, line) => sum + Math.round(line.amount_subtotal * factor), 0);
    const result = { id: 'cs_test_catalog', url: 'https://checkout.stripe.test/catalog', customer: 'cus_testtax', currency: 'eur',
      amount_subtotal: subtotal, amount_total: subtotal + shipping + (inclusive ? 0 : tax),
      total_details: { amount_tax: tax, amount_discount: 0 }, automatic_tax: { enabled: true, status: 'complete' },
      shipping_cost: { amount_subtotal: shipping, amount_tax: shippingTax, amount_total: shipping + (inclusive ? 0 : shippingTax) },
      line_items: { has_more: returnedLines.length > 10, data: returnedLines.slice(0, 10) },
    };
    if (mutation) mutation(result);
    return result;
  });
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'listLineItems', async (id, params) => {
    assert.equal(id, 'cs_test_catalog'); assert.equal(params.limit, 100); listCalls++;
    return { has_more: false, data: returnedLines };
  });
  for (const [country, count] of [['DE', 2], ['FR', 20]]) {
    const items = Array.from({ length: count }, (_, index) => ({ configurationId: 'design' + index,
      productKey: 'white-glossy-mug-duo-11oz', variantId: 1320, quantity: index === 0 ? 2 : 1 }));
    const recipient = { name: 'Tax Test', address1: 'Musterweg 1', city: 'Berlin', zip: '10115', country_code: country };
    const quote = buildCustomerQuoteForShipments([{ recipient, items, costs: { currency: 'EUR', total: 32.78, shipping: 11.43 } }]);
    const request = integration.freezeCheckoutRequest({ products: items.map(item => getProduct(item.productKey)),
      configurationIds: items.map(item => item.configurationId), quantity: count + 1, slug: 'tax-test', quoteId: 'catalog',
      baseUrl: 'https://example.test', shipments: [{ recipient, items, customerCosts: { pricing: quote.pricing } }],
    });
    const order = { ...fixture().order, items_cents: quote.itemsCents, shipping_cents: quote.shippingCents,
      total_cents: quote.totalCents, checkout_request_json: JSON.stringify({ ...request, customerId: 'cus_testtax' }) };
    const create = () => integration.createCheckoutSession({ order, ...request, customerId: 'cus_testtax' });
    const result = await create();
    assert.equal(submitted.line_items[0].quantity, 2);
    assert.equal(submitted.line_items[0].price_data.unit_amount, country === 'DE' ? 1107 : 930);
    assert.equal(submitted.line_items[0].price_data.tax_behavior, country === 'DE' ? 'inclusive' : 'exclusive');
    assert.equal(result.pricedItems.length, count);
    assert.equal(result.pricedItems.reduce((sum, item) => sum + item.grossTotalCents, 0) + quote.shippingCents +
      (country === 'DE' ? 0 : result.shippingTaxCents), result.totalCents);
    mutation = session => { session.line_items.data[0].quantity++; };
    await assert.rejects(create(), error => error.code === 'STRIPE_TAX_CALCULATION_INCOMPLETE');
    mutation = null;
  }
  assert.equal(listCalls, 2, 'both large-cart responses fetch all designs before validating totals');
});

test('Stripe cancel and success URLs preserve the checkout origin and the complete cart', async t => {
  process.env.STRIPE_PAYMENT_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_return_unit';
  delete require.cache[require.resolve('../src/stripe')];
  const integration = require('../src/stripe');
  const { getCheckoutBaseUrl } = require('../src/baseUrl');
  const sdk = new Stripe('sk_test_sdk_mock');
  let submitted;
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async params => {
    submitted = params;
    return { ...fixture().session, url: 'https://checkout.stripe.test/return' };
  });
  const product = { key: 'mug', name: 'Weiße Tasse', unit: { singular: 'Tasse', plural: 'Tassen' } };
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.0.0.163:3000', 'https://example.test']) {
    const url = new URL(origin);
    for (const ids of [['design1'], ['design1', 'design2']]) {
      const request = integration.freezeCheckoutRequest({
        products: ids.map(() => product), configurationIds: ids,
        quoteId: 'quote1', quantity: 2, slug: 'return-test', locale: 'en',
        baseUrl: getCheckoutBaseUrl({ protocol: url.protocol.slice(0, -1), get: () => url.host }, 3000),
        shipments: [{ items: ids.map(id => ({ configurationId: id, quantity: 2 / ids.length })),
          recipient: { name: 'Return Test', address1: 'Musterweg 1', city: 'Berlin', zip: '10115', country_code: 'DE' } }],
      });
      await integration.createCheckoutSession({ order: fixture().order, ...request, customerId: 'cus_testtax' });
      const cancel = new URL(submitted.cancel_url);
      assert.equal(cancel.origin, origin);
      assert.equal(cancel.pathname, '/e/return-test/shipping');
      assert.equal(cancel.searchParams.get(ids.length === 1 ? 'configuration' : 'configurations'), ids.join(','));
      assert.equal(cancel.searchParams.get('quote'), 'quote1');
      assert.equal(cancel.searchParams.get('checkout'), 'cancelled');
      assert.equal(cancel.searchParams.get('lang'), 'en');
      const success = new URL(submitted.success_url);
      assert.equal(success.origin, origin);
      assert.equal(success.pathname, '/e/return-test/order-confirmation');
    }
  }
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
  let returnIncompleteTax = false;
  t.mock.method(Object.getPrototypeOf(sdk.customers), 'create', async (...args) => {
    customerCalls.push(args); return { id: 'cus_testtax' };
  });
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async (...args) => {
    assert.equal(persistedCustomer, 'cus_testtax', 'customer is durable before a Session can be paid');
    sessionCalls.push(args);
    if (sessionCalls.length === 1) throw new Error('ambiguous connection timeout');
    if (returnIncompleteTax) {
      return {
        id: 'cs_test_incomplete_tax', url: 'https://checkout.stripe.test/incomplete',
        automatic_tax: { enabled: true, status: 'requires_location_inputs' },
      };
    }
    return {
      ...fixture().session,
      id: 'cs_test_tax',
      url: 'https://checkout.stripe.test/tax',
    };
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
  const created = await integration.createCheckoutSession({
    order, ...request, customerId: persistedCustomer, persistCustomer,
  });
  assert.equal(created.taxCents, 421);
  assert.equal(created.totalCents, 2640);
  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0][0].shipping.address.country, 'DE');
  assert.equal(customerCalls[0][0].shipping.address.postal_code, '10115');
  assert.equal(customerCalls[0][1].idempotencyKey, 'wolkenworte-test-quote-quote1-customer');
  assert.deepEqual(sessionCalls[0], sessionCalls[1], 'recovered Session uses the original idempotent payload');
  const [params, options] = sessionCalls[1];
  assert.deepEqual(params.allowed_payment_method_types, ['card', 'paypal']);
  assert.equal(params.payment_method_types, undefined, 'Stripe filters to active eligible methods');
  assert.equal(params.payment_intent_data.shipping, undefined,
    'Checkout automatic tax cannot be combined with PaymentIntent shipping');
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
  assert.match(params.custom_text.submit.message, /personalised goods/i);
  assert.match(params.custom_text.submit.message, /312g\(2\)\(1\)/i);
  assert.match(params.custom_text.submit.message, /customs duties/i);
  assert.ok(
    params.custom_text.submit.message.indexOf('customs duties') < params.custom_text.submit.message.indexOf('personalised goods'),
    'Stripe shows customs information before the personalised-goods notice, matching shipping'
  );
  assert.equal(options.idempotencyKey, order.stripe_idempotency_key);
  assert.equal(params.payment_intent_data.metadata.orderId, '42');
  const { allowedPaymentMethodTypes, ...legacyRequest } = request;
  await integration.createCheckoutSession({
    order: { ...order, stripe_idempotency_key: 'legacy-card-key' },
    ...legacyRequest, customerId: persistedCustomer, persistCustomer,
  });
  const [legacyParams] = sessionCalls[2];
  assert.deepEqual(legacyParams.payment_method_types, ['card']);
  assert.equal(legacyParams.allowed_payment_method_types, undefined);
  assert.deepEqual(legacyParams.payment_intent_data, { metadata: params.metadata },
    'an older persisted order retains its original card-only idempotent payload');
  await assert.rejects(integration.createCheckoutSession({
    order, ...request, allowedPaymentMethodTypes: ['card', 'paypal', 'klarna'],
    customerId: persistedCustomer, persistCustomer,
  }), (error) => error.code === 'STRIPE_INVALID_CHECKOUT_REQUEST');
  assert.equal(sessionCalls.length, 3, 'unreviewed payment methods never reach Stripe');
  returnIncompleteTax = true;
  await assert.rejects(
    integration.createCheckoutSession({
      order, ...request, customerId: persistedCustomer, persistCustomer,
    }),
    (error) => error.code === 'STRIPE_TAX_CALCULATION_INCOMPLETE'
  );
});
