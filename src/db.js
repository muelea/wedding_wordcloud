'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const { connectionOptions } = require('./dbConfig');
const { getProduct, resolveProductOrientation } = require('./products');
const { buildEmailSnapshot } = require('./emailTemplates');
const log = require('./structuredLog');

const REQUIRED_SCHEMA_VERSION = '6';
const MAX_CONFIGURATION_ASSETS = 6;
const MAX_CONFIGURATION_ASSET_BYTES = 6 * 1024 * 1024;
const MAX_UNATTACHED_OWNER_ASSETS = 12;
const MAX_UNATTACHED_OWNER_BYTES = 12 * 1024 * 1024;
const MAX_UNATTACHED_EVENT_ASSETS = 2000;
const MAX_UNATTACHED_EVENT_BYTES = 1024 * 1024 * 1024;
const MAX_EVENT_CONTRIBUTIONS = 5000;
const MAX_EVENT_UNIQUE_WORDS = 500;
const MAX_OWNER_CONTRIBUTIONS = 100;
const MAX_ACTIVE_UNPAID_CONFIGURATIONS = 2000;
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
  'summary_json',
]);

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new Pool(connectionOptions(process.env.DATABASE_URL));
  pool.on('error', (error) => {
    log.error('database_idle_client_failed', {
      operation: 'postgres_pool', errorCode: log.errorCode(error, 'database_client_failed'),
    });
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
  const currentVersion = Number(result.rows[0]?.version);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < Number(REQUIRED_SCHEMA_VERSION)) {
    throw new Error(
      `Postgres-Schema ist nicht aktuell (mindestens erwartet: ${REQUIRED_SCHEMA_VERSION}). ` +
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
// scrypt is deliberately asynchronous and bounded. This keeps PIN attempts
// from blocking the event loop or saturating libuv's worker pool.
const MAX_ACTIVE_PIN_DERIVATIONS = 4;
const MAX_QUEUED_PIN_DERIVATIONS = 32;
let activePinDerivations = 0;
const queuedPinDerivations = [];

function runPinDerivation(work) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activePinDerivations += 1;
      work((error, result) => {
        activePinDerivations -= 1;
        const next = queuedPinDerivations.shift();
        if (next) queueMicrotask(next);
        if (error) reject(error); else resolve(result);
      });
    };
    if (activePinDerivations < MAX_ACTIVE_PIN_DERIVATIONS) return run();
    if (queuedPinDerivations.length >= MAX_QUEUED_PIN_DERIVATIONS) {
      const error = new Error('PIN verification is temporarily busy.');
      error.code = 'pin_busy';
      reject(error);
      return;
    }
    queuedPinDerivations.push(run);
  });
}

function derivePin(pin, salt) {
  return runPinDerivation((done) => crypto.scrypt(String(pin), salt, 64, done));
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await derivePin(pin, salt)).toString('hex');
  return { hash, salt };
}

async function verifyPin(pin, hash, salt) {
  const candidate = await derivePin(pin, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Events ──────────────────────────────────────────────────────────────
async function createEvent({ slug, coupleName, pin, locale = 'de' }) {
  const { hash, salt } = await hashPin(pin);
  return withTransaction(async (client) => {
    await client.query(`
      INSERT INTO reserved_event_slugs (slug, original_created_at)
      VALUES ($1, transaction_timestamp())
    `, [slug]);
    const result = await client.query(`
      INSERT INTO events (
        slug, couple_name, admin_pin_hash, admin_pin_salt, locale, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, transaction_timestamp(), transaction_timestamp() + interval '365 days')
      RETURNING *
    `, [slug, coupleName, hash, salt, locale]);
    return rowToBoundary(result.rows[0]);
  });
}

async function getEventBySlug(slug) {
  const result = await getPool().query(`
    SELECT * FROM events
    WHERE slug = $1 AND expires_at > transaction_timestamp()
  `, [slug]);
  return rowToBoundary(result.rows[0]);
}

async function getEventById(id) {
  const result = await getPool().query(`
    SELECT * FROM events
    WHERE id = $1 AND expires_at > transaction_timestamp()
  `, [id]);
  return rowToBoundary(result.rows[0]);
}

async function slugExists(slug) {
  const result = await getPool().query(`
    SELECT EXISTS (SELECT 1 FROM reserved_event_slugs WHERE slug = $1) AS exists
  `, [slug]);
  return result.rows[0].exists;
}

async function setEventTheme(eventId, theme) {
  const result = await getPool().query(`
    UPDATE events SET theme = $1
    WHERE id = $2 AND expires_at > transaction_timestamp()
  `, [theme, eventId]);
  if (!result.rowCount) throw new Error('event not found');
}

async function getResetPinStatus(eventId, sourceIpHash) {
  await getPool().query(`
    DELETE FROM admin_pin_failures
    WHERE updated_at < transaction_timestamp() - interval '1 day'
  `);
  const result = await getPool().query(`
    SELECT blocked_until > transaction_timestamp() AS blocked
    FROM admin_pin_failures
    WHERE event_id = $1 AND source_ip_hash = $2
  `, [eventId, sourceIpHash]);
  return { blocked: result.rows[0]?.blocked === true };
}

async function recordResetPinFailure(eventId, sourceIpHash) {
  const result = await getPool().query(`
    INSERT INTO admin_pin_failures (
      event_id, source_ip_hash, window_started_at, failed_attempts, blocked_until, updated_at
    ) VALUES ($1, $2, transaction_timestamp(), 1, null, transaction_timestamp())
    ON CONFLICT (event_id, source_ip_hash) DO UPDATE SET
      window_started_at = case
        when admin_pin_failures.window_started_at <= transaction_timestamp() - interval '15 minutes'
          then transaction_timestamp()
        else admin_pin_failures.window_started_at
      end,
      failed_attempts = case
        when admin_pin_failures.window_started_at <= transaction_timestamp() - interval '15 minutes'
          then 1
        else least(5, admin_pin_failures.failed_attempts + 1)
      end,
      blocked_until = case
        when admin_pin_failures.window_started_at <= transaction_timestamp() - interval '15 minutes'
          then null
        when admin_pin_failures.failed_attempts + 1 >= 5
          then transaction_timestamp() + interval '15 minutes'
        else admin_pin_failures.blocked_until
      end,
      updated_at = transaction_timestamp()
    RETURNING failed_attempts, blocked_until
  `, [eventId, sourceIpHash]);
  return {
    attempts: Number(result.rows[0].failed_attempts),
    blocked: result.rows[0].blocked_until && Date.parse(result.rows[0].blocked_until) > Date.now(),
  };
}

async function clearResetPinFailures(eventId, sourceIpHash) {
  await getPool().query(`
    DELETE FROM admin_pin_failures WHERE event_id = $1 AND source_ip_hash = $2
  `, [eventId, sourceIpHash]);
}

async function authorizeResetPin(event, pin, sourceIpHash) {
  const status = await getResetPinStatus(event.id, sourceIpHash);
  if (status.blocked) return { ok: false, blocked: true };
  const validShape = /^\d{4,6}$/.test(String(pin || ''));
  let valid = false;
  if (validShape) {
    valid = await verifyPin(pin, event.admin_pin_hash, event.admin_pin_salt);
  }
  if (!valid) {
    await recordResetPinFailure(event.id, sourceIpHash);
    return { ok: false, blocked: false };
  }
  await clearResetPinFailures(event.id, sourceIpHash);
  return { ok: true, blocked: false };
}

function limitError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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
  const result = await getPool().query(`
    WITH locked_event AS MATERIALIZED (
      SELECT id FROM events
      WHERE id = $1 AND expires_at > transaction_timestamp()
      FOR UPDATE
    ), usage AS MATERIALIZED (
      SELECT
        (SELECT count(*)::integer FROM word_contributions WHERE event_id = $1) AS event_count,
        (SELECT count(*)::integer FROM word_contributions WHERE event_id = $1 AND owner_id = $2) AS owner_count,
        (SELECT count(*)::integer FROM words WHERE event_id = $1) AS unique_count,
        EXISTS (SELECT 1 FROM words WHERE event_id = $1 AND word = $3) AS word_exists
      FROM locked_event
    ), decision AS MATERIALIZED (
      SELECT case
        when owner_count >= $5 then 'guest_contribution_limit'
        when event_count >= $6 then 'event_contribution_limit'
        when not word_exists and unique_count >= $7 then 'unique_word_limit'
        else null
      end AS error
      FROM usage
    ), upserted_word AS (
      INSERT INTO words (event_id, word, count, updated_at)
      SELECT $1, $3, 1, transaction_timestamp()
      FROM decision WHERE error IS NULL
      ON CONFLICT (event_id, word) DO UPDATE SET
        count = words.count + 1,
        updated_at = transaction_timestamp()
      RETURNING event_id, word
    ), inserted_contribution AS (
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      SELECT $4, event_id, word, $2 FROM upserted_word
      RETURNING receipt_id
    )
    SELECT decision.error, inserted_contribution.receipt_id
    FROM decision
    LEFT JOIN inserted_contribution ON true
  `, [
    eventId,
    ownerId,
    word,
    receiptId,
    MAX_OWNER_CONTRIBUTIONS,
    MAX_EVENT_CONTRIBUTIONS,
    MAX_EVENT_UNIQUE_WORDS,
  ]);
  if (!result.rowCount) throw new Error('event not found');
  if (result.rows[0].error) throw limitError(result.rows[0].error);
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

async function getWordContributionsForOwners(requests) {
  if (!Array.isArray(requests) || !requests.length) return new Map();
  if (requests.length > 1_000) throw new RangeError('ownership batch exceeds 1000 requests');
  const eventIds = requests.map((request) => request.eventId);
  const ownerIds = requests.map((request) => request.ownerId);
  const result = await getPool().query(`
    WITH requested(event_id, owner_id) AS (
      SELECT * FROM unnest($1::bigint[], $2::text[])
    )
    SELECT requested.event_id, requested.owner_id,
           contribution.receipt_id, contribution.word
    FROM requested
    LEFT JOIN word_contributions contribution
      ON contribution.event_id = requested.event_id
     AND contribution.owner_id = requested.owner_id
    ORDER BY requested.event_id ASC, requested.owner_id ASC,
             contribution.created_at ASC, contribution.receipt_id ASC
  `, [eventIds, ownerIds]);
  const contributions = new Map(requests.map((request) => [
    `${request.eventId}:${request.ownerId}`,
    [],
  ]));
  for (const row of result.rows) {
    if (!row.receipt_id) continue;
    contributions.get(`${row.event_id}:${row.owner_id}`).push({
      receipt: row.receipt_id,
      word: row.word,
    });
  }
  return contributions;
}

async function removeWordContribution(eventId, receiptId, ownerId) {
  return withTransaction(async (client) => {
    const event = await client.query(`
      SELECT id FROM events
      WHERE id = $1 AND expires_at > transaction_timestamp()
      FOR KEY SHARE
    `, [eventId]);
    if (!event.rowCount) return null;
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
    const locked = await client.query(`
      SELECT id FROM events
      WHERE id = $1 AND expires_at > transaction_timestamp()
      FOR UPDATE
    `, [eventId]);
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
    const eventResult = await client.query(`
      SELECT slug, couple_name FROM events
      WHERE id = $1 AND expires_at > transaction_timestamp()
    `, [eventId]);
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
      `SELECT slug, couple_name, locale FROM events
       WHERE id = $1 AND expires_at > transaction_timestamp()
       FOR KEY SHARE`,
      [eventId]
    );
    const event = eventResult.rows[0];
    if (!event) throw new Error('event not found');

    const configurationIds = getCheckoutQuoteConfigurationIds(lockedQuote);
    const configurationResult = await client.query(`
      SELECT * FROM configurations
      WHERE id = ANY($1::text[]) AND event_id = $2
        AND expires_at > transaction_timestamp()
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
        checkout_session_expires_at, locale_snapshot
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, 'creating_checkout', $7::jsonb,
        $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18
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
      event.locale,
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

async function insertEmailJobForOrder(client, {
  order,
  kind,
  dedupeKey,
  shipmentId = null,
  noticeAmountCents = null,
  providerSmoke = false,
}) {
  const itemsResult = await client.query(`
    SELECT * FROM order_items WHERE order_id = $1
    ORDER BY shipment_index ASC, item_index ASC
  `, [order.id]);
  const shipmentsResult = await client.query(`
    SELECT * FROM checkout_order_shipments WHERE order_id = $1
    ORDER BY shipment_index ASC
  `, [order.id]);
  const shipment = shipmentId == null
    ? null
    : shipmentsResult.rows.find((entry) => String(entry.id) === String(shipmentId));
  if (shipmentId != null && !shipment) throw new Error('email shipment does not belong to order');
  const snapshot = buildEmailSnapshot({
    kind,
    order: rowToBoundary(order),
    orderItems: rowsToBoundary(itemsResult.rows),
    shipments: rowsToBoundary(shipmentsResult.rows),
    shipment: rowToBoundary(shipment),
    noticeAmountCents,
    locale: order.locale_snapshot,
  });
  const recipient = normalizeBuyerEmail(order.buyer_email);
  const status = recipient ? 'pending' : 'blocked';
  const lastError = recipient ? null : 'buyer_email_missing';
  const inserted = await client.query(`
    INSERT INTO email_jobs (
      order_id, shipment_id, kind, dedupe_key, recipient_email, locale,
      template_version, subject, html_body, text_body, status, provider_smoke,
      last_error
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING *
  `, [
    order.id, shipmentId, kind, dedupeKey, recipient, snapshot.locale,
    snapshot.templateVersion, snapshot.subject, snapshot.htmlBody, snapshot.textBody,
    status, Boolean(providerSmoke), lastError,
  ]);
  if (inserted.rows[0]) return { job: rowToBoundary(inserted.rows[0]), created: true };
  const existing = await client.query('SELECT * FROM email_jobs WHERE dedupe_key = $1', [dedupeKey]);
  return { job: rowToBoundary(existing.rows[0]), created: false };
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
    const email = await insertEmailJobForOrder(client, {
      order: updated.rows[0],
      kind: 'order_confirmation',
      dedupeKey: `order_confirmation:order:${order.id}`,
    });
    return {
      duplicate: false,
      order: rowToBoundary(updated.rows[0]),
      emailJob: email.job,
      emailJobCreated: email.created,
    };
  });
}

async function recordTestPayment(options) {
  return recordSuccessfulPayment({ ...options, livemode: false });
}

async function claimFulfillmentOrder({ orderId = null, lockedBy, leaseMs = 60_000 } = {}) {
  if (!lockedBy || String(lockedBy).length > 120) throw new Error('invalid fulfillment lease owner');
  const safeLeaseMs = Number.isSafeInteger(leaseMs) && leaseMs >= 15_000 && leaseMs <= 300_000
    ? leaseMs
    : 60_000;
  const result = await getPool().query(`
    WITH candidate AS (
      SELECT id
      FROM orders
      WHERE ($1::bigint IS NULL OR id = $1)
        AND status IN ('paid_test', 'paid')
        AND fulfillment_attempts < 3
        AND fulfillment_next_attempt_at <= transaction_timestamp()
        AND (
          fulfillment_status IN ('pending', 'failed') OR
          (fulfillment_status = 'processing' AND fulfillment_locked_until <= transaction_timestamp())
        )
        AND (fulfillment_locked_until IS NULL OR fulfillment_locked_until <= transaction_timestamp())
      ORDER BY fulfillment_next_attempt_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE orders target
    SET fulfillment_status = 'processing',
        fulfillment_attempts = target.fulfillment_attempts + 1,
        fulfillment_error = null,
        fulfillment_locked_by = $2,
        fulfillment_locked_until = transaction_timestamp() + ($3::integer * interval '1 millisecond'),
        fulfillment_lease_version = target.fulfillment_lease_version + 1,
        fulfillment_updated_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    FROM candidate
    WHERE target.id = candidate.id
    RETURNING target.*
  `, [orderId, String(lockedBy), safeLeaseMs]);
  return rowToBoundary(result.rows[0]);
}

async function renewFulfillmentLease(orderId, { lockedBy, leaseVersion }, leaseMs = 60_000) {
  const safeLeaseMs = Number.isSafeInteger(leaseMs) && leaseMs >= 15_000 && leaseMs <= 300_000
    ? leaseMs
    : 60_000;
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_locked_until = transaction_timestamp() + ($1::integer * interval '1 millisecond'),
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE id = $2 AND fulfillment_status = 'processing'
      AND fulfillment_locked_by = $3 AND fulfillment_lease_version = $4
      AND fulfillment_locked_until > transaction_timestamp()
    RETURNING id
  `, [safeLeaseMs, orderId, lockedBy, leaseVersion]);
  return result.rowCount === 1;
}

async function completeFulfillment(
  orderId,
  { lockedBy, leaseVersion },
  { mode, payload, printfulOrderId, printfulStatus }
) {
  const status = mode === 'mock' ? 'mocked' : mode === 'draft' ? 'draft' : 'submitted';
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = $1, fulfillment_mode = $2,
        fulfillment_payload_json = $3::jsonb, printful_order_id = $4,
        printful_order_status = $5, fulfillment_error = null,
        fulfillment_submitted_at = CASE WHEN $1 = 'submitted'
          THEN coalesce(fulfillment_submitted_at, transaction_timestamp())
          ELSE fulfillment_submitted_at END,
        fulfillment_locked_by = null, fulfillment_locked_until = null,
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE id = $6 AND fulfillment_status = 'processing'
      AND fulfillment_locked_by = $7 AND fulfillment_lease_version = $8
      AND fulfillment_locked_until > transaction_timestamp()
    RETURNING *
  `, [
    status, mode, jsonValue(payload), printfulOrderId || null, printfulStatus || status,
    orderId, lockedBy, leaseVersion,
  ]);
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

async function completeOrderShipment(
  shipmentId,
  orderId,
  { lockedBy, leaseVersion },
  { mode, payload, printfulOrderId, printfulStatus }
) {
  const status = mode === 'mock' ? 'mocked' : mode === 'draft' ? 'draft' : 'submitted';
  const result = await getPool().query(`
    UPDATE checkout_order_shipments shipment
    SET fulfillment_status = $1, fulfillment_mode = $2,
        fulfillment_payload_json = $3::jsonb, printful_order_id = $4,
        printful_order_status = $5, fulfillment_error = null,
        fulfillment_submitted_at = CASE WHEN $1 = 'submitted'
          THEN coalesce(shipment.fulfillment_submitted_at, transaction_timestamp())
          ELSE shipment.fulfillment_submitted_at END,
        updated_at = transaction_timestamp()
    FROM orders lease
    WHERE shipment.id = $6 AND shipment.order_id = $7 AND lease.id = shipment.order_id
      AND lease.fulfillment_status = 'processing'
      AND lease.fulfillment_locked_by = $8 AND lease.fulfillment_lease_version = $9
      AND lease.fulfillment_locked_until > transaction_timestamp()
    RETURNING shipment.*
  `, [
    status, mode, jsonValue(payload), printfulOrderId || null, printfulStatus || status,
    shipmentId, orderId, lockedBy, leaseVersion,
  ]);
  return rowToBoundary(result.rows[0]);
}

async function failOrderShipment(shipmentId, orderId, { lockedBy, leaseVersion }, error) {
  const safeError = String(error?.message || error || 'Fulfillment fehlgeschlagen').slice(0, 1000);
  const result = await getPool().query(`
    UPDATE checkout_order_shipments shipment
    SET fulfillment_status = 'failed', fulfillment_attempts = fulfillment_attempts + 1,
        fulfillment_error = $1, updated_at = transaction_timestamp()
    FROM orders lease
    WHERE shipment.id = $2 AND shipment.order_id = $3 AND lease.id = shipment.order_id
      AND lease.fulfillment_status = 'processing'
      AND lease.fulfillment_locked_by = $4 AND lease.fulfillment_lease_version = $5
      AND lease.fulfillment_locked_until > transaction_timestamp()
    RETURNING shipment.*
  `, [safeError, shipmentId, orderId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function failFulfillment(orderId, { lockedBy, leaseVersion }, error, { blocked = false } = {}) {
  const safeError = String(error?.message || error || 'Fulfillment fehlgeschlagen').slice(0, 1000);
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = CASE WHEN $1 OR fulfillment_attempts >= 3 THEN 'blocked' ELSE 'failed' END,
        fulfillment_error = $2,
        fulfillment_next_attempt_at = CASE
          WHEN $1 OR fulfillment_attempts >= 3 THEN fulfillment_next_attempt_at
          WHEN fulfillment_attempts = 1 THEN transaction_timestamp() + interval '5 seconds'
          ELSE transaction_timestamp() + interval '30 seconds'
        END,
        fulfillment_locked_by = null, fulfillment_locked_until = null,
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE id = $3 AND fulfillment_status = 'processing'
      AND fulfillment_locked_by = $4 AND fulfillment_lease_version = $5
      AND fulfillment_locked_until > transaction_timestamp()
    RETURNING *
  `, [blocked, safeError, orderId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function getPendingFulfillmentOrders(limit = 20) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
  const result = await getPool().query(`
    SELECT * FROM orders
    WHERE fulfillment_status IN ('pending', 'failed', 'processing')
      AND fulfillment_attempts < 3
      AND status IN ('paid_test', 'paid')
      AND fulfillment_next_attempt_at <= transaction_timestamp()
      AND (fulfillment_locked_until IS NULL OR fulfillment_locked_until <= transaction_timestamp())
    ORDER BY fulfillment_next_attempt_at ASC, id ASC
    LIMIT $1
  `, [safeLimit]);
  return rowsToBoundary(result.rows);
}

async function recoverStaleFulfillments() {
  const result = await getPool().query(`
    UPDATE orders
    SET fulfillment_status = 'failed',
        fulfillment_error = 'Verarbeitung wurde durch einen Serverneustart unterbrochen.',
        fulfillment_locked_by = null, fulfillment_locked_until = null,
        fulfillment_next_attempt_at = transaction_timestamp(),
        fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
    WHERE fulfillment_status = 'processing'
      AND fulfillment_locked_until <= transaction_timestamp()
  `);
  return result.rowCount;
}

// ── Durable transactional email jobs ──────────────────────────────────
async function getEmailJobById(id) {
  const result = await getPool().query('SELECT * FROM email_jobs WHERE id = $1', [id]);
  return rowToBoundary(result.rows[0]);
}

async function getEmailJobsForOrder(orderId) {
  const result = await getPool().query(`
    SELECT * FROM email_jobs WHERE order_id = $1 ORDER BY id ASC
  `, [orderId]);
  return rowsToBoundary(result.rows);
}

async function claimEmailJob({ jobId = null, lockedBy, leaseMs = 60_000 } = {}) {
  if (!lockedBy || String(lockedBy).length > 120) throw new Error('invalid email lease owner');
  const safeLeaseMs = Number.isSafeInteger(leaseMs) && leaseMs >= 15_000 && leaseMs <= 300_000
    ? leaseMs
    : 60_000;
  const result = await getPool().query(`
    WITH candidate AS (
      SELECT id
      FROM email_jobs
      WHERE ($1::bigint IS NULL OR id = $1)
        AND status IN ('pending', 'failed', 'processing')
        AND provider_terminal = false
        AND attempt_count < 4
        AND next_attempt_at <= transaction_timestamp()
        AND (locked_until IS NULL OR locked_until <= transaction_timestamp())
      ORDER BY next_attempt_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE email_jobs target
    SET status = 'processing',
        attempt_count = target.attempt_count + 1,
        locked_by = $2,
        locked_until = transaction_timestamp() + ($3::integer * interval '1 millisecond'),
        lease_version = target.lease_version + 1,
        updated_at = transaction_timestamp()
    FROM candidate
    WHERE target.id = candidate.id
    RETURNING target.*
  `, [jobId, String(lockedBy), safeLeaseMs]);
  return rowToBoundary(result.rows[0]);
}

async function renewEmailLease(jobId, { lockedBy, leaseVersion }, leaseMs = 60_000) {
  const safeLeaseMs = Number.isSafeInteger(leaseMs) && leaseMs >= 15_000 && leaseMs <= 300_000
    ? leaseMs
    : 60_000;
  const result = await getPool().query(`
    UPDATE email_jobs
    SET locked_until = transaction_timestamp() + ($1::integer * interval '1 millisecond'),
        updated_at = transaction_timestamp()
    WHERE id = $2 AND status = 'processing' AND locked_by = $3 AND lease_version = $4
      AND locked_until > transaction_timestamp()
    RETURNING id
  `, [safeLeaseMs, jobId, lockedBy, leaseVersion]);
  return result.rowCount === 1;
}

async function beginEmailProviderAttempt(jobId, { lockedBy, leaseVersion }) {
  const result = await getPool().query(`
    UPDATE email_jobs
    SET first_send_attempt_at = coalesce(first_send_attempt_at, transaction_timestamp()),
        updated_at = transaction_timestamp()
    WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND lease_version = $3
      AND locked_until > transaction_timestamp()
    RETURNING *
  `, [jobId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function completeMockEmail(jobId, { lockedBy, leaseVersion }) {
  const result = await getPool().query(`
    UPDATE email_jobs
    SET status = 'delivered', provider_message_id = coalesce(provider_message_id, 'mock-' || id::text),
        provider_terminal = true, delivery_ambiguous = false, last_error = null,
        sent_at = coalesce(sent_at, transaction_timestamp()),
        delivered_at = coalesce(delivered_at, transaction_timestamp()),
        locked_by = null, locked_until = null, updated_at = transaction_timestamp()
    WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND lease_version = $3
      AND locked_until > transaction_timestamp()
    RETURNING *
  `, [jobId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function completeEmailProviderAcceptance(jobId, { lockedBy, leaseVersion }, providerMessageId) {
  const result = await getPool().query(`
    UPDATE email_jobs
    SET status = 'sent', provider_message_id = $1, delivery_ambiguous = false,
        last_error = null, sent_at = coalesce(sent_at, transaction_timestamp()),
        locked_by = null, locked_until = null, updated_at = transaction_timestamp()
    WHERE id = $2 AND status = 'processing' AND locked_by = $3 AND lease_version = $4
      AND locked_until > transaction_timestamp()
    RETURNING *
  `, [String(providerMessageId), jobId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function failEmailJob(
  jobId,
  { lockedBy, leaseVersion },
  errorCode,
  { ambiguous = false, blocked = false } = {}
) {
  const safeError = String(errorCode || 'email_delivery_failed')
    .toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 240);
  const result = await getPool().query(`
    UPDATE email_jobs
    SET status = CASE WHEN $1 OR attempt_count >= 4 THEN 'blocked' ELSE 'failed' END,
        last_error = $2,
        delivery_ambiguous = delivery_ambiguous OR $3,
        next_attempt_at = CASE
          WHEN $1 OR attempt_count >= 4 THEN next_attempt_at
          WHEN attempt_count = 1 THEN transaction_timestamp() + interval '30 seconds'
          WHEN attempt_count = 2 THEN transaction_timestamp() + interval '5 minutes'
          ELSE transaction_timestamp() + interval '30 minutes'
        END,
        locked_by = null, locked_until = null, updated_at = transaction_timestamp()
    WHERE id = $4 AND status = 'processing' AND locked_by = $5 AND lease_version = $6
      AND locked_until > transaction_timestamp()
    RETURNING *
  `, [Boolean(blocked), safeError, Boolean(ambiguous), jobId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function blockExpiredAmbiguousEmail(jobId, { lockedBy, leaseVersion }) {
  const result = await getPool().query(`
    UPDATE email_jobs
    SET status = 'blocked', last_error = 'delivery_outcome_unknown',
        delivery_ambiguous = true, locked_by = null, locked_until = null,
        updated_at = transaction_timestamp()
    WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND lease_version = $3
      AND locked_until > transaction_timestamp()
    RETURNING *
  `, [jobId, lockedBy, leaseVersion]);
  return rowToBoundary(result.rows[0]);
}

async function getPendingEmailJobs(limit = 20) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
  const result = await getPool().query(`
    SELECT * FROM email_jobs
    WHERE status IN ('pending', 'failed', 'processing')
      AND provider_terminal = false AND attempt_count < 4
      AND next_attempt_at <= transaction_timestamp()
      AND (locked_until IS NULL OR locked_until <= transaction_timestamp())
    ORDER BY next_attempt_at ASC, id ASC
    LIMIT $1
  `, [safeLimit]);
  return rowsToBoundary(result.rows);
}

async function recoverStaleEmailJobs() {
  const result = await getPool().query(`
    UPDATE email_jobs
    SET status = 'failed', last_error = CASE
          WHEN delivery_ambiguous THEN last_error
          ELSE 'email_processing_interrupted'
        END,
        locked_by = null, locked_until = null, next_attempt_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    WHERE status = 'processing' AND locked_until <= transaction_timestamp()
      AND provider_terminal = false
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
      AND events.expires_at > transaction_timestamp()
  `, [quoteId, configurationId, slug]);
  return rowToBoundary(result.rows[0]);
}

async function getEventCartCheckoutQuote(slug, configurationIds, quoteId) {
  const result = await getPool().query(`
    SELECT checkout_quotes.*
    FROM checkout_quotes
    JOIN events ON events.id = checkout_quotes.event_id
    WHERE checkout_quotes.id = $1 AND events.slug = $2
      AND events.expires_at > transaction_timestamp()
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
function designAssetIds(design) {
  if (!design?.surfaces || typeof design.surfaces !== 'object' || Array.isArray(design.surfaces)) return [];
  return [...new Set(Object.values(design.surfaces)
    .flatMap((surface) => Array.isArray(surface) ? surface : [])
    .filter((item) => item?.type === 'image')
    .map((item) => String(item.assetId || ''))
    .filter(Boolean))];
}

function assetValidationError() {
  const error = new Error('Configuration contains unavailable design assets.');
  error.code = 'invalid_design_assets';
  return error;
}

async function beginDesignAssetUpload({
  eventId,
  ownerId,
  mimeType,
  byteSize,
  sha256,
  extension,
}) {
  return withTransaction(async (client) => {
    const lockedEvent = await client.query(`
      SELECT id FROM events
      WHERE id = $1 AND expires_at > transaction_timestamp()
      FOR UPDATE
    `, [eventId]);
    if (!lockedEvent.rowCount) {
      const error = new Error('event not found');
      error.code = 'event_not_found';
      throw error;
    }

    const existing = await client.query(`
      SELECT *
      FROM design_assets
      WHERE event_id = $1 AND uploader_owner_id = $2 AND sha256 = $3
        AND storage_status = 'active' AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE
    `, [eventId, ownerId, sha256]);
    if (existing.rows[0]) {
      const refreshed = await client.query(`
        UPDATE design_assets
        SET expires_at = greatest(expires_at, transaction_timestamp() + interval '30 days')
        WHERE id = $1
        RETURNING *
      `, [existing.rows[0].id]);
      return { reused: true, asset: rowToBoundary(refreshed.rows[0]) };
    }

    const usage = await client.query(`
      SELECT
        count(*) filter (
          where uploader_owner_id = $2 and not exists (
            select 1 from configuration_assets reference where reference.asset_id = asset.id
          )
        )::integer AS owner_count,
        coalesce(sum(byte_size) filter (
          where uploader_owner_id = $2 and not exists (
            select 1 from configuration_assets reference where reference.asset_id = asset.id
          )
        ), 0)::bigint AS owner_bytes,
        count(*) filter (where not (
          exists (
            select 1 from configuration_assets reference where reference.asset_id = asset.id
          ) and not exists (
            select 1
            from configuration_assets reference
            where reference.asset_id = asset.id
              and not exists (
                select 1
                from order_items item
                join orders paid_order on paid_order.id = item.order_id
                where item.configuration_id = reference.configuration_id
                  and paid_order.status in ('paid_test', 'paid', 'fulfilled')
              )
          )
        ))::integer AS event_count,
        coalesce(sum(byte_size) filter (where not (
          exists (
            select 1 from configuration_assets reference where reference.asset_id = asset.id
          ) and not exists (
            select 1
            from configuration_assets reference
            where reference.asset_id = asset.id
              and not exists (
                select 1
                from order_items item
                join orders paid_order on paid_order.id = item.order_id
                where item.configuration_id = reference.configuration_id
                  and paid_order.status in ('paid_test', 'paid', 'fulfilled')
              )
          )
        )), 0)::bigint AS event_bytes
      FROM design_assets asset
      WHERE event_id = $1
        AND storage_status in ('uploading', 'active')
        AND deleted_at IS NULL
    `, [eventId, ownerId]);
    const totals = usage.rows[0];
    const exceedsOwner = Number(totals.owner_count) + 1 > MAX_UNATTACHED_OWNER_ASSETS ||
      Number(totals.owner_bytes) + byteSize > MAX_UNATTACHED_OWNER_BYTES;
    const exceedsEvent = Number(totals.event_count) + 1 > MAX_UNATTACHED_EVENT_ASSETS ||
      Number(totals.event_bytes) + byteSize > MAX_UNATTACHED_EVENT_BYTES;
    if (exceedsOwner || exceedsEvent) {
      const error = new Error('Asset upload ceiling reached.');
      error.code = 'asset_limit';
      throw error;
    }

    const id = crypto.randomBytes(18).toString('base64url');
    const objectKey = `photos/${eventId}/${crypto.randomBytes(24).toString('hex')}.${extension}`;
    const inserted = await client.query(`
      INSERT INTO design_assets (
        id, event_id, uploader_owner_id, object_key, mime_type, byte_size,
        sha256, storage_status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading', transaction_timestamp() + interval '30 days')
      RETURNING *
    `, [id, eventId, ownerId, objectKey, mimeType, byteSize, sha256]);
    return { reused: false, asset: rowToBoundary(inserted.rows[0]) };
  });
}

async function activateDesignAsset(assetId) {
  const result = await getPool().query(`
    UPDATE design_assets
    SET storage_status = 'active', last_delete_error = NULL,
        expires_at = greatest(expires_at, transaction_timestamp() + interval '30 days')
    WHERE id = $1 AND storage_status = 'uploading' AND deleted_at IS NULL
    RETURNING *
  `, [assetId]);
  if (!result.rows[0]) throw new Error('Design asset could not be activated.');
  return rowToBoundary(result.rows[0]);
}

async function markDesignAssetUploadFailed(assetId, reason) {
  const sanitized = String(reason || 'storage_upload_failed').replace(/[^a-z0-9_:-]/gi, '').slice(0, 240);
  const result = await getPool().query(`
    UPDATE design_assets
    SET storage_status = 'delete_failed', last_delete_error = $2
    WHERE id = $1 AND storage_status = 'uploading' AND deleted_at IS NULL
    RETURNING *
  `, [assetId, sanitized]);
  return rowToBoundary(result.rows[0]);
}

async function getConfigurationAssets(configurationId) {
  const result = await getPool().query(`
    SELECT asset.*
    FROM configuration_assets reference
    JOIN design_assets asset ON asset.id = reference.asset_id
    WHERE reference.configuration_id = $1
    ORDER BY asset.id
  `, [configurationId]);
  return rowsToBoundary(result.rows);
}

async function claimDesignAssetForDeletion(assetId) {
  return withTransaction(async (client) => {
    const locked = await client.query(`
      SELECT * FROM design_assets WHERE id = $1 FOR UPDATE
    `, [assetId]);
    const asset = locked.rows[0];
    if (!asset || asset.deleted_at || asset.storage_status === 'deleting') return null;
    const references = await client.query(
      'SELECT 1 FROM configuration_assets WHERE asset_id = $1 LIMIT 1',
      [assetId]
    );
    const staleUpload = asset.storage_status === 'uploading' &&
      Date.parse(asset.created_at) <= Date.now() - 15 * 60 * 1000;
    const eligible = asset.storage_status === 'delete_failed' || staleUpload ||
      (asset.storage_status === 'active' && Date.parse(asset.expires_at) <= Date.now());
    if (references.rowCount || !eligible) return null;
    const claimed = await client.query(`
      UPDATE design_assets
      SET storage_status = 'deleting', deletion_attempts = deletion_attempts + 1,
          last_delete_error = NULL
      WHERE id = $1
      RETURNING *
    `, [assetId]);
    return rowToBoundary(claimed.rows[0]);
  });
}

async function finishDesignAssetDeletion(assetId) {
  const result = await getPool().query(`
    DELETE FROM design_assets asset
    WHERE asset.id = $1 AND asset.storage_status = 'deleting'
      AND NOT EXISTS (
        SELECT 1 FROM configuration_assets reference WHERE reference.asset_id = asset.id
      )
    RETURNING id
  `, [assetId]);
  if (!result.rowCount) throw new Error('Design asset deletion lost its claim.');
  return true;
}

async function failDesignAssetDeletion(assetId, reason) {
  const sanitized = String(reason || 'storage_delete_failed').replace(/[^a-z0-9_:-]/gi, '').slice(0, 240);
  const result = await getPool().query(`
    UPDATE design_assets
    SET storage_status = 'delete_failed', last_delete_error = $2
    WHERE id = $1 AND storage_status = 'deleting'
    RETURNING *
  `, [assetId, sanitized]);
  if (!result.rows[0]) throw new Error('Design asset deletion failure could not be recorded.');
  return rowToBoundary(result.rows[0]);
}

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
  const assetIds = designAssetIds(design);
  if (assetIds.length > MAX_CONFIGURATION_ASSETS ||
      (configurationType === 'event_wordcloud' && assetIds.length)) {
    throw assetValidationError();
  }
  return withTransaction(async (client) => {
    const eventResult = await client.query(`
      SELECT id, expires_at FROM events
      WHERE id = $1 AND expires_at > transaction_timestamp()
      FOR UPDATE
    `, [eventId]);
    const event = eventResult.rows[0];
    if (!event) throw new Error('event not found');

    const activeConfigurations = await client.query(`
      SELECT count(*)::integer AS count
      FROM configurations configuration
      WHERE configuration.event_id = $1
        AND configuration.expires_at > transaction_timestamp()
        AND NOT EXISTS (
          SELECT 1
          FROM order_items item
          JOIN orders on orders.id = item.order_id
          WHERE item.configuration_id = configuration.id
            AND orders.status in ('paid_test', 'paid', 'fulfilled')
        )
    `, [eventId]);
    if (Number(activeConfigurations.rows[0].count) >= MAX_ACTIVE_UNPAID_CONFIGURATIONS) {
      throw limitError('configuration_limit');
    }

    if (assetIds.length) {
      const assets = await client.query(`
        SELECT id, byte_size
        FROM design_assets
        WHERE id = ANY($1::text[]) AND event_id = $2
          AND storage_status = 'active' AND deleted_at IS NULL
        ORDER BY id
        FOR KEY SHARE
      `, [assetIds, eventId]);
      const totalBytes = assets.rows.reduce((sum, asset) => sum + Number(asset.byte_size), 0);
      if (assets.rowCount !== assetIds.length || totalBytes > MAX_CONFIGURATION_ASSET_BYTES) {
        throw assetValidationError();
      }
      await client.query(`
        UPDATE design_assets
        SET expires_at = greatest(expires_at, transaction_timestamp() + interval '30 days')
        WHERE id = ANY($1::text[])
      `, [assetIds]);
    }

    const id = crypto.randomBytes(12).toString('base64url');
    const result = await client.query(`
      INSERT INTO configurations (
        id, event_id, product_key, printful_variant_id, quantity, unit_price_cents,
        theme, words_json, design_json, configuration_type, orientation,
        print_width, print_height, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13,
        case when $10 = 'personal_memory'
          then transaction_timestamp() + interval '30 days'
          else $14::timestamptz
        end
      )
      RETURNING *
    `, [
      id, eventId, productKey, printfulVariantId, quantity, unitPriceCents, theme,
      jsonValue(words), jsonValue(design), configurationType, orientation, printWidth, printHeight,
      event.expires_at,
    ]);
    if (assetIds.length) {
      await client.query(`
        INSERT INTO configuration_assets (configuration_id, asset_id)
        SELECT $1, unnest($2::text[])
      `, [id, assetIds]);
    }
    return rowToBoundary(result.rows[0]);
  });
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
      AND events.expires_at > transaction_timestamp()
      AND (
        configurations.expires_at > transaction_timestamp() OR EXISTS (
          SELECT 1 FROM order_items item
          JOIN orders retained_order ON retained_order.id = item.order_id
          WHERE item.configuration_id = configurations.id
            AND retained_order.status IN ('paid_test', 'paid', 'fulfilled')
        )
      )
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
      AND events.expires_at > transaction_timestamp()
      AND (
        configurations.expires_at > transaction_timestamp() OR EXISTS (
          SELECT 1 FROM order_items item
          JOIN orders retained_order ON retained_order.id = item.order_id
          WHERE item.configuration_id = configurations.id
            AND retained_order.status IN ('paid_test', 'paid', 'fulfilled')
        )
      )
  `, [ids, slug]);
  if (result.rows.length !== ids.length) return [];
  const byId = new Map(rowsToBoundary(result.rows).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id));
}

// ── Expired event cleanup ───────────────────────────────────────────────
// These primitives establish the race-safe object-first cleanup boundary;
// scheduling and bounded batch orchestration live in the maintenance worker.
async function prepareExpiredEventCleanup(eventId) {
  return withTransaction(async (client) => {
    const eventResult = await client.query(`
      SELECT id FROM events
      WHERE id = $1 AND expires_at <= transaction_timestamp()
      FOR UPDATE
    `, [eventId]);
    if (!eventResult.rowCount) return null;

    // Let an already-created Stripe Checkout session finish or expire. This
    // prevents the event-expiry boundary from deleting a still-payable order.
    const activeCheckout = await client.query(`
      SELECT 1 FROM orders
      WHERE event_id = $1
        AND status IN ('creating_checkout', 'checkout_pending')
        AND checkout_session_expires_at > transaction_timestamp()
      LIMIT 1
    `, [eventId]);
    if (activeCheckout.rowCount) return null;

    // Unpaid/abandoned checkout attempts are event-lifetime data. Removing
    // them first releases their configuration references. Paid commerce is
    // retained and detached below.
    await client.query(`
      DELETE FROM orders
      WHERE event_id = $1 AND status NOT IN ('paid_test', 'paid', 'fulfilled')
    `, [eventId]);

    const retainedResult = await client.query(`
      SELECT DISTINCT configuration_id
      FROM (
        SELECT item.configuration_id
        FROM order_items item
        JOIN orders retained_order ON retained_order.id = item.order_id
        WHERE retained_order.event_id = $1
          AND retained_order.status IN ('paid_test', 'paid', 'fulfilled')
          AND item.configuration_id IS NOT NULL
        UNION
        SELECT retained_order.configuration_id
        FROM orders retained_order
        WHERE retained_order.event_id = $1
          AND retained_order.status IN ('paid_test', 'paid', 'fulfilled')
          AND retained_order.configuration_id IS NOT NULL
      ) retained
    `, [eventId]);
    const retainedConfigurationIds = retainedResult.rows.map((row) => row.configuration_id);

    if (retainedConfigurationIds.length) {
      await client.query(`
        UPDATE design_assets asset
        SET event_id = null
        WHERE asset.event_id = $1 AND EXISTS (
          SELECT 1 FROM configuration_assets reference
          WHERE reference.asset_id = asset.id
            AND reference.configuration_id = ANY($2::text[])
        )
      `, [eventId, retainedConfigurationIds]);
      await client.query(`
        UPDATE configurations
        SET event_id = null
        WHERE event_id = $1 AND id = ANY($2::text[])
      `, [eventId, retainedConfigurationIds]);
    }

    await client.query('DELETE FROM configurations WHERE event_id = $1', [eventId]);
    const assets = await client.query(`
      UPDATE design_assets asset
      SET storage_status = 'deleting', deletion_attempts = deletion_attempts + 1,
          last_delete_error = null
      WHERE asset.event_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM configuration_assets reference WHERE reference.asset_id = asset.id
        )
      RETURNING *
    `, [eventId]);
    return {
      eventId: String(eventId),
      retainedConfigurationIds,
      assets: rowsToBoundary(assets.rows),
    };
  });
}

async function finishExpiredEventDeletion(eventId) {
  return withTransaction(async (client) => {
    const event = await client.query(`
      SELECT id FROM events
      WHERE id = $1 AND expires_at <= transaction_timestamp()
      FOR UPDATE
    `, [eventId]);
    if (!event.rowCount) return false;
    const remaining = await client.query(`
      SELECT
        EXISTS (SELECT 1 FROM configurations WHERE event_id = $1) AS configurations,
        EXISTS (SELECT 1 FROM design_assets WHERE event_id = $1) AS assets
    `, [eventId]);
    if (remaining.rows[0].configurations || remaining.rows[0].assets) return false;
    await client.query('DELETE FROM events WHERE id = $1', [eventId]);
    return true;
  });
}

// ── Frozen paid print artifacts ─────────────────────────────────────────
async function getOrCreatePrintArtifact({
  id,
  orderId,
  orderItemId,
  configurationId,
  surfaceKey,
  objectKey,
  mimeType,
  byteSize,
  sha256,
  accessNonce,
  expiresAt,
}) {
  const result = await getPool().query(`
    INSERT INTO print_artifacts (
      id, order_id, order_item_id, configuration_id, surface_key, object_key,
      mime_type, byte_size, sha256, access_nonce, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (order_item_id, surface_key) DO UPDATE
      SET order_item_id = excluded.order_item_id
    RETURNING *
  `, [
    id, orderId, orderItemId, configurationId || null, surfaceKey, objectKey,
    mimeType, byteSize, sha256, accessNonce, expiresAt,
  ]);
  return rowToBoundary(result.rows[0]);
}

async function activatePrintArtifact(id, { byteSize, sha256 }) {
  const result = await getPool().query(`
    UPDATE print_artifacts
    SET storage_status = 'active', last_upload_error = null
    WHERE id = $1 AND storage_status = 'uploading'
      AND byte_size = $2 AND sha256 = $3
    RETURNING *
  `, [id, byteSize, sha256]);
  return rowToBoundary(result.rows[0]);
}

async function failPrintArtifactUpload(id, errorCode = 'storage_upload_failed') {
  const result = await getPool().query(`
    UPDATE print_artifacts
    SET storage_status = 'uploading', last_upload_error = $1
    WHERE id = $2 AND storage_status = 'uploading'
    RETURNING *
  `, [String(errorCode).slice(0, 240), id]);
  return rowToBoundary(result.rows[0]);
}

async function getPrintArtifact(id) {
  const result = await getPool().query('SELECT * FROM print_artifacts WHERE id = $1', [id]);
  return rowToBoundary(result.rows[0]);
}

async function getActivePrintArtifact(id, accessNonce) {
  const result = await getPool().query(`
    SELECT * FROM print_artifacts
    WHERE id = $1 AND access_nonce = $2 AND storage_status = 'active'
      AND expires_at > transaction_timestamp()
  `, [id, accessNonce]);
  return rowToBoundary(result.rows[0]);
}

async function getOrderPrintArtifacts(orderId) {
  const result = await getPool().query(`
    SELECT * FROM print_artifacts
    WHERE order_id = $1
    ORDER BY order_item_id, surface_key
  `, [orderId]);
  return rowsToBoundary(result.rows);
}

async function extendOrderArtifactRetention(orderId, expiresAt) {
  const result = await getPool().query(`
    UPDATE print_artifacts
    SET expires_at = greatest(expires_at, $2::timestamptz)
    WHERE order_id = $1 AND storage_status = 'active'
  `, [orderId, expiresAt]);
  return result.rowCount;
}

async function claimExpiredPrintArtifact(excludeIds = []) {
  return withTransaction(async (client) => {
    const selected = await client.query(`
      SELECT id FROM print_artifacts
      WHERE support_hold = false AND expires_at <= transaction_timestamp()
        AND storage_status IN ('active', 'delete_failed')
        AND NOT (id = ANY($1::text[]))
      ORDER BY expires_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [excludeIds]);
    if (!selected.rowCount) return null;
    const claimed = await client.query(`
      UPDATE print_artifacts
      SET storage_status = 'deleting', deletion_attempts = deletion_attempts + 1,
          last_delete_error = null
      WHERE id = $1
      RETURNING *
    `, [selected.rows[0].id]);
    return rowToBoundary(claimed.rows[0]);
  });
}

async function finishPrintArtifactDeletion(id) {
  const result = await getPool().query(`
    DELETE FROM print_artifacts WHERE id = $1 AND storage_status = 'deleting'
  `, [id]);
  return result.rowCount === 1;
}

async function failPrintArtifactDeletion(id, errorCode = 'storage_delete_failed') {
  const result = await getPool().query(`
    UPDATE print_artifacts
    SET storage_status = 'delete_failed', last_delete_error = $1
    WHERE id = $2 AND storage_status = 'deleting'
    RETURNING *
  `, [String(errorCode).slice(0, 240), id]);
  return rowToBoundary(result.rows[0]);
}

// ── Bounded retention claims and maintenance heartbeat ─────────────────
async function getExpiredEventIds(limit = 5) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 20 ? limit : 5;
  const result = await getPool().query(`
    SELECT id FROM events
    WHERE expires_at <= transaction_timestamp()
    ORDER BY expires_at, id
    LIMIT $1
  `, [safeLimit]);
  return result.rows.map((row) => String(row.id));
}

async function prepareExpiredPersonalConfigurationCleanup() {
  return withTransaction(async (client) => {
    const selected = await client.query(`
      SELECT configuration.id
      FROM configurations configuration
      WHERE configuration.configuration_type = 'personal_memory'
        AND configuration.expires_at <= transaction_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM order_items item
          JOIN orders retained_order ON retained_order.id = item.order_id
          WHERE item.configuration_id = configuration.id
            AND retained_order.status IN ('paid_test', 'paid', 'fulfilled')
        )
      ORDER BY configuration.expires_at, configuration.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    if (!selected.rowCount) return null;
    const configurationId = selected.rows[0].id;
    const assetResult = await client.query(`
      SELECT asset.id
      FROM design_assets asset
      JOIN configuration_assets reference ON reference.asset_id = asset.id
      WHERE reference.configuration_id = $1
      FOR UPDATE OF asset
    `, [configurationId]);
    await client.query('DELETE FROM configurations WHERE id = $1', [configurationId]);
    const assetIds = assetResult.rows.map((row) => row.id);
    if (!assetIds.length) return { configurationId, assets: [] };
    const unreferenced = await client.query(`
      SELECT asset.* FROM design_assets asset
      WHERE asset.id = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM configuration_assets reference WHERE reference.asset_id = asset.id
        )
    `, [assetIds]);
    return { configurationId, assets: rowsToBoundary(unreferenced.rows) };
  });
}

async function claimExpiredDesignAsset(excludeIds = []) {
  return withTransaction(async (client) => {
    const selected = await client.query(`
      SELECT asset.id
      FROM design_assets asset
      WHERE asset.expires_at <= transaction_timestamp()
        AND NOT (asset.id = ANY($1::text[]))
        AND (
          asset.storage_status IN ('active', 'delete_failed') OR
          (asset.storage_status = 'uploading'
            AND asset.created_at < transaction_timestamp() - interval '10 minutes')
        )
        AND NOT EXISTS (
          SELECT 1 FROM configuration_assets reference WHERE reference.asset_id = asset.id
        )
      ORDER BY asset.expires_at, asset.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [excludeIds]);
    if (!selected.rowCount) return null;
    const claimed = await client.query(`
      UPDATE design_assets
      SET storage_status = 'deleting', deletion_attempts = deletion_attempts + 1,
          last_delete_error = null
      WHERE id = $1
      RETURNING *
    `, [selected.rows[0].id]);
    return rowToBoundary(claimed.rows[0]);
  });
}

async function startMaintenanceRun(triggerKind = 'http') {
  const result = await getPool().query(`
    INSERT INTO maintenance_runs (trigger_kind) VALUES ($1) RETURNING *
  `, [triggerKind]);
  return rowToBoundary(result.rows[0]);
}

async function finishMaintenanceRun(id, summary) {
  const result = await getPool().query(`
    UPDATE maintenance_runs
    SET status = 'succeeded', summary_json = $1::jsonb,
        error_code = null, completed_at = transaction_timestamp()
    WHERE id = $2 AND status = 'running'
    RETURNING *
  `, [jsonValue(summary), id]);
  return rowToBoundary(result.rows[0]);
}

async function failMaintenanceRun(id, errorCode = 'maintenance_failed') {
  const result = await getPool().query(`
    UPDATE maintenance_runs
    SET status = 'failed', error_code = $1, completed_at = transaction_timestamp()
    WHERE id = $2 AND status = 'running'
    RETURNING *
  `, [String(errorCode).slice(0, 120), id]);
  return rowToBoundary(result.rows[0]);
}

async function getLatestMaintenanceRun() {
  const result = await getPool().query(`
    SELECT * FROM maintenance_runs ORDER BY id DESC LIMIT 1
  `);
  return rowToBoundary(result.rows[0]);
}

// ── Operational status and guarded operator actions ───────────────────
async function getOperationalStatus() {
  const result = await getPool().query(`
    SELECT
      (SELECT status FROM maintenance_runs ORDER BY id DESC LIMIT 1) AS latest_maintenance_status,
      (SELECT extract(epoch from transaction_timestamp() - max(completed_at))::bigint
       FROM maintenance_runs WHERE status = 'succeeded') AS maintenance_success_age_seconds,
      (SELECT count(*)::integer FROM orders
       WHERE status IN ('paid_test', 'paid')
         AND fulfillment_status IN ('pending', 'failed', 'processing')) AS fulfillment_actionable,
      (SELECT count(*)::integer FROM orders
       WHERE status IN ('paid_test', 'paid') AND fulfillment_status = 'blocked') AS fulfillment_blocked,
      (SELECT count(*)::integer FROM orders
       WHERE status IN ('paid_test', 'paid') AND fulfillment_status = 'processing'
         AND fulfillment_locked_until <= transaction_timestamp()) AS fulfillment_expired_leases,
      (SELECT count(*)::integer FROM orders
       WHERE status IN ('paid_test', 'paid')
         AND fulfillment_status IN ('pending', 'failed', 'processing')
         AND paid_at < transaction_timestamp() - interval '5 minutes') AS fulfillment_over_five_minutes,
      (SELECT coalesce(extract(epoch from transaction_timestamp() - min(coalesce(fulfillment_updated_at, paid_at)))::bigint, 0)
       FROM orders WHERE status IN ('paid_test', 'paid')
         AND fulfillment_status IN ('pending', 'failed', 'processing')) AS oldest_fulfillment_age_seconds,
      (SELECT count(*)::integer FROM email_jobs
       WHERE status IN ('pending', 'failed', 'processing')) AS email_actionable,
      (SELECT count(*)::integer FROM email_jobs WHERE status = 'blocked') AS email_blocked,
      (SELECT count(*)::integer FROM email_jobs
       WHERE status = 'processing' AND locked_until <= transaction_timestamp()) AS email_expired_leases,
      (SELECT count(*)::integer FROM email_jobs WHERE status = 'bounced') AS email_bounced,
      (SELECT count(*)::integer FROM email_jobs WHERE status = 'complained') AS email_complained,
      (SELECT coalesce(extract(epoch from transaction_timestamp() - min(created_at))::bigint, 0)
       FROM email_jobs WHERE status IN ('pending', 'failed', 'processing')) AS oldest_email_age_seconds,
      (SELECT count(*)::integer FROM design_assets
       WHERE storage_status = 'delete_failed'
          OR (storage_status = 'uploading'
              AND created_at < transaction_timestamp() - interval '10 minutes')) AS design_asset_failures,
      (SELECT count(*)::integer FROM print_artifacts
       WHERE storage_status IN ('uploading', 'delete_failed')
         AND created_at < transaction_timestamp() - interval '10 minutes') AS print_artifact_failures,
      (SELECT count(*)::integer FROM checkout_quotes
       WHERE expires_at <= transaction_timestamp()) AS expired_quotes,
      (SELECT count(*)::integer FROM events
       WHERE expires_at <= transaction_timestamp()) AS expired_events
  `);
  const row = result.rows[0] || {};
  return {
    sampledAt: new Date().toISOString(),
    maintenance: {
      latestStatus: row.latest_maintenance_status || 'missing',
      successfulAgeSeconds: row.maintenance_success_age_seconds == null
        ? null : Number(row.maintenance_success_age_seconds),
    },
    fulfillment: {
      actionable: Number(row.fulfillment_actionable || 0),
      blocked: Number(row.fulfillment_blocked || 0),
      expiredLeases: Number(row.fulfillment_expired_leases || 0),
      overFiveMinutes: Number(row.fulfillment_over_five_minutes || 0),
      oldestAgeSeconds: Number(row.oldest_fulfillment_age_seconds || 0),
    },
    email: {
      actionable: Number(row.email_actionable || 0),
      blocked: Number(row.email_blocked || 0),
      expiredLeases: Number(row.email_expired_leases || 0),
      bounced: Number(row.email_bounced || 0),
      complained: Number(row.email_complained || 0),
      oldestAgeSeconds: Number(row.oldest_email_age_seconds || 0),
    },
    storage: {
      designAssetFailures: Number(row.design_asset_failures || 0),
      printArtifactFailures: Number(row.print_artifact_failures || 0),
    },
    retention: {
      expiredQuotes: Number(row.expired_quotes || 0),
      expiredEvents: Number(row.expired_events || 0),
    },
  };
}

async function claimBlockedFulfillmentForManualRetry({ orderId, lockedBy, leaseMs = 120_000 }) {
  if (!/^\d+$/.test(String(orderId || ''))) throw new Error('invalid order id');
  if (!/^operator-[A-Za-z0-9_-]{8,100}$/.test(String(lockedBy || ''))) {
    throw new Error('invalid operator lease owner');
  }
  const safeLeaseMs = Number.isSafeInteger(leaseMs) && leaseMs >= 15_000 && leaseMs <= 300_000
    ? leaseMs : 120_000;
  return withTransaction(async (client) => {
    const selected = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const current = selected.rows[0];
    if (!current || !['paid_test', 'paid'].includes(current.status)) return { outcome: 'not_found' };
    if (current.fulfillment_status !== 'blocked') {
      return { outcome: 'not_blocked', order: rowToBoundary(current) };
    }
    const actionResult = await client.query(`
      INSERT INTO operator_actions (
        action_type, order_id, before_state, status
      ) VALUES ('manual_fulfillment_retry', $1, $2, 'running')
      RETURNING *
    `, [current.id, current.fulfillment_status]);
    const claimed = await client.query(`
      UPDATE orders
      SET fulfillment_status = 'processing', fulfillment_attempts = 1,
          fulfillment_error = null, fulfillment_next_attempt_at = transaction_timestamp(),
          fulfillment_locked_by = $2,
          fulfillment_locked_until = transaction_timestamp() + ($3::integer * interval '1 millisecond'),
          fulfillment_lease_version = fulfillment_lease_version + 1,
          fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE id = $1 AND fulfillment_status = 'blocked'
      RETURNING *
    `, [current.id, lockedBy, safeLeaseMs]);
    return {
      outcome: 'claimed',
      action: rowToBoundary(actionResult.rows[0]),
      order: rowToBoundary(claimed.rows[0]),
    };
  });
}

async function finishOperatorAction(id, { succeeded, afterState = null, errorCode = null, summary = null } = {}) {
  const result = await getPool().query(`
    UPDATE operator_actions
    SET status = $1, after_state = $2, error_code = $3,
        summary_json = $4::jsonb, completed_at = transaction_timestamp()
    WHERE id = $5 AND status = 'running'
    RETURNING *
  `, [
    succeeded ? 'succeeded' : 'failed',
    afterState == null ? null : String(afterState).slice(0, 80),
    errorCode == null ? null : String(errorCode).slice(0, 120),
    jsonValue(summary), id,
  ]);
  return rowToBoundary(result.rows[0]);
}

const PRELIVE_BUSINESS_TABLES = Object.freeze([
  'email_smoke_runs', 'provider_smoke_runs', 'resend_webhook_events',
  'printful_webhook_events', 'stripe_webhook_events', 'email_jobs',
  'print_artifacts', 'order_items', 'checkout_order_shipments', 'orders',
  'checkout_quotes', 'configuration_assets', 'design_assets', 'configurations',
  'admin_pin_failures', 'archives', 'word_contributions', 'words', 'events',
  'reserved_event_slugs', 'maintenance_runs',
]);

async function getPreliveCleanupCounts() {
  const selections = PRELIVE_BUSINESS_TABLES
    .map((table) => `(SELECT count(*)::integer FROM ${table}) AS ${table}`)
    .join(',\n');
  const result = await getPool().query(`SELECT ${selections}`);
  return Object.fromEntries(PRELIVE_BUSINESS_TABLES.map((table) => [
    table, Number(result.rows[0]?.[table] || 0),
  ]));
}

async function clearPreliveBusinessData() {
  return withTransaction(async (client) => {
    const beforeSelections = PRELIVE_BUSINESS_TABLES
      .map((table) => `(SELECT count(*)::integer FROM ${table}) AS ${table}`)
      .join(',\n');
    const beforeResult = await client.query(`SELECT ${beforeSelections}`);
    const before = Object.fromEntries(PRELIVE_BUSINESS_TABLES.map((table) => [
      table, Number(beforeResult.rows[0]?.[table] || 0),
    ]));
    for (const table of PRELIVE_BUSINESS_TABLES) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query('DELETE FROM operator_actions');
    const actionResult = await client.query(`
      INSERT INTO operator_actions (
        action_type, before_state, after_state, status, summary_json, completed_at
      ) VALUES ('prelive_cleanup', 'hosted_test_data', 'empty', 'succeeded', $1::jsonb,
                transaction_timestamp())
      RETURNING *
    `, [jsonValue({ deletedRows: before })]);
    return { before, action: rowToBoundary(actionResult.rows[0]) };
  });
}

// ── Replay-safe Resend provider status updates ─────────────────────────
async function recordResendWebhook({
  svixId,
  eventType,
  eventCreatedAt = null,
  providerMessageId = null,
  emailJobTag = null,
}) {
  const statusByEvent = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.bounced': 'bounced',
    'email.failed': 'failed',
    'email.complained': 'complained',
  };
  const nextStatus = statusByEvent[eventType];
  if (!nextStatus) return { duplicate: false, matched: false, ignored: true };
  return withTransaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO resend_webhook_events (
        svix_id, event_type, event_created_at, provider_message_id
      ) VALUES ($1, $2, $3::timestamptz, $4)
      ON CONFLICT (svix_id) DO NOTHING
      RETURNING svix_id
    `, [svixId, eventType, eventCreatedAt, providerMessageId]);
    if (!inserted.rowCount) return { duplicate: true, matched: false };

    const providerMatch = providerMessageId
      ? await client.query('SELECT * FROM email_jobs WHERE provider_message_id = $1 FOR UPDATE', [providerMessageId])
      : { rows: [] };
    const taggedId = /^\d+$/.test(String(emailJobTag || '')) ? String(emailJobTag) : null;
    const tagMatch = taggedId
      ? await client.query('SELECT * FROM email_jobs WHERE id = $1 FOR UPDATE', [taggedId])
      : { rows: [] };
    if (providerMatch.rows[0] && tagMatch.rows[0] &&
        String(providerMatch.rows[0].id) !== String(tagMatch.rows[0].id)) {
      return { duplicate: false, matched: false, mismatch: true };
    }
    const job = providerMatch.rows[0] || tagMatch.rows[0];
    if (!job) return { duplicate: false, matched: false };
    if (job.provider_message_id && providerMessageId && job.provider_message_id !== providerMessageId) {
      return { duplicate: false, matched: false, mismatch: true };
    }

    let resolvedStatus = nextStatus;
    const terminalFailure = job.provider_terminal && ['bounced', 'failed', 'complained'].includes(job.status);
    if (job.status === 'complained') resolvedStatus = 'complained';
    else if (terminalFailure && nextStatus !== 'complained') resolvedStatus = job.status;
    else if (job.status === 'delivered' && nextStatus === 'sent') resolvedStatus = 'delivered';

    const terminal = ['delivered', 'bounced', 'failed', 'complained'].includes(resolvedStatus);
    const errorByStatus = {
      bounced: 'provider_bounced',
      failed: 'provider_failed',
      complained: 'provider_complained',
    };
    const updated = await client.query(`
      UPDATE email_jobs
      SET status = $1,
          provider_message_id = coalesce(provider_message_id, $2),
          provider_terminal = $3,
          provider_event_at = CASE
            WHEN $4::timestamptz IS NULL THEN provider_event_at
            ELSE greatest(coalesce(provider_event_at, $4::timestamptz), $4::timestamptz)
          END,
          delivery_ambiguous = false,
          last_error = $5,
          sent_at = CASE WHEN $1 IN ('sent', 'delivered', 'bounced', 'complained')
            THEN coalesce(sent_at, $4::timestamptz, transaction_timestamp()) ELSE sent_at END,
          delivered_at = CASE WHEN $1 = 'delivered'
            THEN coalesce(delivered_at, $4::timestamptz, transaction_timestamp()) ELSE delivered_at END,
          bounced_at = CASE WHEN $1 = 'bounced'
            THEN coalesce(bounced_at, $4::timestamptz, transaction_timestamp()) ELSE bounced_at END,
          complained_at = CASE WHEN $1 = 'complained'
            THEN coalesce(complained_at, $4::timestamptz, transaction_timestamp()) ELSE complained_at END,
          locked_by = null, locked_until = null, updated_at = transaction_timestamp()
      WHERE id = $6
      RETURNING *
    `, [
      resolvedStatus, providerMessageId, terminal, eventCreatedAt,
      errorByStatus[resolvedStatus] || null, job.id,
    ]);
    await client.query(`
      UPDATE resend_webhook_events SET email_job_id = $1 WHERE svix_id = $2
    `, [job.id, svixId]);
    return { duplicate: false, matched: true, job: rowToBoundary(updated.rows[0]) };
  });
}

async function recordStripeRefund({
  stripeEventId,
  eventType,
  paymentIntentId,
  livemode,
  amountRefunded,
  currency,
}) {
  return withTransaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO stripe_webhook_events (stripe_event_id, event_type, stripe_session_id)
      VALUES ($1, $2, null)
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `, [stripeEventId, eventType]);
    if (!inserted.rowCount) return { duplicate: true, matched: false };
    const orderResult = await client.query(`
      SELECT * FROM orders WHERE stripe_payment_intent_id = $1 FOR UPDATE
    `, [paymentIntentId]);
    const order = orderResult.rows[0];
    if (!order) return { duplicate: false, matched: false };
    const expectedMode = livemode ? 'live' : 'test';
    if (order.mode !== expectedMode || String(currency || '').toUpperCase() !== order.currency ||
        !Number.isSafeInteger(Number(amountRefunded)) || Number(amountRefunded) < 0 ||
        Number(amountRefunded) > Number(order.total_cents)) {
      throw new Error('refund does not match trusted order data');
    }
    const updated = await client.query(`
      UPDATE orders
      SET refunded_at = coalesce(refunded_at, transaction_timestamp()),
          refunded_cents = greatest(coalesce(refunded_cents, 0), $1),
          updated_at = transaction_timestamp()
      WHERE id = $2 RETURNING *
    `, [Number(amountRefunded), order.id]);
    await client.query(`
      UPDATE stripe_webhook_events SET order_id = $1 WHERE stripe_event_id = $2
    `, [order.id, stripeEventId]);
    const email = await insertEmailJobForOrder(client, {
      order: updated.rows[0],
      kind: 'refund_confirmation',
      dedupeKey: `refund_confirmation:order:${order.id}`,
      noticeAmountCents: Number(amountRefunded),
    });
    return {
      duplicate: false,
      matched: true,
      order: rowToBoundary(updated.rows[0]),
      emailJob: email.job,
      emailJobCreated: email.created,
    };
  });
}

// ── Replay-safe Printful provider status updates ────────────────────────
async function recordPrintfulWebhook({
  eventKey,
  eventType,
  providerOrderId = null,
  externalOrderId = null,
  providerShipmentId = null,
  providerStatus = null,
  carrier = null,
  trackingNumber = null,
  trackingUrl = null,
  shippedAt = null,
  deliveredAt = null,
}) {
  return withTransaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO printful_webhook_events (
        event_key, event_type, provider_order_id, external_order_id
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key
    `, [eventKey, eventType, providerOrderId, externalOrderId]);
    if (!inserted.rowCount) return { duplicate: true, matched: false };

    const shipmentResult = await client.query(`
      SELECT shipment.id, shipment.order_id
      FROM checkout_order_shipments shipment
      WHERE ($1::text IS NOT NULL AND shipment.fulfillment_payload_json->>'external_id' = $1)
         OR ($2::text IS NOT NULL AND shipment.printful_order_id = $2)
      ORDER BY shipment.id
      LIMIT 1
      FOR UPDATE
    `, [externalOrderId, providerOrderId]);
    const shipment = shipmentResult.rows[0];
    if (!shipment) return { duplicate: false, matched: false };

    const safeStatus = String(providerStatus || eventType).slice(0, 80);
    await client.query(`
      UPDATE checkout_order_shipments
      SET printful_order_status = CASE
            WHEN $6 IN ('order_created', 'order_updated')
              AND printful_order_status IN ('shipped', 'delivered', 'returned')
              THEN printful_order_status
            ELSE $1
          END,
          provider_shipment_id = coalesce(provider_shipment_id, $2),
          shipped_at = coalesce(shipped_at, $3::timestamptz),
          delivered_at = coalesce(delivered_at, $4::timestamptz),
          carrier = coalesce(carrier, $7),
          tracking_number = coalesce(tracking_number, $8),
          tracking_url = coalesce(tracking_url, $9),
          fulfillment_status = CASE
            WHEN $6 IN ('order_failed', 'order_canceled') THEN 'blocked'
            ELSE fulfillment_status
          END,
          fulfillment_error = CASE
            WHEN $6 IN ('order_failed', 'order_canceled') THEN 'printful_' || $6
            ELSE fulfillment_error
          END,
          updated_at = transaction_timestamp()
      WHERE id = $5
    `, [
      safeStatus, providerShipmentId, shippedAt, deliveredAt, shipment.id, eventType,
      carrier, trackingNumber, trackingUrl,
    ]);

    if (['order_failed', 'order_canceled'].includes(eventType)) {
      await client.query(`
        UPDATE orders
        SET fulfillment_status = 'blocked', fulfillment_error = 'printful_' || $2,
            canceled_at = CASE WHEN $2 = 'order_canceled'
              THEN coalesce(canceled_at, transaction_timestamp()) ELSE canceled_at END,
            fulfillment_updated_at = transaction_timestamp(), updated_at = transaction_timestamp()
        WHERE id = $1 AND fulfillment_status IN ('draft', 'submitted')
      `, [shipment.order_id, eventType]);
    }

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [shipment.order_id]);
    const storedOrder = orderResult.rows[0];
    const orderSubmittedAt = orderResult.rows[0]?.fulfillment_submitted_at;
    const retentionBase = deliveredAt
      ? new Date(new Date(deliveredAt).getTime() + 60 * 24 * 60 * 60 * 1000)
      : new Date(new Date(orderSubmittedAt || Date.now()).getTime() + 90 * 24 * 60 * 60 * 1000);
    await client.query(`
      UPDATE print_artifacts
      SET expires_at = greatest(expires_at, $2::timestamptz)
      WHERE order_id = $1
    `, [shipment.order_id, retentionBase]);

    const pending = await client.query(`
      SELECT 1 FROM checkout_order_shipments
      WHERE order_id = $1 AND shipped_at IS NULL
      LIMIT 1
    `, [shipment.order_id]);
    if (!pending.rowCount && eventType === 'shipment_sent') {
      await client.query(`
        UPDATE orders SET status = 'fulfilled', updated_at = transaction_timestamp()
        WHERE id = $1 AND status = 'paid'
      `, [shipment.order_id]);
    }
    let email = null;
    if (eventType === 'shipment_sent' && providerShipmentId) {
      email = await insertEmailJobForOrder(client, {
        order: storedOrder,
        kind: 'shipment_confirmation',
        shipmentId: shipment.id,
        dedupeKey: `shipment_confirmation:order:${shipment.order_id}:shipment:${providerShipmentId}`,
      });
    } else if (eventType === 'order_canceled') {
      email = await insertEmailJobForOrder(client, {
        order: storedOrder,
        kind: 'cancellation_confirmation',
        dedupeKey: `cancellation_confirmation:order:${shipment.order_id}`,
      });
    }
    return {
      duplicate: false,
      matched: true,
      orderId: String(shipment.order_id),
      emailJob: email?.job || null,
      emailJobCreated: Boolean(email?.created),
    };
  });
}

// ── Explicit operator-only provider smoke data ──────────────────────────
async function createProviderSmokeOrder({ productKey, recipient }) {
  const product = resolveProductOrientation(getProduct(productKey), 'default');
  if (!product) throw new Error('provider smoke product is invalid');
  const configurationId = crypto.randomBytes(12).toString('base64url');
  const quoteId = `smoke_${crypto.randomBytes(12).toString('base64url')}`;
  const design = {
    version: 2,
    surfaces: Object.fromEntries(product.printSurfaces.map((surface, index) => [
      surface.key,
      [{
        id: `smoke-${index + 1}`,
        type: 'text',
        text: 'Wolkenworte Test',
        x: product.printFile.width / 2,
        y: product.printFile.height / 2,
        angle: 0,
        color: '#a40e4c',
        fontSize: Math.max(24, Math.min(96, product.printFile.height / 6)),
        fontFamily: 'classic',
      }],
    ])),
  };
  return withTransaction(async (client) => {
    const configurationResult = await client.query(`
      INSERT INTO configurations (
        id, event_id, product_key, printful_variant_id, quantity, unit_price_cents,
        theme, words_json, design_json, configuration_type, orientation,
        print_width, print_height, expires_at
      ) VALUES (
        $1, null, $2, $3, 1, 0, 'pastel', '[]'::jsonb, $4::jsonb,
        'personal_memory', 'default', $5, $6,
        transaction_timestamp() + interval '30 days'
      ) RETURNING *
    `, [
      configurationId, product.key, product.printful.variantId, jsonValue(design),
      product.printFile.width, product.printFile.height,
    ]);
    const configuration = rowToBoundary(configurationResult.rows[0]);
    const orderResult = await client.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot, configuration_id,
        configuration_ids_json, quote_id, status, shipping_json, currency,
        items_cents, shipping_cents, tax_cents, total_cents, mode, paid_at,
        fulfillment_status, fulfillment_next_attempt_at, provider_smoke
      ) VALUES (
        null, 'provider-smoke', 'Wolkenworte Provider Smoke', $1, $2::jsonb,
        $3, 'paid', $4::jsonb, 'EUR', 0, 0, 0, 0, 'live',
        transaction_timestamp(), 'pending', transaction_timestamp(), true
      ) RETURNING *
    `, [configuration.id, jsonValue([configuration.id]), quoteId, jsonValue(recipient)]);
    const order = rowToBoundary(orderResult.rows[0]);
    await client.query(`
      INSERT INTO checkout_order_shipments (
        order_id, shipment_index, quantity, items_json, recipient_json,
        printful_costs_json, currency, shipping_cents, tax_cents
      ) VALUES ($1, 0, 1, $2::jsonb, $3::jsonb, '{}'::jsonb, 'EUR', 0, 0)
    `, [order.id, jsonValue([{ configurationId: configuration.id, quantity: 1 }]), jsonValue(recipient)]);
    await client.query(`
      INSERT INTO order_items (
        order_id, configuration_id, shipment_index, item_index, product_key,
        printful_variant_id, quantity, configuration_snapshot_json
      ) VALUES ($1, $2, 0, 0, $3, $4, 1, $5::jsonb)
    `, [
      order.id, configuration.id, configuration.product_key,
      configuration.printful_variant_id, jsonValue(configurationSnapshot(configuration)),
    ]);
    const smokeResult = await client.query(`
      INSERT INTO provider_smoke_runs (order_id, product_key, status)
      VALUES ($1, $2, 'running') RETURNING *
    `, [order.id, product.key]);
    return { order, smokeRun: rowToBoundary(smokeResult.rows[0]) };
  });
}

async function finishProviderSmokeRun(id, { succeeded, outcomeCode }) {
  const result = await getPool().query(`
    UPDATE provider_smoke_runs
    SET status = $1, outcome_code = $2, completed_at = transaction_timestamp()
    WHERE id = $3 AND status = 'running'
    RETURNING *
  `, [succeeded ? 'succeeded' : 'failed', String(outcomeCode || '').slice(0, 120) || null, id]);
  return rowToBoundary(result.rows[0]);
}

async function createEmailSmokeJob({ recipientEmail, locale = 'de' }) {
  const recipient = normalizeBuyerEmail(recipientEmail);
  if (!recipient) throw new Error('email smoke recipient is invalid');
  const product = resolveProductOrientation(getProduct('white-glossy-mug-duo-11oz'), 'default');
  const quoteId = `email_smoke_${crypto.randomBytes(12).toString('base64url')}`;
  return withTransaction(async (client) => {
    const orderResult = await client.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot, configuration_ids_json,
        quote_id, status, shipping_json, buyer_email, currency, items_cents,
        shipping_cents, tax_cents, total_cents, mode, paid_at,
        fulfillment_status, fulfillment_mode, provider_smoke, locale_snapshot
      ) VALUES (
        null, 'email-provider-smoke', 'Wolkenworte E-Mail Provider Smoke', '[]'::jsonb,
        $1, 'paid', $2::jsonb, $3, 'EUR', 2490, 490, 566, 3546, 'live',
        transaction_timestamp(), 'mocked', 'mock', true, $4
      ) RETURNING *
    `, [
      quoteId,
      jsonValue({
        name: 'Wolkenworte Testempfänger', address1: 'Testweg 6',
        zip: '74080', city: 'Heilbronn', country_code: 'DE',
      }),
      recipient,
      String(locale),
    ]);
    const order = orderResult.rows[0];
    const shipmentResult = await client.query(`
      INSERT INTO checkout_order_shipments (
        order_id, shipment_index, quantity, items_json, recipient_json,
        printful_costs_json, currency, shipping_cents, tax_cents,
        fulfillment_status, fulfillment_mode
      ) VALUES (
        $1, 0, 1, $2::jsonb, $3::jsonb, '{}'::jsonb, 'EUR', 490, 566,
        'mocked', 'mock'
      ) RETURNING *
    `, [
      order.id,
      jsonValue([{ configurationId: null, quantity: 1 }]),
      jsonValue({
        name: 'Wolkenworte Testempfänger', address1: 'Testweg 6',
        zip: '74080', city: 'Heilbronn', country_code: 'DE',
      }),
    ]);
    await client.query(`
      INSERT INTO order_items (
        order_id, configuration_id, shipment_index, item_index, product_key,
        printful_variant_id, quantity, configuration_snapshot_json
      ) VALUES ($1, null, 0, 0, $2, $3, 1, $4::jsonb)
    `, [
      order.id,
      product.key,
      product.printful.variantId,
      jsonValue({
        version: 1,
        configurationId: `email-smoke-${crypto.randomBytes(6).toString('base64url')}`,
        productKey: product.key,
        printfulVariantId: product.printful.variantId,
        orientation: 'default',
        configurationType: 'personal_memory',
      }),
    ]);
    const email = await insertEmailJobForOrder(client, {
      order,
      kind: 'order_confirmation',
      dedupeKey: `email_smoke:order_confirmation:${order.id}`,
      providerSmoke: true,
    });
    const smokeResult = await client.query(`
      INSERT INTO email_smoke_runs (order_id, email_job_id, status)
      VALUES ($1, $2, 'running') RETURNING *
    `, [order.id, email.job.id]);
    return {
      order: rowToBoundary(order),
      shipment: rowToBoundary(shipmentResult.rows[0]),
      emailJob: email.job,
      smokeRun: rowToBoundary(smokeResult.rows[0]),
    };
  });
}

async function finishEmailSmokeRun(id, { succeeded, outcomeCode }) {
  const result = await getPool().query(`
    UPDATE email_smoke_runs
    SET status = $1, outcome_code = $2, completed_at = transaction_timestamp()
    WHERE id = $3 AND status = 'running'
    RETURNING *
  `, [succeeded ? 'succeeded' : 'failed', String(outcomeCode || '').slice(0, 120) || null, id]);
  return rowToBoundary(result.rows[0]);
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
  getResetPinStatus,
  recordResetPinFailure,
  clearResetPinFailures,
  authorizeResetPin,
  upsertWord,
  addWordContribution,
  getWordContributions,
  getWordContributionsForOwners,
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
  renewFulfillmentLease,
  completeFulfillment,
  getOrderShipments,
  getOrderItems,
  completeOrderShipment,
  failOrderShipment,
  failFulfillment,
  getPendingFulfillmentOrders,
  recoverStaleFulfillments,
  getEmailJobById,
  getEmailJobsForOrder,
  claimEmailJob,
  renewEmailLease,
  beginEmailProviderAttempt,
  completeMockEmail,
  completeEmailProviderAcceptance,
  failEmailJob,
  blockExpiredAmbiguousEmail,
  getPendingEmailJobs,
  recoverStaleEmailJobs,
  cleanupAbandonedQuotes,
  createCheckoutQuote,
  getCheckoutQuote,
  getEventCheckoutQuote,
  getEventCartCheckoutQuote,
  updateCheckoutQuote,
  isCheckoutQuoteExpired,
  beginDesignAssetUpload,
  activateDesignAsset,
  markDesignAssetUploadFailed,
  getConfigurationAssets,
  claimDesignAssetForDeletion,
  finishDesignAssetDeletion,
  failDesignAssetDeletion,
  createConfiguration,
  getConfiguration,
  getEventConfiguration,
  getEventConfigurations,
  prepareExpiredEventCleanup,
  finishExpiredEventDeletion,
  getOrCreatePrintArtifact,
  activatePrintArtifact,
  failPrintArtifactUpload,
  getPrintArtifact,
  getActivePrintArtifact,
  getOrderPrintArtifacts,
  extendOrderArtifactRetention,
  claimExpiredPrintArtifact,
  finishPrintArtifactDeletion,
  failPrintArtifactDeletion,
  getExpiredEventIds,
  prepareExpiredPersonalConfigurationCleanup,
  claimExpiredDesignAsset,
  startMaintenanceRun,
  finishMaintenanceRun,
  failMaintenanceRun,
  getLatestMaintenanceRun,
  getOperationalStatus,
  claimBlockedFulfillmentForManualRetry,
  finishOperatorAction,
  PRELIVE_BUSINESS_TABLES,
  getPreliveCleanupCounts,
  clearPreliveBusinessData,
  recordResendWebhook,
  recordStripeRefund,
  recordPrintfulWebhook,
  createProviderSmokeOrder,
  finishProviderSmokeRun,
  createEmailSmokeJob,
  finishEmailSmokeRun,
};
