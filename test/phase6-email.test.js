'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Webhook } = require('standardwebhooks');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

async function createPreparedOrder(db, event, suffix, { mode = 'test' } = {}) {
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
      name: 'Lieferung Eins', address1: 'Testweg 6', city: 'Heilbronn',
      zip: '74080', country_code: 'DE',
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
  const sessionId = `cs_phase6_${suffix}`;
  await db.attachStripeSession(order.id, { id: sessionId, url: `https://checkout.test/${suffix}` });
  return { order: await db.getOrderById(order.id), configuration, quote, sessionId };
}

async function payPreparedOrder(db, prepared, suffix, { mode = 'test', buyerEmail = 'buyer@example.test' } = {}) {
  return db.recordSuccessfulPayment({
    stripeEventId: `evt_phase6_${suffix}`,
    eventType: 'checkout.session.completed',
    stripeSessionId: prepared.sessionId,
    paymentIntentId: `pi_phase6_${suffix}`,
    livemode: mode === 'live',
    amountTotal: prepared.order.total_cents,
    currency: prepared.order.currency,
    paymentStatus: 'paid',
    buyerEmail,
  });
}

function signedResendHeaders(secret, svixId, body) {
  const timestamp = new Date();
  return {
    'Content-Type': 'application/json',
    'svix-id': svixId,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': new Webhook(secret).sign(svixId, timestamp, body),
  };
}

test('Phase 6 buyer contact, durable email jobs and provider reconciliation', async (t) => {
  const previous = {};
  for (const name of [
    'EMAIL_DELIVERY_MODE', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL',
    'RESEND_WEBHOOK_SECRET', 'RESEND_SMOKE_RECIPIENTS', 'STRIPE_ALLOW_LIVE_PAYMENTS',
  ]) previous[name] = process.env[name];
  process.env.EMAIL_DELIVERY_MODE = 'mock';
  process.env.STRIPE_ALLOW_LIVE_PAYMENTS = 'false';
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_SMOKE_RECIPIENTS;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const hosted = await startTestServer();
  t.after(hosted.close);
  const db = require('../src/db');
  const emailDelivery = require('../src/emailDelivery');
  const resend = require('../src/resend');
  const fulfillment = require('../src/fulfillment');
  t.after(() => resend.resetAdapterForTests());
  const eventPublic = await createEvent(hosted.baseUrl, {
    coupleName: 'E-Mail Emma & Nachricht Noah', locale: 'de',
  });
  const event = await db.getEventBySlug(eventPublic.slug);

  await t.test('payment atomically snapshots one confirmation job and test payments never call Resend', async () => {
    const prepared = await createPreparedOrder(db, event, 'atomic');
    const paid = await payPreparedOrder(db, prepared, 'atomic', {
      buyerEmail: '  BUYER@Example.Test  ',
    });
    assert.equal(paid.order.buyer_email, 'buyer@example.test');
    assert.equal(paid.emailJobCreated, true);
    assert.equal(paid.emailJob.status, 'pending');
    assert.equal(paid.emailJob.recipient_email, 'buyer@example.test');
    assert.match(paid.emailJob.subject, /WW-\d{8}/);
    assert.match(paid.emailJob.text_body, /2 × Wortwolken-Tasse/);
    assert.match(paid.emailJob.text_body, /Variante: 1320/);
    assert.match(paid.emailJob.text_body, new RegExp(prepared.configuration.id));
    assert.match(paid.emailJob.text_body, /Testweg 6/);
    assert.match(paid.emailJob.text_body, /29,75\s*€/);
    assert.match(paid.emailJob.text_body, /JUSA Engineering UG/);
    assert.match(paid.emailJob.text_body, /§ 312g/);

    const duplicate = await payPreparedOrder(db, prepared, 'atomic', {
      buyerEmail: 'buyer@example.test',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal((await db.getEmailJobsForOrder(prepared.order.id)).length, 1);

    let providerCalls = 0;
    resend.setAdapterForTests({ async send() { providerCalls += 1; throw new Error('must not send'); } });
    process.env.EMAIL_DELIVERY_MODE = 'live';
    process.env.RESEND_API_KEY = 're_phase6_fake';
    process.env.RESEND_FROM_EMAIL = 'Wolkenworte <bestellung@mail.example.test>';
    const delivered = await emailDelivery.processJob(paid.emailJob.id);
    assert.equal(delivered.status, 'delivered');
    assert.match(delivered.provider_message_id, /^mock-/);
    assert.equal(providerCalls, 0, 'a Stripe test payment must never contact Resend');
  });

  await t.test('a missing verified buyer email blocks only email and never payment or fulfillment', async () => {
    const prepared = await createPreparedOrder(db, event, 'missing-email');
    const paid = await payPreparedOrder(db, prepared, 'missing-email', { buyerEmail: null });
    assert.equal(paid.order.status, 'paid_test');
    assert.equal(paid.order.fulfillment_status, 'pending');
    assert.equal(paid.emailJob.status, 'blocked');
    assert.equal(paid.emailJob.last_error, 'buyer_email_missing');
    const fulfilled = await fulfillment.processOrder(prepared.order.id);
    assert.equal(fulfilled.fulfillment_status, 'mocked');
    assert.equal((await db.getEmailJobById(paid.emailJob.id)).status, 'blocked');
  });

  process.env.EMAIL_DELIVERY_MODE = 'live';
  process.env.RESEND_API_KEY = 're_phase6_fake';
  process.env.RESEND_FROM_EMAIL = 'Wolkenworte <bestellung@mail.example.test>';
  process.env.RESEND_SMOKE_RECIPIENTS = 'maintainer@example.test';
  const webhookSecret = `whsec_${crypto.randomBytes(32).toString('base64')}`;
  process.env.RESEND_WEBHOOK_SECRET = webhookSecret;

  await t.test('an accepted send with a lost response is reconciled by the non-PII job tag', async () => {
    const smoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'en',
    });
    const calls = [];
    resend.setAdapterForTests({
      async send(payload, options) {
        calls.push({ payload, options });
        throw new TypeError('simulated response loss');
      },
    });
    const ambiguous = await emailDelivery.processJob(smoke.emailJob.id, { providerSmoke: true });
    assert.equal(ambiguous.status, 'failed');
    assert.equal(ambiguous.delivery_ambiguous, true);
    assert.ok(ambiguous.first_send_attempt_at);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.idempotencyKey, smoke.emailJob.dedupe_key);
    assert.deepEqual(calls[0].payload.tags.find((tag) => tag.name === 'email_job_id'), {
      name: 'email_job_id', value: String(smoke.emailJob.id),
    });

    const body = JSON.stringify({
      type: 'email.delivered', created_at: new Date().toISOString(),
      data: {
        email_id: 'resend-accepted-lost-response', created_at: new Date().toISOString(),
        from: process.env.RESEND_FROM_EMAIL, to: ['maintainer@example.test'],
        subject: smoke.emailJob.subject, tags: { email_job_id: String(smoke.emailJob.id) },
      },
    });
    for (const duplicate of [false, true]) {
      const response = await fetch(`${hosted.baseUrl}/webhook/resend`, {
        method: 'POST',
        headers: signedResendHeaders(webhookSecret, 'msg_phase6_lost_response', body),
        body,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).duplicate, duplicate);
    }
    const reconciled = await db.getEmailJobById(smoke.emailJob.id);
    assert.equal(reconciled.status, 'delivered');
    assert.equal(reconciled.provider_message_id, 'resend-accepted-lost-response');
    await hosted.query('UPDATE email_jobs SET next_attempt_at = transaction_timestamp() WHERE id = $1', [smoke.emailJob.id]);
    await emailDelivery.processJob(smoke.emailJob.id, { providerSmoke: true });
    assert.equal(calls.length, 1, 'a reconciled job must never send again');
  });

  await t.test('ambiguous retries reuse one key inside 23 hours and block before it expires', async () => {
    const retrySmoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'fr',
    });
    const keys = [];
    let loseResponse = true;
    resend.setAdapterForTests({
      async send(payload, options) {
        keys.push(options.idempotencyKey);
        if (loseResponse) throw new TypeError('simulated response loss');
        return { data: { id: 'resend-safe-retry' }, error: null };
      },
    });
    let job = await emailDelivery.processJob(retrySmoke.emailJob.id, { providerSmoke: true });
    assert.equal(job.delivery_ambiguous, true);
    await hosted.query('UPDATE email_jobs SET next_attempt_at = transaction_timestamp() WHERE id = $1', [job.id]);
    loseResponse = false;
    job = await emailDelivery.processJob(job.id, { providerSmoke: true });
    assert.equal(job.status, 'sent');
    assert.deepEqual(keys, [retrySmoke.emailJob.dedupe_key, retrySmoke.emailJob.dedupe_key]);

    const expiredSmoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'de',
    });
    loseResponse = true;
    let expired = await emailDelivery.processJob(expiredSmoke.emailJob.id, { providerSmoke: true });
    const callsBeforeBoundary = keys.length;
    await hosted.query(`
      UPDATE email_jobs
      SET first_send_attempt_at = transaction_timestamp() - interval '23 hours 1 minute',
          next_attempt_at = transaction_timestamp()
      WHERE id = $1
    `, [expired.id]);
    expired = await emailDelivery.processJob(expired.id, { providerSmoke: true });
    assert.equal(expired.status, 'blocked');
    assert.equal(expired.last_error, 'delivery_outcome_unknown');
    assert.equal(keys.length, callsBeforeBoundary, 'no provider request is allowed after the 23-hour boundary');
  });

  await t.test('expired leases recover and stale owners cannot overwrite a successful retry', async () => {
    const smoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'it',
    });
    const first = await db.claimEmailJob({ jobId: smoke.emailJob.id, lockedBy: 'email-worker-a', leaseMs: 15_000 });
    await hosted.query(`
      UPDATE email_jobs SET locked_until = transaction_timestamp() - interval '1 second' WHERE id = $1
    `, [smoke.emailJob.id]);
    const second = await db.claimEmailJob({ jobId: smoke.emailJob.id, lockedBy: 'email-worker-b', leaseMs: 15_000 });
    assert.equal(Number(second.lease_version), Number(first.lease_version) + 1);
    const stale = await db.completeMockEmail(smoke.emailJob.id, {
      lockedBy: first.locked_by, leaseVersion: Number(first.lease_version),
    });
    assert.equal(stale, null);
    const current = await db.completeMockEmail(smoke.emailJob.id, {
      lockedBy: second.locked_by, leaseVersion: Number(second.lease_version),
    });
    assert.equal(current.status, 'delivered');
  });

  await t.test('shipment, refund and cancellation notices deduplicate and always address the buyer', async () => {
    const prepared = await createPreparedOrder(db, event, 'notices', { mode: 'live' });
    const paid = await payPreparedOrder(db, prepared, 'notices', {
      mode: 'live', buyerEmail: 'buyer-notices@example.test',
    });
    const shipment = (await db.getOrderShipments(prepared.order.id))[0];
    await hosted.query(`
      UPDATE checkout_order_shipments
      SET fulfillment_payload_json = $1::jsonb, printful_order_id = 'pf-phase6',
          fulfillment_status = 'submitted', fulfillment_mode = 'live'
      WHERE id = $2
    `, [JSON.stringify({ external_id: 'ww_phase6_notice' }), shipment.id]);
    const shipmentEvent = {
      eventKey: crypto.createHash('sha256').update('phase6-shipment').digest('hex'),
      eventType: 'shipment_sent', providerOrderId: 'pf-phase6',
      externalOrderId: 'ww_phase6_notice', providerShipmentId: 'shipment-6001',
      providerStatus: 'shipped', carrier: 'DHL', trackingNumber: 'TRACK-6001',
      trackingUrl: 'https://tracking.example.test/TRACK-6001',
      shippedAt: '2026-08-27T12:00:00Z',
    };
    const recorded = await db.recordPrintfulWebhook(shipmentEvent);
    assert.equal(recorded.emailJobCreated, true);
    assert.equal(recorded.emailJob.kind, 'shipment_confirmation');
    assert.equal(recorded.emailJob.recipient_email, paid.order.buyer_email);
    assert.match(recorded.emailJob.text_body, /TRACK-6001/);
    assert.equal((await db.recordPrintfulWebhook(shipmentEvent)).duplicate, true);

    const storedShipment = (await db.getOrderShipments(prepared.order.id))[0];
    assert.equal(Object.hasOwn(JSON.parse(storedShipment.recipient_json), 'email'), false);

    const refund = await db.recordStripeRefund({
      stripeEventId: 'evt_phase6_refund', eventType: 'charge.refunded',
      paymentIntentId: 'pi_phase6_notices', livemode: true,
      amountRefunded: prepared.order.total_cents, currency: prepared.order.currency,
    });
    assert.equal(refund.emailJob.kind, 'refund_confirmation');
    assert.equal(refund.emailJob.recipient_email, paid.order.buyer_email);
    assert.equal((await db.recordStripeRefund({
      stripeEventId: 'evt_phase6_refund', eventType: 'charge.refunded',
      paymentIntentId: 'pi_phase6_notices', livemode: true,
      amountRefunded: prepared.order.total_cents, currency: prepared.order.currency,
    })).duplicate, true);

    const canceled = await db.recordPrintfulWebhook({
      ...shipmentEvent,
      eventKey: crypto.createHash('sha256').update('phase6-cancel').digest('hex'),
      eventType: 'order_canceled', providerStatus: 'canceled',
    });
    assert.equal(canceled.emailJob.kind, 'cancellation_confirmation');
    assert.equal(canceled.emailJob.recipient_email, paid.order.buyer_email);
    const notices = await db.getEmailJobsForOrder(prepared.order.id);
    assert.deepEqual(notices.map((job) => job.kind), [
      'order_confirmation', 'shipment_confirmation', 'refund_confirmation', 'cancellation_confirmation',
    ]);
  });

  await t.test('signed terminal events never move backward and unsigned events change nothing', async () => {
    const smoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'es',
    });
    await hosted.query(`
      UPDATE email_jobs SET status = 'sent', provider_message_id = 'resend-terminal-test',
        sent_at = transaction_timestamp()
      WHERE id = $1
    `, [smoke.emailJob.id]);
    const eventBody = (type, svixId) => {
      const body = JSON.stringify({
        type, created_at: new Date().toISOString(),
        data: {
          email_id: 'resend-terminal-test', created_at: new Date().toISOString(),
          from: process.env.RESEND_FROM_EMAIL, to: ['maintainer@example.test'],
          subject: smoke.emailJob.subject, tags: { email_job_id: String(smoke.emailJob.id) },
        },
      });
      return { body, headers: signedResendHeaders(webhookSecret, svixId, body) };
    };
    const bounced = eventBody('email.bounced', 'msg_phase6_bounced');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: bounced.headers, body: bounced.body,
    })).status, 200);
    const deliveredLate = eventBody('email.delivered', 'msg_phase6_delivered_late');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: deliveredLate.headers, body: deliveredLate.body,
    })).status, 200);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).status, 'bounced');

    const complained = eventBody('email.complained', 'msg_phase6_complained');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: complained.headers, body: complained.body,
    })).status, 200);
    const sentLate = eventBody('email.sent', 'msg_phase6_sent_late');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: sentLate.headers, body: sentLate.body,
    })).status, 200);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).status, 'complained');

    const invalid = await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: {
        ...sentLate.headers,
        'svix-id': 'msg_phase6_invalid',
        'svix-signature': 'v1,invalid',
      }, body: sentLate.body,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).status, 'complained');
  });
});
