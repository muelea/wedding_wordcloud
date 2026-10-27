'use strict';

const I18n = require('./i18n');
const { checkoutRequest, paymentAmounts } = require('./checkoutTax');
const performanceProbe = require('./performanceProbe');
const stripeConfig = require('./stripeConfig');

const PERSONALIZED_GOODS_NOTICE = 'Die Produkte werden nach euren individuellen Vorgaben angefertigt. Für solche personalisierten Waren besteht grundsätzlich kein gesetzliches Widerrufsrecht (§ 312g Abs. 2 Nr. 1 BGB). Eure gesetzlichen Rechte bei Mängeln bleiben unberührt.';
const CUSTOMS_NOTICE = 'Bei Lieferungen in bestimmte Länder können zusätzliche Zölle, Einfuhrsteuern oder sonstige Einfuhrgebühren anfallen. Diese sind vom Empfänger zu tragen.';

/**
 * Stripe-hosted Checkout for trusted, server-side EUR quotes.
 *
 * Test and live credentials are separate. Live mode is rejected unless the
 * dedicated payment mode and live safety gate both select it. No static Stripe
 * Price is needed: every
 * Checkout Session gets frozen unit prices and shipping in cents, with the
 * tax behavior selected for the validated delivery country.
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
    // Pin the category with new orders. Older frozen requests keep their
    // original generic category and identical idempotent retry payload.
    ...(product.familyKey === 'clothing' ? { taxCode: 'txcd_30011000' } : {}),
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
  if (!Array.isArray(shipments) || shipments.length !== 1) {
    throw new Error('Stripe Tax checkout requires one delivery address');
  }
  const shipment = shipments[0];
  const pricing = shipment.customerCosts?.pricing || null;
  const recipient = shipment.recipient;
  if (!recipient?.name || !recipient.address1 || !recipient.city || !recipient.country_code) {
    throw new Error('Stripe Tax checkout requires a validated delivery address');
  }
  const shipping = {
    name: recipient.name,
    address: {
      line1: recipient.address1, line2: recipient.address2 || '',
      city: recipient.city, postal_code: recipient.zip || '',
      state: recipient.state_code || '', country: recipient.country_code,
    },
  };
  const basket = (shipment.items || [{ configurationId: ids[0], quantity }]).map((item) => {
    const index = ids.indexOf(String(item.configurationId));
    if (index < 0 || !frozenProducts[index] || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error('Stripe Tax checkout contains an invalid product');
    }
    return { configurationId: ids[index], quantity: item.quantity, product: frozenProducts[index] };
  });
  if (basket.reduce((sum, item) => sum + item.quantity, 0) !== Number(quantity)) {
    throw new Error('Stripe Tax checkout quantity mismatch');
  }
  return {
    // Persist the integration policy with the order. Older recoverable orders
    // retain their original card-only payload and Stripe idempotency key.
    allowedPaymentMethodTypes: ['card', 'paypal'],
    ...(pricing ? { pricing } : {}),
    shipping,
    basket,
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
  slug,
  configurationId,
  configurationIds = null,
  quoteId,
  baseUrl,
  locale = I18n.DEFAULT_LOCALE,
  shipping = null,
  basket = null,
  customerId = null,
  persistCustomer = null,
  allowedPaymentMethodTypes = null,
  pricing = null,
}) {
  const client = getClient();
  if (!client) throw notConfiguredError();

  if (allowedPaymentMethodTypes !== null && (
    !Array.isArray(allowedPaymentMethodTypes) ||
    allowedPaymentMethodTypes.length !== 2 ||
    allowedPaymentMethodTypes[0] !== 'card' || allowedPaymentMethodTypes[1] !== 'paypal'
  )) {
    const error = new Error('Die gespeicherten Zahlungsmethoden sind ungültig.');
    error.code = 'STRIPE_INVALID_CHECKOUT_REQUEST';
    throw error;
  }

  const totalCents = Number(order?.total_cents);
  const taxBehavior = pricing?.version === 2 ? pricing.taxBehavior : 'exclusive';
  if (pricing && (pricing.version !== 2 || !['inclusive', 'exclusive'].includes(taxBehavior) ||
      pricing.country !== shipping?.address?.country ||
      (taxBehavior === 'inclusive') !== (pricing.country === 'DE') ||
      pricing.itemsCents !== order.items_cents || pricing.shippingCents !== order.shipping_cents ||
      !Array.isArray(pricing.items) || pricing.items.length !== basket?.length ||
      pricing.items.some((item, index) => item.configurationId !== basket[index].configurationId ||
        item.productKey !== basket[index].product.key || item.quantity !== basket[index].quantity ||
        !Number.isSafeInteger(item.unitAmountCents) || item.unitAmountCents <= 0) ||
      pricing.items.reduce((sum, item) => sum + item.quantity * item.unitAmountCents, 0) !== order.items_cents)) {
    const error = new Error('Die gespeicherten Produktpreise sind ungültig.');
    error.code = 'STRIPE_INVALID_CHECKOUT_REQUEST';
    throw error;
  }
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
  const checkoutLocale = I18n.normalizeLocale(locale);
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
    if (!shipping?.address?.country || !basket?.length ||
        !Number.isSafeInteger(order.items_cents) || order.items_cents <= 0 ||
        !Number.isSafeInteger(order.shipping_cents) || order.shipping_cents < 0 ||
        totalCents !== order.items_cents + order.shipping_cents || order.tax_cents !== 0) {
      throw new Error('Der gespeicherte Preis oder die Lieferadresse ist ungültig.');
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
    session = await client.checkout.sessions.create({
      mode: 'payment',
      locale: checkoutLocale,
      // Filter Dashboard-managed methods to the supported card/PayPal flow.
      // Inactive or ineligible PayPal must not break card Checkout. Absence of
      // the frozen policy identifies an older order whose retry stays exact.
      ...(allowedPaymentMethodTypes
        ? { allowed_payment_method_types: allowedPaymentMethodTypes }
        : { payment_method_types: ['card'] }),
      client_reference_id: String(order.id),
      customer: customerId,
      automatic_tax: { enabled: true },
      adaptive_pricing: { enabled: false },
      ...(pricing ? { expand: ['line_items'] } : {}),
      // New orders retain exact catalog unit prices and quantities. Recoverable
      // legacy orders retain their original aggregate, tax-exclusive payload.
      line_items: pricing ? pricing.items.map((item, index) => ({ quantity: item.quantity, price_data: {
        currency, unit_amount: item.unitAmountCents, tax_behavior: taxBehavior,
        product_data: {
          name: I18n.translate(basket[index].product.name, checkoutLocale),
          description: I18n.translate(basket[index].product.size.label, checkoutLocale),
          tax_code: basket[index].product.taxCode || 'txcd_99999999',
          metadata: { configurationId: item.configurationId },
        },
      } })) : [{ quantity: 1, price_data: {
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
        tax_behavior: taxBehavior, tax_code: 'txcd_92010001',
      } }],
      metadata,
      payment_intent_data: { metadata },
      custom_text: {
        submit: {
          message: `${I18n.translate(CUSTOMS_NOTICE, checkoutLocale)} ${I18n.translate(PERSONALIZED_GOODS_NOTICE, checkoutLocale)}`,
        },
      },
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

  const validationOrder = {
    ...order,
    checkout_request_json: JSON.stringify({ ...checkoutRequest(order), customerId, ...(pricing ? { pricing } : {}) }),
  };
  const amounts = paymentAmounts(validationOrder, session);
  if (!session?.id || !session.url || !amounts) {
    const error = new Error('Stripe konnte den endgültigen Steuer- und Gesamtbetrag nicht bestätigen.');
    error.code = 'STRIPE_TAX_CALCULATION_INCOMPLETE';
    throw error;
  }

  let pricedItems;
  if (pricing) {
    // Expanded Sessions contain only the first page. A cart can contain up to
    // 20 designs, so fetch the complete list before displaying per-item totals.
    const lines = session.line_items?.has_more
      ? await client.checkout.sessions.listLineItems(session.id, { limit: 100 })
      : session.line_items;
    const valid = lines && !lines.has_more && lines.data?.length === pricing.items.length &&
      lines.data.every((line, index) => {
        const item = pricing.items[index];
        return line.quantity === item.quantity &&
          line.amount_subtotal === item.quantity * item.unitAmountCents &&
          Number.isSafeInteger(line.amount_total) && line.amount_total >= line.amount_subtotal &&
          (taxBehavior !== 'inclusive' || line.amount_total === line.amount_subtotal);
      }) && lines.data.reduce((sum, line) => sum + line.amount_total, 0) +
        session.shipping_cost.amount_total === amounts.totalCents;
    if (!valid) {
      const error = new Error('Stripe konnte die endgültigen Produktbeträge nicht bestätigen.');
      error.code = 'STRIPE_TAX_CALCULATION_INCOMPLETE';
      throw error;
    }
    pricedItems = pricing.items.map((item, index) => ({ ...item, grossTotalCents: lines.data[index].amount_total }));
  }

  return {
    url: session.url,
    id: session.id,
    taxCents: amounts.taxCents,
    totalCents: amounts.totalCents,
    ...(pricing ? {
      shippingTaxCents: session.shipping_cost.amount_tax,
      pricedItems,
    } : {}),
    expiresAt: order.checkout_session_expires_at,
  };
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
