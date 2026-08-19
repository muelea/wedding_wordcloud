'use strict';

/**
 * Durable bridge from a confirmed Stripe payment to Printful.
 *
 * Stripe test payments are unconditionally processed as local mocks. A real
 * Printful write additionally requires a live Stripe payment, an explicit
 * fulfillment mode and a separate write switch. Confirming a draft (which
 * charges the Printful account and starts production) has one more switch.
 */

const db = require('./db');
const printful = require('./printful');

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 30_000];
const activeOrders = new Set();

class FulfillmentSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FulfillmentSafetyError';
    this.code = 'FULFILLMENT_BLOCKED';
  }
}

function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function configuredMode() {
  const mode = String(process.env.PRINTFUL_FULFILLMENT_MODE || 'mock').trim().toLowerCase();
  if (!['mock', 'draft', 'live'].includes(mode)) {
    throw new FulfillmentSafetyError(
      'PRINTFUL_FULFILLMENT_MODE muss mock, draft oder live sein.'
    );
  }
  return mode;
}

function resolveMode(order) {
  // This is deliberately unconditional: no combination of Printful env vars
  // can turn a Stripe test payment into an external order write.
  if (order.mode !== 'live' || order.status === 'paid_test') return 'mock';

  const mode = configuredMode();
  if (mode === 'mock') return mode;
  if (!envFlag('STRIPE_ALLOW_LIVE_PAYMENTS')) {
    throw new FulfillmentSafetyError('Live-Zahlungen sind nicht freigeschaltet.');
  }
  if (!envFlag('PRINTFUL_ALLOW_ORDER_WRITES')) {
    throw new FulfillmentSafetyError('Printful-Bestellzugriffe sind nicht freigeschaltet.');
  }
  if (mode === 'live' && !envFlag('PRINTFUL_CONFIRM_LIVE_ORDERS')) {
    throw new FulfillmentSafetyError('Die Bestätigung echter Printful-Bestellungen ist gesperrt.');
  }
  return mode;
}

function parseRecipient(order) {
  let recipient;
  try {
    recipient = JSON.parse(order.shipping_json);
  } catch {
    throw new Error('Die gespeicherte Lieferadresse ist ungültig.');
  }
  const required = ['name', 'address1', 'city', 'zip', 'country_code'];
  if (!recipient || required.some((field) => !recipient[field])) {
    throw new Error('Die gespeicherte Lieferadresse ist unvollständig.');
  }
  return recipient;
}

function publicPrintFileUrl(event, configuration, mode) {
  const configuredBase = String(process.env.PUBLIC_URL || '').trim();
  const fallbackBase = `http://localhost:${process.env.PORT || 3000}`;
  let url;
  try {
    url = new URL(configuredBase || fallbackBase);
  } catch {
    throw new FulfillmentSafetyError('PUBLIC_URL ist keine gültige URL.');
  }

  if (mode !== 'mock') {
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (url.protocol !== 'https:' || localHosts.has(url.hostname)) {
      throw new FulfillmentSafetyError(
        'Für Printful-Bestellungen muss PUBLIC_URL eine öffentliche HTTPS-Adresse sein.'
      );
    }
  }

  const slug = encodeURIComponent(event.slug);
  const configurationId = encodeURIComponent(configuration.id);
  return new URL(
    `/api/events/${slug}/configurations/${configurationId}/print.svg`,
    url
  ).toString();
}

function buildPrintfulPayload({ order, event, configuration, mode }) {
  const variantId = Number(configuration.printful_variant_id);
  const quantity = Number(configuration.quantity);
  if (!Number.isSafeInteger(variantId) || variantId < 1) {
    throw new Error('Die gespeicherte Printful-Variante ist ungültig.');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new Error('Die gespeicherte Bestellmenge ist ungültig.');
  }
  // The opaque quote id keeps this reference unique even if a local/staging
  // database is ever rebuilt and starts its integer order ids at 1 again.
  const externalId = order.quote_id
    ? `weddingcloud-${order.id}-${order.quote_id}`
    : `weddingcloud-${order.id}`;
  return {
    external_id: externalId,
    shipping: 'STANDARD',
    recipient: parseRecipient(order),
    items: [{
      external_id: `${externalId}-item-1`,
      variant_id: variantId,
      quantity,
      files: [{
        type: 'default',
        url: publicPrintFileUrl(event, configuration, mode),
      }],
    }],
  };
}

async function processOrder(orderId) {
  if (activeOrders.has(orderId)) return db.getOrderById(orderId);
  const order = db.claimFulfillmentOrder(orderId);
  if (!order) return db.getOrderById(orderId);
  activeOrders.add(orderId);

  try {
    const event = db.getEventById(order.event_id);
    const configuration = db.getConfiguration(order.configuration_id);
    if (!event || !configuration) throw new Error('Bestellkonfiguration wurde nicht gefunden.');

    const mode = resolveMode(order);
    const payload = buildPrintfulPayload({ order, event, configuration, mode });

    if (mode === 'mock') {
      const printfulOrderId = `MOCK-WC-${order.id}`;
      console.log(
        `[fulfillment:mock] Bestellung ${order.id} sicher simuliert; ` +
        'es wurde keine Anfrage an Printful gesendet.'
      );
      return db.completeFulfillment(order.id, {
        mode,
        payload,
        printfulOrderId,
        printfulStatus: 'mocked',
      });
    }

    const result = await printful.createPrintfulOrder({
      payload,
      confirm: mode === 'live',
    });
    // Missing credentials deliberately degrade to a mock in printful.js.
    // Never label that result as a real draft/submission.
    const completedMode = result.mocked ? 'mock' : mode;
    return db.completeFulfillment(order.id, {
      mode: completedMode,
      payload,
      printfulOrderId: result.printfulOrderId,
      printfulStatus: result.status,
    });
  } catch (error) {
    const blocked = error?.code === 'FULFILLMENT_BLOCKED';
    const failed = db.failFulfillment(order.id, error, { blocked });
    console.error(`[fulfillment:${blocked ? 'blocked' : 'failed'}] order ${order.id}:`, error.message);
    if (!blocked && Number(failed.fulfillment_attempts) < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[Math.max(0, Number(failed.fulfillment_attempts) - 1)] || 30_000;
      const retryTimer = setTimeout(() => scheduleOrder(order.id), delay);
      retryTimer.unref();
    }
    return failed;
  } finally {
    activeOrders.delete(orderId);
  }
}

function scheduleOrder(orderId) {
  setImmediate(() => {
    processOrder(orderId).catch((error) => {
      console.error(`[fulfillment:worker] order ${orderId}:`, error);
    });
  });
}

function resumePendingOrders() {
  db.recoverStaleFulfillments();
  const orders = db.getPendingFulfillmentOrders(20);
  for (const order of orders) scheduleOrder(order.id);
  return orders.length;
}

module.exports = {
  MAX_ATTEMPTS,
  FulfillmentSafetyError,
  configuredMode,
  resolveMode,
  buildPrintfulPayload,
  processOrder,
  scheduleOrder,
  resumePendingOrders,
};
