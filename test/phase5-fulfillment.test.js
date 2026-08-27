'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

async function createPaidOrder(db, event, suffix, { mode = 'live' } = {}) {
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
      name: 'Phase Fünf Test', address1: 'Testweg 5', city: 'Berlin',
      zip: '10115', country_code: 'DE',
    },
    printfulCosts: { currency: 'EUR', subtotal: 10, shipping: 5, vat: 3, total: 18 },
    quote: {
      currency: 'EUR', quantity: 2, itemsCents: 2000,
      shippingCents: 500, taxCents: 475, totalCents: 2975,
    },
  });
  const { order } = await db.createCheckoutOrder({
    eventId: event.id, configurationId: configuration.id, quote, mode,
  });
  const sessionId = `cs_${mode}_${suffix}`;
  await db.attachStripeSession(order.id, { id: sessionId, url: `https://checkout.test/${suffix}` });
  await db.recordSuccessfulPayment({
    stripeEventId: `evt_${mode}_${suffix}`,
    eventType: 'checkout.session.completed',
    stripeSessionId: sessionId,
    paymentIntentId: `pi_${mode}_${suffix}`,
    livemode: mode === 'live',
  });
  return { order: await db.getOrderById(order.id), configuration, quote };
}

test('Phase 5 paid artifacts, leased work, maintenance and Printful reconciliation', async (t) => {
  const previous = {};
  for (const name of [
    'PUBLIC_URL', 'STRIPE_ALLOW_LIVE_PAYMENTS', 'PRINTFUL_FULFILLMENT_MODE',
    'PRINTFUL_ALLOW_ORDER_WRITES', 'PRINTFUL_CONFIRM_LIVE_ORDERS',
    'PRINTFUL_API_KEY', 'PRINTFUL_STORE_ID', 'PRINTFUL_WEBHOOK_SECRET',
    'PRINTFUL_WEBHOOK_PUBLIC_KEY', 'EMAIL_DELIVERY_MODE', 'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
  ]) previous[name] = process.env[name];
  process.env.STRIPE_ALLOW_LIVE_PAYMENTS = 'true';
  process.env.PRINTFUL_FULFILLMENT_MODE = 'draft';
  process.env.PRINTFUL_ALLOW_ORDER_WRITES = 'true';
  process.env.PRINTFUL_CONFIRM_LIVE_ORDERS = 'false';
  process.env.PRINTFUL_API_KEY = 'printful_test_key';
  process.env.PRINTFUL_STORE_ID = '12345';
  process.env.PRINTFUL_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.PRINTFUL_WEBHOOK_PUBLIC_KEY = Buffer.from('phase-five-public-key').toString('base64');
  process.env.EMAIL_DELIVERY_MODE = 'live';
  process.env.RESEND_API_KEY = 're_phase_five_test';
  process.env.RESEND_FROM_EMAIL = 'Wolkenworte <test@example.test>';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const hosted = await startTestServer();
  t.after(hosted.close);
  process.env.PUBLIC_URL = hosted.baseUrl;
  const db = require('../src/db');
  const storage = require('../src/privateStorage');
  const printful = require('../src/printful');
  const fulfillment = require('../src/fulfillment');
  const eventPublic = await createEvent(hosted.baseUrl, { coupleName: 'Lease Lara & Artefakt Anton' });
  const event = await db.getEventBySlug(eventPublic.slug);
  const objects = new Map();
  let failNextRemoval = false;
  storage.setAdapterForTests({
    async upload(key, bytes) {
      if (objects.has(key)) throw new Error('already exists');
      objects.set(key, Buffer.from(bytes));
    },
    async download(key) {
      if (!objects.has(key)) throw new Error('not found');
      return objects.get(key);
    },
    async remove(key) {
      if (failNextRemoval) {
        failNextRemoval = false;
        throw new Error('forced delete failure');
      }
      objects.delete(key);
    },
    async createSignedUrl() { throw new Error('not used'); },
  });
  t.after(() => storage.resetAdapterForTests());

  await t.test('Printful order and item ids are stable, compact and collision-separated', () => {
    const order = { id: '42', quote_id: 'opaque-quote' };
    const one = fulfillment.shipmentExternalId(order, 0);
    assert.equal(one, fulfillment.shipmentExternalId(order, 0));
    assert.match(one, /^ww_[A-Za-z0-9_-]{24}$/);
    assert.ok(one.length <= 32);
    assert.notEqual(one, fulfillment.shipmentExternalId(order, 1));
    const item = fulfillment.itemExternalId(order, 0, 0);
    assert.match(item, /^wi_[A-Za-z0-9_-]{24}$/);
    assert.ok(item.length <= 32);
    assert.notEqual(item, fulfillment.itemExternalId(order, 0, 1));
    assert.notEqual(item, fulfillment.itemExternalId(order, 1, 0));
  });

  const paid = await createPaidOrder(db, event, 'artifact');
  const originalReconcile = printful.reconcilePrintfulOrder;
  const providerCalls = [];
  printful.reconcilePrintfulOrder = async (options) => {
    providerCalls.push(options);
    return { printfulOrderId: 'draft-phase-five', status: 'draft', mocked: false, confirmed: false };
  };
  t.after(() => { printful.reconcilePrintfulOrder = originalReconcile; });

  await t.test('paid draft work freezes one private artifact and streams only the active capability', async () => {
    const completed = await fulfillment.processOrder(paid.order.id);
    assert.equal(completed.fulfillment_status, 'draft');
    assert.equal(providerCalls.length, 1);
    const artifacts = await db.getOrderPrintArtifacts(paid.order.id);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].storage_status, 'active');
    assert.match(artifacts[0].object_key, /^print-artifacts\/[A-Za-z0-9_-]{24}\/[a-f0-9]{64}\.svg$/);
    assert.equal(objects.size, 1);
    const fileUrl = providerCalls[0].payload.items[0].files[0].url;
    assert.equal(fileUrl, `${hosted.baseUrl}/api/print-files/${artifacts[0].id}/${artifacts[0].access_nonce}`);
    assert.ok(!fileUrl.includes('supabase'));

    const valid = await fetch(fileUrl);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('content-type'), 'image/svg+xml');
    assert.equal(valid.headers.get('cache-control'), 'private, no-store');
    const bytes = Buffer.from(await valid.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), artifacts[0].sha256);

    const wrongNonce = await fetch(`${hosted.baseUrl}/api/print-files/${artifacts[0].id}/${'x'.repeat(32)}`);
    assert.equal(wrongNonce.status, 404);
    const wrongId = await fetch(`${hosted.baseUrl}/api/print-files/${'y'.repeat(24)}/${artifacts[0].access_nonce}`);
    assert.equal(wrongId.status, 404);
  });

  await t.test('an expired lease is recoverable and its stale owner cannot commit', async () => {
    const pending = await createPaidOrder(db, event, 'lease', { mode: 'test' });
    const first = await db.claimFulfillmentOrder({ orderId: pending.order.id, lockedBy: 'worker-a', leaseMs: 15_000 });
    assert.ok(first);
    await hosted.query(`
      UPDATE orders SET fulfillment_locked_until = transaction_timestamp() - interval '1 second'
      WHERE id = $1
    `, [pending.order.id]);
    const second = await db.claimFulfillmentOrder({ orderId: pending.order.id, lockedBy: 'worker-b', leaseMs: 15_000 });
    assert.equal(Number(second.fulfillment_lease_version), Number(first.fulfillment_lease_version) + 1);
    const stale = await db.completeFulfillment(pending.order.id, {
      lockedBy: first.fulfillment_locked_by,
      leaseVersion: Number(first.fulfillment_lease_version),
    }, { mode: 'mock', payload: {}, printfulOrderId: 'stale', printfulStatus: 'mocked' });
    assert.equal(stale, null);
    const current = await db.completeFulfillment(pending.order.id, {
      lockedBy: second.fulfillment_locked_by,
      leaseVersion: Number(second.fulfillment_lease_version),
    }, { mode: 'mock', payload: {}, printfulOrderId: 'current', printfulStatus: 'mocked' });
    assert.equal(current.printful_order_id, 'current');
  });

  await t.test('lost create and confirm responses reconcile by the same external id before retry writes', async () => {
    printful.reconcilePrintfulOrder = originalReconcile;
    const originalFetch = global.fetch;
    let getCalls = 0;
    let postCalls = 0;
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('/orders/%40ww_') && options.method === 'GET') {
        getCalls += 1;
        if (getCalls === 1) return new Response(JSON.stringify({ code: 404 }), { status: 404 });
        return new Response(JSON.stringify({
          code: 200,
          result: { id: 991, external_id: 'ww_abcdefghijklmnopqrstuvwx', status: 'draft' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('/orders?') && options.method === 'POST') {
        postCalls += 1;
        throw new TypeError('forced response loss');
      }
      throw new Error(`unexpected fetch ${options.method} ${url}`);
    };
    try {
      const payload = { external_id: 'ww_abcdefghijklmnopqrstuvwx', items: [] };
      await assert.rejects(printful.reconcilePrintfulOrder({ payload, confirm: false }), /momentan nicht erreichbar/);
      const reconciled = await printful.reconcilePrintfulOrder({ payload, confirm: false });
      assert.equal(reconciled.printfulOrderId, '991');
      assert.equal(reconciled.reconciled, true);
      assert.equal(postCalls, 1, 'the retry must not create a second provider order');
      assert.equal(getCalls, 2);

      let confirmationGets = 0;
      let confirmationWrites = 0;
      global.fetch = async (url, options = {}) => {
        if (String(url).includes('/orders/%40ww_') && options.method === 'GET') {
          confirmationGets += 1;
          return new Response(JSON.stringify({
            code: 200,
            result: {
              id: 992,
              external_id: payload.external_id,
              status: confirmationGets === 1 ? 'draft' : 'pending',
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (String(url).endsWith('/orders/992/confirm') && options.method === 'POST') {
          confirmationWrites += 1;
          throw new TypeError('forced confirm response loss');
        }
        throw new Error(`unexpected fetch ${options.method} ${url}`);
      };
      await assert.rejects(printful.reconcilePrintfulOrder({ payload, confirm: true }), /momentan nicht erreichbar/);
      const confirmed = await printful.reconcilePrintfulOrder({ payload, confirm: true });
      assert.equal(confirmed.status, 'pending');
      assert.equal(confirmed.reconciled, true);
      assert.equal(confirmationWrites, 1, 'an accepted confirmation must not be submitted twice');
      assert.equal(confirmationGets, 2);
    } finally {
      global.fetch = originalFetch;
      printful.reconcilePrintfulOrder = async (options) => {
        providerCalls.push(options);
        return { printfulOrderId: 'draft-phase-five', status: 'draft', mocked: false };
      };
    }
  });

  await t.test('signed Printful callbacks are replay-safe and unsigned callbacks change nothing', async () => {
    const artifact = (await db.getOrderPrintArtifacts(paid.order.id))[0];
    const shipment = (await db.getOrderShipments(paid.order.id))[0];
    const payloadObject = {
      type: 'shipment_sent', occurred_at: '2026-08-27T12:00:00Z', retries: 0,
      store_id: 12345,
      data: {
        shipment: {
          id: 7001, status: 'shipped', shipped_at: '2026-08-27T12:00:00Z', delivered_at: null,
        },
        order: {
          id: Number(shipment.printful_order_id || 991),
          external_id: providerCalls[0].payload.external_id,
          status: 'fulfilled',
        },
      },
    };
    const body = JSON.stringify(payloadObject);
    const signature = crypto.createHmac(
      'sha256', Buffer.from(process.env.PRINTFUL_WEBHOOK_SECRET, 'hex')
    ).update(body).digest('hex');
    const invalid = await fetch(`${hosted.baseUrl}/webhook/printful`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        'x-pf-webhook-signature': '0'.repeat(64),
        'x-pf-webhook-public-key': process.env.PRINTFUL_WEBHOOK_PUBLIC_KEY,
      }, body,
    });
    assert.equal(invalid.status, 400);

    for (const duplicate of [false, true]) {
      const response = await fetch(`${hosted.baseUrl}/webhook/printful`, {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          'x-pf-webhook-signature': signature,
          'x-pf-webhook-public-key': process.env.PRINTFUL_WEBHOOK_PUBLIC_KEY,
        }, body,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).duplicate, duplicate);
    }
    const updatedShipment = (await db.getOrderShipments(paid.order.id))[0];
    assert.equal(updatedShipment.shipped_at, '2026-08-27T12:00:00.000Z');
    assert.equal((await db.getOrderById(paid.order.id)).status, 'fulfilled');
    assert.ok(Date.parse((await db.getPrintArtifact(artifact.id)).expires_at) > Date.now() + 80 * 86400000);
  });

  await t.test('maintenance is secret-bound, heartbeated and retries object-first artifact deletion', async () => {
    const artifact = (await db.getOrderPrintArtifacts(paid.order.id))[0];
    await hosted.query(`
      UPDATE print_artifacts
      SET expires_at = transaction_timestamp() - interval '1 second', support_hold = true
      WHERE id = $1
    `, [artifact.id]);
    const before = await hosted.query('SELECT count(*)::integer AS count FROM maintenance_runs');
    const unauthenticated = await fetch(`${hosted.baseUrl}/internal/maintenance/run`, { method: 'POST' });
    assert.equal(unauthenticated.status, 404);
    const afterUnauthenticated = await hosted.query('SELECT count(*)::integer AS count FROM maintenance_runs');
    assert.equal(afterUnauthenticated.rows[0].count, before.rows[0].count);

    const run = () => fetch(`${hosted.baseUrl}/internal/maintenance/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.MAINTENANCE_SECRET}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    let response = await run();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
    assert.ok(await db.getPrintArtifact(artifact.id), 'support hold must retain expired metadata and object');
    const expiredCapability = await fetch(
      `${hosted.baseUrl}/api/print-files/${artifact.id}/${artifact.access_nonce}`
    );
    assert.equal(expiredCapability.status, 404, 'an expired capability is unavailable even under support hold');

    await hosted.query('UPDATE print_artifacts SET support_hold = false WHERE id = $1', [artifact.id]);
    failNextRemoval = true;
    response = await run();
    assert.equal(response.status, 200);
    assert.equal((await db.getPrintArtifact(artifact.id)).storage_status, 'delete_failed');
    response = await run();
    assert.equal(response.status, 200);
    assert.equal(await db.getPrintArtifact(artifact.id), null);
    assert.equal(objects.size, 0);
    const latest = await db.getLatestMaintenanceRun();
    assert.equal(latest.status, 'succeeded');
    assert.ok(latest.completed_at);
    assert.doesNotMatch(latest.summary_json, /print-artifacts|Testweg|provider-smoke/);
  });

  await t.test('the committed Cron definition reads Vault secrets and uses the explicit 30-second timeout', () => {
    const migration = fs.readFileSync(path.join(
      __dirname, '..', 'supabase', 'migrations', '20260827000011_global_maintenance_cron.sql'
    ), 'utf8');
    assert.match(migration, /vault\.decrypted_secrets/);
    assert.match(migration, /timeout_milliseconds := 30000/);
    assert.match(migration, /'\*\/5 \* \* \* \*'/);
    assert.doesNotMatch(migration, /Bearer [A-Za-z0-9_-]{32,}/);
  });
});
