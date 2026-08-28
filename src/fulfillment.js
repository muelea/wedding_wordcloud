'use strict';

/** Single-concurrency, Postgres-leased fulfillment worker. */

const crypto = require('crypto');
const db = require('./db');
const printful = require('./printful');
const printArtifacts = require('./printArtifacts');
const { getProduct, resolveProductOrientation } = require('./products');
const log = require('./structuredLog');

const MAX_ATTEMPTS = 3;
const LEASE_MS = 120_000;
const POLL_MS = 5_000;
const WORKER_ID = `web-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;

let stopping = false;
let workerBusy = false;
let pollTimer = null;
let scheduledKick = null;
const requestedOrders = new Set();

class FulfillmentSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FulfillmentSafetyError';
    this.code = 'FULFILLMENT_BLOCKED';
  }
}

class LeaseLostError extends Error {
  constructor() {
    super('Der Fulfillment-Lease wurde von einem neueren Versuch übernommen.');
    this.name = 'LeaseLostError';
    this.code = 'FULFILLMENT_LEASE_LOST';
  }
}

function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function configuredMode() {
  const mode = String(process.env.PRINTFUL_FULFILLMENT_MODE || 'mock').trim().toLowerCase();
  if (!['mock', 'draft', 'live'].includes(mode)) {
    throw new FulfillmentSafetyError('PRINTFUL_FULFILLMENT_MODE muss mock, draft oder live sein.');
  }
  return mode;
}

function resolveMode(order, { providerSmoke = false } = {}) {
  if (providerSmoke) {
    if (!order.provider_smoke || envFlag('STRIPE_ALLOW_LIVE_PAYMENTS') ||
        configuredMode() !== 'draft' || !envFlag('PRINTFUL_ALLOW_ORDER_WRITES') ||
        envFlag('PRINTFUL_CONFIRM_LIVE_ORDERS')) {
      throw new FulfillmentSafetyError('Der kontrollierte Printful-Draft-Smoke ist nicht sicher freigeschaltet.');
    }
    return 'draft';
  }

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

function digestId(prefix, source) {
  return prefix + crypto.createHash('sha256').update(source).digest('base64url').slice(0, 24);
}

function shipmentExternalId(order, shipmentIndex) {
  return digestId('ww_', `order:${order.id}:quote:${order.quote_id || 'none'}:shipment:${Number(shipmentIndex)}`);
}

function itemExternalId(order, shipmentIndex, itemIndex) {
  return digestId(
    'wi_',
    `order:${order.id}:quote:${order.quote_id || 'none'}:shipment:${Number(shipmentIndex)}:item:${Number(itemIndex)}`
  );
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseRecipient(value) {
  const recipient = parseJson(value);
  const required = ['name', 'address1', 'city', 'zip', 'country_code'];
  if (!recipient || required.some((field) => !recipient[field])) {
    throw new Error('Die gespeicherte Lieferadresse ist unvollständig.');
  }
  return recipient;
}

function dynamicConfigurationUrl(event, configuration, surfaceKey = null) {
  const base = new URL(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`);
  const url = new URL(
    `/api/events/${encodeURIComponent(event.slug)}/configurations/${encodeURIComponent(configuration.id)}/print.svg`,
    base
  );
  if (surfaceKey) url.searchParams.set('surface', surfaceKey);
  return url.toString();
}

function artifactMap(artifacts = []) {
  return new Map(artifacts.map((artifact) => [
    `${artifact.order_item_id}:${artifact.surface_key}`,
    artifact,
  ]));
}

function itemFromSnapshot({ order, orderItem, artifactsByKey, mode }) {
  const snapshot = printArtifacts.parseSnapshot(orderItem);
  const product = resolveProductOrientation(getProduct(snapshot.productKey), snapshot.orientation);
  if (!product || product.printful.variantId !== Number(orderItem.printful_variant_id)) {
    throw new Error('Das gespeicherte Printful-Produkt ist ungültig.');
  }
  const files = product.printful.placements.map((placement, index) => {
    const surface = product.printSurfaces[index];
    const artifact = artifactsByKey.get(`${orderItem.id}:${surface.key}`);
    if (!artifact && mode !== 'mock') throw new Error('Ein eingefrorenes Druckartefakt fehlt.');
    return {
      type: placement,
      url: artifact
        ? printArtifacts.artifactCapabilityUrl(artifact)
        : dynamicConfigurationUrl(
            { slug: order.event_slug_snapshot },
            { id: orderItem.configuration_id },
            product.printSurfaces.length > 1 ? surface.key : null
          ),
    };
  });
  return {
    external_id: itemExternalId(order, orderItem.shipment_index, orderItem.item_index),
    variant_id: Number(orderItem.printful_variant_id),
    quantity: Number(orderItem.quantity),
    files,
    ...(product.printful.options.length ? { options: product.printful.options } : {}),
  };
}

function legacyItem({ order, event, configuration, quantity, shipmentIndex, itemIndex }) {
  const product = resolveProductOrientation(
    getProduct(configuration.product_key),
    configuration.orientation || 'default'
  );
  if (!product || product.printful.variantId !== Number(configuration.printful_variant_id)) {
    throw new Error('Das gespeicherte Printful-Produkt ist ungültig.');
  }
  return {
    external_id: itemExternalId(order, shipmentIndex, itemIndex),
    variant_id: Number(configuration.printful_variant_id),
    quantity: Number(quantity),
    files: product.printful.placements.map((placement, index) => ({
      type: placement,
      url: dynamicConfigurationUrl(
        event,
        configuration,
        product.printSurfaces.length > 1 ? product.printSurfaces[index].key : null
      ),
    })),
    ...(product.printful.options.length ? { options: product.printful.options } : {}),
  };
}

function buildPrintfulPayload({
  order,
  event = null,
  configuration = null,
  configurations = [],
  orderItems = [],
  artifacts = [],
  mode,
  shipment = null,
}) {
  const shipmentIndex = Number(shipment?.shipment_index || 0);
  const relevantItems = orderItems
    .filter((item) => Number(item.shipment_index) === shipmentIndex)
    .sort((a, b) => Number(a.item_index) - Number(b.item_index));
  let items;
  if (relevantItems.length) {
    const artifactsByKey = artifactMap(artifacts);
    items = relevantItems.map((orderItem) => itemFromSnapshot({ order, orderItem, artifactsByKey, mode }));
  } else {
    const storedItems = parseJson(shipment?.items_json, []);
    const byId = new Map([configuration, ...configurations]
      .filter(Boolean).map((entry) => [entry.id, entry]));
    const fallbackItems = storedItems.length
      ? storedItems
      : [{ configurationId: configuration?.id, quantity: shipment?.quantity || configuration?.quantity }];
    items = fallbackItems.map((entry, index) => legacyItem({
      order,
      event,
      configuration: byId.get(entry.configurationId || entry.configuration_id) || configuration,
      quantity: Number(entry.quantity),
      shipmentIndex,
      itemIndex: index,
    }));
  }
  return {
    external_id: shipmentExternalId(order, shipmentIndex),
    shipping: 'STANDARD',
    recipient: parseRecipient(shipment?.recipient_json || order.shipping_json),
    items,
  };
}

function leaseFor(order) {
  return { lockedBy: order.fulfillment_locked_by, leaseVersion: Number(order.fulfillment_lease_version) };
}

async function renew(order, deadline) {
  if (deadline && Date.now() + 500 >= deadline) {
    const error = new Error('Der Wartungslauf hat sein sicheres Zeitbudget erreicht.');
    error.code = 'FULFILLMENT_CHECKPOINT';
    throw error;
  }
  if (!await db.renewFulfillmentLease(order.id, leaseFor(order), LEASE_MS)) throw new LeaseLostError();
}

function providerTimeout(deadline) {
  if (!deadline) return 10_000;
  return Math.max(1_000, Math.min(10_000, deadline - Date.now() - 1_000));
}

async function executeClaimedOrder(order, { deadline = null, providerSmoke = false } = {}) {
  const lease = leaseFor(order);
  try {
    const mode = resolveMode(order, { providerSmoke });
    const orderItems = await db.getOrderItems(order.id);
    if (!orderItems.length) throw new Error('Bestellartikel wurden nicht gefunden.');
    let artifacts = [];
    if (mode !== 'mock') {
      await renew(order, deadline);
      artifacts = await printArtifacts.ensureOrderArtifacts(order, orderItems, { deadline });
      await renew(order, deadline);
    }

    const shipments = await db.getOrderShipments(order.id);
    if (!shipments.length) throw new Error('Bestelllieferungen wurden nicht gefunden.');
    const completedModes = [];
    for (const shipment of shipments) {
      if (['mocked', 'draft', 'submitted'].includes(shipment.fulfillment_status)) {
        completedModes.push(shipment.fulfillment_mode || mode);
        continue;
      }
      const payload = buildPrintfulPayload({ order, orderItems, artifacts, mode, shipment });
      try {
        let result;
        if (mode === 'mock') {
          result = {
            printfulOrderId: shipments.length > 1
              ? `MOCK-WC-${order.id}-${Number(shipment.shipment_index) + 1}`
              : `MOCK-WC-${order.id}`,
            status: 'mocked',
            mocked: true,
          };
        } else {
          await renew(order, deadline);
          result = await printful.reconcilePrintfulOrder({
            payload,
            confirm: mode === 'live',
            timeoutMs: providerTimeout(deadline),
          });
          await renew(order, deadline);
        }
        const completedMode = result.mocked ? 'mock' : mode;
        const completed = await db.completeOrderShipment(shipment.id, order.id, lease, {
          mode: completedMode,
          payload,
          printfulOrderId: result.printfulOrderId,
          printfulStatus: result.status,
        });
        if (!completed) throw new LeaseLostError();
        completedModes.push(completedMode);
      } catch (error) {
        if (error.code !== 'FULFILLMENT_LEASE_LOST') {
          await db.failOrderShipment(shipment.id, order.id, lease, error);
        }
        throw error;
      }
    }

    const finalShipments = await db.getOrderShipments(order.id);
    const payload = {
      shipments: finalShipments.map((shipment) => parseJson(shipment.fulfillment_payload_json)).filter(Boolean),
    };
    const printfulOrderId = finalShipments.map((shipment) => shipment.printful_order_id)
      .filter(Boolean).join(',');
    const completedMode = completedModes.some((entry) => entry !== 'mock') ? mode : 'mock';
    const completed = await db.completeFulfillment(order.id, lease, {
      mode: completedMode,
      payload,
      printfulOrderId,
      printfulStatus: completedMode === 'mock' ? 'mocked' : completedMode,
    });
    if (!completed) throw new LeaseLostError();
    if (completedMode === 'live') {
      await db.extendOrderArtifactRetention(order.id, new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
    }
    if (completedMode === 'mock') {
      log.info('fulfillment_mock_completed', {
        orderId: order.id, outcome: 'mocked', mode: 'mock',
      });
    }
    return completed;
  } catch (error) {
    if (error.code === 'FULFILLMENT_LEASE_LOST') return db.getOrderById(order.id);
    const blocked = error.code === 'FULFILLMENT_BLOCKED' || error.code === 'PRINTFUL_ORDER_TERMINAL';
    const failed = await db.failFulfillment(order.id, lease, error, { blocked });
    log.error(blocked ? 'fulfillment_blocked' : 'fulfillment_failed', {
      orderId: order.id,
      outcome: blocked ? 'blocked' : 'failed',
      errorCode: log.errorCode(error, blocked ? 'fulfillment_blocked' : 'fulfillment_failed'),
      mode: order.mode,
    });
    return failed || db.getOrderById(order.id);
  }
}

async function processClaimedOrder(order, options = {}) {
  if (!order || order.fulfillment_status !== 'processing' ||
      !order.fulfillment_locked_by || !order.fulfillment_locked_until) {
    throw new Error('manual fulfillment retry requires a claimed order');
  }
  return executeClaimedOrder(order, options);
}

async function processOrder(orderId, options = {}) {
  if (stopping || workerBusy) return db.getOrderById(orderId);
  workerBusy = true;
  try {
    const order = await db.claimFulfillmentOrder({ orderId, lockedBy: WORKER_ID, leaseMs: LEASE_MS });
    if (!order) return db.getOrderById(orderId);
    return executeClaimedOrder(order, options);
  } finally {
    workerBusy = false;
  }
}

async function drainDueJobs({ maxJobs = 1, deadline = null } = {}) {
  if (stopping || workerBusy) return { claimed: 0, completed: 0 };
  workerBusy = true;
  let claimed = 0;
  let completed = 0;
  try {
    while (claimed < maxJobs && (!deadline || Date.now() + 500 < deadline)) {
      const order = await db.claimFulfillmentOrder({ lockedBy: WORKER_ID, leaseMs: LEASE_MS });
      if (!order) break;
      claimed += 1;
      const result = await executeClaimedOrder(order, { deadline });
      if (result && ['mocked', 'draft', 'submitted'].includes(result.fulfillment_status)) completed += 1;
    }
    return { claimed, completed };
  } finally {
    workerBusy = false;
  }
}

async function drainRequested() {
  if (stopping || workerBusy) return;
  const orderId = requestedOrders.values().next().value;
  if (orderId == null) return;
  requestedOrders.delete(orderId);
  await processOrder(orderId);
  if (requestedOrders.size) scheduleKick();
}

function scheduleKick() {
  if (stopping || scheduledKick) return false;
  scheduledKick = setImmediate(() => {
    scheduledKick = null;
    drainRequested().catch((error) => log.error('fulfillment_worker_failed', {
      errorCode: log.errorCode(error, 'fulfillment_worker_failed'),
    }));
  });
  scheduledKick.unref();
  return true;
}

function scheduleOrder(orderId) {
  if (stopping) return false;
  requestedOrders.add(String(orderId));
  return scheduleKick();
}

async function resumePendingOrders() {
  if (stopping) return 0;
  await db.recoverStaleFulfillments();
  const pending = await db.getPendingFulfillmentOrders(20);
  pending.forEach((order) => requestedOrders.add(String(order.id)));
  if (pending.length) scheduleKick();
  return pending.length;
}

function start() {
  if (stopping || pollTimer) return false;
  pollTimer = setInterval(() => {
    drainDueJobs({ maxJobs: 1 }).catch((error) => log.error('fulfillment_poll_failed', {
      errorCode: log.errorCode(error, 'fulfillment_poll_failed'),
    }));
  }, POLL_MS);
  pollTimer.unref();
  resumePendingOrders().catch((error) => log.error('fulfillment_resume_failed', {
    errorCode: log.errorCode(error, 'fulfillment_resume_failed'),
  }));
  return true;
}

async function stop({ timeoutMs = 15_000 } = {}) {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (scheduledKick) clearImmediate(scheduledKick);
  scheduledKick = null;
  requestedOrders.clear();
  const deadline = Date.now() + timeoutMs;
  while (workerBusy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  return { drained: !workerBusy, activeOrders: workerBusy ? 1 : 0 };
}

module.exports = {
  MAX_ATTEMPTS,
  LEASE_MS,
  FulfillmentSafetyError,
  LeaseLostError,
  configuredMode,
  resolveMode,
  shipmentExternalId,
  itemExternalId,
  buildPrintfulPayload,
  processOrder,
  processClaimedOrder,
  drainDueJobs,
  scheduleOrder,
  resumePendingOrders,
  start,
  stop,
};
