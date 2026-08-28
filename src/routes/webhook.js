'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const stripeIntegration = require('../stripe');
const fulfillment = require('../fulfillment');
const emailDelivery = require('../emailDelivery');
const { asyncRoute } = require('../asyncRoute');
const log = require('../structuredLog');
const performanceProbe = require('../performanceProbe');

// Mounted before express.json() in server.js. Stripe signature verification
// requires the exact raw bytes, so this route owns its raw body parser.
function makeWebhookRouter() {
  const router = express.Router();

  router.post('/resend', express.raw({ type: 'application/json', limit: '256kb' }), asyncRoute(async (req, res) => {
    let event;
    try {
      event = resendIntegration().verifyWebhook(req.body, {
        id: req.get('svix-id'),
        timestamp: req.get('svix-timestamp'),
        signature: req.get('svix-signature'),
      });
    } catch (error) {
      if (error.code === 'RESEND_WEBHOOK_NOT_CONFIGURED') {
        return res.status(501).send('resend webhook not configured');
      }
      performanceProbe.recordOperation('webhookFailed');
      log.warn('resend_webhook_rejected', { errorCode: 'signature_verification_failed' });
      return res.status(400).send('invalid webhook signature');
    }
    const supported = new Set([
      'email.sent', 'email.delivered', 'email.bounced', 'email.failed', 'email.complained',
    ]);
    if (!event || !supported.has(event.type) || !event.data) {
      return res.json({ received: true, ignored: 'unsupported_event' });
    }
    const result = await db.recordResendWebhook({
      svixId: req.get('svix-id'),
      eventType: event.type,
      eventCreatedAt: event.created_at || event.data.created_at || null,
      providerMessageId: event.data.email_id == null ? null : String(event.data.email_id),
      emailJobTag: event.data.tags?.email_job_id,
    });
    if (result.job && ['email.bounced', 'email.failed', 'email.complained'].includes(event.type)) {
      log.error('email_provider_failure_recorded', {
        jobId: result.job.id,
        outcome: result.job.status,
        errorCode: 'provider_delivery_failed',
      });
    }
    return res.json({ received: true, duplicate: result.duplicate, matched: result.matched });
  }));

  router.post('/printful', express.raw({ type: 'application/json', limit: '256kb' }), asyncRoute(async (req, res) => {
    let signatureValid;
    try {
      signatureValid = printfulIntegration().verifyWebhook(req.body, {
        signature: req.get('x-pf-webhook-signature'),
        publicKey: req.get('x-pf-webhook-public-key'),
      });
    } catch (error) {
      if (error.code === 'PRINTFUL_WEBHOOK_NOT_CONFIGURED') {
        return res.status(501).send('printful webhook not configured');
      }
      performanceProbe.recordOperation('webhookFailed');
      log.error('printful_webhook_unavailable', {
        errorCode: log.errorCode(error, 'webhook_configuration_invalid'),
      });
      return res.status(500).send('printful webhook unavailable');
    }
    if (!signatureValid) return res.status(400).send('invalid webhook signature');

    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('invalid webhook'); }
    const supported = new Set([
      'order_created', 'order_updated', 'order_failed', 'order_canceled',
      'shipment_sent', 'shipment_returned',
    ]);
    if (!event || !supported.has(event.type) || !event.data?.order) {
      return res.json({ received: true, ignored: 'unsupported_event' });
    }
    if (process.env.PRINTFUL_STORE_ID &&
        String(event.store_id) !== String(process.env.PRINTFUL_STORE_ID)) {
      return res.status(400).send('invalid webhook store');
    }
    const order = event.data.order;
    const shipment = event.data.shipment || {};
    const stableIdentity = JSON.stringify([
      event.type,
      event.store_id,
      order.id,
      order.external_id,
      shipment.id || null,
      event.occurred_at,
      shipment.status || order.status || null,
    ]);
    const result = await db.recordPrintfulWebhook({
      eventKey: crypto.createHash('sha256').update(stableIdentity).digest('hex'),
      eventType: event.type,
      providerOrderId: order.id == null ? null : String(order.id),
      externalOrderId: order.external_id == null ? null : String(order.external_id),
      providerShipmentId: shipment.id == null ? null : String(shipment.id),
      providerStatus: shipment.status || order.status || event.type,
      carrier: inferredCarrier(shipment),
      trackingNumber: String(shipment.tracking_number || '').slice(0, 200) || null,
      trackingUrl: normalizedTrackingUrl(shipment.tracking_url),
      shippedAt: shipment.shipped_at || null,
      deliveredAt: shipment.delivered_at || null,
    });
    if (result.emailJob?.id && result.emailJob.status === 'pending') {
      emailDelivery.scheduleJob(result.emailJob.id);
    }
    return res.json({ received: true, duplicate: result.duplicate });
  }));

  router.post('/stripe', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
    let event;
    try {
      event = stripeIntegration.constructWebhookEvent(req.body, req.get('stripe-signature'));
    } catch (error) {
      if (error.code === 'STRIPE_NOT_CONFIGURED' ||
          error.code === 'STRIPE_WEBHOOK_SECRET_MISSING' ||
          error.code === 'STRIPE_CONFIG_INVALID' ||
          error.code === 'STRIPE_LIVE_MODE_BLOCKED') {
        log.warn('stripe_webhook_unconfigured', {
          errorCode: log.errorCode(error, 'stripe_not_configured'),
        });
        return res.status(501).send('stripe not configured');
      }
      performanceProbe.recordOperation('webhookFailed');
      log.warn('stripe_webhook_rejected', { errorCode: 'signature_verification_failed' });
      return res.status(400).send('Webhook Error: signature verification failed');
    }

    // Hard safety switch: even a correctly signed live event cannot transition
    // an order until live payments are deliberately enabled.
    if (event.livemode && !stripeIntegration.isLiveModeAllowed()) {
      log.error('stripe_live_event_blocked', { errorCode: 'live_mode_blocked' });
      return res.json({ received: true, ignored: 'live_mode_blocked' });
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (!paymentIntentId) return res.json({ received: true, ignored: 'order_not_found' });
      try {
        const result = await db.recordStripeRefund({
          stripeEventId: event.id,
          eventType: event.type,
          paymentIntentId,
          livemode: Boolean(event.livemode),
          amountRefunded: Number(charge.amount_refunded),
          currency: charge.currency,
        });
        if (result.emailJob?.id && result.emailJob.status === 'pending') {
          emailDelivery.scheduleJob(result.emailJob.id);
        }
        return res.json({ received: true, duplicate: result.duplicate, matched: result.matched });
      } catch (error) {
        performanceProbe.recordOperation('webhookFailed');
        log.error('stripe_refund_persist_failed', {
          errorCode: log.errorCode(error, 'refund_persist_failed'),
        });
        return res.status(500).send('could not persist refund');
      }
    }

    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      return res.json({ received: true });
    }

    const session = event.data.object;
    const metadata = session.metadata || {};
    let order = await db.getOrderBySessionId(session.id);
    // Stripe may have accepted the idempotent create while the process died
    // before persisting the Session id. Signed metadata can locate the one
    // frozen candidate, but it still has to pass every trusted-order check.
    if (!order && /^\d+$/.test(String(metadata.orderId || '')) && metadata.quoteId) {
      const candidate = await db.getOrderById(metadata.orderId);
      if (candidate?.quote_id === metadata.quoteId && !candidate.stripe_session_id) {
        order = candidate;
      }
    }
    if (!order) {
      log.warn('stripe_checkout_session_unknown', { errorCode: 'order_not_found' });
      return res.json({ received: true, ignored: 'order_not_found' });
    }

    const eventMode = event.livemode ? 'live' : 'test';
    const expectedConfigurationIds = db.getOrderConfigurationIds(order).join(',');
    const metadataMatches = metadata.orderId === String(order.id) &&
      metadata.quoteId === order.quote_id &&
      metadata.configurationId === order.configuration_id &&
      metadata.configurationIds === expectedConfigurationIds &&
      metadata.eventSlug === order.event_slug_snapshot &&
      metadata.checkoutMode === eventMode &&
      order.mode === eventMode;
    const amountMatches = Number(session.amount_total) === Number(order.total_cents) &&
      String(session.currency || '').toUpperCase() === order.currency;
    if (!metadataMatches || !amountMatches || session.payment_status !== 'paid') {
      log.error('stripe_checkout_session_mismatch', {
        orderId: order.id,
        errorCode: 'trusted_order_mismatch',
      });
      return res.json({ received: true, ignored: 'order_mismatch' });
    }

    try {
      const result = await db.recordSuccessfulPayment({
        stripeEventId: event.id,
        eventType: event.type,
        stripeSessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        livemode: Boolean(event.livemode),
        orderId: order.id,
        quoteId: metadata.quoteId,
        amountTotal: session.amount_total,
        currency: session.currency,
        paymentStatus: session.payment_status,
        buyerEmail: session.customer_details?.email,
      });
      if (result.order?.id) fulfillment.scheduleOrder(result.order.id);
      if (result.emailJob?.id && result.emailJob.status === 'pending') {
        emailDelivery.scheduleJob(result.emailJob.id);
      } else if (result.emailJob?.status === 'blocked') {
        log.error('email_job_blocked', {
          orderId: result.order?.id,
          errorCode: 'buyer_email_missing',
          outcome: 'blocked',
        });
      }
      if (!result.duplicate) {
        log.info('stripe_payment_recorded', {
          orderId: order.id,
          outcome: 'succeeded',
          mode: event.livemode ? 'live' : 'test',
        });
      }
      return res.json({ received: true, duplicate: result.duplicate });
    } catch (error) {
      performanceProbe.recordOperation('webhookFailed');
      log.error('stripe_payment_persist_failed', {
        orderId: order.id,
        errorCode: log.errorCode(error, 'payment_persist_failed'),
      });
      // A temporary database error should be retried by Stripe.
      return res.status(500).send('could not persist payment');
    }
  }));

  return router;
}

function printfulIntegration() {
  // Lazy load keeps Stripe-only test stubs independent from Printful env state.
  return require('../printful');
}

function resendIntegration() {
  return require('../resend');
}

function normalizedTrackingUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

function inferredCarrier(shipment) {
  const explicit = String(shipment?.carrier || shipment?.service || '').trim();
  if (explicit) return explicit.slice(0, 120);
  const trackingUrl = normalizedTrackingUrl(shipment?.tracking_url);
  if (!trackingUrl) return null;
  try { return new URL(trackingUrl).hostname.replace(/^www\./, '').slice(0, 120); } catch { return null; }
}

module.exports = { makeWebhookRouter };
