'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

async function createPaidTestOrder(db, event, suffix) {
  const configuration = await db.createConfiguration({
    eventId: event.id,
    productKey: 'white-glossy-mug-duo-11oz',
    printfulVariantId: 1320,
    quantity: 2,
    unitPriceCents: 0,
    theme: 'pastel',
    words: [['liebe', 2]],
    design: { version: 2, surfaces: productDesignPayload().designs },
    printWidth: 2700,
    printHeight: 1050,
  });
  const quote = await db.createCheckoutQuote({
    eventId: event.id,
    configurationId: configuration.id,
    recipient: {
      name: 'Private Testperson', address1: 'Geheimer Weg 8', city: 'Berlin',
      zip: '10115', country_code: 'DE',
    },
    printfulCosts: { currency: 'EUR', subtotal: 10, shipping: 5, vat: 3, total: 18 },
    quote: {
      currency: 'EUR', quantity: 2, itemsCents: 2000,
      shippingCents: 500, taxCents: 475, totalCents: 2975,
    },
  });
  const { order } = await db.createCheckoutOrder({
    eventId: event.id, configurationId: configuration.id, quote, mode: 'test',
  });
  const sessionId = `cs_test_operations_${suffix}`;
  await db.attachStripeSession(order.id, { id: sessionId, url: `https://checkout.test/${suffix}` });
  await db.recordSuccessfulPayment({
    stripeEventId: `evt_test_operations_${suffix}`,
    eventType: 'checkout.session.completed',
    stripeSessionId: sessionId,
    paymentIntentId: `pi_test_operations_${suffix}`,
    livemode: false,
    buyerEmail: 'private-person@example.test',
  });
  return db.getOrderById(order.id);
}

test('built-in observability, recovery and pre-live cleanup', async (t) => {
  const environmentNames = [
    'PUBLIC_URL', 'ALLOW_TEST_DATA_RESET', 'MAINTENANCE_MODE',
    'STRIPE_LIVE_PAYMENTS_ENABLED', 'PRINTFUL_FULFILLMENT_MODE',
    'PRINTFUL_ALLOW_ORDER_WRITES', 'PRINTFUL_CONFIRM_LIVE_ORDERS',
    'EMAIL_DELIVERY_MODE', 'PRINTFUL_API_KEY',
  ];
  const previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.ALLOW_TEST_DATA_RESET = 'false';
  process.env.MAINTENANCE_MODE = 'false';
  process.env.STRIPE_LIVE_PAYMENTS_ENABLED = 'false';
  process.env.PRINTFUL_FULFILLMENT_MODE = 'mock';
  process.env.PRINTFUL_ALLOW_ORDER_WRITES = 'false';
  process.env.PRINTFUL_CONFIRM_LIVE_ORDERS = 'false';
  process.env.EMAIL_DELIVERY_MODE = 'mock';
  delete process.env.PRINTFUL_API_KEY;

  const hosted = await startTestServer();
  t.after(hosted.close);
  process.env.PUBLIC_URL = hosted.baseUrl;
  const db = require('../src/db');
  const storage = require('../src/privateStorage');
  const objects = new Map();
  let rejectBulkRemoval = false;
  storage.setAdapterForTests({
    async upload(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async download(key) {
      if (!objects.has(key)) throw new Error('not found');
      return objects.get(key);
    },
    async remove(key) { objects.delete(key); },
    async removeMany(keys) {
      if (rejectBulkRemoval) {
        rejectBulkRemoval = false;
        const error = new Error('forced storage failure');
        error.code = 'storage_delete_failed';
        throw error;
      }
      keys.forEach((key) => objects.delete(key));
    },
    async listAllObjectKeys() { return [...objects.keys()]; },
  });
  t.after(() => storage.resetAdapterForTests());

  const eventPublic = await createEvent(hosted.baseUrl, {
    title: 'Privatname Betrieb Test', clientIp: '192.0.2.88',
  });
  const event = await db.getEventBySlug(eventPublic.slug);

  await t.test('JSON logs correlate requests while rejecting arbitrary and PII-like fields', () => {
    const log = require('../src/structuredLog');
    const records = [];
    log.setSinkForTests((record) => records.push(record));
    const response = { set() {} };
    log.requestContext({}, response, () => {
      log.error('test_failure', {
        operation: 'test',
        orderId: '42',
        errorCode: 'private-person@example.test',
        email: 'private-person@example.test',
        address: 'Geheimer Weg 8',
      });
    });
    log.resetForTests();
    assert.equal(records.length, 1);
    assert.match(records[0].requestId, /^[A-Za-z0-9_-]+$/);
    assert.equal(records[0].orderId, '42');
    assert.equal(records[0].errorCode, 'operation_failed');
    assert.equal(Object.hasOwn(records[0], 'email'), false);
    assert.equal(JSON.stringify(records[0]).includes('private-person'), false);
    assert.equal(JSON.stringify(records[0]).includes('Geheimer'), false);
  });

  const paidOrder = await createPaidTestOrder(db, event, 'retry');
  await hosted.query(`
    UPDATE orders
    SET fulfillment_status = 'blocked', fulfillment_attempts = 8,
        fulfillment_error = 'manual_review_required',
        fulfillment_locked_by = null, fulfillment_locked_until = null
    WHERE id = $1
  `, [paidOrder.id]);

  await t.test('aggregate status is secret-bound and contains no order, event or customer records', async () => {
    const hidden = await fetch(`${hosted.baseUrl}/internal/performance/operations`);
    assert.equal(hidden.status, 404);
    const visible = await fetch(`${hosted.baseUrl}/internal/performance/operations`, {
      headers: { Authorization: `Bearer ${process.env.MAINTENANCE_SECRET}` },
    });
    assert.equal(visible.status, 200);
    const status = await visible.json();
    assert.equal(status.fulfillment.blocked, 1);
    assert.ok(status.email.actionable >= 1);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(eventPublic.slug), false);
    assert.equal(serialized.includes('private-person'), false);
    assert.equal(serialized.includes('Geheimer'), false);
    assert.equal(Object.hasOwn(status.fulfillment, 'orders'), false);
  });

  await t.test('an additive future migration does not stop the currently compatible release', async () => {
    await hosted.query('INSERT INTO app_schema_versions (version) VALUES (4)');
    try {
      await assert.doesNotReject(db.assertDatabaseReady());
    } finally {
      await hosted.query('DELETE FROM app_schema_versions WHERE version = 4');
    }
  });

  await t.test('manual recovery claims exactly one blocked order and records the outcome', async () => {
    const command = require('../scripts/retry-blocked-fulfillment');
    assert.throws(
      () => command.validateOptions({ confirmed: false, orderId: paidOrder.id }),
      (error) => error.code === 'confirmation_required'
    );
    const summary = await command.run(
      { confirmed: true, orderId: String(paidOrder.id) },
      { output() {} }
    );
    assert.equal(summary.succeeded, true);
    assert.equal(summary.fulfillmentStatus, 'mocked');
    const updated = await db.getOrderById(paidOrder.id);
    assert.equal(updated.fulfillment_status, 'mocked');
    const action = await hosted.query(`
      SELECT * FROM operator_actions WHERE id = $1
    `, [summary.operatorActionId]);
    assert.equal(action.rows[0].status, 'succeeded');
    assert.equal(action.rows[0].before_state, 'blocked');
    assert.equal(action.rows[0].after_state, 'mocked');
  });

  await t.test('maintenance mode leaves health visible and rejects public traffic', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const root = await fetch(`${hosted.baseUrl}/`);
    assert.equal(root.status, 503);
    assert.equal(root.headers.get('x-wolkenworte-maintenance'), 'active');
    assert.match(root.headers.get('content-type') || '', /text\/html/);
    const english = await fetch(`${hosted.baseUrl}/?lang=en`);
    assert.equal(english.status, 503);
    assert.match(await english.text(), /We’ll be right back\./);
    const maintenanceStyles = await fetch(`${hosted.baseUrl}/site-fonts.css`);
    assert.equal(maintenanceStyles.status, 200,
      'the maintenance page must be able to load its local presentation assets');
    const publicExport = await fetch(`${hosted.baseUrl}/e/unavailable/export.svg`);
    assert.equal(publicExport.status, 503,
      'only immutable presentation assets may pass the stop-the-world maintenance gate');
    const live = await fetch(`${hosted.baseUrl}/health/live`);
    assert.equal(live.status, 200);
    const guard = require('../src/maintenanceMode');
    await new Promise((resolve, reject) => {
      guard.socketGuard({}, (error) => {
        try {
          assert.equal(error?.message, 'maintenance');
          resolve();
        } catch (assertionError) { reject(assertionError); }
      });
    });
  });

  await t.test('pre-live cleanup requires every guard and never removes DB rows after Storage failure', async () => {
    const cleanup = require('../src/preliveCleanup');
    objects.set('prelive-test/object.bin', Buffer.from('hosted-test-object'));
    const safeEnv = {
      ...process.env,
      NODE_ENV: 'test',
      ALLOW_TEST_DATA_RESET: 'true',
      STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
      PRINTFUL_FULFILLMENT_MODE: 'mock',
      PRINTFUL_ALLOW_ORDER_WRITES: 'false',
      PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
      EMAIL_DELIVERY_MODE: 'mock',
      PUBLIC_URL: hosted.baseUrl,
    };
    assert.throws(
      () => cleanup.assertSafetyConfiguration({ ...safeEnv, STRIPE_LIVE_PAYMENTS_ENABLED: 'true' }),
      (error) => error.code === 'unsafe_runtime_configuration'
    );
    await assert.rejects(
      cleanup.runPreliveCleanup({ confirmed: false }, { env: safeEnv }),
      (error) => error.code === 'confirmation_required'
    );
    await assert.rejects(
      cleanup.runPreliveCleanup(
        { confirmed: true, targetUrl: hosted.baseUrl },
        {
          env: { ...safeEnv, SUPABASE_URL: 'https://different-project.supabase.co' },
          output() {},
        }
      ),
      (error) => error.code === 'cleanup_target_mismatch'
    );
    assert.ok(await db.getEventBySlug(eventPublic.slug), 'Target mismatch must preserve database rows');
    rejectBulkRemoval = true;
    await assert.rejects(
      cleanup.runPreliveCleanup(
        { confirmed: true, targetUrl: hosted.baseUrl },
        { env: safeEnv, output() {} }
      ),
      (error) => error.code === 'storage_delete_failed'
    );
    assert.ok(await db.getEventBySlug(eventPublic.slug), 'Storage failure must preserve database rows');

    const summary = await cleanup.runPreliveCleanup(
      { confirmed: true, targetUrl: hosted.baseUrl },
      { env: safeEnv, output() {} }
    );
    assert.equal(summary.verifiedEmpty, true);
    assert.ok(summary.databaseRowsDeleted > 0);
    assert.ok(summary.storageObjectsDeleted > 0);
    assert.equal(objects.size, 0);
    assert.ok(Object.values(await db.getPreliveCleanupCounts()).every((count) => count === 0));
    const audit = await hosted.query(`
      SELECT action_type, status, summary_json FROM operator_actions
    `);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].action_type, 'prelive_cleanup');
    assert.equal(audit.rows[0].status, 'succeeded');
  });

  await t.test('operations tooling uses no new runtime package and the global grant follows the schema migration', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(packageJson.dependencies, '@sentry/node'), false);
    assert.equal(Object.hasOwn(packageJson.dependencies, 'prom-client'), false);
    const baseline = fs.readFileSync(path.join(
      __dirname, '..', 'supabase', 'migrations', '20260831000000_wolkenworte_baseline.sql'
    ), 'utf8');
    assert.match(baseline, /operator_actions/);
    assert.match(baseline, /wolkenworte_runtime/);
    assert.match(baseline, /enable row level security/);
  });
});
