'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Stripe = require('stripe');

const ENV_PATH = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: ENV_PATH });
const {
  STRIPE_WEBHOOK_EVENTS,
  hasExactEvents,
  hostedWebhookUrl,
} = require('./configure-stripe-webhook');

function assertLiveStripePreparationSafety(env = process.env) {
  if (String(env.APP_ENVIRONMENT || '').trim().toLowerCase() !== 'local') {
    throw new Error('Die Live-Vorbereitung muss aus APP_ENVIRONMENT=local gestartet werden.');
  }
  if (String(env.STRIPE_PAYMENT_MODE || '').trim().toLowerCase() !== 'test') {
    throw new Error('Während der Live-Vorbereitung muss STRIPE_PAYMENT_MODE=test bleiben.');
  }
  if (String(env.STRIPE_LIVE_PAYMENTS_ENABLED || 'false').trim().toLowerCase() !== 'false') {
    throw new Error('Stripe-Live-Zahlungen müssen während der Vorbereitung deaktiviert bleiben.');
  }
  const key = String(env.STRIPE_LIVE_SECRET_KEY || '').trim();
  if (!key.startsWith('sk_live_')) {
    throw new Error('STRIPE_LIVE_SECRET_KEY muss ein sk_live_-Key sein.');
  }
  return { key, webhookUrl: hostedWebhookUrl(env) };
}

function replaceEnvValue(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(source)
    ? source.replace(pattern, () => line)
    : `${source.trimEnd()}\n${line}\n`;
}

function storeLocalWebhookSecret(secret, { envPath = ENV_PATH } = {}) {
  const value = String(secret || '').trim();
  if (!value.startsWith('whsec_') || /[\r\n]/.test(value)) {
    throw new Error('Stripe hat kein gültiges Live-Webhook-Secret geliefert.');
  }
  const current = fs.readFileSync(envPath, 'utf8');
  const updated = replaceEnvValue(current, 'STRIPE_LIVE_WEBHOOK_SECRET', value);
  const temporaryPath = `${envPath}.tmp-${process.pid}-${Date.now()}`;
  let renamed = false;
  try {
    fs.writeFileSync(temporaryPath, updated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, envPath);
    fs.chmodSync(envPath, 0o600);
    renamed = true;
  } finally {
    if (!renamed && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return 'stored';
}

function validLiveEndpoint(endpoint, webhookUrl) {
  return endpoint?.url === webhookUrl && endpoint.status === 'enabled' &&
    endpoint.livemode === true && hasExactEvents(endpoint);
}

async function run({
  argv = process.argv,
  env = process.env,
  stripeClient,
  persistSecret = storeLocalWebhookSecret,
  output = console.log,
} = {}) {
  if (!argv.includes('--confirm-replace-live-webhook')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-replace-live-webhook');
  }
  const { key, webhookUrl } = assertLiveStripePreparationSafety(env);
  const stripe = stripeClient || new Stripe(key);
  const listed = await stripe.webhookEndpoints.list({ limit: 100 });
  const replaced = listed.data.filter((endpoint) => endpoint.url === webhookUrl);
  let created;
  let persisted = false;
  try {
    created = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      description: 'Wolkenworte live payment callbacks',
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    });
    if (!created?.secret || !validLiveEndpoint(created, webhookUrl)) {
      throw new Error('Stripe hat keinen vollständig konfigurierten Live-Webhook geliefert.');
    }
    await persistSecret(created.secret);
    persisted = true;
    for (const endpoint of replaced) await stripe.webhookEndpoints.del(endpoint.id);

    const verified = await stripe.webhookEndpoints.list({ limit: 100 });
    const exact = verified.data.filter((endpoint) => endpoint.url === webhookUrl);
    if (exact.length !== 1 || exact[0].id !== created.id || !validLiveEndpoint(exact[0], webhookUrl)) {
      throw new Error('Der Live-Webhook konnte nach dem Erstellen nicht eindeutig verifiziert werden.');
    }
  } catch (error) {
    if (created?.id && !persisted) await stripe.webhookEndpoints.del(created.id).catch(() => {});
    throw error;
  }

  const result = {
    endpointId: created.id,
    livemode: true,
    url: created.url,
    status: created.status,
    events: [...created.enabled_events].sort(),
    replaced: replaced.length,
    localWebhookSecret: 'stored',
    livePaymentsEnabled: false,
  };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[stripe-live-webhook] Einrichtung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ENV_PATH,
  assertLiveStripePreparationSafety,
  replaceEnvValue,
  run,
  storeLocalWebhookSecret,
  validLiveEndpoint,
};
