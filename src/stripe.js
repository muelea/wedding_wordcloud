'use strict';

const I18n = require('./i18n');
const performanceProbe = require('./performanceProbe');

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

function freezeProduct(product) {
  if (!product) return null;
  return {
    key: String(product.key || ''),
    name: String(product.name || ''),
    unit: {
      singular: String(product.unit?.singular || 'Produkt'),
      plural: String(product.unit?.plural || 'Produkte'),
    },
    size: { label: String(product.size?.label || '') },
  };
}

/**
 * Persist only the deterministic, non-secret inputs used to construct a
 * Stripe Session. A retry after an ambiguous provider response must use this
 * exact snapshot together with the original idempotency key.
 */
function freezeCheckoutRequest({
  product = null,
  products = null,
  slug,
  configurationId = null,
  configurationIds = null,
  quoteId,
  quantity,
  shipmentCount = 1,
  baseUrl,
  locale = I18n.DEFAULT_LOCALE,
}) {
  const frozenProducts = (Array.isArray(products) && products.length ? products : [product])
    .map(freezeProduct)
    .filter(Boolean);
  const ids = (Array.isArray(configurationIds) && configurationIds.length
    ? configurationIds
    : [configurationId]).filter(Boolean).map(String);
  return {
    products: frozenProducts,
    slug: String(slug || ''),
    configurationIds: ids,
    quoteId: String(quoteId || ''),
    quantity: Number(quantity),
    shipmentCount: Number(shipmentCount),
    baseUrl: String(baseUrl || ''),
    locale: I18n.normalizeLocale(locale),
  };
}

/**
 * Create a Stripe-hosted Checkout Session from an already persisted order.
 * The browser never supplies the amount.
 */
async function createCheckoutSession({
  order,
  product,
  products = null,
  slug,
  configurationId,
  configurationIds = null,
  quoteId,
  quantity,
  shipmentCount = 1,
  baseUrl,
  locale = I18n.DEFAULT_LOCALE,
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
  const cartConfigurationIds = Array.isArray(configurationIds) && configurationIds.length
    ? configurationIds.map((id) => String(id))
    : configurationId ? [String(configurationId)] : [];
  const encodedConfiguration = encodeURIComponent(cartConfigurationIds[0] || configurationId);
  const checkoutMode = order.mode === 'live' ? 'live' : 'test';
  const metadata = {
    eventSlug: slug,
    configurationId: cartConfigurationIds[0] || configurationId || '',
    configurationIds: cartConfigurationIds.join(','),
    quoteId,
    orderId: String(order.id),
    checkoutMode,
  };
  const cartProducts = Array.isArray(products) && products.length ? products : product ? [product] : [];
  const singleProduct = cartProducts.length === 1 ? cartProducts[0] : null;
  const checkoutLocale = I18n.normalizeLocale(locale);
  const unitLabel = singleProduct
    ? I18n.translate(quantity === 1 ? singleProduct.unit.singular : singleProduct.unit.plural, checkoutLocale)
    : I18n.translate(quantity === 1 ? 'Produkt' : 'Produkte', checkoutLocale);
  const shipmentLabel = shipmentCount > 1
    ? ` · ${shipmentCount} ${I18n.translate('Lieferadressen', checkoutLocale)}`
    : '';
  const quantityLabel = singleProduct
    ? `${quantity} ${unitLabel}${shipmentLabel} · ${I18n.translate(singleProduct.size.label, checkoutLocale)}`
    : `${I18n.translate('Wolkenworte Bestellung', checkoutLocale)} · ${quantity} ${unitLabel}${shipmentLabel}`;
  const description = singleProduct
    ? I18n.translate('{{product}} mit persönlichem Design inklusive Standardversand', checkoutLocale, {
        product: I18n.translate(singleProduct.name, checkoutLocale),
      })
    : I18n.translate('{{count}} persönliche Designs inklusive Standardversand', checkoutLocale, {
        count: cartProducts.length,
      });
  const cancelUrl = cartConfigurationIds.length > 1
    ? `${baseUrl}/e/${encodedSlug}/shipping?configurations=${encodeURIComponent(cartConfigurationIds.join(','))}` +
      `&quote=${encodeURIComponent(quoteId)}&checkout=cancelled`
    : `${baseUrl}/e/${encodedSlug}/shipping?configuration=${encodedConfiguration}` +
      `&quote=${encodeURIComponent(quoteId)}&checkout=cancelled`;

  const expiresAt = Math.floor(Date.parse(order?.checkout_session_expires_at || '') / 1000);
  if (!Number.isSafeInteger(expiresAt)) {
    const error = new Error('Die gespeicherte Stripe-Ablaufzeit ist ungültig.');
    error.code = 'STRIPE_INVALID_CHECKOUT_REQUEST';
    throw error;
  }
  const idempotencyKey = String(order?.stripe_idempotency_key || '');
  if (!idempotencyKey) {
    const error = new Error('Der gespeicherte Stripe-Idempotenzschlüssel fehlt.');
    error.code = 'STRIPE_INVALID_CHECKOUT_REQUEST';
    throw error;
  }

  const startedAt = Date.now();
  let session;
  try {
    session = await client.checkout.sessions.create({
      mode: 'payment',
      locale: checkoutLocale,
      payment_method_types: ['card'],
      client_reference_id: String(order.id),
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: totalCents,
          product_data: {
            name: quantityLabel,
            description,
            metadata: {
              productKey: singleProduct?.key || 'mixed',
              configurationId: cartConfigurationIds[0] || configurationId || '',
              configurationIds: cartConfigurationIds.join(','),
            },
          },
        },
      }],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${baseUrl}/e/${encodedSlug}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      expires_at: expiresAt,
    }, {
      idempotencyKey,
    });
  } catch (error) {
    performanceProbe.recordExternalCall('stripe', {
      durationMs: Date.now() - startedAt, succeeded: false,
    });
    throw error;
  }
  performanceProbe.recordExternalCall('stripe', {
    durationMs: Date.now() - startedAt, succeeded: true,
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
  freezeCheckoutRequest,
  createCheckoutSession,
  constructWebhookEvent,
};
