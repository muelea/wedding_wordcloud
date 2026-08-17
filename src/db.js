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
    event_title     TEXT NOT NULL DEFAULT 'Hochzeit',
    wedding_date    TEXT,
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
    status             TEXT NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | failed
    shipping_json      TEXT,
    printful_order_id  TEXT,
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
    print_width          INTEGER NOT NULL,
    print_height         INTEGER NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Keep local databases created before the configurable-quantity feature
// usable without a manual migration step. Existing duo drafts retain their
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
function createEvent({ slug, coupleName, eventTitle, weddingDate, pin }) {
  const { hash, salt } = hashPin(pin);
  const stmt = db.prepare(`
    INSERT INTO events (slug, couple_name, event_title, wedding_date, admin_pin_hash, admin_pin_salt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(slug, coupleName, eventTitle || 'Hochzeit', weddingDate || null, hash, salt);
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
  printWidth,
  printHeight,
}) {
  const id = crypto.randomBytes(12).toString('base64url');
  db.prepare(`
    INSERT INTO configurations (
      id, event_id, product_key, printful_variant_id, quantity,
      unit_price_cents, theme, placement, words_json, design_json,
      print_width, print_height
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  getWords,
  clearWords,
  archiveWords,
  createOrder,
  markOrderPaid,
  markOrderFulfilled,
  getOrderBySessionId,
  createConfiguration,
  getConfiguration,
  getEventConfiguration,
};
