'use strict';

const express = require('express');
const db = require('../db');
const stripeIntegration = require('../stripe');
const fulfillment = require('../fulfillment');

// Mounted before express.json() in server.js. Stripe signature verification
// requires the exact raw bytes, so this route owns its raw body parser.
function makeWebhookRouter() {
  const router = express.Router();

  router.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    let event;
    try {
      event = stripeIntegration.constructWebhookEvent(req.body, req.get('stripe-signature'));
    } catch (error) {
      if (error.code === 'STRIPE_NOT_CONFIGURED' ||
          error.code === 'STRIPE_WEBHOOK_SECRET_MISSING' ||
          error.code === 'STRIPE_LIVE_MODE_BLOCKED') {
        console.warn('[webhook:stripe]', error.message);
        return res.status(501).send('stripe not configured');
      }
      console.warn('[webhook:stripe] signature verification failed:', error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      return res.json({ received: true });
    }

    // Hard safety switch for this phase: even a correctly signed live event
    // cannot transition an order until live payments are deliberately enabled.
    if (event.livemode && !stripeIntegration.isLiveModeAllowed()) {
      console.error(`[webhook:stripe] ignored live event ${event.id}; live payments are blocked.`);
      return res.json({ received: true, ignored: 'live_mode_blocked' });
    }

    const session = event.data.object;
    const order = db.getOrderBySessionId(session.id);
    if (!order) {
      console.warn(`[webhook:stripe] completed unknown Checkout Session ${session.id}`);
      return res.json({ received: true, ignored: 'order_not_found' });
    }

    const metadata = session.metadata || {};
    const eventMode = event.livemode ? 'live' : 'test';
    const metadataMatches = metadata.orderId === String(order.id) &&
      metadata.quoteId === order.quote_id &&
      metadata.configurationId === order.configuration_id &&
      metadata.checkoutMode === eventMode &&
      order.mode === eventMode;
    const amountMatches = Number(session.amount_total) === Number(order.total_cents) &&
      String(session.currency || '').toUpperCase() === order.currency;
    if (!metadataMatches || !amountMatches || session.payment_status !== 'paid') {
      console.error('[webhook:stripe] ignored Checkout Session with mismatched trusted order data', {
        stripeSessionId: session.id,
        metadataMatches,
        amountMatches,
        paymentStatus: session.payment_status,
      });
      return res.json({ received: true, ignored: 'order_mismatch' });
    }

    try {
      const result = db.recordSuccessfulPayment({
        stripeEventId: event.id,
        eventType: event.type,
        stripeSessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        livemode: Boolean(event.livemode),
      });
      if (result.order?.id) fulfillment.scheduleOrder(result.order.id);
      if (!result.duplicate) {
        const message = event.livemode
          ? 'Live-Zahlung gespeichert; Fulfillment wurde sicher vorgemerkt.'
          : 'Testzahlung gespeichert; Fulfillment läuft ausschließlich als lokaler Mock.';
        console.log(`[webhook:stripe] Bestellung ${order.id}: ${message}`);
      }
      return res.json({ received: true, duplicate: result.duplicate });
    } catch (error) {
      console.error('[webhook:stripe] could not persist successful payment:', error);
      // A temporary database error should be retried by Stripe.
      return res.status(500).send('could not persist payment');
    }
  });

  return router;
}

module.exports = { makeWebhookRouter };
