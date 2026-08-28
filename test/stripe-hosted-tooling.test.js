'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const configure = require('../scripts/configure-stripe-webhook');
const verify = require('../scripts/verify-hosted-stripe-payment');

const SAFE_ENV = {
  PUBLIC_URL: 'https://wolkenworte.fly.dev',
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_ALLOW_LIVE_PAYMENTS: 'false',
};

function endpoint(overrides = {}) {
  return {
    id: 'we_fixture',
    url: 'https://wolkenworte.fly.dev/webhook/stripe',
    status: 'enabled',
    enabled_events: [...configure.STRIPE_WEBHOOK_EVENTS],
    ...overrides,
  };
}

test('hosted Stripe tooling is sandbox-bound and requires one exact destination', () => {
  assert.deepEqual(configure.assertHostedStripeSafety(SAFE_ENV), {
    key: 'sk_test_fixture',
    webhookUrl: 'https://wolkenworte.fly.dev/webhook/stripe',
  });
  assert.equal(
    configure.assertHostedStripeSafety({ ...SAFE_ENV, PUBLIC_URL: '' }).webhookUrl,
    'https://wolkenworte.fly.dev/webhook/stripe'
  );
  assert.throws(
    () => configure.assertHostedStripeSafety({ ...SAFE_ENV, STRIPE_SECRET_KEY: 'sk_live_forbidden' }),
    /sk_test_/
  );
  assert.throws(
    () => configure.assertHostedStripeSafety({ ...SAFE_ENV, STRIPE_ALLOW_LIVE_PAYMENTS: 'true' }),
    /deaktiviert/
  );
  assert.throws(
    () => configure.assertHostedStripeSafety({ ...SAFE_ENV, PUBLIC_URL: 'https://example.com' }),
    /wolkenworte\.fly\.dev/
  );

  assert.equal(configure.hasExactEvents(endpoint()), true);
  assert.equal(configure.hasExactEvents(endpoint({ enabled_events: ['*'] })), false);
  assert.equal(verify.validateDestination([endpoint()], endpoint().url).id, 'we_fixture');
  assert.throws(() => verify.validateDestination([], endpoint().url), /fehlt/);
  assert.throws(() => verify.validateDestination([endpoint(), endpoint({ id: 'we_2' })], endpoint().url), /doppelt/);
});

test('webhook configuration stages the returned secret and replaces only the hosted URL', async () => {
  const removed = [];
  let staged;
  const stripeClient = {
    webhookEndpoints: {
      async list() {
        return { data: [endpoint({ id: 'we_old' }), endpoint({ id: 'we_unrelated', url: 'https://example.com' })] };
      },
      async create(request) {
        assert.equal(request.url, endpoint().url);
        assert.deepEqual([...request.enabled_events].sort(), [...configure.STRIPE_WEBHOOK_EVENTS].sort());
        return endpoint({ id: 'we_new', secret: 'whsec_fixture' });
      },
      async del(id) { removed.push(id); },
    },
  };
  const result = await configure.run({
    argv: ['node', 'script', '--confirm-replace-webhook'],
    env: SAFE_ENV,
    stripeClient,
    stageSecret: async (values) => { staged = values; },
    output() {},
  });
  assert.deepEqual(staged, { STRIPE_WEBHOOK_SECRET: 'whsec_fixture' });
  assert.deepEqual(removed, ['we_old']);
  assert.equal(result.endpointId, 'we_new');
  assert.equal(result.replaced, 1);
});

test('hosted payment acceptance requires paid Stripe, webhook, mock work and confirmation state', () => {
  const session = verify.validateStripeSession({
    id: 'cs_test_fixture',
    livemode: false,
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    payment_intent: 'pi_fixture',
    amount_total: 1649,
    metadata: { checkoutMode: 'test', orderId: '3', eventSlug: 'test-fixture' },
  });
  const state = {
    session,
    order: {
      status: 'paid_test', mode: 'test', stripe_payment_intent_id: 'pi_fixture',
      fulfillment_status: 'mocked', fulfillment_mode: 'mock',
    },
    confirmation: {
      paymentConfirmed: true, status: 'paid_test', fulfillmentStatus: 'mocked',
      mode: 'test', totalCents: 1649,
    },
    emailJobs: [{
      kind: 'order_confirmation', status: 'delivered', provider_message_id: 'mock-1',
    }],
    stripeEvent: { pending_webhooks: 0 },
  };
  assert.equal(verify.acceptedState(state), true);
  assert.equal(verify.acceptedState({ ...state, stripeEvent: { pending_webhooks: 1 } }), false);
  assert.equal(verify.acceptedState({ ...state, order: { ...state.order, fulfillment_status: 'submitted' } }), false);
  assert.equal(verify.validateSessionId('cs_test_fixture'), 'cs_test_fixture');
  assert.throws(() => verify.validateSessionId('cs_live_fixture'), /cs_test_/);
});
