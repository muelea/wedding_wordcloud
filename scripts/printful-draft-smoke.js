'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function enabled(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
}

function validateSafety() {
  if (!process.argv.includes('--confirm-draft-smoke')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-draft-smoke');
  }
  if (enabled('STRIPE_LIVE_PAYMENTS_ENABLED')) {
    throw new Error('Der Provider-Smoke läuft nicht bei freigeschalteten Live-Zahlungen.');
  }
  if (String(process.env.PRINTFUL_FULFILLMENT_MODE || '') !== 'draft' ||
      !enabled('PRINTFUL_ALLOW_ORDER_WRITES') || enabled('PRINTFUL_CONFIRM_LIVE_ORDERS')) {
    throw new Error('Der Smoke benötigt draft + Order-Writes und verbietet Live-Bestätigung.');
  }
  if (!process.env.PRINTFUL_API_KEY || !process.env.PRINTFUL_STORE_ID) {
    throw new Error('Printful API-Key und Store-ID fehlen.');
  }
  const publicUrl = new URL(process.env.PUBLIC_URL || '');
  if (publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL muss öffentliches HTTPS verwenden.');
}

function loadRecipient() {
  const filename = argument('--recipient-file');
  if (!filename) throw new Error('--recipient-file mit synthetischer Testadresse fehlt.');
  const recipient = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
  for (const field of ['name', 'address1', 'city', 'zip', 'country_code']) {
    if (typeof recipient[field] !== 'string' || !recipient[field].trim()) {
      throw new Error(`Testadresse enthält kein gültiges Feld ${field}.`);
    }
  }
  return recipient;
}

function fileStatuses(order) {
  return (order?.items || []).flatMap((item) => item.files || [])
    .map((file) => String(file.status || '').toLowerCase()).filter(Boolean);
}

async function waitForPrintFiles(externalId) {
  const printful = require('../src/printful');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const order = await printful.getPrintfulOrderByExternalId(externalId);
    const statuses = fileStatuses(order);
    if (statuses.length && statuses.every((status) => status === 'ok')) return true;
    if (statuses.some((status) => status === 'failed')) return false;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return false;
}

async function main() {
  validateSafety();
  const recipient = loadRecipient();
  const productKey = argument('--product') || 'white-glossy-mug-duo-11oz';
  const db = require('../src/db');
  const fulfillment = require('../src/fulfillment');
  await db.assertDatabaseReady();
  let smoke;
  try {
    smoke = await db.createProviderSmokeOrder({ productKey, recipient });
    const completed = await fulfillment.processOrder(smoke.order.id, { providerSmoke: true });
    if (completed?.fulfillment_status !== 'draft') throw new Error('Printful-Draft wurde nicht sicher erstellt.');
    const externalId = fulfillment.shipmentExternalId(smoke.order, 0);
    if (!await waitForPrintFiles(externalId)) throw new Error('Printful hat die Druckdatei nicht erfolgreich verarbeitet.');
    await db.finishProviderSmokeRun(smoke.smokeRun.id, { succeeded: true, outcomeCode: 'draft_files_ok' });
    console.log(`[printful-smoke] Draft und Druckdatei erfolgreich geprüft; Produkt ${productKey}.`);
  } catch (error) {
    if (smoke?.smokeRun?.id) {
      await db.finishProviderSmokeRun(smoke.smokeRun.id, {
        succeeded: false,
        outcomeCode: error.code || 'draft_smoke_failed',
      }).catch(() => {});
    }
    throw error;
  } finally {
    await db.closePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[printful-smoke] fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { validateSafety, fileStatuses };
