'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const { connectionOptions } = require('./dbConfig');
const { getProduct, resolveProductOrientation } = require('./products');

const REQUIRED_SCHEMA_VERSION = '1';
const JSON_COLUMNS = new Set([
  'words_json',
  'design_json',
  'shipping_json',
  'fulfillment_payload_json',
  'configuration_ids_json',
  'checkout_request_json',
  'recipient_json',
  'shipments_json',
  'printful_costs_json',
  'items_json',
  'configuration_snapshot_json',
]);

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new Pool(connectionOptions(process.env.DATABASE_URL));
  pool.on('error', (error) => {
    console.error('[database] idle Postgres client failed:', error.message);
  });
  return pool;
}

function toBoundaryValue(key, value) {
  if (value instanceof Date) return value.toISOString();
  if (JSON_COLUMNS.has(key) && value != null && typeof value !== 'string') {
    return JSON.stringify(value);
  }
  return value;
}

function rowToBoundary(row) {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, toBoundaryValue(key, value)])
  );
}

function rowsToBoundary(rows) {
  return rows.map(rowToBoundary);
}

function jsonValue(value) {
  return JSON.stringify(value == null ? null : value);
}

async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

async function assertDatabaseReady() {
  const result = await getPool().query(`
    SELECT
      (SELECT version::text FROM app_schema_versions ORDER BY version DESC LIMIT 1) AS version,
      current_user AS current_user,
      has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create_schema_objects
  `);
  if (result.rows[0]?.version !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(
      `Postgres-Schema ist nicht aktuell (erwartet: ${REQUIRED_SCHEMA_VERSION}). ` +
      'Bitte zuerst die Supabase-Migrationen anwenden.'
    );
  }
  if (process.env.NODE_ENV === 'production' &&
      (result.rows[0].current_user !== 'wolkenworte_app' || result.rows[0].can_create_schema_objects)) {
    throw new Error('Der Produktionsprozess verwendet nicht die eingeschränkte wolkenworte_app-Rolle.');
  }
  return true;
}

async function checkDatabaseReady(timeoutMs = 1_500) {
  let timeout;
  try {
    return await Promise.race([
      assertDatabaseReady(),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Postgres readiness timed out.')), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// ── PIN hashing ─────────────────────────────────────────────────────────
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPin(pin, hash, salt) {
  const candidate = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Events ──────────────────────────────────────────────────────────────
async function createEvent({ slug, coupleName, pin, locale = 'de' }) {
  const { hash, salt } = hashPin(pin);
  const result = await getPool().query(`
    INSERT INTO events (
      slug, couple_name, admin_pin_hash, admin_pin_salt, locale, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, transaction_timestamp(), transaction_timestamp() + interval '365 days')
    RETURNING *
  `, [slug, coupleName, hash, salt, locale]);
  return rowToBoundary(result.rows[0]);
}

async function getEventBySlug(slug) {
  const result = await getPool().query('SELECT * FROM events WHERE slug = $1', [slug]);
  return rowToBoundary(result.rows[0]);
}

async function getEventById(id) {
  const result = await getPool().query('SELECT * FROM events WHERE id = $1', [id]);
  return rowToBoundary(result.rows[0]);
}

async function slugExists(slug) {
  const result = await getPool().query('SELECT EXISTS (SELECT 1 FROM events WHERE slug = $1) AS exists', [slug]);
  return result.rows[0].exists;
}

async function setEventTheme(eventId, theme) {
  await getPool().query('UPDATE events SET theme = $1 WHERE id = $2', [theme, eventId]);
}

// ── Words ───────────────────────────────────────────────────────────────
async function upsertWordWith(client, eventId, word) {
  await client.query(`
    INSERT INTO words (event_id, word, count, updated_at)
    VALUES ($1, $2, 1, transaction_timestamp())
    ON CONFLICT (event_id, word) DO UPDATE SET
      count = words.count + 1,
      updated_at = transaction_timestamp()
  `, [eventId, word]);
}

async function upsertWord(eventId, word) {
  await upsertWordWith(getPool(), eventId, word);
}

async function addWordContribution(eventId, word, ownerId) {
  const receiptId = crypto.randomBytes(18).toString('base64url');
  // One Postgres statement is one transaction. The event KEY SHARE lock is
  // compatible across submissions but conflicts with reset's FOR UPDATE lock,
  // so the aggregate and its receipt are wholly before or after a reset.
  const result = await getPool().query(`
    WITH locked_event AS MATERIALIZED (
      SELECT id FROM events WHERE id = $1 FOR KEY SHARE
    ), upserted_word AS (
      INSERT INTO words (event_id, word, count, updated_at)
      SELECT id, $2, 1, transaction_timestamp()
      FROM locked_event
      ON CONFLICT (event_id, word) DO UPDATE SET
        count = words.count + 1,
        updated_at = transaction_timestamp()
      RETURNING event_id, word
    ), inserted_contribution AS (
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      SELECT $3, event_id, word, $4
      FROM upserted_word
      RETURNING receipt_id
    )
    SELECT receipt_id FROM inserted_contribution
  `, [eventId, word, receiptId, ownerId]);
  if (!result.rowCount) throw new Error('event not found');
  return result.rows[0].receipt_id;
}

async function getWordContributions(eventId, ownerId) {
  const result = await getPool().query(`
    SELECT receipt_id, word
    FROM word_contributions
    WHERE event_id = $1 AND owner_id = $2
    ORDER BY created_at ASC, receipt_id ASC
  `, [eventId, ownerId]);
  return result.rows.map((row) => ({ receipt: row.receipt_id, word: row.word }));
}

async function removeWordContribution(eventId, receiptId, ownerId) {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM events WHERE id = $1 FOR KEY SHARE', [eventId]);
    const deleted = await client.query(`
      DELETE FROM word_contributions
      WHERE event_id = $1 AND receipt_id = $2 AND owner_id = $3
      RETURNING word
    `, [eventId, receiptId, ownerId]);
    const contribution = deleted.rows[0];
    if (!contribution) return null;

    const aggregate = await client.query(`
      SELECT count FROM words
      WHERE event_id = $1 AND word = $2
      FOR UPDATE
    `, [eventId, contribution.word]);
    if (!aggregate.rows[0] || aggregate.rows[0].count <= 1) {
      await client.query('DELETE FROM words WHERE event_id = $1 AND word = $2', [eventId, contribution.word]);
    } else {
      await client.query(`
        UPDATE words
        SET count = count - 1, updated_at = transaction_timestamp()
        WHERE event_id = $1 AND word = $2
      `, [eventId, contribution.word]);
    }
    return contribution.word;
  });
}

async function getWordsWith(queryable, eventId) {
  const result = await queryable.query(`
    SELECT word, count
    FROM words
    WHERE event_id = $1
    ORDER BY count DESC, word ASC
  `, [eventId]);
  return result.rows.map((row) => [row.word, row.count]);
}

async function getWords(eventId) {
  return getWordsWith(getPool(), eventId);
}

async function clearWords(eventId) {
  await getPool().query('DELETE FROM words WHERE event_id = $1', [eventId]);
}

async function archiveWords(eventId) {
  const words = await getWords(eventId);
  if (!words.length) return null;
  await getPool().query(
    'INSERT INTO archives (event_id, words_json) VALUES ($1, $2::jsonb)',
    [eventId, jsonValue(words)]
  );
  return words;
}

async function archiveAndClearWords(eventId) {
  return withTransaction(async (client) => {
    const locked = await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!locked.rowCount) return null;
    const words = await getWordsWith(client, eventId);
    if (words.length) {
      await client.query(
        'INSERT INTO archives (event_id, words_json) VALUES ($1, $2::jsonb)',
        [eventId, jsonValue(words)]
      );
    }
    await client.query('DELETE FROM words WHERE event_id = $1', [eventId]);
    return words;
  });
}

// ── JSON helpers ────────────────────────────────────────────────────────
function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseJsonArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
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
  const explicit = Number(shipment?.quantity);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  if (Array.isArray(shipment?.items)) {
    return shipment.items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  }
  return 0;
}

function getCheckoutQuoteShipments(quote) {
  if (!quote) return [];
  const stored = parseJson(quote.shipments_json);
  if (Array.isArray(stored)) {
    return stored.map((shipment) => ({ ...shipment, quantity: shipmentQuantity(shipment) }));
  }
  const recipient = parseJson(quote.recipient_json);
  const printfulCosts = parseJson(quote.printful_costs_json);
  const quantity = Number(quote.quantity);
  if (!recipient || !Number.isSafeInteger(quantity) || quantity < 1) return [];
  return [{ quantity, recipient, printfulCosts }];
}

// ── Orders and checkout ─────────────────────────────────────────────────
async function createOrder({ eventId, stripeSessionId }) {
  return withTransaction(async (client) => {
    const eventResult = await client.query('SELECT slug, couple_name FROM events WHERE id = $1', [eventId]);
    const event = eventResult.rows[0];
    if (!event) throw new Error('event not found');
    const result = await client.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot, stripe_session_id, status
      ) VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id
    `, [eventId, event.slug, event.couple_name, stripeSessionId]);
    return result.rows[0].id;
  });
}

async function markOrderPaid(stripeSessionId, shippingJson) {
  await getPool().query(`
    UPDATE orders
    SET status = 'paid', shipping_json = $1::jsonb, updated_at = transaction_timestamp()
    WHERE stripe_session_id = $2
  `, [typeof shippingJson === 'string' ? shippingJson : jsonValue(shippingJson), stripeSessionId]);
}

async function markOrderFulfilled(stripeSessionId, printfulOrderId) {
  await getPool().query(`
    UPDATE orders
    SET status = 'fulfilled', printful_order_id = $1, updated_at = transaction_timestamp()
    WHERE stripe_session_id = $2
  `, [printfulOrderId, stripeSessionId]);
}

async function oneOrder(sql, params) {
  const result = await getPool().query(sql, params);
  return rowToBoundary(result.rows[0]);
}

async function getOrderBySessionId(stripeSessionId) {
  return oneOrder('SELECT * FROM orders WHERE stripe_session_id = $1', [stripeSessionId]);
}

async function getOrderById(id) {
  return oneOrder('SELECT * FROM orders WHERE id = $1', [id]);
}

async function getOrderByQuoteId(quoteId) {
  return oneOrder('SELECT * FROM orders WHERE quote_id = $1', [quoteId]);
}

async function getEventOrderBySessionId(slug, stripeSessionId) {
  return oneOrder(`
    SELECT orders.*
    FROM orders
    WHERE orders.stripe_session_id = $1
      AND orders.event_slug_snapshot = $2
  `, [stripeSessionId, slug]);
}

function normalizedShipmentItems(shipment, primaryConfigurationId) {
  if (Array.isArray(shipment.items) && shipment.items.length) {
    return shipment.items.map((item) => ({
      configurationId: String(item.configurationId || item.configuration_id || ''),
      quantity: Number(item.quantity),
    }));
  }
  return [{ configurationId: primaryConfigurationId, quantity: shipmentQuantity(shipment) }];
}

function configurationSnapshot(configuration) {
  const product = resolveProductOrientation(
    getProduct(configuration.product_key),
    configuration.orientation
  );
  if (!product) throw new Error('configuration product is invalid');
  return {
    version: 1,
    configurationId: configuration.id,
    productKey: configuration.product_key,
    printfulVariantId: configuration.printful_variant_id,
    printfulPlacements: product.printful.placements,
    printfulOptions: product.printful.options,
    orientation: configuration.orientation,
    configurationType: configuration.configuration_type,
    theme: configuration.theme,
    printWidth: configuration.print_width,
    printHeight: configuration.print_height,
    words: parseJson(configuration.words_json, []),
    design: parseJson(configuration.design_json),
    createdAt: configuration.created_at,
  };
}

async function insertOrderShipmentsAndItems(client, orderId, quote, configurations) {
  const shipments = getCheckoutQuoteShipments(quote);
  const configurationById = new Map(configurations.map((entry) => [entry.id, entry]));
  for (let shipmentIndex = 0; shipmentIndex < shipments.length; shipmentIndex += 1) {
    const shipment = shipments[shipmentIndex];
    const printfulCosts = shipment.printfulCosts || shipment.costs || {};
    const customerCosts = shipment.customerCosts || {};
    const items = normalizedShipmentItems(shipment, quote.configuration_id);
    const shippingCents = Number.isSafeInteger(Number(customerCosts.shippingCents))
      ? Number(customerCosts.shippingCents)
      : Math.round(Number(printfulCosts.shipping || 0) * 100);
    const taxCents = Number.isSafeInteger(Number(customerCosts.taxCents))
      ? Number(customerCosts.taxCents)
      : Math.round(Number(printfulCosts.tax || 0) * 100) + Math.round(Number(printfulCosts.vat || 0) * 100);
    await client.query(`
      INSERT INTO checkout_order_shipments (
        order_id, shipment_index, quantity, items_json, recipient_json,
        printful_costs_json, currency, shipping_cents, tax_cents
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
    `, [
      orderId,
      shipmentIndex,
      shipmentQuantity(shipment),
      jsonValue(items),
      jsonValue(shipment.recipient),
      jsonValue(printfulCosts),
      String(printfulCosts.currency || quote.currency || '').toUpperCase(),
      shippingCents,
      taxCents,
    ]);

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      const configuration = configurationById.get(item.configurationId);
      if (!configuration || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
        throw new Error('checkout item configuration is invalid');
      }
      await client.query(`
        INSERT INTO order_items (
          order_id, configuration_id, shipment_index, item_index, product_key,
          printful_variant_id, quantity, configuration_snapshot_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [
        orderId,
        configuration.id,
        shipmentIndex,
        itemIndex,
        configuration.product_key,
        configuration.printful_variant_id,
        item.quantity,
        jsonValue(configurationSnapshot(configuration)),
      ]);
    }
  }
}

async function createCheckoutOrder({ eventId, configurationId, quote, mode = 'test', checkoutRequest = null }) {
  if (!['test', 'live'].includes(mode)) throw new Error('invalid checkout mode');
  return withTransaction(async (client) => {
    const lockedQuoteResult = await client.query(
      'SELECT * FROM checkout_quotes WHERE id = $1 FOR UPDATE',
      [quote.id]
    );
    const lockedQuote = rowToBoundary(lockedQuoteResult.rows[0]);
    if (!lockedQuote || String(lockedQuote.event_id) !== String(eventId)) {
      throw new Error('checkout quote not found');
    }
    const existingResult = await client.query('SELECT * FROM orders WHERE quote_id = $1', [lockedQuote.id]);
    if (existingResult.rows[0]) {
      return { order: rowToBoundary(existingResult.rows[0]), created: false };
    }

    const eventResult = await client.query(
      'SELECT slug, couple_name FROM events WHERE id = $1 FOR KEY SHARE',
      [eventId]
    );
    const event = eventResult.rows[0];
    if (!event) throw new Error('event not found');

    const configurationIds = getCheckoutQuoteConfigurationIds(lockedQuote);
    const configurationResult = await client.query(`
      SELECT * FROM configurations
      WHERE id = ANY($1::text[]) AND event_id = $2
      FOR KEY SHARE
    `, [configurationIds, eventId]);
    const configurations = rowsToBoundary(configurationResult.rows);
    if (configurations.length !== configurationIds.length) {
      throw new Error('checkout configuration not found');
    }

    const idempotencyKey = `wolkenworte-${mode}-quote-${lockedQuote.id}`;
    const sessionExpiresAt = new Date(Date.now() + 31 * 60 * 1000);
    const inserted = await client.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot,
        configuration_id, configuration_ids_json, quote_id, status, shipping_json,
        currency, items_cents, payment_reserve_cents, shipping_cents, tax_cents,
        total_cents, mode, checkout_request_json, stripe_idempotency_key,
        checkout_session_expires_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, 'creating_checkout', $7::jsonb,
        $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17
      )
      RETURNING *
    `, [
      eventId,
      event.slug,
      event.couple_name,
      configurationId || configurationIds[0],
      jsonValue(configurationIds),
      lockedQuote.id,
      lockedQuote.shipments_json || lockedQuote.recipient_json,
      lockedQuote.currency,
      lockedQuote.items_cents,
      lockedQuote.payment_reserve_cents || 0,
      lockedQuote.shipping_cents,
      lockedQuote.tax_cents,
      lockedQuote.total_cents,
      mode,
      jsonValue(checkoutRequest || {}),
      idempotencyKey,
      sessionExpiresAt,
    ]);
    const order = rowToBoundary(inserted.rows[0]);
    await insertOrderShipmentsAndItems(client, order.id, lockedQuote, configurations);
    return { order, created: true };
  });
}

async function claimCheckoutAttempt(orderId) {
  const result = await getPool().query(`
    UPDATE orders
    SET checkout_first_attempt_at = coalesce(checkout_first_attempt_at, transaction_timestamp()),
        checkout_last_attempt_at = transaction_timestamp(),
        checkout_attempts = checkout_attempts + 1,
        checkout_ambiguous = false,
        checkout_error = null,
        updated_at = transaction_timestamp()
    WHERE id = $1
      AND status = 'creating_checkout'
      AND stripe_session_id IS NULL
      AND checkout_session_expires_at > transaction_timestamp()
      AND (
        checkout_last_attempt_at IS NULL OR
        checkout_ambiguous = true OR
        checkout_last_attempt_at < transaction_timestamp() - interval '30 seconds'
      )
    RETURNING *
  `, [orderId]);
  return rowToBoundary(result.rows[0]);
}

async function attachStripeSession(orderId, { id, url }) {
  const result = await getPool().query(`
    UPDATE orders
    SET stripe_session_id = $1, stripe_checkout_url = $2,
        status = 'checkout_pending', checkout_ambiguous = false,
        checkout_error = null, updated_at = transaction_timestamp()
    WHERE id = $3 AND status = 'creating_checkout' AND stripe_session_id IS NULL
    RETURNING *
  `, [id, url, orderId]);
  if (!result.rows[0]) {
    const existing = await getOrderById(orderId);
    if (existing?.stripe_session_id === id) return existing;
    throw new Error('checkout session could not be attached');
  }
  return rowToBoundary(result.rows[0]);
}

async function markCheckoutCreationFailed(orderId, error = null) {
  const safeError = String(error?.message || error || 'Stripe Checkout response was not persisted').slice(0, 1000);
  const result = await getPool().query(`
    UPDATE orders
    SET checkout_ambiguous = true, checkout_error = $1, updated_at = transaction_timestamp()
    WHERE id = $2 AND status = 'creating_checkout' AND stripe_session_id IS NULL
    RETURNING *
  `, [safeError, orderId]);
  return rowToBoundary(result.rows[0]);
}

async function retryCheckoutOrder(orderId) {
  return getOrderById(orderId);
}

function normalizeBuyerEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFC').trim().toLowerCase();
  if (!email || email.length > 254 || /[\x00-\x20\x7f]/.test(email)) return null;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return null;
  return email;
}

async function recordSuccessfulPayment({
  stripeEventId,
  eventType,
  stripeSessionId,
  paymentIntentId,
  livemode,
  orderId = null,
  quoteId = null,
  amountTotal = null,
  currency = null,
  paymentStatus = 'paid',
  buyerEmail = null,
}) {
  return withTransaction(async (client) => {
    const insertedEvent = await client.query(`
      INSERT INTO stripe_webhook_events (stripe_event_id, event_type, stripe_session_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `, [stripeEventId, eventType, stripeSessionId]);
    if (!insertedEvent.rowCount) {
      const duplicateOrder = await client.query(`
        SELECT * FROM orders
        WHERE stripe_session_id = $1 OR ($2::bigint IS NOT NULL AND id = $2)
        ORDER BY (stripe_session_id = $1) DESC
        LIMIT 1
      `, [stripeSessionId, orderId]);
      return { duplicate: true, order: rowToBoundary(duplicateOrder.rows[0]) };
    }

    let orderResult = await client.query(
      'SELECT * FROM orders WHERE stripe_session_id = $1 FOR UPDATE',
      [stripeSessionId]
    );
    if (!orderResult.rows[0] && orderId && quoteId) {
      orderResult = await client.query(`
        SELECT * FROM orders
        WHERE id = $1 AND quote_id = $2 AND stripe_session_id IS NULL
        FOR UPDATE
      `, [orderId, quoteId]);
    }
    const order = orderResult.rows[0];
    if (!order) throw new Error('checkout order not found or not payable');

    const expectedMode = livemode ? 'live' : 'test';
    const trustedAmount = amountTotal == null || Number(amountTotal) === order.total_cents;
    const trustedCurrency = currency == null || String(currency).toUpperCase() === order.currency;
    if (order.mode !== expectedMode || !trustedAmount || !trustedCurrency || paymentStatus !== 'paid') {
      throw new Error('checkout payment does not match trusted order data');
    }
    if (order.quote_id && quoteId && order.quote_id !== quoteId) {
      throw new Error('checkout quote does not match trusted order data');
    }

    if (['paid_test', 'paid'].includes(order.status)) {
      await client.query(
        'UPDATE stripe_webhook_events SET order_id = $1 WHERE stripe_event_id = $2',
        [order.id, stripeEventId]
      );
      return { duplicate: true, order: rowToBoundary(order) };
    }
    if (!['checkout_pending', 'creating_checkout'].includes(order.status)) {
      throw new Error('checkout order not found or not payable');
    }

    const paymentState = livemode ? 'paid' : 'paid_test';
    const fulfillmentMode = livemode ? null : 'mock';
    const storedBuyerEmail = normalizeBuyerEmail(buyerEmail);
    const updated = await client.query(`
      UPDATE orders
      SET stripe_session_id = coalesce(stripe_session_id, $1),
          stripe_payment_intent_id = $2,
          stripe_event_id = $3,
          buyer_email = coalesce(buyer_email, $4),
          status = $5,
          fulfillment_status = 'pending',
          fulfillment_mode = $6,
          fulfillment_error = null,
          paid_at = transaction_timestamp(),
          fulfillment_updated_at = transaction_timestamp(),
          checkout_ambiguous = false,
          checkout_error = null,
          updated_at = transaction_timestamp()
      WHERE id = $7
      RETURNING *
    `, [
      stripeSessionId,
      paymentIntentId || null,
      stripeEventId,
      storedBuyerEmail,
      paymentState,
      fulfillmentMode,
      order.id,
    ]);
    await client.query(
      'UPDATE stripe_webhook_events SET order_id = $1 WHERE stripe_event_id = $2',
      [order.id, stripeEventId]
    );
    return { duplicate: false, order: rowToBoundary(updated.rows[0]) };
  });
}

async function recordTestPayment(options) {
  return recordSuccessfulPayment({ ...options, livemode: false });
}

async function claimFulfillmentOrder(orderId) {
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = 'processing',
        fulfillment_attempts = fulfillment_attempts + 1,
        fulfillment_error = null,
        fulfillment_updated_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    WHERE id = $1
      AND fulfillment_status IN ('pending', 'failed')
      AND fulfillment_attempts < 3
      AND status IN ('paid_test', 'paid')
    RETURNING *
  `, [orderId]);
  return rowToBoundary(result.rows[0]);
}

async function completeFulfillment(orderId, { mode, payload, printfulOrderId, printfulStatus }) {
  const status = mode === 'mock' ? 'mocked' : mode === 'draft' ? 'draft' : 'submitted';
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = $1, fulfillment_mode = $2,
        fulfillment_payload_json = $3::jsonb, printful_order_id = $4,
        printful_order_status = $5, fulfillment_error = null,
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE id = $6 AND fulfillment_status = 'processing'
    RETURNING *
  `, [status, mode, jsonValue(payload), printfulOrderId || null, printfulStatus || status, orderId]);
  return rowToBoundary(result.rows[0]);
}

async function getOrderShipments(orderId) {
  const result = await getPool().query(`
    SELECT * FROM checkout_order_shipments
    WHERE order_id = $1
    ORDER BY shipment_index ASC
  `, [orderId]);
  return rowsToBoundary(result.rows);
}

async function getOrderItems(orderId) {
  const result = await getPool().query(`
    SELECT * FROM order_items
    WHERE order_id = $1
    ORDER BY shipment_index ASC, item_index ASC
  `, [orderId]);
  return rowsToBoundary(result.rows);
}

async function completeOrderShipment(shipmentId, { mode, payload, printfulOrderId, printfulStatus }) {
  const status = mode === 'mock' ? 'mocked' : mode === 'draft' ? 'draft' : 'submitted';
  await getPool().query(`
    UPDATE checkout_order_shipments
    SET fulfillment_status = $1, fulfillment_mode = $2,
        fulfillment_payload_json = $3::jsonb, printful_order_id = $4,
        printful_order_status = $5, fulfillment_error = null,
        updated_at = transaction_timestamp()
    WHERE id = $6
  `, [status, mode, jsonValue(payload), printfulOrderId || null, printfulStatus || status, shipmentId]);
}

async function failOrderShipment(shipmentId, error) {
  const safeError = String(error?.message || error || 'Fulfillment fehlgeschlagen').slice(0, 1000);
  await getPool().query(`
    UPDATE checkout_order_shipments
    SET fulfillment_status = 'failed', fulfillment_attempts = fulfillment_attempts + 1,
        fulfillment_error = $1, updated_at = transaction_timestamp()
    WHERE id = $2
  `, [safeError, shipmentId]);
}

async function failFulfillment(orderId, error, { blocked = false } = {}) {
  const safeError = String(error?.message || error || 'Fulfillment fehlgeschlagen').slice(0, 1000);
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = $1, fulfillment_error = $2,
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE id = $3 AND fulfillment_status = 'processing'
    RETURNING *
  `, [blocked ? 'blocked' : 'failed', safeError, orderId]);
  return rowToBoundary(result.rows[0]);
}

async function getPendingFulfillmentOrders(limit = 20) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
  const result = await getPool().query(`
    SELECT * FROM orders
    WHERE fulfillment_status IN ('pending', 'failed')
      AND fulfillment_attempts < 3
      AND status IN ('paid_test', 'paid')
    ORDER BY id ASC
    LIMIT $1
  `, [safeLimit]);
  return rowsToBoundary(result.rows);
}

async function recoverStaleFulfillments() {
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = 'failed',
        fulfillment_error = 'Verarbeitung wurde durch einen Serverneustart unterbrochen.',
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE fulfillment_status = 'processing'
      AND fulfillment_updated_at < transaction_timestamp() - interval '15 minutes'
  `);
  return result.rowCount;
}

// ── Expiring checkout quotes ────────────────────────────────────────────
function checkoutQuoteTtlMs() {
  const minutes = Number(process.env.CHECKOUT_QUOTE_TTL_MINUTES || 30);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 5 && minutes <= 120 ? minutes : 30;
  return Math.round(safeMinutes * 60 * 1000);
}

async function cleanupAbandonedQuotes() {
  await getPool().query(`
    DELETE FROM checkout_quotes
    WHERE expires_at < transaction_timestamp() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.quote_id = checkout_quotes.id)
  `);
}

async function createCheckoutQuote({ eventId, configurationId, configurationIds, recipient, shipments, printfulCosts, quote }) {
  await cleanupAbandonedQuotes();
  const id = crypto.randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + checkoutQuoteTtlMs());
  const storedConfigurationIds = uniqueConfigurationIds(configurationIds || [configurationId]);
  const primaryConfigurationId = configurationId || storedConfigurationIds[0];
  const normalizedShipments = Array.isArray(shipments) && shipments.length ? shipments : null;
  const primaryRecipient = recipient || normalizedShipments?.[0]?.recipient;
  const storedPrintfulCosts = printfulCosts || (normalizedShipments
    ? { shipments: normalizedShipments.map((shipment) => shipment.printfulCosts || shipment.costs || {}) }
    : null);
  const result = await getPool().query(`
    INSERT INTO checkout_quotes (
      id, event_id, configuration_id, configuration_ids_json, recipient_json,
      shipments_json, printful_costs_json, currency, quantity, items_cents,
      payment_reserve_cents, shipping_cents, tax_cents, total_cents, expires_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9,
      $10, $11, $12, $13, $14, $15
    )
    RETURNING *
  `, [
    id,
    eventId,
    primaryConfigurationId,
    jsonValue(storedConfigurationIds.length ? storedConfigurationIds : [primaryConfigurationId]),
    jsonValue(primaryRecipient),
    normalizedShipments ? jsonValue(normalizedShipments) : null,
    jsonValue(storedPrintfulCosts),
    quote.currency,
    quote.quantity,
    quote.itemsCents,
    quote.paymentReserveCents || 0,
    quote.shippingCents,
    quote.taxCents,
    quote.totalCents,
    expiresAt,
  ]);
  return rowToBoundary(result.rows[0]);
}

async function getCheckoutQuote(id) {
  const result = await getPool().query('SELECT * FROM checkout_quotes WHERE id = $1', [id]);
  return rowToBoundary(result.rows[0]);
}

async function getEventCheckoutQuote(slug, configurationId, quoteId) {
  const result = await getPool().query(`
    SELECT checkout_quotes.*
    FROM checkout_quotes
    JOIN events ON events.id = checkout_quotes.event_id
    WHERE checkout_quotes.id = $1
      AND checkout_quotes.configuration_id = $2
      AND events.slug = $3
  `, [quoteId, configurationId, slug]);
  return rowToBoundary(result.rows[0]);
}

async function getEventCartCheckoutQuote(slug, configurationIds, quoteId) {
  const result = await getPool().query(`
    SELECT checkout_quotes.*
    FROM checkout_quotes
    JOIN events ON events.id = checkout_quotes.event_id
    WHERE checkout_quotes.id = $1 AND events.slug = $2
  `, [quoteId, slug]);
  const quote = rowToBoundary(result.rows[0]);
  if (!quote) return null;
  const expectedIds = uniqueConfigurationIds(configurationIds).sort();
  const storedIds = getCheckoutQuoteConfigurationIds(quote).sort();
  if (expectedIds.length !== storedIds.length || expectedIds.some((id, index) => id !== storedIds[index])) {
    return null;
  }
  return quote;
}

async function updateCheckoutQuote(quoteId, { recipient, shipments, printfulCosts, quote }) {
  const expiresAt = new Date(Date.now() + checkoutQuoteTtlMs());
  const normalizedShipments = Array.isArray(shipments) && shipments.length ? shipments : null;
  const primaryRecipient = recipient || normalizedShipments?.[0]?.recipient || null;
  const storedPrintfulCosts = printfulCosts || (normalizedShipments
    ? { shipments: normalizedShipments.map((shipment) => shipment.printfulCosts || shipment.costs || {}) }
    : null);
  const result = normalizedShipments
    ? await getPool().query(`
        UPDATE checkout_quotes
        SET recipient_json = $1::jsonb, shipments_json = $2::jsonb,
            printful_costs_json = $3::jsonb, currency = $4, quantity = $5,
            items_cents = $6, payment_reserve_cents = $7, shipping_cents = $8,
            tax_cents = $9, total_cents = $10, expires_at = $11,
            updated_at = transaction_timestamp()
        WHERE id = $12
        RETURNING *
      `, [
        jsonValue(primaryRecipient), jsonValue(normalizedShipments), jsonValue(storedPrintfulCosts),
        quote.currency, quote.quantity, quote.itemsCents, quote.paymentReserveCents || 0,
        quote.shippingCents, quote.taxCents, quote.totalCents, expiresAt, quoteId,
      ])
    : await getPool().query(`
        UPDATE checkout_quotes
        SET printful_costs_json = $1::jsonb, currency = $2, quantity = $3,
            items_cents = $4, payment_reserve_cents = $5, shipping_cents = $6,
            tax_cents = $7, total_cents = $8, expires_at = $9,
            updated_at = transaction_timestamp()
        WHERE id = $10
        RETURNING *
      `, [
        jsonValue(storedPrintfulCosts), quote.currency, quote.quantity, quote.itemsCents,
        quote.paymentReserveCents || 0, quote.shippingCents, quote.taxCents,
        quote.totalCents, expiresAt, quoteId,
      ]);
  return rowToBoundary(result.rows[0]);
}

function isCheckoutQuoteExpired(quote) {
  return !quote || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now();
}

// ── Configurations ──────────────────────────────────────────────────────
async function createConfiguration({
  eventId,
  productKey,
  printfulVariantId,
  quantity,
  unitPriceCents,
  theme,
  words,
  design,
  configurationType = 'event_wordcloud',
  orientation = 'default',
  printWidth,
  printHeight,
}) {
  if (!design) throw new TypeError('A configuration requires an immutable canvas design.');
  const id = crypto.randomBytes(12).toString('base64url');
  const result = await getPool().query(`
    INSERT INTO configurations (
      id, event_id, product_key, printful_variant_id, quantity, unit_price_cents,
      theme, words_json, design_json, configuration_type, orientation,
      print_width, print_height
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
    RETURNING *
  `, [
    id, eventId, productKey, printfulVariantId, quantity, unitPriceCents, theme,
    jsonValue(words), jsonValue(design), configurationType, orientation, printWidth, printHeight,
  ]);
  return rowToBoundary(result.rows[0]);
}

async function getConfiguration(id) {
  const result = await getPool().query('SELECT * FROM configurations WHERE id = $1', [id]);
  return rowToBoundary(result.rows[0]);
}

async function getEventConfiguration(slug, configurationId) {
  const result = await getPool().query(`
    SELECT configurations.*
    FROM configurations
    JOIN events ON events.id = configurations.event_id
    WHERE configurations.id = $1 AND events.slug = $2
  `, [configurationId, slug]);
  return rowToBoundary(result.rows[0]);
}

async function getEventConfigurations(slug, configurationIds) {
  const ids = uniqueConfigurationIds(configurationIds);
  if (!ids.length) return [];
  const result = await getPool().query(`
    SELECT configurations.*
    FROM configurations
    JOIN events ON events.id = configurations.event_id
    WHERE configurations.id = ANY($1::text[]) AND events.slug = $2
  `, [ids, slug]);
  if (result.rows.length !== ids.length) return [];
  const byId = new Map(rowsToBoundary(result.rows).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id));
}

module.exports = {
  get pool() { return getPool(); },
  getPool,
  closePool,
  assertDatabaseReady,
  checkDatabaseReady,
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
  archiveAndClearWords,
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
  claimCheckoutAttempt,
  attachStripeSession,
  markCheckoutCreationFailed,
  retryCheckoutOrder,
  recordSuccessfulPayment,
  recordTestPayment,
  claimFulfillmentOrder,
  completeFulfillment,
  getOrderShipments,
  getOrderItems,
  completeOrderShipment,
  failOrderShipment,
  failFulfillment,
  getPendingFulfillmentOrders,
  recoverStaleFulfillments,
  cleanupAbandonedQuotes,
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
