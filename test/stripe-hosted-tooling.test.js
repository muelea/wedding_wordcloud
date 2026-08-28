'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const configure = require('../scripts/configure-stripe-webhook');
const verify = require('../scripts/verify-hosted-stripe-payment');
const stripeConfig = require('../src/stripeConfig');

const SAFE_ENV = {
  APP_ENVIRONMENT: 'local',
  PUBLIC_URL: 'https://wolkenworte.fly.dev',
  STRIPE_PAYMENT_MODE: 'test',
  STRIPE_TEST_SECRET_KEY: 'sk_test_fixture',
  STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
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
    () => configure.assertHostedStripeSafety({ ...SAFE_ENV, STRIPE_TEST_SECRET_KEY: 'sk_live_forbidden' }),
    /sk_test_/
  );
  assert.throws(
    () => configure.assertHostedStripeSafety({ ...SAFE_ENV, STRIPE_LIVE_PAYMENTS_ENABLED: 'true' }),
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

test('Stripe credential selection is explicit for local, hosted-test and production', () => {
  const secrets = {
    STRIPE_TEST_LOCAL_WEBHOOK_SECRET: 'whsec_local',
    STRIPE_TEST_HOSTED_WEBHOOK_SECRET: 'whsec_hosted',
    STRIPE_LIVE_WEBHOOK_SECRET: 'whsec_live',
  };
  assert.equal(stripeConfig.configuredWebhookSecret({
    ...secrets, APP_ENVIRONMENT: 'local', STRIPE_PAYMENT_MODE: 'test',
  }), 'whsec_local');
  assert.equal(stripeConfig.configuredWebhookSecret({
    ...secrets, APP_ENVIRONMENT: 'hosted-test', STRIPE_PAYMENT_MODE: 'test',
  }), 'whsec_hosted');
  assert.equal(stripeConfig.configuredWebhookSecret({
    ...secrets, APP_ENVIRONMENT: 'production', STRIPE_PAYMENT_MODE: 'live',
  }), 'whsec_live');
  assert.deepEqual(stripeConfig.validationErrors({
    APP_ENVIRONMENT: 'hosted-test',
    STRIPE_PAYMENT_MODE: 'test',
    STRIPE_TEST_SECRET_KEY: 'sk_test_fixture',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
  }), []);
  assert.match(stripeConfig.validationErrors({
    APP_ENVIRONMENT: 'hosted-test',
    STRIPE_PAYMENT_MODE: 'live',
    STRIPE_LIVE_SECRET_KEY: 'sk_live_fixture',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'true',
  }).join(' '), /hosted-test erlaubt nur/);
  assert.match(stripeConfig.validationErrors({
    APP_ENVIRONMENT: 'local',
    STRIPE_PAYMENT_MODE: 'test',
    STRIPE_TEST_HOSTED_WEBHOOK_SECRET: 'whsec_wrong_scope',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
  }).join(' '), /nur in Fly Secrets/);
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
  assert.deepEqual(staged, { STRIPE_TEST_HOSTED_WEBHOOK_SECRET: 'whsec_fixture' });
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
