'use strict';

const I18n = require('./i18n');
const performanceProbe = require('./performanceProbe');
const stripeConfig = require('./stripeConfig');

/**
 * Stripe-hosted Checkout for trusted, server-side EUR quotes.
 *
 * Test and live credentials are separate. Live mode is rejected unless the
 * dedicated payment mode and live safety gate both select it. No static Stripe
 * Price is needed: every
 * Checkout Session gets the revalidated net products and shipping in cents.
 */

let stripeClient = null;
let stripeClientKey = null;

function isConfigured() {
  return Boolean(stripeConfig.configuredSecretKey());
}

function isLiveModeAllowed() {
  return stripeConfig.livePaymentsEnabled();
}

function getCheckoutMode() {
  assertSafeConfiguration();
  return stripeConfig.paymentMode();
}

function assertSafeConfiguration() {
  const errors = stripeConfig.validationErrors();
  if (errors.length) {
    const error = new Error(
      `Stripe-Konfiguration ist ungültig: ${errors.join(' ')}`
    );
    error.code = errors.some((message) => message.includes('live') || message.includes('Live'))
      ? 'STRIPE_LIVE_MODE_BLOCKED'
      : 'STRIPE_CONFIG_INVALID';
    throw error;
  }
}

function getClient() {
  assertSafeConfiguration();
  const key = stripeConfig.configuredSecretKey();
  if (!key) return null;
  if (!stripeClient || stripeClientKey !== key) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(key);
    stripeClientKey = key;
  }
  return stripeClient;
}

function notConfiguredError() {
  const error = new Error(
    'Stripe ist für den gewählten Modus nicht eingerichtet. Bitte den passenden STRIPE_TEST_*- oder STRIPE_LIVE_*-Key ergänzen.'
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
  shipments = null,
  baseUrl,
  locale = I18n.DEFAULT_LOCALE,
}) {
  const frozenProducts = (Array.isArray(products) && products.length ? products : [product])
    .map(freezeProduct)
    .filter(Boolean);
  const ids = (Array.isArray(configurationIds) && configurationIds.length
    ? configurationIds
    : [configurationId]).filter(Boolean).map(String);
  const taxInputs = {};
  if (shipments) {
    if (shipments.length !== 1) throw new Error('Stripe Tax checkout requires one delivery address');
    const shipment = shipments[0];
    const recipient = shipment.recipient;
    if (!recipient?.name || !recipient.address1 || !recipient.city || !recipient.country_code) {
      throw new Error('Stripe Tax checkout requires a validated delivery address');
    }
    taxInputs.taxMode = 'stripe';
    taxInputs.shipping = {
      name: recipient.name,
      address: {
        line1: recipient.address1, line2: recipient.address2 || '',
        city: recipient.city, postal_code: recipient.zip || '',
        state: recipient.state_code || '', country: recipient.country_code,
      },
    };
    taxInputs.basket = (shipment.items || [{ configurationId: ids[0], quantity }]).map((item) => {
      const index = ids.indexOf(String(item.configurationId));
      if (index < 0 || !frozenProducts[index] || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
        throw new Error('Stripe Tax checkout contains an invalid product');
      }
      return { configurationId: ids[index], quantity: item.quantity, product: frozenProducts[index] };
    });
    if (taxInputs.basket.reduce((sum, item) => sum + item.quantity, 0) !== Number(quantity)) {
      throw new Error('Stripe Tax checkout quantity mismatch');
    }
  }
  return {
    ...taxInputs,
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
  taxMode = null,
  shipping = null,
  basket = null,
  customerId = null,
  persistCustomer = null,
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
      `&quote=${encodeURIComponent(quoteId)}&checkout=cancelled&lang=${encodeURIComponent(checkoutLocale)}`
    : `${baseUrl}/e/${encodedSlug}/shipping?configuration=${encodedConfiguration}` +
      `&quote=${encodeURIComponent(quoteId)}&checkout=cancelled&lang=${encodeURIComponent(checkoutLocale)}`;

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
    let taxParameters = {};
    if (taxMode === 'stripe') {
      if (!shipping?.address?.country || !basket?.length ||
          !Number.isSafeInteger(order.items_cents) || order.items_cents <= 0 ||
          !Number.isSafeInteger(order.shipping_cents) || order.shipping_cents < 0 ||
          totalCents !== order.items_cents + order.shipping_cents || order.tax_cents !== 0) {
        throw new Error('Der gespeicherte Nettopreis oder die Lieferadresse ist ungültig.');
      }
      if (!customerId) {
        if (typeof persistCustomer !== 'function') throw new Error('Customer persistence is required');
        // One technical customer per purchase, with immutable shipping input.
        // Persist before Session creation so even a fast webhook can validate it.
        const customer = await client.customers.create({
          name: shipping.name, shipping,
          metadata: { orderId: String(order.id), quoteId: String(quoteId) },
        }, { idempotencyKey: `wolkenworte-${checkoutMode}-quote-${quoteId}-customer` });
        customerId = customer.id;
        await persistCustomer(customerId);
      }
      const basketDescription = basket.map((item) =>
        `${item.quantity} × ${I18n.translate(item.product.name, checkoutLocale)} · ${I18n.translate(item.product.size.label, checkoutLocale)}`
      ).join('; ');
      taxParameters = {
        customer: customerId,
        automatic_tax: { enabled: true },
        adaptive_pricing: { enabled: false },
        // Printful supplies an aggregate product estimate, not reliable per-item
        // retail prices. Keep that exact net basket amount, describe each design,
        // and charge shipping separately without invented unit-price allocation.
        line_items: [{ quantity: 1, price_data: {
          currency, unit_amount: order.items_cents, tax_behavior: 'exclusive',
          product_data: {
            name: basket.length === 1
              ? `${basket[0].quantity} × ${I18n.translate(basket[0].product.name, checkoutLocale)}`
              : I18n.translate('Wolkenworte Bestellung', checkoutLocale),
            description: basketDescription.slice(0, 500),
            tax_code: 'txcd_99999999',
            metadata: { configurationIds: cartConfigurationIds.join(',') },
          },
        } }],
        shipping_options: [{ shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: order.shipping_cents, currency },
          display_name: I18n.translate('Versand', checkoutLocale),
          tax_behavior: 'exclusive', tax_code: 'txcd_92010001',
        } }],
      };
    }
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
      ...taxParameters,
      metadata,
      payment_intent_data: { metadata },
      success_url: `${baseUrl}/e/${encodedSlug}/order-confirmation?session_id={CHECKOUT_SESSION_ID}` +
        `&lang=${encodeURIComponent(checkoutLocale)}`,
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

/**
 * Expire an unpaid Checkout Session before replacing an immutable parameter
 * such as its locale. A failed expire call is reconciled with Stripe so a
 * concurrently completed payment always wins over a replacement attempt.
 */
async function expireCheckoutSession(sessionId) {
  const client = getClient();
  if (!client) throw notConfiguredError();
  const id = String(sessionId || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) {
    const error = new Error('Die gespeicherte Stripe-Session ist ungültig.');
    error.code = 'STRIPE_INVALID_CHECKOUT_SESSION';
    throw error;
  }

  const startedAt = Date.now();
  try {
    const session = await client.checkout.sessions.expire(id);
    performanceProbe.recordExternalCall('stripe', {
      durationMs: Date.now() - startedAt, succeeded: true,
    });
    return { id: session.id, status: session.status, paymentStatus: session.payment_status };
  } catch (expireError) {
    try {
      const session = await client.checkout.sessions.retrieve(id);
      if (session.status === 'complete' || session.status === 'expired') {
        performanceProbe.recordExternalCall('stripe', {
          durationMs: Date.now() - startedAt, succeeded: true,
        });
        return { id: session.id, status: session.status, paymentStatus: session.payment_status };
      }
    } catch {
      // Preserve the original expiry failure; it is the operation the caller
      // can safely retry without changing local checkout state.
    }
    performanceProbe.recordExternalCall('stripe', {
      durationMs: Date.now() - startedAt, succeeded: false,
    });
    throw expireError;
  }
}

/** Verify and parse the exact raw Stripe webhook bytes. */
function constructWebhookEvent(rawBody, signatureHeader) {
  const client = getClient();
  if (!client) throw notConfiguredError();
  const webhookSecret = stripeConfig.configuredWebhookSecret();
  if (!webhookSecret) {
    const error = new Error('Das Stripe-Webhook-Secret für die gewählte Umgebung ist nicht gesetzt.');
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
  expireCheckoutSession,
  constructWebhookEvent,
};
