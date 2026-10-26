'use strict';

// Test infrastructure only. Never loads .env or reads an application database URL.
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const execute = promisify(execFile);
const IMAGE = 'postgres:17-alpine';
const DATABASE = 'wolkenworte_test';
const ROOT = path.join(__dirname, '../..');

function validateTestDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Ungültige lokale Testdatenbank-Verbindung.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.pathname !== `/${DATABASE}` || url.search || url.hash || !url.port) {
    throw new Error(`Tests dürfen ausschließlich eine lokale ${DATABASE}-Datenbank verwenden. Hosted-Verbindungen sind gesperrt.`);
  }
  return url.href;
}

function testEnvironment(base = process.env, databaseUrl = '') {
  // Defining every documented application setting also prevents server.js and
  // operator modules' dotenv calls from importing workstation credentials later.
  const keys = Object.keys(require('dotenv').parse(fs.readFileSync(path.join(ROOT, '.env.example'))));
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(DATABASE_|MIGRATION_|SUPABASE_|STRIPE_|PRINTFUL_|RESEND_|AUTH_|MAINTENANCE_|CUTOVER_|FLY_)/.test(key)) env[key] = '';
  }
  for (const key of keys) env[key] = '';
  Object.assign(env, {
    NODE_ENV: 'test', APP_ENVIRONMENT: 'local', PORT: '3000',
    STRIPE_PAYMENT_MODE: 'test', STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock', PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false', PRINTFUL_MOCKUP_TOOLS_ENABLED: 'false',
    EMAIL_DELIVERY_MODE: 'mock', AUTH_EMAIL_DELIVERY_MODE: 'mock',
    DESIGN_ACCOUNTS_ENABLED: 'false', MAINTENANCE_MODE: 'false',
    // OAuth redirects and cleanup identity tests need a valid URL shape, not
    // a real service. The reserved .invalid domain cannot identify Supabase.
    SUPABASE_URL: 'https://supabase.wolkenworte.invalid',
    DATABASE_SCHEMA: 'public', DATABASE_APPLICATION_NAME: 'wolkenworte-test',
    RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-that-is-long-enough',
    MAINTENANCE_SECRET: 'test-maintenance-secret-that-is-long-enough',
    SHOP_PRODUCT_MARKUP_PERCENT: '50', SHOP_PAYMENT_RESERVE_PERCENT: '3.69',
    SHOP_PAYMENT_RESERVE_FIXED_CENTS: '49',
    TEST_DATABASE_URL: databaseUrl ? validateTestDatabaseUrl(databaseUrl) : '',
    DATABASE_URL: databaseUrl ? validateTestDatabaseUrl(databaseUrl) : '',
    MIGRATION_DATABASE_URL: '',
  });
  return env;
}

async function docker(args, options = {}) {
  try {
    return (await execute('docker', args, { encoding: 'utf8', timeout: 30_000, ...options })).stdout.trim();
  } catch {
    // Arguments may contain disposable credentials. Do not echo them or .env.
    throw new Error('Lokales Test-Postgres konnte nicht gestartet werden. ./setup.sh test --install prüft Docker und bietet Hilfe. Anleitung: docs/development-environment.md. Supabase wird niemals als Ersatz verwendet.');
  }
}

async function startLocalPostgres({ onSignal } = {}) {
  const { Client } = require('pg');
  // Docker's explicit context takes precedence over DOCKER_HOST.
  const endpoint = (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
    await docker(['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), '--format', '{{.Endpoints.docker.Host}}']);
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) {
    throw new Error('Test-Postgres benötigt einen lokalen Docker-Dienst (Unix-Socket oder Named Pipe).');
  }
  await docker(['info', '--format', '{{.ServerVersion}}']);
  try { await docker(['image', 'inspect', IMAGE]); }
  catch { await docker(['pull', IMAGE], { timeout: 180_000 }); }

  const name = `ww-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('hex');
  let removed = false;
  const closeSync = () => {
    if (removed) return;
    const result = execFileSync('docker', ['rm', '--force', name], {
      stdio: 'ignore', timeout: 15_000,
    });
    removed = true;
    return result;
  };
  const onExit = () => { try { closeSync(); } catch { /* next Docker shutdown removes tmpfs data */ } };
  const onInterrupt = () => { onSignal?.('SIGINT'); onExit(); process.exit(130); };
  const onTerminate = () => { onSignal?.('SIGTERM'); onExit(); process.exit(143); };
  process.once('exit', onExit);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const close = async () => {
    if (!removed) { await docker(['rm', '--force', name]); removed = true; }
    process.off('exit', onExit);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
  try {
    await docker(['run', '--detach', '--rm', '--name', name,
      '--label', 'io.wolkenworte.automated-test=true',
      '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
      '--env', `POSTGRES_DB=${DATABASE}`, '--env', `POSTGRES_PASSWORD=${password}`,
      IMAGE, '-c', 'shared_buffers=64MB', '-c', 'max_connections=100']);
    const binding = await docker(['port', name, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error('Test-Postgres ist nicht ausschließlich an die lokale Loopback-Adresse gebunden.');
    const url = validateTestDatabaseUrl(`postgresql://postgres:${password}@127.0.0.1:${match[1]}/${DATABASE}`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 500 });
      try {
        await client.connect();
        await client.query('SELECT 1');
        return { url, name, close };
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      finally { await client.end().catch(() => {}); }
    }
    throw new Error('Lokales Test-Postgres wurde nicht rechtzeitig bereit.');
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

module.exports = { DATABASE, IMAGE, validateTestDatabaseUrl, testEnvironment, startLocalPostgres };
