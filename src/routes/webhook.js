'use strict';

const express = require('express');
const db = require('../db');
const stripeIntegration = require('../stripe');
const printful = require('../printful');
const { getBaseUrl } = require('../baseUrl');

// Mounted with express.raw() (see server.js) — Stripe signature verification
// requires the exact raw request bytes, not Express's re-serialized JSON.
//
// `port` is only used as getBaseUrl()'s local-dev fallback (LAN IP) when
// neither PUBLIC_URL nor a non-local Host header is available — same
// pattern as routes/events.js.
function makeWebhookRouter({ port } = {}) {
  const router = express.Router();

  router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = stripeIntegration.constructWebhookEvent(req.body, req.get('stripe-signature'));
    } catch (err) {
      if (err.code === 'STRIPE_NOT_CONFIGURED' || err.code === 'STRIPE_WEBHOOK_SECRET_MISSING') {
        console.warn('[webhook:stripe]', err.message);
        return res.status(501).send('stripe not configured');
      }
      console.warn('[webhook:stripe] signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const slug = session.metadata && session.metadata.eventSlug;
      const eventRow = slug && db.getEventBySlug(slug);

      if (!eventRow) {
        console.warn(`[webhook:stripe] checkout.session.completed for unknown event slug "${slug}"`);
        return res.json({ received: true });
      }

      const shipping = session.customer_details
        ? { name: session.customer_details.name, address: session.customer_details.address }
        : session.shipping_details
        ? { name: session.shipping_details.name, address: session.shipping_details.address }
        : null;

      db.markOrderPaid(session.id, JSON.stringify(shipping));

      try {
        // A fetchable URL, not inline SVG markup — Printful's order API
        // fetches the print file itself rather than accepting it inline.
        // GET /e/:slug/export.svg (server.js) renders the current word
        // list with the same layoutWords()/buildSVG() engine on demand.
        const words = db.getWords(eventRow.id);
        const svgUrl = words.length
          ? `${getBaseUrl(req, port)}/e/${encodeURIComponent(eventRow.slug)}/export.svg`
          : null;
        const { printfulOrderId } = await printful.createPrintfulOrder({
          event: eventRow,
          svgUrl,
          shipping,
          stripeSessionId: session.id,
        });
        db.markOrderFulfilled(session.id, printfulOrderId);
      } catch (err) {
        console.error('[webhook:stripe] Printful order creation failed:', err);
        // Payment already succeeded — don't fail the webhook (Stripe would
        // retry indefinitely); this is logged for manual follow-up instead.
      }
    }

    res.json({ received: true });
  });

  return router;
}

module.exports = { makeWebhookRouter };
