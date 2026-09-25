'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer, createEvent } = require('./helpers');
const { yearEndDeadline } = require('../src/retentionPolicy');

test('retention uses complete German calendar years, including the UTC year boundary', () => {
  assert.equal(yearEndDeadline('2026-06-01T00:00:00Z', 8).toISOString(), '2034-12-31T23:00:00.000Z');
  assert.equal(yearEndDeadline('2026-12-31T23:30:00Z', 3).toISOString(), '2030-12-31T23:00:00.000Z');
  assert.equal(yearEndDeadline('2026-12-31T22:30:00Z', 3).toISOString(), '2029-12-31T23:00:00.000Z');
});

test('commerce retention protects evidence and removes expired personal copies', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const db = require('../src/db');
  const year = new Date().getUTCFullYear();
  const ago = (years) => new Date(Date.UTC(year - years, 5, 15));
  const recipient = { name: 'Retention Buyer', address1: 'Testweg 1', city: 'Berlin',
    zip: '10115', country_code: 'DE', phone: '+4930123456', email: 'private@example.test' };

  async function fixture({ at = ago(4), emailStatus = 'delivered' } = {}) {
    const configId = crypto.randomBytes(18).toString('base64url');
    await app.query(`INSERT INTO configurations
      (id, product_key, printful_variant_id, theme, words_json, design_json, print_width, print_height, expires_at)
      VALUES ($1, 'white-glossy-mug-duo-11oz', 1320, 'blush', '[["secret",1]]',
        '{"image":"private"}', 2700, 1120, $2)`, [configId, at]);
    const order = (await app.query(`INSERT INTO orders
      (event_slug_snapshot, event_title_snapshot, buyer_email, status, shipping_json,
       fulfillment_status, fulfillment_error, fulfillment_payload_json, checkout_error,
       configuration_id, currency, items_cents, shipping_cents, tax_cents, total_cents,
       checkout_request_json, paid_at, created_at, stripe_payment_intent_id)
      VALUES ('expired-slug', 'Personal title', 'private@example.test', 'fulfilled', $1,
        'submitted', 'old error with unnecessary detail', '{"recipient":"private"}', 'old detail',
        $2, 'EUR', 1000, 500, 285, 1785, '{"customerId":"cus_kept","address":"private"}', $3, $3, $4)
      RETURNING *`, [JSON.stringify([{ recipient }]), configId, at, `pi_${configId}`])).rows[0];
    const shipment = (await app.query(`INSERT INTO checkout_order_shipments
      (order_id, shipment_index, quantity, recipient_json, printful_costs_json, currency,
       shipping_cents, tax_cents, fulfillment_status, delivered_at, shipped_at,
       fulfillment_payload_json, printful_order_id, tracking_number, tracking_url)
      VALUES ($1, 0, 1, $2, '{"total":10}', 'EUR', 500, 0, 'submitted', $3, $3,
        $4, $5, 'private-tracking', 'https://example.test/private') RETURNING *`,
    [order.id, JSON.stringify(recipient), at, JSON.stringify({ external_id: `order-${order.id}`, recipient }),
      `pf_${order.id}`])).rows[0];
    const item = (await app.query(`INSERT INTO order_items
      (order_id, configuration_id, shipment_index, item_index, product_key, printful_variant_id,
       quantity, configuration_snapshot_json)
      VALUES ($1, $2, 0, 0, 'white-glossy-mug-duo-11oz', 1320, 1,
        '{"productKey":"white-glossy-mug-duo-11oz","words":["secret"],"design":{"image":"private"}}')
      RETURNING *`, [order.id, configId])).rows[0];
    for (const kind of ['order_confirmation', 'shipment_confirmation', 'refund_confirmation', 'cancellation_confirmation']) {
      await app.query(`INSERT INTO email_jobs
        (order_id, shipment_id, kind, dedupe_key, recipient_email, locale, template_version,
         subject, html_body, text_body, status, provider_terminal, created_at)
        VALUES ($1, $2, $3, $4, 'private@example.test', 'de', 'test', 'Evidence',
          '<p>Evidence with address</p>', 'Evidence with address', $5, $6, $7)`,
      [order.id, shipment.id, kind, `${kind}:${order.id}`, emailStatus, emailStatus === 'delivered', at]);
    }
    return { order, shipment, item, configId };
  }
  t.beforeEach(async () => {
    await app.query('TRUNCATE orders, configurations, stripe_webhook_events, resend_webhook_events, printful_webhook_events CASCADE');
  });

  await t.test('90-day cleanup removes provider details, keeps addresses, email evidence and matching identifiers', async () => {
    const { order } = await fixture({ at: new Date(Date.now() - 120 * 86400000) });
    const result = await db.cleanupCommerceRecords();
    assert.equal(result.technical, 1);
    assert.equal(result.operational, 0);
    const stored = await db.getOrderById(order.id);
    assert.equal(stored.fulfillment_payload_json, null);
    assert.equal(stored.checkout_error, null);
    assert.equal(stored.buyer_email, 'private@example.test');
    assert.equal((await db.getEmailJobsForOrder(order.id))[0].subject, 'Evidence');
    assert.deepEqual(JSON.parse((await db.getOrderShipments(order.id))[0].fulfillment_payload_json),
      { external_id: `order-${order.id}` });
  });

  await t.test('three years removes duplicate contacts, artwork and configurations but keeps one tax address', async () => {
    const { order, configId } = await fixture();
    const event = await createEvent(app.baseUrl);
    const eventRow = await db.getEventBySlug(event.slug);
    const quote = await db.createCheckoutQuote({ eventId: eventRow.id, configurationId: configId,
      recipient, printfulCosts: { total: 10 }, quote: { currency: 'EUR', quantity: 1,
        itemsCents: 1000, shippingCents: 500, taxCents: 285, totalCents: 1785 } });
    await app.query('UPDATE orders SET quote_id = $2 WHERE id = $1', [order.id, quote.id]);
    const result = await db.cleanupCommerceRecords();
    assert.equal(result.operational, 1);
    const stored = await db.getOrderById(order.id);
    assert.equal(stored.buyer_email, null);
    assert.equal(stored.configuration_id, null);
    const evidence = JSON.parse(stored.shipping_json)[0];
    assert.equal(evidence.country_code, 'DE');
    assert.equal(evidence.name, 'Retention Buyer');
    assert.equal(evidence.phone, undefined);
    assert.equal(evidence.email, undefined);
    assert.equal(stored.total_cents, 1785);
    assert.deepEqual(JSON.parse(stored.checkout_request_json), { customerId: 'cus_kept' });
    const shipment = (await db.getOrderShipments(order.id))[0];
    assert.equal(shipment.recipient_json, '{}');
    assert.equal(shipment.tracking_url, null);
    assert.equal(await db.getConfiguration(configId), null);
    assert.equal(await db.getCheckoutQuote(quote.id), null);
    assert.equal(JSON.parse((await db.getOrderItems(order.id))[0].configuration_snapshot_json).design, undefined);
    assert.equal((await db.getEmailJobsForOrder(order.id))[0].subject, 'Evidence');
    assert.equal((await db.cleanupCommerceRecords()).checked, 0, 'same-day scan is idempotent');
  });

  await t.test('six-year correspondence expires before eight-year booking evidence and cannot be resent', async () => {
    const { order } = await fixture({ at: ago(7) });
    assert.equal((await db.cleanupCommerceRecords()).emails, 2);
    const emails = await db.getEmailJobsForOrder(order.id);
    for (const email of emails) {
      const expired = ['shipment_confirmation', 'cancellation_confirmation'].includes(email.kind);
      assert.equal(Boolean(email.content_erased_at), expired);
      assert.equal(email.subject, expired ? '[expired]' : 'Evidence');
      if (expired) {
        assert.equal(email.recipient_email, null);
        assert.equal(await db.claimEmailJob({ jobId: email.id, lockedBy: 'retention-test' }), null);
      }
    }
  });

  await t.test('eight-year expiry deletes the full record; minimal dedupe IDs survive until metadata cleanup', async () => {
    const { order, configId } = await fixture({ at: ago(9) });
    await app.query(`INSERT INTO stripe_webhook_events (stripe_event_id, event_type, order_id)
      VALUES ('evt_retained', 'checkout.session.completed', $1)`, [order.id]);
    assert.equal((await db.cleanupCommerceRecords()).orders, 1);
    assert.equal(await db.getOrderById(order.id), null);
    assert.equal(await db.getConfiguration(configId), null);
    assert.equal((await db.getEmailJobsForOrder(order.id)).length, 0);
    assert.equal((await app.query("SELECT order_id FROM stripe_webhook_events WHERE stripe_event_id = 'evt_retained'")).rows[0].order_id, null);
  });

  await t.test('ten-year override and reviewed holds prevent premature deletion', async () => {
    const { order } = await fixture({ at: ago(9) });
    await db.setOrderRetentionPolicy({ orderId: order.id, holdReason: 'audit',
      reviewAt: new Date(Date.now() + 86400000).toISOString(), years: 10 });
    await app.query("UPDATE orders SET retention_review_at = transaction_timestamp() - interval '1 day' WHERE id = $1", [order.id]);
    assert.equal((await db.cleanupCommerceRecords()).checked, 0);
    assert.equal((await db.getOperationalStatus()).retention.reviewsDue, 1);
    await db.setOrderRetentionPolicy({ orderId: order.id });
    assert.equal((await db.cleanupCommerceRecords()).orders, 0);
    assert.ok(await db.getOrderById(order.id));
    await assert.rejects(db.setOrderRetentionPolicy({ orderId: order.id, holdReason: 'dispute' }), /invalid retention/);
    await assert.rejects(app.query(`UPDATE orders SET retention_review_at = transaction_timestamp()
      WHERE id = $1`, [order.id]), /orders_retention_hold/);
  });

  await t.test('active email work and returned shipments stay intact', async () => {
    const active = await fixture({ at: ago(9), emailStatus: 'pending' });
    const returned = await fixture({ at: ago(9) });
    await app.query("UPDATE checkout_order_shipments SET printful_order_status = 'returned' WHERE order_id = $1", [returned.order.id]);
    const result = await db.cleanupCommerceRecords();
    assert.equal(result.orders, 0);
    assert.equal(result.operational, 0);
    assert.equal((await db.getOrderById(active.order.id)).buyer_email, 'private@example.test');
  });

  await t.test('unknown Stripe attempts survive; confirmed unpaid expiration waits thirty days', async () => {
    async function unpaid(id, days, attempted = true) {
      return (await app.query(`INSERT INTO orders (event_slug_snapshot, event_title_snapshot, status,
        stripe_session_id, quote_id, checkout_first_attempt_at, checkout_session_expires_at, created_at)
        VALUES ('old', 'old', 'checkout_pending', $1, $1,
          CASE WHEN $2 THEN transaction_timestamp() - interval '40 days' ELSE null END,
          transaction_timestamp() - ($3 * interval '1 day'), transaction_timestamp() - interval '40 days')
        RETURNING *`, [id, attempted, days])).rows[0];
    }
    const unknown = await unpaid('cs_unknown', 35);
    const expired = await unpaid('cs_expired', 31);
    const recent = await unpaid('cs_recent', 29);
    for (const [order, days] of [[expired, 31], [recent, 29]]) {
      const session = { id: order.stripe_session_id, status: 'expired', payment_status: 'unpaid',
        expires_at: Math.floor(Date.now() / 1000 - days * 86400) };
      assert.equal((await db.recordExpiredCheckout({ stripeEventId: `evt_${order.id}`, session, livemode: true })).matched, false);
      assert.equal((await db.recordExpiredCheckout({ stripeEventId: `evt_${order.id}`, session, livemode: false })).matched, true);
    }
    assert.equal((await db.cleanupCommerceRecords()).unpaid, 1);
    assert.equal(await db.getOrderById(expired.id), null);
    assert.ok(await db.getOrderById(unknown.id));
    assert.ok(await db.getOrderById(recent.id));
  });

  await t.test('event expiration cannot bypass an unresolved checkout or its hold', async () => {
    const event = await createEvent(app.baseUrl);
    const row = await db.getEventBySlug(event.slug);
    const { order, configId } = await fixture();
    await app.query(`UPDATE orders SET event_id = $2, paid_at = null, status = 'creating_checkout',
      checkout_ambiguous = true WHERE id = $1`, [order.id, row.id]);
    await app.query('UPDATE configurations SET event_id = $2 WHERE id = $1', [configId, row.id]);
    await app.query("UPDATE events SET created_at = transaction_timestamp() - interval '366 days' WHERE id = $1", [row.id]);
    assert.equal((await require('../src/lifecycle').cleanupExpiredEvent(row.id)).deleted, true);
    assert.ok(await db.getOrderById(order.id));
    assert.equal((await db.getConfiguration(configId)).event_id, null);
  });

  await t.test('holds protect storage; metadata cleanup cannot delete a file before object removal', async () => {
    const { order, item, configId } = await fixture({ at: ago(9) });
    const artifact = await db.getOrCreatePrintArtifact({ id: 'a'.repeat(24), orderId: order.id,
      orderItemId: item.id, configurationId: configId, surfaceKey: 'default', objectKey: 'private/key',
      mimeType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64), accessNonce: 'b'.repeat(32), expiresAt: ago(1) });
    await db.activatePrintArtifact(artifact.id, { byteSize: 1, sha256: 'a'.repeat(64) });
    await db.setOrderRetentionPolicy({ orderId: order.id, holdReason: 'support',
      reviewAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(await db.claimExpiredPrintArtifact(), null);
    await db.setOrderRetentionPolicy({ orderId: order.id });
    assert.equal((await db.cleanupCommerceRecords()).orders, 0);
    const claimed = await db.claimExpiredPrintArtifact();
    assert.equal(claimed.id, artifact.id);
    await assert.rejects(db.setOrderRetentionPolicy({ orderId: order.id, holdReason: 'audit',
      reviewAt: new Date(Date.now() + 86400000).toISOString() }), /deletion in progress/);
  });

  await t.test('batch limits, busy child locks and deadline keep maintenance bounded', async () => {
    const first = await fixture();
    await fixture();
    const locker = await db.getPool().connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM email_jobs WHERE order_id = $1 FOR UPDATE', [first.order.id]);
      assert.equal((await db.cleanupCommerceRecords()).checked, 0);
    } finally {
      await locker.query('ROLLBACK'); locker.release();
    }
    assert.equal((await db.cleanupCommerceRecords({ deadline: Date.now() })).checked, 0);
    assert.equal((await db.cleanupCommerceRecords({ limit: 1 })).checked, 1);
    assert.equal((await db.cleanupCommerceRecords({ limit: 1 })).checked, 1);
  });

  await t.test('metadata expires after ninety days, but linked payment evidence and active runs survive', async () => {
    const { order } = await fixture();
    await app.query(`INSERT INTO stripe_webhook_events (stripe_event_id, event_type, order_id, processed_at)
      VALUES ('evt_linked', 'checkout.session.completed', $1, transaction_timestamp() - interval '100 days'),
        ('evt_unmatched', 'checkout.session.expired', null, transaction_timestamp() - interval '100 days')`, [order.id]);
    await app.query(`INSERT INTO maintenance_runs (status, completed_at)
      VALUES ('succeeded', transaction_timestamp() - interval '100 days'), ('running', null)`);
    assert.equal(await db.cleanupRetentionMetadata(), 2);
    assert.equal((await app.query('SELECT stripe_event_id FROM stripe_webhook_events')).rows[0].stripe_event_id, 'evt_linked');
    assert.equal((await app.query("SELECT 1 FROM maintenance_runs WHERE status = 'running'")).rowCount, 1);
  });

  await t.test('another retained order keeps a shared design alive', async () => {
    const first = await fixture();
    const second = await fixture({ at: new Date(Date.now() - 120 * 86400000) });
    await app.query('UPDATE orders SET configuration_id = $2 WHERE id = $1', [second.order.id, first.configId]);
    await app.query('UPDATE order_items SET configuration_id = $2 WHERE order_id = $1', [second.order.id, first.configId]);
    await db.cleanupCommerceRecords();
    assert.ok(await db.getConfiguration(first.configId));
    assert.equal((await db.getOrderById(first.order.id)).configuration_id, null);
    assert.equal((await db.getOrderById(second.order.id)).configuration_id, first.configId);
  });

  await t.test('only signed expiry callbacks authorize cleanup and an old Session cannot expire its replacement', async (st) => {
    const Stripe = require('stripe');
    const sdk = new Stripe('sk_test_retention');
    const names = ['APP_ENVIRONMENT', 'STRIPE_PAYMENT_MODE', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_LOCAL_WEBHOOK_SECRET'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    st.after(() => names.forEach((name) => {
      if (previous[name] == null) delete process.env[name]; else process.env[name] = previous[name];
    }));
    Object.assign(process.env, { APP_ENVIRONMENT: 'local', STRIPE_PAYMENT_MODE: 'test',
      STRIPE_TEST_SECRET_KEY: 'sk_test_retention', STRIPE_TEST_LOCAL_WEBHOOK_SECRET: 'whsec_retention' });
    const expiresAt = Math.floor(Date.now() / 1000) - 31 * 86400;
    const row = (await app.query(`INSERT INTO orders (event_slug_snapshot, event_title_snapshot,
      status, stripe_session_id, quote_id, checkout_session_expires_at, created_at)
      VALUES ('old', 'old', 'checkout_pending', 'cs_retention_http', 'quote_http',
        to_timestamp($1), transaction_timestamp() - interval '40 days') RETURNING *`, [expiresAt])).rows[0];
    const session = { id: row.stripe_session_id, status: 'expired', payment_status: 'unpaid',
      expires_at: expiresAt, metadata: { orderId: String(row.id), quoteId: row.quote_id } };
    const payload = JSON.stringify({ id: 'evt_retention_http', type: 'checkout.session.expired',
      livemode: false, data: { object: session } });
    const send = (secret) => fetch(`${app.baseUrl}/webhook/stripe`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature':
        sdk.webhooks.generateTestHeaderString({ payload, secret }) }, body: payload });
    assert.equal((await send('whsec_wrong')).status, 400);
    assert.equal((await db.getOrderById(row.id)).checkout_expired_confirmed_at, null);
    assert.equal((await (await send('whsec_retention')).json()).matched, true);
    assert.equal((await (await send('whsec_retention')).json()).duplicate, true);
    await db.replaceExpiredCheckoutSession(row.id, { expectedSessionId: session.id,
      checkoutRequest: { customerId: 'cus_replacement' }, locale: 'de' });
    assert.equal((await db.recordExpiredCheckout({ stripeEventId: 'evt_old_late', session, livemode: false })).matched, false);
    const replacement = await db.getOrderById(row.id);
    assert.equal(replacement.checkout_expired_confirmed_at, null);
    assert.equal(replacement.stripe_session_id, null);
    assert.equal((await db.cleanupCommerceRecords()).unpaid, 0);
  });
});
