'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const INITIAL_DATABASE_URL = process.env.TEST_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;
const APPLICATION_MIGRATION = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260827000001_application_schema.sql'
);

function clearApplicationModules() {
  for (const modulePath of [
    '../src/db',
    '../src/routes/events',
    '../src/routes/webhook',
    '../src/fulfillment',
    '../src/socket',
    '../server',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

/**
 * Boots one server against an isolated Postgres schema. Node's test runner
 * gives each test file its own process; every server within that file gets a
 * fresh random schema and applies the exact production application migration.
 */
async function startTestServer() {
  if (!INITIAL_DATABASE_URL) {
    throw new Error('Tests require TEST_DATABASE_URL, MIGRATION_DATABASE_URL or DATABASE_URL.');
  }
  const schema = `test_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const { connectionOptions } = require('../src/dbConfig');
  const adminPool = new Pool(connectionOptions(INITIAL_DATABASE_URL, {
    schema: 'public',
    applicationName: `wolkenworte-test-setup-${process.pid}`,
    requireDirect: false,
  }));
  const setupClient = await adminPool.connect();
  try {
    await setupClient.query(`CREATE SCHEMA "${schema}"`);
    await setupClient.query(`SET search_path TO "${schema}", public`);
    await setupClient.query(fs.readFileSync(APPLICATION_MIGRATION, 'utf8'));
  } catch (error) {
    try { await setupClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* ignore */ }
    throw error;
  } finally {
    setupClient.release();
  }

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = INITIAL_DATABASE_URL;
  process.env.DATABASE_SCHEMA = schema;
  process.env.DATABASE_APPLICATION_NAME = `wolkenworte-test-${process.pid}`;
  process.env.ADMIN_TOKEN_SECRET = 'test-secret';
  clearApplicationModules();

  const { server, io, initialize } = require('../server');
  const database = require('../src/db');
  await initialize();

  try {
    await new Promise((resolve, reject) => {
      const onListenError = (error) => reject(error);
      server.once('error', onListenError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onListenError);
        resolve();
      });
    });
  } catch (error) {
    await database.closePool();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
    throw error;
  }

  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    io,
    schema,
    async query(sql, params = []) {
      return database.getPool().query(sql, params);
    },
    async close() {
      await new Promise((resolve) => io.close(() => resolve()));
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      await database.closePool();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    },
  };
}

let counter = 0;
function uniqueCoupleName() {
  counter += 1;
  return `Test Couple ${Date.now()}-${counter}`;
}

async function createEvent(baseUrl, overrides = {}) {
  const coupleName = overrides.coupleName || uniqueCoupleName();
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coupleName,
      slug: overrides.slug,
      pin: overrides.pin || '1234',
      locale: overrides.locale,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createEvent failed: ${res.status} ${JSON.stringify(body)}`);
  return { ...body, coupleName, pin: overrides.pin || '1234' };
}

function productDesignPayload(productKey = 'white-glossy-mug-duo-11oz', orientation = 'default') {
  const { getProduct, resolveProductOrientation } = require('../src/products');
  const product = resolveProductOrientation(getProduct(productKey), orientation);
  if (!product) throw new Error(`Unknown test product: ${productKey}`);
  const design = [{
    id: 'test-design-word',
    text: 'liebe',
    x: product.printFile.width / 2,
    y: product.printFile.height / 2,
    fontSize: Math.max(24, Math.min(96, product.printFile.height / 6)),
    angle: 0,
    color: '#a40e4c',
    fontFamily: 'classic',
  }];
  return {
    designs: Object.fromEntries(product.printSurfaces.map((surface) => [
      surface.key,
      design.map((item) => ({ ...item, id: `${item.id}-${surface.key}` })),
    ])),
  };
}

module.exports = { startTestServer, createEvent, uniqueCoupleName, productDesignPayload };
