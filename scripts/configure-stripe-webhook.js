'use strict';

const path = require('node:path');
const Stripe = require('stripe');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { importSecrets } = require('./configure-fly-secrets');

const HOSTED_TEST_ORIGIN = 'https://wolkenworte.fly.dev';
const STRIPE_WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'charge.refunded',
]);

function hostedWebhookUrl(env = process.env) {
  const publicUrl = new URL(String(env.PUBLIC_URL || HOSTED_TEST_ORIGIN));
  if (publicUrl.origin !== HOSTED_TEST_ORIGIN || publicUrl.pathname !== '/') {
    throw new Error(`PUBLIC_URL muss für diesen Test ${HOSTED_TEST_ORIGIN} sein.`);
  }
  return new URL('/webhook/stripe', publicUrl).toString();
}

function assertHostedStripeSafety(env = process.env) {
  const key = String(env.STRIPE_SECRET_KEY || '');
  if (!key.startsWith('sk_test_')) {
    throw new Error('Die Hosted-Aktivierung akzeptiert nur einen Stripe sk_test_-Key.');
  }
  if (String(env.STRIPE_ALLOW_LIVE_PAYMENTS || 'false').toLowerCase() === 'true') {
    throw new Error('Stripe-Live-Zahlungen müssen für den Hosted-Test deaktiviert bleiben.');
  }
  return { key, webhookUrl: hostedWebhookUrl(env) };
}

function hasExactEvents(endpoint) {
  const actual = [...(endpoint?.enabled_events || [])].sort();
  return actual.length === STRIPE_WEBHOOK_EVENTS.length &&
    actual.every((event, index) => event === [...STRIPE_WEBHOOK_EVENTS].sort()[index]);
}

async function run({
  argv = process.argv,
  env = process.env,
  stripeClient,
  stageSecret = importSecrets,
  output = console.log,
} = {}) {
  if (!argv.includes('--confirm-replace-webhook')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-replace-webhook');
  }
  const { key, webhookUrl } = assertHostedStripeSafety(env);
  const stripe = stripeClient || new Stripe(key);
  const listed = await stripe.webhookEndpoints.list({ limit: 100 });
  const replaced = listed.data.filter((endpoint) => endpoint.url === webhookUrl);
  let created;
  let staged = false;
  try {
    created = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      description: 'Wolkenworte hosted test payment callbacks',
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    });
    if (!created?.secret || created.status !== 'enabled' || !hasExactEvents(created)) {
      throw new Error('Stripe hat keinen vollständig konfigurierten Webhook geliefert.');
    }
    await stageSecret({ STRIPE_WEBHOOK_SECRET: created.secret });
    staged = true;
    for (const endpoint of replaced) await stripe.webhookEndpoints.del(endpoint.id);
  } catch (error) {
    if (created?.id && !staged) await stripe.webhookEndpoints.del(created.id).catch(() => {});
    throw error;
  }
  const result = {
    endpointId: created.id,
    url: created.url,
    status: created.status,
    events: [...created.enabled_events].sort(),
    replaced: replaced.length,
    flySecret: 'staged',
  };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[stripe-webhook] Einrichtung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  HOSTED_TEST_ORIGIN,
  STRIPE_WEBHOOK_EVENTS,
  assertHostedStripeSafety,
  hasExactEvents,
  hostedWebhookUrl,
  run,
};
