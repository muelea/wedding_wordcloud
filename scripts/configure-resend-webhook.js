'use strict';

const path = require('node:path');
const { Resend } = require('resend');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { importSecrets } = require('./configure-fly-secrets');

const RESEND_WEBHOOK_URL = 'https://wolkenworte.io/webhook/resend';
const RESEND_WEBHOOK_EVENTS = Object.freeze([
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.failed',
  'email.complained',
  'email.suppressed',
]);

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function assertResendSetupSafety(env = process.env) {
  if (String(env.APP_ENVIRONMENT || '').trim().toLowerCase() !== 'local') {
    throw new Error('Das Operator-Skript muss aus APP_ENVIRONMENT=local gestartet werden.');
  }
  if (String(env.EMAIL_DELIVERY_MODE || 'mock').trim().toLowerCase() !== 'mock') {
    throw new Error('Der Resend-Webhook wird nur bei EMAIL_DELIVERY_MODE=mock ersetzt.');
  }
  if (enabled(env.STRIPE_LIVE_PAYMENTS_ENABLED)) {
    throw new Error('Der Resend-Webhook wird nicht bei freigeschalteten Live-Zahlungen ersetzt.');
  }
  const runtimeKey = String(env.RESEND_API_KEY || '').trim();
  const managementKey = String(env.RESEND_MANAGEMENT_API_KEY || '').trim();
  if (!runtimeKey.startsWith('re_')) {
    throw new Error('RESEND_API_KEY muss der domainbeschränkte Sending-access-Key sein.');
  }
  if (!managementKey.startsWith('re_')) {
    throw new Error('RESEND_MANAGEMENT_API_KEY muss der temporäre Full-access-Key sein.');
  }
  if (managementKey === runtimeKey) {
    throw new Error('Runtime- und Management-Key müssen getrennte Resend-Schlüssel sein.');
  }
  const from = String(env.RESEND_FROM_EMAIL || '').trim();
  if (!/<[^<>@\s]+@mail\.wolkenworte\.io>$/i.test(from)) {
    throw new Error('RESEND_FROM_EMAIL muss die verifizierte Domain mail.wolkenworte.io verwenden.');
  }
  return { managementKey, runtimeKey, from, webhookUrl: RESEND_WEBHOOK_URL };
}

function providerData(result) {
  if (result?.error) {
    const error = new Error(result.error.message || result.error.name || 'Resend request failed');
    error.code = result.error.name || 'resend_request_failed';
    throw error;
  }
  return result?.data;
}

function listedWebhooks(result) {
  const data = providerData(result);
  if (Array.isArray(data?.data)) return data.data;
  return Array.isArray(data) ? data : [];
}

async function run({
  argv = process.argv,
  env = process.env,
  managementClient,
  stageSecret = importSecrets,
  output = console.log,
} = {}) {
  if (!argv.includes('--confirm-replace-webhook')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-replace-webhook');
  }
  const { managementKey, runtimeKey, from, webhookUrl } = assertResendSetupSafety(env);
  const resend = managementClient || new Resend(managementKey);
  const existing = listedWebhooks(await resend.webhooks.list())
    .filter((entry) => entry.endpoint === webhookUrl);
  for (const webhook of existing) providerData(await resend.webhooks.remove(webhook.id));

  let created;
  let staged = false;
  try {
    created = providerData(await resend.webhooks.create({
      endpoint: webhookUrl,
      events: [...RESEND_WEBHOOK_EVENTS],
    }));
    if (!created?.id || !created?.signing_secret) {
      throw new Error('Resend hat keinen vollständig konfigurierten Webhook geliefert.');
    }
    await stageSecret({
      RESEND_API_KEY: runtimeKey,
      RESEND_FROM_EMAIL: from,
      RESEND_WEBHOOK_SECRET: created.signing_secret,
    });
    staged = true;
  } catch (error) {
    if (created?.id && !staged) await resend.webhooks.remove(created.id).catch(() => {});
    throw error;
  }

  const result = {
    webhookId: created.id,
    url: webhookUrl,
    events: [...RESEND_WEBHOOK_EVENTS],
    replaced: existing.length,
    flySecret: 'staged',
  };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[resend-webhook] Einrichtung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  RESEND_WEBHOOK_EVENTS,
  RESEND_WEBHOOK_URL,
  assertResendSetupSafety,
  listedWebhooks,
  providerData,
  run,
};
