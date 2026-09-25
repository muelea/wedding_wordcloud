'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const configure = require('../scripts/configure-stripe-webhook');
const live = require('../scripts/configure-stripe-live-webhook');

const SAFE_ENV = {
  APP_ENVIRONMENT: 'local',
  PUBLIC_URL: 'https://wolkenworte.fly.dev',
  STRIPE_PAYMENT_MODE: 'test',
  STRIPE_LIVE_SECRET_KEY: 'sk_live_fixture',
  STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
};

function endpoint(overrides = {}) {
  return {
    id: 'we_live_fixture',
    url: 'https://wolkenworte.fly.dev/webhook/stripe',
    status: 'enabled',
    livemode: true,
    enabled_events: [...configure.STRIPE_WEBHOOK_EVENTS],
    ...overrides,
  };
}

test('live webhook preparation requires a live key while all payment gates remain disabled', () => {
  assert.deepEqual(live.assertLiveStripePreparationSafety(SAFE_ENV), {
    key: 'sk_live_fixture',
    webhookUrl: 'https://wolkenworte.fly.dev/webhook/stripe',
  });
  assert.throws(
    () => live.assertLiveStripePreparationSafety({ ...SAFE_ENV, APP_ENVIRONMENT: 'production' }),
    /APP_ENVIRONMENT=local/
  );
  assert.throws(
    () => live.assertLiveStripePreparationSafety({ ...SAFE_ENV, STRIPE_PAYMENT_MODE: 'live' }),
    /STRIPE_PAYMENT_MODE=test/
  );
  assert.throws(
    () => live.assertLiveStripePreparationSafety({ ...SAFE_ENV, STRIPE_LIVE_PAYMENTS_ENABLED: 'true' }),
    /deaktiviert/
  );
  assert.throws(
    () => live.assertLiveStripePreparationSafety({ ...SAFE_ENV, STRIPE_LIVE_SECRET_KEY: 'sk_test_wrong' }),
    /sk_live_/
  );
});

test('live webhook preparation stores the new secret locally and replaces only the exact live URL', async () => {
  const old = endpoint({ id: 'we_live_old' });
  const unrelated = endpoint({ id: 'we_live_unrelated', url: 'https://example.com/webhook' });
  const created = endpoint({ id: 'we_live_new', secret: 'whsec_live_fixture' });
  const removed = [];
  const outputs = [];
  let listed = 0;
  let stored;
  const stripeClient = {
    webhookEndpoints: {
      async list() {
        listed += 1;
        return listed === 1 ? { data: [old, unrelated] } : { data: [created, unrelated] };
      },
      async create(request) {
        assert.equal(request.url, created.url);
        assert.equal(request.description, 'Wolkenworte live payment callbacks');
        assert.deepEqual([...request.enabled_events].sort(), [...configure.STRIPE_WEBHOOK_EVENTS].sort());
        return created;
      },
      async del(id) { removed.push(id); },
    },
  };
  const result = await live.run({
    argv: ['node', 'script', '--confirm-replace-live-webhook'],
    env: SAFE_ENV,
    stripeClient,
    persistSecret: async (secret) => { stored = secret; },
    output: (value) => outputs.push(value),
  });

  assert.equal(stored, 'whsec_live_fixture');
  assert.deepEqual(removed, ['we_live_old']);
  assert.equal(result.endpointId, 'we_live_new');
  assert.equal(result.replaced, 1);
  assert.equal(result.localWebhookSecret, 'stored');
  assert.equal(result.livePaymentsEnabled, false);
  assert.doesNotMatch(outputs.join('\n'), /whsec_live_fixture/);
});

test('live webhook secret is written atomically without changing private file permissions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolkenworte-live-webhook-'));
  const envPath = path.join(directory, '.env');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(envPath, 'APP_ENVIRONMENT=local\nSTRIPE_LIVE_WEBHOOK_SECRET=\n', { mode: 0o600 });

  live.storeLocalWebhookSecret('whsec_replaced_fixture', { envPath });

  assert.match(fs.readFileSync(envPath, 'utf8'), /^STRIPE_LIVE_WEBHOOK_SECRET=whsec_replaced_fixture$/m);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(directory).length, 1, 'no secret-bearing temporary file remains');
});
