'use strict';

// Unit-level checks for the Stripe/Printful integration shape: both must be
// no-op-safe (never throw uncaught, never silently "succeed") when their
// real credentials aren't configured — which is the expected state for
// this build pass. The HTTP-level behavior (POST /api/events/:slug/checkout
// returning 501 with a clear German message when Stripe isn't configured)
// is exercised manually in README "Try it" steps and was verified during
// development; these tests pin down the underlying module contracts.

const test = require('node:test');
const assert = require('node:assert/strict');

test('stripe.isConfigured() is false and createCheckoutSession() rejects clearly without env vars', async () => {
  delete process.env.STRIPE_TEST_SECRET_KEY;
  process.env.STRIPE_PAYMENT_MODE = 'test';
  delete require.cache[require.resolve('../src/stripe')];
  const stripe = require('../src/stripe');

  assert.equal(stripe.isConfigured(), false);
  await assert.rejects(
    () => stripe.createCheckoutSession({ slug: 'test-event', baseUrl: 'http://localhost:3000' }),
    (err) => err.code === 'STRIPE_NOT_CONFIGURED'
  );
});

test('Stripe live keys are hard-blocked during the test-only checkout phase', async () => {
  process.env.STRIPE_PAYMENT_MODE = 'live';
  process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_must_not_be_used';
  process.env.STRIPE_LIVE_PAYMENTS_ENABLED = 'false';
  delete require.cache[require.resolve('../src/stripe')];
  const stripe = require('../src/stripe');

  assert.equal(stripe.isConfigured(), true);
  await assert.rejects(
    () => stripe.createCheckoutSession({}),
    (error) => error.code === 'STRIPE_LIVE_MODE_BLOCKED'
  );

  process.env.STRIPE_PAYMENT_MODE = 'test';
  delete process.env.STRIPE_LIVE_SECRET_KEY;
  process.env.STRIPE_LIVE_PAYMENTS_ENABLED = 'false';
  delete require.cache[require.resolve('../src/stripe')];
});

test('ambiguous legacy Stripe variable names are rejected instead of guessed', () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_legacy';
  const config = require('../src/stripeConfig');
  assert.match(config.validationErrors().join(' '), /STRIPE_SECRET_KEY.*mehrdeutig/);
  delete process.env.STRIPE_SECRET_KEY;
});

test('printful.createPrintfulOrder() returns a mocked order instead of throwing when unconfigured', async () => {
  delete process.env.PRINTFUL_API_KEY;
  delete require.cache[require.resolve('../src/printful')];
  const printful = require('../src/printful');

  assert.equal(printful.isConfigured(), false);

  const result = await printful.createPrintfulOrder({
    payload: {
      external_id: 'weddingcloud-123',
      recipient: { name: 'Anna Beispiel' },
      items: [],
    },
  });

  assert.equal(result.mocked, true);
  assert.match(result.printfulOrderId, /^MOCK-/);
});

test('live Printful pricing fails clearly without exposing or requiring a token in the browser', async () => {
  delete process.env.PRINTFUL_API_KEY;
  delete require.cache[require.resolve('../src/printful')];
  const printful = require('../src/printful');

  await assert.rejects(
    () => printful.estimateOrderCosts({
      variantId: 1320,
      quantity: 1,
      recipient: { name: 'Test', address1: 'Test 1', city: 'Berlin', zip: '10115', country_code: 'DE' },
    }),
    (error) => error.code === 'PRINTFUL_NOT_CONFIGURED' && error.status === 501
  );
});

test('Printful fulfillment creates a draft first and confirms it only when explicitly requested', async (t) => {
  process.env.PRINTFUL_API_KEY = 'printful_test_token';
  process.env.PRINTFUL_STORE_ID = 'store_123';
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const result = calls.length === 1
      ? { id: 451, status: 'draft' }
      : { id: 451, status: 'pending' };
    return {
      ok: true,
      status: 200,
      async json() { return { code: 200, result }; },
    };
  };
  delete require.cache[require.resolve('../src/printful')];
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.PRINTFUL_API_KEY;
    delete process.env.PRINTFUL_STORE_ID;
    delete require.cache[require.resolve('../src/printful')];
  });
  const printful = require('../src/printful');
  const payload = {
    external_id: 'weddingcloud-451',
    recipient: { name: 'Test' },
    items: [{ variant_id: 1320, quantity: 1, files: [{ url: 'https://example.test/print.svg' }] }],
  };

  const result = await printful.createPrintfulOrder({ payload, confirm: true });
  assert.deepEqual(result, {
    printfulOrderId: '451', status: 'pending', mocked: false, confirmed: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.printful.com/orders?confirm=false&update_existing=true');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.equal(calls[0].options.headers['X-PF-Store-Id'], 'store_123');
  assert.equal(calls[1].url, 'https://api.printful.com/orders/451/confirm');
  assert.equal(calls[1].options.method, 'POST');
});
