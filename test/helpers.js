'use strict';

require('./support/test-environment');

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { after } = require('node:test');
const { startLocalPostgres, validateTestDatabaseUrl } = require('./support/local-postgres');

const explicitTestUrl = process.env.TEST_DATABASE_URL?.trim();
if (explicitTestUrl) validateTestDatabaseUrl(explicitTestUrl);
let localDatabase;
let databasePromise;
const openServers = new Set();
async function testDatabaseUrl() {
  if (explicitTestUrl) return explicitTestUrl;
  // Direct node --test invocations also work without any database configuration.
  databasePromise ||= startLocalPostgres().then(database => { localDatabase = database; return database.url; });
  return databasePromise;
}
after(async () => {
  try { await Promise.all([...openServers].map(close => close())); }
  finally { if (localDatabase) await localDatabase.close(); }
});
const APPLICATION_MIGRATIONS = [
  '20260831000000_wolkenworte_baseline.sql',
  '20260901000000_generalize_event_naming.sql',
  '20260901010000_organizer_pin_and_personal_palettes.sql',
  '20260923000000_recover_artifact_deletion.sql',
  '20260924000000_commerce_retention.sql',
  '20261012000000_optional_design_accounts.sql',
  '20261026000000_durable_mockup_jobs.sql',
  '20261027000000_activity_retention.sql',
  '20261028000000_print_approval.sql',
  '20261029000000_private_design_images.sql',
].map((filename) => path.join(__dirname, '..', 'supabase', 'migrations', filename));

function clearApplicationModules() {
  for (const modulePath of [
    '../src/db',
    '../src/accountAuth',
    '../src/savedDesigns',
    '../src/authEmail',
    '../src/routes/accounts',
    '../src/routes/events',
    '../src/routes/webhook',
    '../src/fulfillment',
    '../src/emailDelivery',
    '../src/emailTemplates',
    '../src/resend',
    '../src/stripe',
    '../src/printful',
    '../src/printfulMockups',
    '../src/mockupQueue',
    '../src/privateStorage',
    '../src/designImageAssets',
    '../src/clientIdentity',
    '../src/rateLimits',
    '../src/performanceProbe',
    '../src/structuredLog',
    '../src/maintenanceMode',
    '../src/cleanupTarget',
    '../src/preliveCleanup',
    '../src/wordBroadcasts',
    '../src/socketEventCache',
    '../src/socketOwnershipLoader',
    '../src/lifecycle',
    '../src/dailyRetention',
    '../src/workerPoller',
    '../src/maintenance',
    '../src/printArtifacts',
    '../src/printPreparation',
    '../src/mockupApproval',
    '../src/pageRenderer',
    '../src/routes/maintenance',
    '../src/routes/performance',
    '../scripts/operations-status',
    '../scripts/retry-blocked-fulfillment',
    '../scripts/prelive-cleanup',
    '../src/socket',
    '../server',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

/**
 * Boots one server against an isolated Postgres schema. Node's test runner
 * gives each test file its own process; every server within that file gets a
 * fresh random schema and applies the exact production application migration.
 */
async function startTestServer({ host = '127.0.0.1' } = {}) {
  const databaseUrl = validateTestDatabaseUrl(await testDatabaseUrl());
  const schema = `test_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const { connectionOptions } = require('../src/dbConfig');
  const adminPool = new Pool(connectionOptions(databaseUrl, {
    schema: 'public',
    applicationName: `wolkenworte-test-setup-${process.pid}`,
    requireDirect: false,
  }));
  let server, io, database, shutdown, closing;
  const close = () => {
    closing ||= (async () => {
      try {
        if (io) await new Promise(resolve => io.close(resolve));
        if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally {
        try { if (database) await database.closePool(); }
        finally {
          try { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
          finally { await adminPool.end(); openServers.delete(close); }
        }
      }
    })();
    return closing;
  };
  openServers.add(close);
  try {
    const setupClient = await adminPool.connect();
    try {
      // Migrations either all commit or none do; interrupted setup cannot leave
      // a partly migrated schema behind.
      await setupClient.query('BEGIN');
      await setupClient.query(`CREATE SCHEMA "${schema}"`);
      await setupClient.query(`SET LOCAL search_path TO "${schema}", public`);
      for (const migration of APPLICATION_MIGRATIONS) {
        await setupClient.query(fs.readFileSync(migration, 'utf8'));
      }
      await setupClient.query('COMMIT');
    } catch (error) {
      await setupClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { setupClient.release(); }

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_SCHEMA = schema;
    process.env.DATABASE_APPLICATION_NAME = `wolkenworte-test-${process.pid}`;
    process.env.RATE_LIMIT_HMAC_SECRET = 'test-rate-limit-secret-that-is-long-enough';
    process.env.MAINTENANCE_SECRET = 'test-maintenance-secret-that-is-long-enough';
    clearApplicationModules();

    const imageObjects = new Map();
    require('../src/designImageAssets').setStorageForTests({
      async upload(key,bytes) { if(imageObjects.has(key)) throw new Error('object exists'); imageObjects.set(key,Buffer.from(bytes)); },
      async download(key) { if(!imageObjects.has(key)) throw new Error('missing image'); return imageObjects.get(key); },
      async remove(key) { imageObjects.delete(key); },
    });
    const app = require('../server');
    ({ server, io, shutdown } = app);
    database = require('../src/db');
    await app.initialize();
    await new Promise((resolve, reject) => {
      const onListenError = (error) => reject(error);
      server.once('error', onListenError);
      server.listen(0, host, () => {
        server.off('error', onListenError);
        resolve();
      });
    });
  } catch (error) {
    await close().catch(cleanupError => { error.cause ||= cleanupError; });
    throw error;
  }

  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    io,
    shutdown,
    schema,
    async query(sql, params = []) {
      return database.getPool().query(sql, params);
    },
    close,
  };
}

let counter = 0;
let clientCounter = 0;
function uniqueTitle() {
  counter += 1;
  return `Test Cloud ${Date.now()}-${counter}`;
}

async function createEvent(baseUrl, overrides = {}) {
  clientCounter += 1;
  const title = overrides.title || uniqueTitle();
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wolkenworte-Test-Client-IP': overrides.clientIp || `192.0.2.${(clientCounter % 250) + 1}`,
    },
    body: JSON.stringify({
      title,
      pin: overrides.pin || '1234',
      locale: overrides.locale,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createEvent failed: ${res.status} ${JSON.stringify(body)}`);
  return { ...body, title, pin: overrides.pin || '1234' };
}

function productDesignPayload(productKey = 'white-glossy-mug-duo-11oz', orientation = 'default') {
  const { getProduct, resolveProductOrientation } = require('../src/products');
  const product = resolveProductOrientation(getProduct(productKey), orientation);
  if (!product) throw new Error(`Unknown test product: ${productKey}`);
  const design = [{
    id: 'test-design-word',
    text: 'liebe',
    x: product.printFile.width / 2,
    y: product.printFile.height / 2,
    fontSize: Math.max(24, Math.min(96, product.printFile.height / 6)),
    angle: 0,
    color: '#a40e4c',
    fontFamily: 'classic',
  }];
  return {
    designs: Object.fromEntries(product.printSurfaces.map((surface) => [
      surface.key,
      design.map((item) => ({ ...item, id: `${item.id}-${surface.key}` })),
    ])),
  };
}

function stripeTaxPaymentSession({
  order,
  sessionId,
  customerId,
  taxCents,
  shippingTaxCents = 0,
}) {
  const itemsCents = Number(order.items_cents);
  const shippingCents = Number(order.shipping_cents);
  const finalTaxCents = Number(taxCents);
  const request = typeof order.checkout_request_json === 'string'
    ? JSON.parse(order.checkout_request_json) : order.checkout_request_json || {};
  const inclusive = request.pricing?.taxBehavior === 'inclusive';
  const finalTotalCents = itemsCents + shippingCents + (inclusive ? 0 : finalTaxCents);
  return {
    amountTotal: finalTotalCents,
    currency: String(order.currency || '').toLowerCase(),
    paymentStatus: 'paid',
    checkoutSession: {
      id: sessionId,
      customer: customerId,
      payment_status: 'paid',
      currency: String(order.currency || '').toLowerCase(),
      amount_subtotal: itemsCents,
      amount_total: finalTotalCents,
      automatic_tax: { enabled: true, status: 'complete' },
      total_details: { amount_tax: finalTaxCents, amount_discount: 0 },
      shipping_cost: {
        amount_subtotal: shippingCents,
        amount_tax: shippingTaxCents,
        amount_total: shippingCents + (inclusive ? 0 : shippingTaxCents),
      },
    },
  };
}

module.exports = {
  startTestServer,
  createEvent,
  uniqueTitle,
  productDesignPayload,
  stripeTaxPaymentSession,
};

// Use only in suites testing downstream payment behavior; print-approval.test.js exercises the real gate.
module.exports.stubMockupApproval = function stubMockupApproval(t) {
  t.mock.method(require('../src/mockupApproval'), 'approve', async () => true);
};
