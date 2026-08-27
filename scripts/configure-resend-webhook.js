'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function enabled(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

async function main() {
  if (!process.argv.includes('--confirm-replace-webhook')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-replace-webhook');
  }
  if (enabled('STRIPE_ALLOW_LIVE_PAYMENTS')) {
    throw new Error('Der Resend-Webhook wird nicht bei freigeschalteten Live-Zahlungen ersetzt.');
  }
  const publicUrl = new URL(process.env.PUBLIC_URL || '');
  if (publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL muss öffentliches HTTPS verwenden.');
  const resend = require('../src/resend');
  if (!resend.isConfigured()) throw new Error('RESEND_API_KEY und RESEND_FROM_EMAIL fehlen.');
  const webhookUrl = new URL('/webhook/resend', publicUrl).toString();
  const existing = await resend.listWebhooks();
  for (const webhook of existing.filter((entry) => entry.endpoint === webhookUrl)) {
    await resend.removeWebhook(webhook.id);
  }
  const webhook = await resend.createWebhook(webhookUrl);
  if (!webhook?.signing_secret) throw new Error('Resend hat kein Webhook-Signatursecret geliefert.');
  const app = process.env.FLY_APP_NAME || 'wolkenworte';
  const fly = spawnSync('flyctl', [
    'secrets', 'set', '--stage', '--app', app,
    `RESEND_WEBHOOK_SECRET=${webhook.signing_secret}`,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (fly.status !== 0) {
    throw new Error('Webhook wurde bei Resend ersetzt, aber das Fly-Secret konnte nicht vorgemerkt werden.');
  }
  console.log('[resend-webhook] Signierte Zustellereignisse konfiguriert; das Secret ist für den nächsten Deploy vorgemerkt.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[resend-webhook] Einrichtung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
