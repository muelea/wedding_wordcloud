'use strict';

/**
 * Data layer.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) instead of Postgres.
 * Why: the brief asks for Postgres, with SQLite as an acceptable local-dev
 * drop-in "if Postgres isn't easily available in this environment" — and it
 * isn't (no local Postgres server/binary in this sandbox, no `psql`/`pg_ctl`
 * on PATH, no ability to install and daemonize one here). `node:sqlite`
 * specifically (rather than `better-sqlite3` or similar) was chosen because
 * it ships in Node itself with zero native-compile step, which matters for
 * an "agent-first, low-maintenance" project with no ops team watching for
 * a broken `npm install` after a Node upgrade.
 *
 * The schema and queries below are written in plain ANSI-ish SQL
 * (INTEGER PRIMARY KEY AUTOINCREMENT, ON CONFLICT ... DO UPDATE, no
 * SQLite-only extensions) so porting to real Postgres later is a matter of
 * swapping this file's driver, not rewriting the schema or call sites.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'weddingcloud.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT UNIQUE NOT NULL,
    couple_name     TEXT NOT NULL,
    admin_pin_hash  TEXT NOT NULL,
    admin_pin_salt  TEXT NOT NULL,
    theme           TEXT NOT NULL DEFAULT 'pastel',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS words (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    word       TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, word)
  );

  CREATE TABLE IF NOT EXISTS word_contributions (
    receipt_id TEXT PRIMARY KEY,
    event_id   INTEGER NOT NULL,
    word       TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(event_id, word) REFERENCES words(event_id, word) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS word_contributions_owner_idx
    ON word_contributions(event_id, owner_id, created_at);

  CREATE TABLE IF NOT EXISTS archives (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    words_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    stripe_session_id  TEXT UNIQUE,
    status             TEXT NOT NULL DEFAULT 'pending', -- payment / checkout state
    shipping_json      TEXT,
    printful_order_id  TEXT,
    fulfillment_status TEXT NOT NULL DEFAULT 'not_started',
    fulfillment_mode   TEXT,
    fulfillment_attempts INTEGER NOT NULL DEFAULT 0,
    fulfillment_error  TEXT,
    fulfillment_payload_json TEXT,
    printful_order_status TEXT,
    fulfillment_updated_at TEXT,
    configuration_ids_json TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS configurations (
    id                   TEXT PRIMARY KEY,
    event_id             INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    product_key          TEXT NOT NULL,
    printful_variant_id  INTEGER NOT NULL,
    quantity             INTEGER NOT NULL DEFAULT 2,
    unit_price_cents     INTEGER NOT NULL DEFAULT 1745,
    theme                TEXT NOT NULL,
    placement            TEXT NOT NULL,
    words_json           TEXT NOT NULL,
    design_json          TEXT,
    configuration_type   TEXT NOT NULL DEFAULT 'event_wordcloud',
    print_width          INTEGER NOT NULL,
    print_height         INTEGER NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// These fields were part of the original setup form but are no longer
// collected or shown anywhere. Drop them from existing local databases while
// leaving every event's identity, access, words and order data untouched.
const eventColumns = new Set(
  db.prepare('PRAGMA table_info(events)').all().map((column) => column.name)
);
for (const legacyColumn of ['event_title', 'wedding_date']) {
  if (eventColumns.has(legacyColumn)) {
    db.exec(`ALTER TABLE events DROP COLUMN ${legacyColumn};`);
  }
}

// Quotes deliberately live separately from orders: couples can calculate a
// price more than once while correcting their address, but only the quote
// they explicitly continue with becomes an order. The exact cent amounts and
// address snapshot are immutable inputs to Stripe Checkout.
db.exec(`
  CREATE TABLE IF NOT EXISTS checkout_quotes (
    id                    TEXT PRIMARY KEY,
    event_id              INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    configuration_id      TEXT NOT NULL REFERENCES configurations(id) ON DELETE CASCADE,
    configuration_ids_json TEXT,
    recipient_json        TEXT NOT NULL,
    shipments_json        TEXT,
    printful_costs_json    TEXT NOT NULL,
    currency              TEXT NOT NULL,
    quantity              INTEGER NOT NULL,
    items_cents           INTEGER NOT NULL,
    payment_reserve_cents INTEGER NOT NULL DEFAULT 0,
    shipping_cents        INTEGER NOT NULL,
    tax_cents             INTEGER NOT NULL,
    total_cents           INTEGER NOT NULL,
    expires_at            TEXT NOT NULL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS checkout_quotes_event_configuration_idx
    ON checkout_quotes(event_id, configuration_id);

  CREATE TABLE IF NOT EXISTS checkout_order_shipments (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id              INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    shipment_index        INTEGER NOT NULL,
    quantity              INTEGER NOT NULL,
    items_json            TEXT,
    recipient_json        TEXT NOT NULL,
    printful_costs_json    TEXT NOT NULL,
    currency              TEXT NOT NULL,
    shipping_cents        INTEGER NOT NULL,
    tax_cents             INTEGER NOT NULL,
    fulfillment_status    TEXT NOT NULL DEFAULT 'pending',
    fulfillment_mode      TEXT,
    fulfillment_attempts  INTEGER NOT NULL DEFAULT 0,
    fulfillment_error     TEXT,
    fulfillment_payload_json TEXT,
    printful_order_id     TEXT,
    printful_order_status TEXT,
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(order_id, shipment_index)
  );

  CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    stripe_event_id  TEXT PRIMARY KEY,
    event_type       TEXT NOT NULL,
    stripe_session_id TEXT,
    processed_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Keep local databases created before the configurable-quantity feature
// usable without a manual migration step. Existing two-mug drafts retain their
// original quantity of two and the equivalent 17,45 € unit price.
const configurationColumns = new Set(
  db.prepare('PRAGMA table_info(configurations)').all().map((column) => column.name)
);
if (!configurationColumns.has('quantity')) {
  db.exec('ALTER TABLE configurations ADD COLUMN quantity INTEGER NOT NULL DEFAULT 2;');
}
if (!configurationColumns.has('unit_price_cents')) {
  db.exec('ALTER TABLE configurations ADD COLUMN unit_price_cents INTEGER NOT NULL DEFAULT 1745;');
}
if (!configurationColumns.has('design_json')) {
  db.exec('ALTER TABLE configurations ADD COLUMN design_json TEXT;');
}
if (!configurationColumns.has('configuration_type')) {
  db.exec("ALTER TABLE configurations ADD COLUMN configuration_type TEXT NOT NULL DEFAULT 'event_wordcloud';");
}

// Forward-only, no-ops-on-new-databases migrations for the checkout state
// stored in older local SQLite files. Keeping these additive makes `git pull`
// + restart sufficient for local development.
const orderColumns = new Set(
  db.prepare('PRAGMA table_info(orders)').all().map((column) => column.name)
);
const orderMigrations = [
  ['configuration_id', 'TEXT'],
  ['quote_id', 'TEXT'],
  ['currency', 'TEXT'],
  ['items_cents', 'INTEGER'],
  ['payment_reserve_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['shipping_cents', 'INTEGER'],
  ['tax_cents', 'INTEGER'],
  ['total_cents', 'INTEGER'],
  ['stripe_checkout_url', 'TEXT'],
  ['stripe_payment_intent_id', 'TEXT'],
  ['stripe_event_id', 'TEXT'],
  ['mode', "TEXT NOT NULL DEFAULT 'test'"],
  ['paid_at', 'TEXT'],
  ['fulfillment_status', "TEXT NOT NULL DEFAULT 'not_started'"],
  ['fulfillment_mode', 'TEXT'],
  ['fulfillment_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['fulfillment_error', 'TEXT'],
  ['fulfillment_payload_json', 'TEXT'],
  ['printful_order_status', 'TEXT'],
  ['fulfillment_updated_at', 'TEXT'],
  ['configuration_ids_json', 'TEXT'],
];
for (const [name, declaration] of orderMigrations) {
  if (!orderColumns.has(name)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${declaration};`);
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_quote_id_unique ON orders(quote_id) WHERE quote_id IS NOT NULL;');

const checkoutQuoteColumns = new Set(
  db.prepare('PRAGMA table_info(checkout_quotes)').all().map((column) => column.name)
);
if (!checkoutQuoteColumns.has('shipments_json')) {
  db.exec('ALTER TABLE checkout_quotes ADD COLUMN shipments_json TEXT;');
}
if (!checkoutQuoteColumns.has('payment_reserve_cents')) {
  db.exec('ALTER TABLE checkout_quotes ADD COLUMN payment_reserve_cents INTEGER NOT NULL DEFAULT 0;');
}
if (!checkoutQuoteColumns.has('configuration_ids_json')) {
  db.exec('ALTER TABLE checkout_quotes ADD COLUMN configuration_ids_json TEXT;');
}

const checkoutOrderShipmentColumns = new Set(
  db.prepare('PRAGMA table_info(checkout_order_shipments)').all().map((column) => column.name)
);
if (!checkoutOrderShipmentColumns.has('items_json')) {
  db.exec('ALTER TABLE checkout_order_shipments ADD COLUMN items_json TEXT;');
}

// ── Password hashing (admin PIN) ────────────────────────────────────────────
// scrypt from Node's built-in crypto — no bcrypt dependency needed for a
// 4-6 digit PIN gate on a low-stakes local admin action.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPin(pin, hash, salt) {
  const candidate = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Events ───────────────────────────────────────────────────────────────
function createEvent({ slug, coupleName, pin }) {
  const { hash, salt } = hashPin(pin);
  const stmt = db.prepare(`
    INSERT INTO events (slug, couple_name, admin_pin_hash, admin_pin_salt)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(slug, coupleName, hash, salt);
  return getEventById(info.lastInsertRowid);
}

function getEventBySlug(slug) {
  return db.prepare('SELECT * FROM events WHERE slug = ?').get(slug) || null;
}

function getEventById(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) || null;
}

function slugExists(slug) {
  return !!db.prepare('SELECT 1 FROM events WHERE slug = ?').get(slug);
}

function setEventTheme(eventId, theme) {
  db.prepare('UPDATE events SET theme = ? WHERE id = ?').run(theme, eventId);
}

// ── Words ────────────────────────────────────────────────────────────────
// Atomic upsert — the core correctness fix over the prototype's in-memory
// Map: concurrent submissions from many phones at once can't race/clobber
// each other, and the count survives a server restart.
function upsertWord(eventId, word) {
  db.prepare(`
    INSERT INTO words (event_id, word, count, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(event_id, word) DO UPDATE SET
      count = count + 1,
      updated_at = datetime('now')
  `).run(eventId, word);
}

// Each aggregate increment gets an unguessable receipt tied to one anonymous
// browser session. The receipt is a capability for exactly that contribution,
// while ownerId prevents a receipt copied from another guest from being used
// in a different browser session. Keeping both writes in one transaction means
// the visible count can never diverge from the removable contributions.
function addWordContribution(eventId, word, ownerId) {
  const receiptId = crypto.randomBytes(18).toString('base64url');
  db.exec('BEGIN IMMEDIATE;');
  try {
    upsertWord(eventId, word);
    db.prepare(`
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      VALUES (?, ?, ?, ?)
    `).run(receiptId, eventId, word, ownerId);
    db.exec('COMMIT;');
    return receiptId;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function getWordContributions(eventId, ownerId) {
  return db.prepare(`
    SELECT receipt_id, word
    FROM word_contributions
    WHERE event_id = ? AND owner_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(eventId, ownerId).map((row) => ({ receipt: row.receipt_id, word: row.word }));
}

// Removes one—and only one—owned contribution. Aggregate words from older
// databases that predate receipts remain valid: a new removable contribution
// can increment such a row and later decrement it back to its legacy count.
function removeWordContribution(eventId, receiptId, ownerId) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const contribution = db.prepare(`
      SELECT word
      FROM word_contributions
      WHERE receipt_id = ? AND event_id = ? AND owner_id = ?
    `).get(receiptId, eventId, ownerId);

    if (!contribution) {
      db.exec('COMMIT;');
      return null;
    }

    db.prepare(`
      DELETE FROM word_contributions
      WHERE receipt_id = ? AND event_id = ? AND owner_id = ?
    `).run(receiptId, eventId, ownerId);

    const aggregate = db.prepare(`
      SELECT count FROM words WHERE event_id = ? AND word = ?
    `).get(eventId, contribution.word);

    if (!aggregate || Number(aggregate.count) <= 1) {
      db.prepare('DELETE FROM words WHERE event_id = ? AND word = ?')
        .run(eventId, contribution.word);
    } else {
      db.prepare(`
        UPDATE words
        SET count = count - 1, updated_at = datetime('now')
        WHERE event_id = ? AND word = ?
      `).run(eventId, contribution.word);
    }

    db.exec('COMMIT;');
    return contribution.word;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function getWords(eventId) {
  const rows = db.prepare('SELECT word, count FROM words WHERE event_id = ? ORDER BY count DESC').all(eventId);
  return rows.map((r) => [r.word, Number(r.count)]);
}

function clearWords(eventId) {
  db.prepare('DELETE FROM words WHERE event_id = ?').run(eventId);
}

// Snapshot current words before a reset ("Neue Runde"), mirroring the
// prototype's archive-to-disk behavior, so starting a new round never
// silently loses the previous one.
function archiveWords(eventId) {
  const words = getWords(eventId);
  if (words.length === 0) return;
  db.prepare('INSERT INTO archives (event_id, words_json) VALUES (?, ?)')
    .run(eventId, JSON.stringify(words));
}

// ── Orders ───────────────────────────────────────────────────────────────
function createOrder({ eventId, stripeSessionId }) {
  const info = db.prepare(`
    INSERT INTO orders (event_id, stripe_session_id, status) VALUES (?, ?, 'pending')
  `).run(eventId, stripeSessionId);
  return info.lastInsertRowid;
}

function markOrderPaid(stripeSessionId, shippingJson) {
  db.prepare(`
    UPDATE orders SET status = 'paid', shipping_json = ?, updated_at = datetime('now')
    WHERE stripe_session_id = ?
  `).run(shippingJson, stripeSessionId);
}

function markOrderFulfilled(stripeSessionId, printfulOrderId) {
  db.prepare(`
    UPDATE orders SET status = 'fulfilled', printful_order_id = ?, updated_at = datetime('now')
    WHERE stripe_session_id = ?
  `).run(printfulOrderId, stripeSessionId);
}

function getOrderBySessionId(stripeSessionId) {
  return db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(stripeSessionId) || null;
}

function getOrderById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

function getOrderByQuoteId(quoteId) {
  return db.prepare('SELECT * FROM orders WHERE quote_id = ?').get(quoteId) || null;
}

function getEventOrderBySessionId(slug, stripeSessionId) {
  return db.prepare(`
    SELECT orders.*
    FROM orders
    JOIN events ON events.id = orders.event_id
    WHERE orders.stripe_session_id = ? AND events.slug = ?
  `).get(stripeSessionId, slug) || null;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueConfigurationIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^[A-Za-z0-9_-]{16}$/.test(id)))];
}

function getCheckoutQuoteConfigurationIds(quote) {
  const ids = uniqueConfigurationIds(parseJsonArray(quote?.configuration_ids_json));
  return ids.length ? ids : uniqueConfigurationIds([quote?.configuration_id]);
}

function getOrderConfigurationIds(order) {
  const ids = uniqueConfigurationIds(parseJsonArray(order?.configuration_ids_json));
  return ids.length ? ids : uniqueConfigurationIds([order?.configuration_id]);
}

function shipmentQuantity(shipment) {
  if (Number.isSafeInteger(Number(shipment?.quantity)) && Number(shipment.quantity) > 0) {
    return Number(shipment.quantity);
  }
  if (Array.isArray(shipment?.items)) {
    return shipment.items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  }
  return 0;
}

function getCheckoutQuoteShipments(quote) {
  if (!quote) return [];
  if (quote.shipments_json) {
    try {
      const shipments = JSON.parse(quote.shipments_json);
      if (Array.isArray(shipments)) {
        return shipments.map((shipment) => ({
          ...shipment,
          quantity: shipmentQuantity(shipment),
        }));
      }
    } catch {
      return [];
    }
  }

  let recipient;
  let printfulCosts;
  try {
    recipient = JSON.parse(quote.recipient_json);
    printfulCosts = JSON.parse(quote.printful_costs_json);
  } catch {
    return [];
  }
  const quantity = Number(quote.quantity);
  if (!recipient || !Number.isSafeInteger(quantity) || quantity < 1) return [];
  return [{ quantity, recipient, printfulCosts }];
}

function insertOrderShipments(orderId, quote) {
  const shipments = getCheckoutQuoteShipments(quote);
  const stmt = db.prepare(`
    INSERT INTO checkout_order_shipments (
      order_id, shipment_index, quantity, items_json, recipient_json, printful_costs_json,
      currency, shipping_cents, tax_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  shipments.forEach((shipment, index) => {
    const printfulCosts = shipment.printfulCosts || shipment.costs || {};
    const customerCosts = shipment.customerCosts || {};
    const items = Array.isArray(shipment.items) && shipment.items.length
      ? shipment.items.map((item) => ({
          configurationId: String(item.configurationId || item.configuration_id || ''),
          quantity: Number(item.quantity),
        }))
      : null;
    const shippingCents = Number.isSafeInteger(Number(customerCosts.shippingCents))
      ? Number(customerCosts.shippingCents)
      : Math.round(Number(printfulCosts.shipping || 0) * 100);
    const taxCents = Number.isSafeInteger(Number(customerCosts.taxCents))
      ? Number(customerCosts.taxCents)
      : Math.round(Number(printfulCosts.tax || 0) * 100) +
        Math.round(Number(printfulCosts.vat || 0) * 100);
    stmt.run(
      orderId,
      index,
      shipmentQuantity(shipment),
      items ? JSON.stringify(items) : null,
      JSON.stringify(shipment.recipient),
      JSON.stringify(printfulCosts),
      String(printfulCosts.currency || quote.currency || '').toUpperCase(),
      shippingCents,
      taxCents
    );
  });
}

function createCheckoutOrder({ eventId, configurationId, quote, mode = 'test' }) {
  if (!['test', 'live'].includes(mode)) throw new Error('invalid checkout mode');
  const existing = getOrderByQuoteId(quote.id);
  if (existing) return { order: existing, created: false };
  const configurationIds = getCheckoutQuoteConfigurationIds(quote);
  db.exec('BEGIN IMMEDIATE;');
  try {
    const info = db.prepare(`
      INSERT INTO orders (
        event_id, configuration_id, configuration_ids_json, quote_id, status, shipping_json,
        currency, items_cents, payment_reserve_cents, shipping_cents, tax_cents, total_cents, mode
      ) VALUES (?, ?, ?, ?, 'creating_checkout', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      configurationId || configurationIds[0],
      JSON.stringify(configurationIds.length ? configurationIds : [configurationId]),
      quote.id,
      quote.shipments_json || quote.recipient_json,
      quote.currency,
      Number(quote.items_cents),
      Number(quote.payment_reserve_cents || 0),
      Number(quote.shipping_cents),
      Number(quote.tax_cents),
      Number(quote.total_cents),
      mode
    );
    insertOrderShipments(info.lastInsertRowid, quote);
    db.exec('COMMIT;');
    return { order: getOrderById(info.lastInsertRowid), created: true };
  } catch (error) {
    db.exec('ROLLBACK;');
    // A concurrent double-click can race the initial lookup. The unique
    // quote index makes the database the final arbiter.
    const racedOrder = getOrderByQuoteId(quote.id);
    if (racedOrder) return { order: racedOrder, created: false };
    throw error;
  }
}

function attachStripeSession(orderId, { id, url }) {
  db.prepare(`
    UPDATE orders
    SET stripe_session_id = ?, stripe_checkout_url = ?, status = 'checkout_pending',
        updated_at = datetime('now')
    WHERE id = ? AND status = 'creating_checkout'
  `).run(id, url, orderId);
  return getOrderById(orderId);
}

function markCheckoutCreationFailed(orderId) {
  db.prepare(`
    UPDATE orders SET status = 'checkout_failed', updated_at = datetime('now')
    WHERE id = ? AND status = 'creating_checkout'
  `).run(orderId);
}

function retryCheckoutOrder(orderId) {
  db.prepare(`
    UPDATE orders SET status = 'creating_checkout', updated_at = datetime('now')
    WHERE id = ? AND status = 'checkout_failed'
  `).run(orderId);
  return getOrderById(orderId);
}

/**
 * Record a successful payment and the Stripe event atomically. If
 * Stripe retries the same webhook, the event insert changes zero rows and
 * the order cannot be transitioned or queued for fulfillment twice. Stripe
 * test payments are always queued for the local mock pipeline.
 */
function recordSuccessfulPayment({ stripeEventId, eventType, stripeSessionId, paymentIntentId, livemode }) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const inserted = db.prepare(`
      INSERT INTO stripe_webhook_events (stripe_event_id, event_type, stripe_session_id)
      VALUES (?, ?, ?)
      ON CONFLICT(stripe_event_id) DO NOTHING
    `).run(stripeEventId, eventType, stripeSessionId);
    if (Number(inserted.changes) === 0) {
      db.exec('COMMIT;');
      return { duplicate: true, order: getOrderBySessionId(stripeSessionId) };
    }

    const currentOrder = getOrderBySessionId(stripeSessionId);
    if (currentOrder && ['paid_test', 'paid'].includes(currentOrder.status)) {
      // Stripe can legitimately emit more than one successful event type for
      // the same Session. Treat the Session itself as already processed even
      // when the event id is new.
      db.exec('COMMIT;');
      return { duplicate: true, order: currentOrder };
    }

    const expectedMode = livemode ? 'live' : 'test';
    if (!currentOrder || currentOrder.mode !== expectedMode) {
      throw new Error('checkout mode does not match Stripe payment mode');
    }
    const paymentStatus = livemode ? 'paid' : 'paid_test';
    const fulfillmentMode = livemode ? null : 'mock';
    const updated = db.prepare(`
      UPDATE orders
      SET status = ?, stripe_payment_intent_id = ?, stripe_event_id = ?,
          fulfillment_status = 'pending', fulfillment_mode = ?,
          fulfillment_error = NULL, paid_at = datetime('now'),
          fulfillment_updated_at = datetime('now'), updated_at = datetime('now')
      WHERE stripe_session_id = ? AND status = 'checkout_pending'
    `).run(paymentStatus, paymentIntentId || null, stripeEventId, fulfillmentMode, stripeSessionId);
    if (Number(updated.changes) === 0) {
      throw new Error('checkout order not found or not payable');
    }
    db.exec('COMMIT;');
    return { duplicate: false, order: getOrderBySessionId(stripeSessionId) };
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function recordTestPayment(options) {
  return recordSuccessfulPayment({ ...options, livemode: false });
}

/**
 * Claiming is a single conditional UPDATE. Stripe retries, server restarts
 * and two in-process workers therefore cannot run the same fulfillment at
 * the same time. Completed draft/submitted/mock records are never claimable.
 */
function claimFulfillmentOrder(orderId) {
  const updated = db.prepare(`
    UPDATE orders
    SET fulfillment_status = 'processing',
        fulfillment_attempts = fulfillment_attempts + 1,
        fulfillment_error = NULL,
        fulfillment_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
      AND fulfillment_status IN ('pending', 'failed')
      AND fulfillment_attempts < 3
      AND status IN ('paid_test', 'paid')
  `).run(orderId);
  return Number(updated.changes) === 1 ? getOrderById(orderId) : null;
}

function completeFulfillment(orderId, { mode, payload, printfulOrderId, printfulStatus }) {
  const status = mode === 'mock'
    ? 'mocked'
    : mode === 'draft'
      ? 'draft'
      : 'submitted';
  db.prepare(`
    UPDATE orders
    SET fulfillment_status = ?, fulfillment_mode = ?, fulfillment_payload_json = ?,
        printful_order_id = ?, printful_order_status = ?, fulfillment_error = NULL,
        fulfillment_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND fulfillment_status = 'processing'
  `).run(
    status,
    mode,
    JSON.stringify(payload),
    printfulOrderId || null,
    printfulStatus || status,
    orderId
  );
  return getOrderById(orderId);
}

function getOrderShipments(orderId) {
  return db.prepare(`
    SELECT *
    FROM checkout_order_shipments
    WHERE order_id = ?
    ORDER BY shipment_index ASC
  `).all(orderId);
}

function completeOrderShipment(shipmentId, { mode, payload, printfulOrderId, printfulStatus }) {
  const status = mode === 'mock'
    ? 'mocked'
    : mode === 'draft'
      ? 'draft'
      : 'submitted';
  db.prepare(`
    UPDATE checkout_order_shipments
    SET fulfillment_status = ?, fulfillment_mode = ?, fulfillment_payload_json = ?,
        printful_order_id = ?, printful_order_status = ?, fulfillment_error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    status,
    mode,
    JSON.stringify(payload),
    printfulOrderId || null,
    printfulStatus || status,
    shipmentId
  );
}

function failOrderShipment(shipmentId, error) {
  const safeError = String(error?.message || error || 'Fulfillment fehlgeschlagen').slice(0, 1000);
  db.prepare(`
    UPDATE checkout_order_shipments
    SET fulfillment_status = 'failed',
        fulfillment_attempts = fulfillment_attempts + 1,
        fulfillment_error = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(safeError, shipmentId);
}

function failFulfillment(orderId, error, { blocked = false } = {}) {
  const safeError = String(error?.message || error || 'Fulfillment fehlgeschlagen').slice(0, 1000);
  db.prepare(`
    UPDATE orders
    SET fulfillment_status = ?, fulfillment_error = ?,
        fulfillment_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND fulfillment_status = 'processing'
  `).run(blocked ? 'blocked' : 'failed', safeError, orderId);
  return getOrderById(orderId);
}

function getPendingFulfillmentOrders(limit = 20) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
  return db.prepare(`
    SELECT * FROM orders
    WHERE fulfillment_status IN ('pending', 'failed')
      AND fulfillment_attempts < 3
      AND status IN ('paid_test', 'paid')
    ORDER BY id ASC
    LIMIT ?
  `).all(safeLimit);
}

function recoverStaleFulfillments() {
  return db.prepare(`
    UPDATE orders
    SET fulfillment_status = 'failed',
        fulfillment_error = 'Verarbeitung wurde durch einen Serverneustart unterbrochen.',
        fulfillment_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE fulfillment_status = 'processing'
      AND fulfillment_updated_at < datetime('now', '-15 minutes')
  `).run();
}

// ── Expiring checkout quotes ────────────────────────────────────────────
function checkoutQuoteTtlMs() {
  const minutes = Number(process.env.CHECKOUT_QUOTE_TTL_MINUTES || 30);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 5 && minutes <= 120 ? minutes : 30;
  return Math.round(safeMinutes * 60 * 1000);
}

function cleanupAbandonedQuotes() {
  // Keep checkout/paid records for reconciliation, but remove personal
  // address data from abandoned quotes one day after expiry.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    DELETE FROM checkout_quotes
    WHERE expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.quote_id = checkout_quotes.id)
  `).run(cutoff);
}

function createCheckoutQuote({ eventId, configurationId, configurationIds, recipient, shipments, printfulCosts, quote }) {
  cleanupAbandonedQuotes();
  const id = crypto.randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + checkoutQuoteTtlMs()).toISOString();
  const storedConfigurationIds = uniqueConfigurationIds(configurationIds || [configurationId]);
  const primaryConfigurationId = configurationId || storedConfigurationIds[0];
  const normalizedShipments = Array.isArray(shipments) && shipments.length ? shipments : null;
  const primaryRecipient = recipient || normalizedShipments?.[0]?.recipient;
  const storedPrintfulCosts = printfulCosts ||
    (normalizedShipments
      ? { shipments: normalizedShipments.map((shipment) => shipment.printfulCosts || shipment.costs || {}) }
      : null);
  db.prepare(`
    INSERT INTO checkout_quotes (
      id, event_id, configuration_id, configuration_ids_json, recipient_json, shipments_json, printful_costs_json,
      currency, quantity, items_cents, payment_reserve_cents, shipping_cents, tax_cents, total_cents, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    eventId,
    primaryConfigurationId,
    JSON.stringify(storedConfigurationIds.length ? storedConfigurationIds : [primaryConfigurationId]),
    JSON.stringify(primaryRecipient),
    normalizedShipments ? JSON.stringify(normalizedShipments) : null,
    JSON.stringify(storedPrintfulCosts),
    quote.currency,
    quote.quantity,
    quote.itemsCents,
    quote.paymentReserveCents || 0,
    quote.shippingCents,
    quote.taxCents,
    quote.totalCents,
    expiresAt
  );
  return getCheckoutQuote(id);
}

function getCheckoutQuote(id) {
  return db.prepare('SELECT * FROM checkout_quotes WHERE id = ?').get(id) || null;
}

function getEventCheckoutQuote(slug, configurationId, quoteId) {
  return db.prepare(`
    SELECT checkout_quotes.*
    FROM checkout_quotes
    JOIN events ON events.id = checkout_quotes.event_id
    WHERE checkout_quotes.id = ?
      AND checkout_quotes.configuration_id = ?
      AND events.slug = ?
  `).get(quoteId, configurationId, slug) || null;
}

function getEventCartCheckoutQuote(slug, configurationIds, quoteId) {
  const quote = db.prepare(`
    SELECT checkout_quotes.*
    FROM checkout_quotes
    JOIN events ON events.id = checkout_quotes.event_id
    WHERE checkout_quotes.id = ?
      AND events.slug = ?
  `).get(quoteId, slug) || null;
  if (!quote) return null;
  const expectedIds = uniqueConfigurationIds(configurationIds).sort();
  const storedIds = getCheckoutQuoteConfigurationIds(quote).sort();
  if (expectedIds.length !== storedIds.length ||
      expectedIds.some((id, index) => id !== storedIds[index])) {
    return null;
  }
  return quote;
}

function updateCheckoutQuote(quoteId, { recipient, shipments, printfulCosts, quote }) {
  const expiresAt = new Date(Date.now() + checkoutQuoteTtlMs()).toISOString();
  const normalizedShipments = Array.isArray(shipments) && shipments.length ? shipments : null;
  const primaryRecipient = recipient || normalizedShipments?.[0]?.recipient || null;
  const storedPrintfulCosts = printfulCosts ||
    (normalizedShipments
      ? { shipments: normalizedShipments.map((shipment) => shipment.printfulCosts || shipment.costs || {}) }
      : null);
  if (normalizedShipments) {
    db.prepare(`
      UPDATE checkout_quotes
      SET recipient_json = ?, shipments_json = ?, printful_costs_json = ?,
          currency = ?, quantity = ?, items_cents = ?, payment_reserve_cents = ?,
          shipping_cents = ?, tax_cents = ?, total_cents = ?, expires_at = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(primaryRecipient),
      JSON.stringify(normalizedShipments),
      JSON.stringify(storedPrintfulCosts),
      quote.currency,
      quote.quantity,
      quote.itemsCents,
      quote.paymentReserveCents || 0,
      quote.shippingCents,
      quote.taxCents,
      quote.totalCents,
      expiresAt,
      quoteId
    );
    return getCheckoutQuote(quoteId);
  }
  db.prepare(`
    UPDATE checkout_quotes
    SET printful_costs_json = ?, currency = ?, quantity = ?, items_cents = ?, payment_reserve_cents = ?,
        shipping_cents = ?, tax_cents = ?, total_cents = ?, expires_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(storedPrintfulCosts),
    quote.currency,
    quote.quantity,
    quote.itemsCents,
    quote.paymentReserveCents || 0,
    quote.shippingCents,
    quote.taxCents,
    quote.totalCents,
    expiresAt,
    quoteId
  );
  return getCheckoutQuote(quoteId);
}

function isCheckoutQuoteExpired(quote) {
  return !quote || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now();
}

// ── Product configurations ──────────────────────────────────────────────
// A configuration stores the exact word list the couple previewed. This is
// intentionally separate from the live `words` table: guests may keep
// submitting after the couple opens the configurator, but an approved print
// file must remain immutable from preview through fulfillment.
function createConfiguration({
  eventId,
  productKey,
  printfulVariantId,
  quantity,
  unitPriceCents,
  theme,
  placement,
  words,
  design,
  configurationType = 'event_wordcloud',
  printWidth,
  printHeight,
}) {
  const id = crypto.randomBytes(12).toString('base64url');
  db.prepare(`
    INSERT INTO configurations (
      id, event_id, product_key, printful_variant_id, quantity,
      unit_price_cents, theme, placement, words_json, design_json,
      configuration_type, print_width, print_height
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    eventId,
    productKey,
    printfulVariantId,
    quantity,
    unitPriceCents,
    theme,
    placement,
    JSON.stringify(words),
    design ? JSON.stringify(design) : null,
    configurationType,
    printWidth,
    printHeight
  );
  return getConfiguration(id);
}

function getConfiguration(id) {
  return db.prepare('SELECT * FROM configurations WHERE id = ?').get(id) || null;
}

function getEventConfiguration(slug, configurationId) {
  return db.prepare(`
    SELECT configurations.*
    FROM configurations
    JOIN events ON events.id = configurations.event_id
    WHERE configurations.id = ? AND events.slug = ?
  `).get(configurationId, slug) || null;
}

function getEventConfigurations(slug, configurationIds) {
  const ids = uniqueConfigurationIds(configurationIds);
  if (!ids.length) return [];
  const rows = ids
    .map((id) => getEventConfiguration(slug, id))
    .filter(Boolean);
  if (rows.length !== ids.length) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id));
}

module.exports = {
  db,
  hashPin,
  verifyPin,
  createEvent,
  getEventBySlug,
  getEventById,
  slugExists,
  setEventTheme,
  upsertWord,
  addWordContribution,
  getWordContributions,
  removeWordContribution,
  getWords,
  clearWords,
  archiveWords,
  createOrder,
  markOrderPaid,
  markOrderFulfilled,
  getOrderBySessionId,
  getOrderById,
  getOrderByQuoteId,
  getEventOrderBySessionId,
  getCheckoutQuoteShipments,
  getCheckoutQuoteConfigurationIds,
  getOrderConfigurationIds,
  createCheckoutOrder,
  attachStripeSession,
  markCheckoutCreationFailed,
  retryCheckoutOrder,
  recordSuccessfulPayment,
  recordTestPayment,
  claimFulfillmentOrder,
  completeFulfillment,
  getOrderShipments,
  completeOrderShipment,
  failOrderShipment,
  failFulfillment,
  getPendingFulfillmentOrders,
  recoverStaleFulfillments,
  createCheckoutQuote,
  getCheckoutQuote,
  getEventCheckoutQuote,
  getEventCartCheckoutQuote,
  updateCheckoutQuote,
  isCheckoutQuoteExpired,
  createConfiguration,
  getConfiguration,
  getEventConfiguration,
  getEventConfigurations,
};
