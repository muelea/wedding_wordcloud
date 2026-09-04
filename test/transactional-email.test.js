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
  const sessionId = `cs_email_${suffix}`;
  await db.attachStripeSession(order.id, { id: sessionId, url: `https://checkout.test/${suffix}` });
  return { order: await db.getOrderById(order.id), configuration, quote, sessionId };
}

async function payPreparedOrder(db, prepared, suffix, { mode = 'test', buyerEmail = 'buyer@example.test' } = {}) {
  return db.recordSuccessfulPayment({
    stripeEventId: `evt_email_${suffix}`,
    eventType: 'checkout.session.completed',
    stripeSessionId: prepared.sessionId,
    paymentIntentId: `pi_email_${suffix}`,
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

test('buyer contact, durable email jobs and provider reconciliation', async (t) => {
  const previous = {};
  for (const name of [
    'EMAIL_DELIVERY_MODE', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL',
    'RESEND_WEBHOOK_SECRET', 'RESEND_SMOKE_RECIPIENTS', 'STRIPE_LIVE_PAYMENTS_ENABLED',
  ]) previous[name] = process.env[name];
  process.env.EMAIL_DELIVERY_MODE = 'mock';
  process.env.STRIPE_LIVE_PAYMENTS_ENABLED = 'false';
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
    title: 'E-Mail Emma & Nachricht Noah', locale: 'de',
  });
  const event = await db.getEventBySlug(eventPublic.slug);

  await t.test('payment snapshots one confirmation and automated tests never call Resend', async () => {
    const prepared = await createPreparedOrder(db, event, 'atomic');
    const paid = await payPreparedOrder(db, prepared, 'atomic', {
      buyerEmail: '  BUYER@Example.Test  ',
    });
    assert.equal(paid.order.buyer_email, 'buyer@example.test');
    assert.equal(paid.emailJobCreated, true);
    assert.equal(paid.emailJob.status, 'pending');
    assert.equal(paid.emailJob.recipient_email, 'buyer@example.test');
    assert.match(paid.emailJob.subject, /WW-\d{8}/);
    assert.match(paid.emailJob.subject, /^\[TEST\]/);
    assert.match(paid.emailJob.text_body, /kein echtes Geld abgebucht/);
    assert.match(paid.emailJob.html_body, /kein Produktionsauftrag ausgelöst/);
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
    process.env.RESEND_API_KEY = 're_email_fake';
    process.env.RESEND_FROM_EMAIL = 'Wolkenworte <bestellung@mail.example.test>';
    const delivered = await emailDelivery.processJob(paid.emailJob.id);
    assert.equal(delivered.status, 'delivered');
    assert.match(delivered.provider_message_id, /^mock-/);
    assert.equal(providerCalls, 0, 'an automated test must never contact Resend');
  });

  await t.test('manual sandbox purchases send one real-provider confirmation while fulfillment stays mocked', async () => {
    const prepared = await createPreparedOrder(db, event, 'sandbox-real-email');
    const paid = await payPreparedOrder(db, prepared, 'sandbox-real-email');
    const calls = [];
    resend.setAdapterForTests({ async send(payload, options) {
      calls.push({ payload, options });
      return { data: { id: 'resend-manual-sandbox-confirmation' } };
    } });
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_DELIVERY_MODE = 'live';
    try {
      assert.equal(emailDelivery.resolveMode({ mode: 'test', status: 'checkout_pending' }, paid.emailJob), 'mock');
      const sent = await emailDelivery.processJob(paid.emailJob.id);
      assert.equal(sent.status, 'sent');
      assert.equal(sent.provider_message_id, 'resend-manual-sandbox-confirmation');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].payload.to, ['buyer@example.test']);
      assert.match(calls[0].payload.subject, /^\[TEST\]/);
      assert.equal(calls[0].payload.replyTo, 'kontakt@jusa.io');
      assert.equal(calls[0].options.idempotencyKey, paid.emailJob.dedupe_key);
      await emailDelivery.processJob(paid.emailJob.id);
      assert.equal(calls.length, 1, 'already accepted confirmations cannot send twice');
      const fulfilled = await fulfillment.processOrder(prepared.order.id);
      assert.equal(fulfilled.fulfillment_status, 'mocked');
      assert.equal((await db.getOrderById(prepared.order.id)).status, 'paid_test');

      process.env.EMAIL_DELIVERY_MODE = 'mock';
      assert.equal(emailDelivery.resolveMode(paid.order, paid.emailJob), 'mock');
      process.env.EMAIL_DELIVERY_MODE = 'live';
      const previousKey = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      try {
        assert.throws(() => emailDelivery.resolveMode(paid.order, paid.emailJob),
          (error) => error.code === 'resend_not_configured');
      } finally { process.env.RESEND_API_KEY = previousKey; }
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      resend.resetAdapterForTests();
    }
  });

  await t.test('sandbox notices are translated and genuine live orders retain ordinary subjects', () => {
    const { buildEmailSnapshot } = require('../src/emailTemplates');
    const notices = {
      de: 'Testbestellung', en: 'test order', fr: 'commande de test',
      it: 'ordine di prova', es: 'pedido de prueba', tr: 'test siparişidir',
    };
    for (const [locale, notice] of Object.entries(notices)) {
      const order = { id: 42, mode: 'test', status: 'paid_test', currency: 'EUR' };
      const snapshot = buildEmailSnapshot({ kind: 'order_confirmation', order, locale });
      assert.match(snapshot.subject, /^\[TEST\]/);
      assert.ok(snapshot.textBody.includes(notice));
      assert.ok(snapshot.htmlBody.includes(notice));
      const live = buildEmailSnapshot({ kind: 'order_confirmation', locale,
        order: { ...order, mode: 'live', status: 'paid' } });
      assert.doesNotMatch(live.subject, /\[TEST\]/);
      assert.ok(!live.textBody.includes(notice));
    }
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
  process.env.RESEND_API_KEY = 're_email_fake';
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
    assert.equal(calls[0].payload.replyTo, 'kontakt@jusa.io');
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
        headers: signedResendHeaders(webhookSecret, 'msg_email_lost_response', body),
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

  await t.test('a crash after provider acceptance preserves the retry boundary across poll and startup recovery', async () => {
    for (const recoverOnStartup of [false, true]) {
      const smoke = await db.createEmailSmokeJob({ recipientEmail: 'maintainer@example.test' });
      const first = await db.claimEmailJob({
        jobId: smoke.emailJob.id, lockedBy: 'crashed-email-worker', leaseMs: 15_000,
        providerSmoke: true,
      });
      const attempted = await db.beginEmailProviderAttempt(first.id, {
        lockedBy: first.locked_by, leaseVersion: Number(first.lease_version),
      });
      assert.equal(attempted.delivery_ambiguous, true, 'uncertainty must be durable before sending');
      let sends = 0;
      resend.setAdapterForTests({
        async send() { sends += 1; return { data: { id: `accepted-before-crash-${first.id}` } }; },
      });
      await resend.sendEmail(attempted);
      // The process disappears here: no acceptance commit and no catch handler.
      await hosted.query(`
        UPDATE email_jobs SET first_send_attempt_at = transaction_timestamp() - interval '25 hours',
          locked_until = transaction_timestamp() - interval '1 second'
        WHERE id = $1
      `, [first.id]);
      if (recoverOnStartup) await db.recoverStaleEmailJobs();
      const result = await emailDelivery.processJob(first.id, { providerSmoke: true });
      assert.equal(result.status, 'blocked');
      assert.equal(result.last_error, 'delivery_outcome_unknown');
      assert.equal(sends, 1, 'an unresolved accepted send must not be repeated outside the window');
    }
  });

  await t.test('a definitive rejection clears only its own uncertainty, never an earlier lost response', async () => {
    const smoke = await db.createEmailSmokeJob({ recipientEmail: 'maintainer@example.test' });
    let loseResponse = false;
    resend.setAdapterForTests({
      async send() {
        if (loseResponse) throw new TypeError('response lost');
        return { error: { name: 'rate_limit_exceeded', statusCode: 429 } };
      },
    });
    let result = await emailDelivery.processJob(smoke.emailJob.id, { providerSmoke: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.delivery_ambiguous, false, 'a rejected first send has no uncertain outcome');
    loseResponse = true;
    result = await emailDelivery.processJob(smoke.emailJob.id, { providerSmoke: true });
    assert.equal(result.delivery_ambiguous, true);
    loseResponse = false;
    result = await emailDelivery.processJob(smoke.emailJob.id, { providerSmoke: true });
    assert.equal(result.delivery_ambiguous, true, 'a later 429 does not settle an earlier accepted send');
  });

  await t.test('expired leases recover and stale owners cannot overwrite a successful retry', async () => {
    const smoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'it',
    });
    const routineClaim = await db.claimEmailJob({
      jobId: smoke.emailJob.id, lockedBy: 'routine-email-worker', leaseMs: 15_000,
    });
    assert.equal(routineClaim, null, 'routine workers must never claim provider-smoke jobs');
    const first = await db.claimEmailJob({
      jobId: smoke.emailJob.id, lockedBy: 'email-worker-a', leaseMs: 15_000,
      providerSmoke: true,
    });
    await hosted.query(`
      UPDATE email_jobs SET locked_until = transaction_timestamp() - interval '1 second' WHERE id = $1
    `, [smoke.emailJob.id]);
    const second = await db.claimEmailJob({
      jobId: smoke.emailJob.id, lockedBy: 'email-worker-b', leaseMs: 15_000,
      providerSmoke: true,
    });
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
      SET fulfillment_payload_json = $1::jsonb, printful_order_id = 'pf-email',
          fulfillment_status = 'submitted', fulfillment_mode = 'live'
      WHERE id = $2
    `, [JSON.stringify({ external_id: 'ww_email_notice' }), shipment.id]);
    const shipmentEvent = {
      eventKey: crypto.createHash('sha256').update('email-shipment').digest('hex'),
      eventType: 'shipment_sent', providerOrderId: 'pf-email',
      externalOrderId: 'ww_email_notice', providerShipmentId: 'shipment-6001',
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

    const firstRefundCents = 1000;
    const firstRefund = await db.recordStripeRefund({
      stripeEventId: 'evt_email_refund_partial', eventType: 'charge.refunded',
      paymentIntentId: 'pi_email_notices', livemode: true,
      amountRefunded: firstRefundCents, currency: prepared.order.currency,
    });
    assert.equal(firstRefund.emailJob.kind, 'refund_confirmation');
    assert.equal(firstRefund.emailJob.recipient_email, paid.order.buyer_email);
    assert.match(firstRefund.emailJob.text_body, /10,00\s*€/);
    assert.equal((await db.recordStripeRefund({
      stripeEventId: 'evt_email_refund_partial', eventType: 'charge.refunded',
      paymentIntentId: 'pi_email_notices', livemode: true,
      amountRefunded: firstRefundCents, currency: prepared.order.currency,
    })).duplicate, true);

    const finalRefund = await db.recordStripeRefund({
      stripeEventId: 'evt_email_refund_final', eventType: 'charge.refunded',
      paymentIntentId: 'pi_email_notices', livemode: true,
      amountRefunded: prepared.order.total_cents, currency: prepared.order.currency,
    });
    assert.equal(finalRefund.emailJob.kind, 'refund_confirmation');
    assert.notEqual(finalRefund.emailJob.dedupe_key, firstRefund.emailJob.dedupe_key);
    assert.match(finalRefund.emailJob.text_body, /19,75\s*€/);
    const staleRefund = await db.recordStripeRefund({
      stripeEventId: 'evt_email_refund_stale', eventType: 'charge.refunded',
      paymentIntentId: 'pi_email_notices', livemode: true,
      amountRefunded: firstRefundCents, currency: prepared.order.currency,
    });
    assert.equal(staleRefund.matched, true);
    assert.equal(staleRefund.emailJob, null);

    const canceled = await db.recordPrintfulWebhook({
      ...shipmentEvent,
      eventKey: crypto.createHash('sha256').update('email-cancel').digest('hex'),
      eventType: 'order_canceled', providerStatus: 'canceled',
    });
    assert.equal(canceled.emailJob.kind, 'cancellation_confirmation');
    assert.equal(canceled.emailJob.recipient_email, paid.order.buyer_email);
    const notices = await db.getEmailJobsForOrder(prepared.order.id);
    assert.deepEqual(notices.map((job) => job.kind), [
      'order_confirmation', 'shipment_confirmation', 'refund_confirmation', 'refund_confirmation',
      'cancellation_confirmation',
    ]);
  });

  await t.test('a signed suppression is a terminal provider failure with its exact reason', async () => {
    const smoke = await db.createEmailSmokeJob({
      recipientEmail: 'maintainer@example.test', locale: 'de',
    });
    await hosted.query(`
      UPDATE email_jobs SET status = 'sent', provider_message_id = 'resend-suppressed-test',
        sent_at = transaction_timestamp()
      WHERE id = $1
    `, [smoke.emailJob.id]);
    const eventBody = (type, svixId) => {
      const body = JSON.stringify({
        type, created_at: new Date().toISOString(),
        data: {
          email_id: 'resend-suppressed-test', created_at: new Date().toISOString(),
          from: process.env.RESEND_FROM_EMAIL, to: ['maintainer@example.test'],
          subject: smoke.emailJob.subject, tags: { email_job_id: String(smoke.emailJob.id) },
        },
      });
      return { body, headers: signedResendHeaders(webhookSecret, svixId, body) };
    };
    const suppressed = eventBody('email.suppressed', 'msg_email_suppressed');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: suppressed.headers, body: suppressed.body,
    })).status, 200);
    const stored = await db.getEmailJobById(smoke.emailJob.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.last_error, 'provider_suppressed');
    assert.equal(stored.provider_terminal, true);

    const deliveredLate = eventBody('email.delivered', 'msg_email_suppressed_delivered_late');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: deliveredLate.headers, body: deliveredLate.body,
    })).status, 200);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).last_error, 'provider_suppressed');
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
    const bounced = eventBody('email.bounced', 'msg_email_bounced');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: bounced.headers, body: bounced.body,
    })).status, 200);
    const deliveredLate = eventBody('email.delivered', 'msg_email_delivered_late');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: deliveredLate.headers, body: deliveredLate.body,
    })).status, 200);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).status, 'bounced');

    const complained = eventBody('email.complained', 'msg_email_complained');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: complained.headers, body: complained.body,
    })).status, 200);
    const sentLate = eventBody('email.sent', 'msg_email_sent_late');
    assert.equal((await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: sentLate.headers, body: sentLate.body,
    })).status, 200);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).status, 'complained');

    const invalid = await fetch(`${hosted.baseUrl}/webhook/resend`, {
      method: 'POST', headers: {
        ...sentLate.headers,
        'svix-id': 'msg_email_invalid',
        'svix-signature': 'v1,invalid',
      }, body: sentLate.body,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await db.getEmailJobById(smoke.emailJob.id)).status, 'complained');
  });
});
