'use strict';

/**
 * Stripe-hosted Checkout for trusted, server-side EUR quotes.
 *
 * This phase is intentionally test-only. A live secret key is rejected
 * unless STRIPE_ALLOW_LIVE_PAYMENTS=true is set explicitly in a later,
 * reviewed production phase. No static Stripe Price is needed: every
 * Checkout Session gets the revalidated order total as integer cents.
 */

let stripeClient = null;
let stripeClientKey = null;

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function isLiveModeAllowed() {
  return String(process.env.STRIPE_ALLOW_LIVE_PAYMENTS || '').toLowerCase() === 'true';
}

function getCheckoutMode() {
  const key = String(process.env.STRIPE_SECRET_KEY || '');
  assertSafeKey(key);
  return key.startsWith('sk_live_') ? 'live' : 'test';
}

function assertSafeKey(key) {
  if (String(key).startsWith('sk_live_') && !isLiveModeAllowed()) {
    const error = new Error(
      'Ein Stripe-Live-Key ist gesetzt, Live-Zahlungen sind für diese Testphase aber gesperrt.'
    );
    error.code = 'STRIPE_LIVE_MODE_BLOCKED';
    throw error;
  }
}

function getClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  assertSafeKey(key);
  if (!stripeClient || stripeClientKey !== key) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(key);
    stripeClientKey = key;
  }
  return stripeClient;
}

function notConfiguredError() {
  const error = new Error(
    'Stripe ist noch nicht eingerichtet. Bitte STRIPE_SECRET_KEY in .env ergänzen.'
  );
  error.code = 'STRIPE_NOT_CONFIGURED';
  return error;
}

/**
 * Create a Stripe-hosted Checkout Session from an already persisted order.
 * The browser never supplies the amount.
 */
async function createCheckoutSession({
  order,
  product,
  slug,
  configurationId,
  quoteId,
  quantity,
  baseUrl,
}) {
  const client = getClient();
  if (!client) throw notConfiguredError();

  const totalCents = Number(order?.total_cents);
  const currency = String(order?.currency || '').toLowerCase();
  if (!Number.isSafeInteger(totalCents) || totalCents < 50 || currency !== 'eur') {
    const error = new Error('Der gespeicherte Checkout-Preis ist ungültig.');
    error.code = 'STRIPE_INVALID_AMOUNT';
    throw error;
  }

  const encodedSlug = encodeURIComponent(slug);
  const encodedConfiguration = encodeURIComponent(configurationId);
  const checkoutMode = order.mode === 'live' ? 'live' : 'test';
  const metadata = {
    eventSlug: slug,
    configurationId,
    quoteId,
    orderId: String(order.id),
    checkoutMode,
  };
  const unitLabel = quantity === 1 ? product.unit.singular : product.unit.plural;
  const quantityLabel = `${quantity} ${unitLabel} · ${product.size.label}`;

  const session = await client.checkout.sessions.create({
    mode: 'payment',
    locale: 'de',
    payment_method_types: ['card'],
    client_reference_id: String(order.id),
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: totalCents,
        product_data: {
          name: quantityLabel,
          description: `${product.name} mit persönlichem Design inklusive Standardversand`,
          metadata: { productKey: product.key, configurationId },
        },
      },
    }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${baseUrl}/e/${encodedSlug}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/e/${encodedSlug}/shipping?configuration=${encodedConfiguration}` +
      `&quote=${encodeURIComponent(quoteId)}&checkout=cancelled`,
  }, {
    idempotencyKey: `weddingcloud-${checkoutMode}-order-${order.id}`,
  });

  return { url: session.url, id: session.id };
}

/** Verify and parse the exact raw Stripe webhook bytes. */
function constructWebhookEvent(rawBody, signatureHeader) {
  const client = getClient();
  if (!client) throw notConfiguredError();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    const error = new Error('STRIPE_WEBHOOK_SECRET ist nicht gesetzt.');
    error.code = 'STRIPE_WEBHOOK_SECRET_MISSING';
    throw error;
  }
  return client.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

module.exports = {
  isConfigured,
  isLiveModeAllowed,
  getCheckoutMode,
  createCheckoutSession,
  constructWebhookEvent,
};
