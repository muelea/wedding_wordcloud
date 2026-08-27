'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  if (!process.argv.includes('--confirm-replace-webhook')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-replace-webhook');
  }
  const publicUrl = new URL(process.env.PUBLIC_URL || '');
  if (publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL muss öffentliches HTTPS verwenden.');
  const printful = require('../src/printful');
  const webhookUrl = new URL('/webhook/printful', publicUrl).toString();
  const scopes = await printful.getTokenScopes();
  if (!scopes.includes('webhooks')) {
    throw new Error('Der Printful-Token benötigt zusätzlich den Schreib-Scope webhooks.');
  }
  const keys = await printful.configureSignedWebhooks(webhookUrl);
  const fly = spawnSync('flyctl', [
    'secrets', 'set', '--stage', '--app', 'wolkenworte',
    `PRINTFUL_WEBHOOK_SECRET=${keys.secretKey}`,
    `PRINTFUL_WEBHOOK_PUBLIC_KEY=${keys.publicKey}`,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (fly.status !== 0) {
    throw new Error('Webhook wurde bei Printful ersetzt, aber die Fly-Secrets konnten nicht vorgemerkt werden.');
  }
  console.log('[printful-webhook] Signierte v2-Events konfiguriert; Fly-Secrets sind für den nächsten Deploy vorgemerkt.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[printful-webhook] Einrichtung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
