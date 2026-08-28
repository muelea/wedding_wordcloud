'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const configure = require('../scripts/configure-resend-webhook');
const smoke = require('../scripts/resend-email-smoke');

const SAFE_ENV = {
  APP_ENVIRONMENT: 'local',
  EMAIL_DELIVERY_MODE: 'mock',
  STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
  RESEND_API_KEY: 're_runtime_fixture',
  RESEND_MANAGEMENT_API_KEY: 're_management_fixture',
  RESEND_FROM_EMAIL: 'Wolkenworte <bestellung@mail.wolkenworte.io>',
};

test('Resend setup is canonical, mock-gated and separates management from runtime access', () => {
  assert.deepEqual(configure.assertResendSetupSafety(SAFE_ENV), {
    managementKey: 're_management_fixture',
    runtimeKey: 're_runtime_fixture',
    from: 'Wolkenworte <bestellung@mail.wolkenworte.io>',
    webhookUrl: 'https://wolkenworte.io/webhook/resend',
  });
  assert.throws(
    () => configure.assertResendSetupSafety({
      ...SAFE_ENV, RESEND_MANAGEMENT_API_KEY: SAFE_ENV.RESEND_API_KEY,
    }),
    /getrennte Resend-Schlüssel/
  );
  assert.throws(
    () => configure.assertResendSetupSafety({ ...SAFE_ENV, EMAIL_DELIVERY_MODE: 'live' }),
    /EMAIL_DELIVERY_MODE=mock/
  );
  assert.throws(
    () => configure.assertResendSetupSafety({
      ...SAFE_ENV, RESEND_FROM_EMAIL: 'Wolkenworte <bestellung@example.com>',
    }),
    /mail\.wolkenworte\.io/
  );
});

test('Resend webhook setup replaces only the canonical endpoint and stages no management credential', async () => {
  const removed = [];
  let createdRequest;
  let staged;
  const managementClient = {
    webhooks: {
      async list() {
        return { data: { data: [
          { id: 'wh_old', endpoint: configure.RESEND_WEBHOOK_URL },
          { id: 'wh_unrelated', endpoint: 'https://example.com/webhook/resend' },
        ] }, error: null };
      },
      async remove(id) {
        removed.push(id);
        return { data: { id }, error: null };
      },
      async create(request) {
        createdRequest = request;
        return {
          data: { id: 'wh_new', signing_secret: 'whsec_fixture' },
          error: null,
        };
      },
    },
  };
  const result = await configure.run({
    argv: ['node', 'script', '--confirm-replace-webhook'],
    env: SAFE_ENV,
    managementClient,
    stageSecret: async (values) => { staged = values; },
    output() {},
  });
  assert.deepEqual(removed, ['wh_old']);
  assert.equal(createdRequest.endpoint, configure.RESEND_WEBHOOK_URL);
  assert.deepEqual(createdRequest.events, [...configure.RESEND_WEBHOOK_EVENTS]);
  assert.ok(createdRequest.events.includes('email.suppressed'));
  assert.deepEqual(staged, {
    RESEND_API_KEY: 're_runtime_fixture',
    RESEND_FROM_EMAIL: 'Wolkenworte <bestellung@mail.wolkenworte.io>',
    RESEND_WEBHOOK_SECRET: 'whsec_fixture',
  });
  assert.equal(result.replaced, 1);
});

test('the operator smoke needs no local webhook secret and recognizes suppression outcomes', async (t) => {
  const previousArgv = process.argv;
  const previous = {};
  for (const name of [
    'EMAIL_DELIVERY_MODE', 'STRIPE_LIVE_PAYMENTS_ENABLED', 'RESEND_API_KEY',
    'RESEND_FROM_EMAIL', 'RESEND_WEBHOOK_SECRET', 'RESEND_SMOKE_RECIPIENTS',
  ]) previous[name] = process.env[name];
  t.after(() => {
    process.argv = previousArgv;
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.argv = [
    'node', 'script', '--confirm-email-smoke', '--recipient', 'suppressed@resend.dev',
    '--expect', 'suppressed',
  ];
  process.env.EMAIL_DELIVERY_MODE = 'live';
  process.env.STRIPE_LIVE_PAYMENTS_ENABLED = 'false';
  process.env.RESEND_API_KEY = 're_runtime_fixture';
  process.env.RESEND_FROM_EMAIL = SAFE_ENV.RESEND_FROM_EMAIL;
  process.env.RESEND_SMOKE_RECIPIENTS = 'suppressed@resend.dev';
  delete process.env.RESEND_WEBHOOK_SECRET;
  assert.deepEqual(smoke.validateSafety(), {
    recipient: 'suppressed@resend.dev', expected: 'suppressed',
  });
  assert.equal((await smoke.waitForOutcome({
    async getEmailJobById() {
      return { status: 'failed', last_error: 'provider_suppressed' };
    },
  }, '1', 'suppressed')).last_error, 'provider_suppressed');
});
