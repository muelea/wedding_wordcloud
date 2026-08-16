'use strict';

/**
 * Stripe Checkout integration for the His & Hers mug-duo (34,90€, single
 * bundled product — see product scope in the project brief).
 *
 * Gated entirely on environment variables that are NOT set in this build
 * pass (no real Stripe account exists yet — that requires the business
 * owner's verified identity, which isn't done). The integration shape is
 * complete and correct; it will start working the moment real keys are
 * dropped into `.env`, with zero code changes.
 *
 * Required env vars (see .env.example):
 *   STRIPE_SECRET_KEY   - sk_test_... / sk_live_...
 *   STRIPE_PRICE_ID     - price_... for the 34,90€ mug-duo product
 *   STRIPE_WEBHOOK_SECRET - whsec_... for verifying the webhook signature
 *   PUBLIC_URL          - used to build success/cancel redirect URLs
 */

let stripeClient = null;

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

function getClient() {
  if (!isConfigured()) return null;
  if (!stripeClient) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

/**
 * Creates a Stripe Checkout Session for the mug-duo, tagged with the event
 * slug so the webhook handler knows which wedding's word cloud to print.
 *
 * @param {object} opts
 * @param {string} opts.slug - event slug, stored in session metadata
 * @param {string} opts.baseUrl - origin to build success/cancel URLs against
 * @returns {Promise<{url: string, id: string}>}
 */
async function createCheckoutSession({ slug, baseUrl }) {
  const client = getClient();
  if (!client) {
    const err = new Error(
      'Stripe is not configured yet (STRIPE_SECRET_KEY / STRIPE_PRICE_ID missing). ' +
      'This is expected until a real Stripe account exists — see README.'
    );
    err.code = 'STRIPE_NOT_CONFIGURED';
    throw err;
  }

  const session = await client.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    shipping_address_collection: { allowed_countries: ['DE', 'AT', 'CH'] },
    metadata: { eventSlug: slug },
    success_url: `${baseUrl}/e/${encodeURIComponent(slug)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/e/${encodeURIComponent(slug)}?checkout=cancelled`,
  });

  return { url: session.url, id: session.id };
}

/**
 * Verifies and parses an incoming Stripe webhook request.
 * `rawBody` must be the unparsed request body Buffer (Stripe signature
 * verification requires the exact bytes, not a re-serialized JSON object —
 * see the raw-body middleware wired up for this route in server.js).
 */
function constructWebhookEvent(rawBody, signatureHeader) {
  const client = getClient();
  if (!client) {
    const err = new Error('Stripe is not configured yet (webhook received but no secret key set).');
    err.code = 'STRIPE_NOT_CONFIGURED';
    throw err;
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    const err = new Error('STRIPE_WEBHOOK_SECRET is not set — cannot verify webhook signature.');
    err.code = 'STRIPE_WEBHOOK_SECRET_MISSING';
    throw err;
  }
  return client.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

module.exports = { isConfigured, createCheckoutSession, constructWebhookEvent };
