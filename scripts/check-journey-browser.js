'use strict';

// This is a local acceptance environment, not a deployment command. No .env,
// hosted database, provider key or persistent Docker volume is used.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const ROOT = path.join(__dirname, '..');

function docker(args, { quiet = false } = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    // Do not echo the invocation: even disposable credentials need not appear.
    throw new Error(String(result.stderr || result.stdout || 'Docker command failed').trim());
  }
  if (!quiet && result.stdout.trim()) console.log(result.stdout.trim());
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--image' || !/^wolkenworte:[a-zA-Z0-9._-]+$/.test(args[1])) {
    throw new Error('Usage: node scripts/check-journey-browser.js --image wolkenworte:<local-candidate>');
  }
  const image = args[1];
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const available = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(available));
    });
  });
  for (const localImage of [image, 'postgres:17']) {
    const found = docker(['image', 'ls', '--filter', `reference=${localImage}`,
      '--format', '{{.Repository}}:{{.Tag}}'], { quiet: true }).split('\n');
    if (!found.includes(localImage)) throw new Error(`Required local image is missing: ${localImage}`);
  }
  const suffix = crypto.randomBytes(6).toString('hex');
  const network = `ww-acceptance-${suffix}`;
  const databaseName = `${network}-db`;
  const appName = `${network}-app`;
  const adminPassword = crypto.randomBytes(24).toString('hex');
  const appPassword = crypto.randomBytes(24).toString('hex');
  let madeNetwork = false;
  let madeDatabase = false;
  let madeApp = false;
  let closing = false;
  let finish;
  const keepAlive = setInterval(() => {}, 60000);
  const stopped = new Promise(resolve => { finish = resolve; });
  const cleanup = () => {
    if (closing) return;
    closing = true;
    clearInterval(keepAlive);
    for (const [exists, name] of [[madeApp, appName], [madeDatabase, databaseName]]) {
      if (exists) {
        try { docker(['stop', '--timeout', '15', name], { quiet: true }); }
        catch (error) { console.error(`Cleanup ${name}: ${error.message}`); }
      }
    }
    if (madeNetwork) {
      try { docker(['network', 'rm', network], { quiet: true }); }
      catch (error) { console.error(`Cleanup ${network}: ${error.message}`); }
    }
    console.log('Acceptance containers stopped; disposable test data removed.');
    finish();
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    // A private bridge is required for Docker Desktop's loopback publishing.
    // Provider isolation is enforced by fixture-only credentials and stubs.
    docker(['network', 'create', network], { quiet: true }); madeNetwork = true;
    docker(['run', '--pull=never', '--detach', '--rm', '--name', databaseName, '--network', network,
      '--publish', `127.0.0.1:${port}:8080`, '--tmpfs', '/var/lib/postgresql/data',
      '--env', 'POSTGRES_DB=ww_acceptance', '--env', `POSTGRES_PASSWORD=${adminPassword}`,
      'postgres:17'], { quiet: true }); madeDatabase = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = spawnSync('docker', ['exec', databaseName, 'pg_isready', '-U', 'postgres', '-d', 'ww_acceptance']);
      if (status.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Disposable Postgres did not become ready.');
    const shared = ['--pull=never', '--platform', 'linux/amd64', '--network', `container:${databaseName}`,
      '--mount', `type=bind,source=${path.join(ROOT, 'test')},target=/app/test,readonly`];
    docker(['run', '--rm', ...shared,
      '--mount', `type=bind,source=${path.join(ROOT, 'supabase/migrations')},target=/acceptance-migrations,readonly`,
      '--env', 'WW_BROWSER_ACCEPTANCE=1',
      '--env', `ACCEPTANCE_DATABASE_URL=postgres://postgres:${adminPassword}@127.0.0.1:5432/ww_acceptance`,
      '--env', `ACCEPTANCE_APP_PASSWORD=${appPassword}`,
      image, 'node', '/app/test/support/acceptance-database.js']);
    docker(['run', '--detach', '--rm', '--name', appName, ...shared,
      '--env', 'WW_BROWSER_ACCEPTANCE=1', '--env', 'NODE_ENV=production', '--env', 'APP_ENVIRONMENT=hosted-test',
      '--env', 'PORT=8080', '--env', 'PUBLIC_URL=https://wolkenworte.acceptance.invalid',
      '--env', `DATABASE_URL=postgres://wolkenworte_app:${appPassword}@127.0.0.1:5432/ww_acceptance`,
      '--env', 'DATABASE_SCHEMA=acceptance', '--env', 'SUPABASE_URL=https://storage.acceptance.invalid',
      '--env', 'SUPABASE_SECRET_KEY=sb_secret_acceptance_not_a_provider_key',
      '--env', 'RATE_LIMIT_HMAC_SECRET=acceptance-rate-secret-not-for-any-real-service',
      '--env', 'MAINTENANCE_SECRET=acceptance-maintenance-secret-not-for-real-use',
      '--env', 'STRIPE_PAYMENT_MODE=test', '--env', 'STRIPE_LIVE_PAYMENTS_ENABLED=false',
      '--env', 'STRIPE_TEST_SECRET_KEY=sk_test_acceptance_fixture_only',
      '--env', 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET=whsec_acceptance_fixture_only',
      '--env', 'PRINTFUL_FULFILLMENT_MODE=mock', '--env', 'PRINTFUL_ALLOW_ORDER_WRITES=false',
      '--env', 'PRINTFUL_CONFIRM_LIVE_ORDERS=false', '--env', 'EMAIL_DELIVERY_MODE=mock',
      image, 'node', '/app/test/support/acceptance-server.js'], { quiet: true }); madeApp = true;
    const origin = `http://127.0.0.1:${port}`;
    ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) {
      console.error(docker(['logs', '--tail', '25', appName], { quiet: true }));
      throw new Error('Acceptance app did not become ready.');
    }
    console.log(`Linux browser acceptance: ${origin}/`);
    console.log(`Proof and provider controls: ${origin}/api/acceptance/`);
    console.log(`Image: ${image}; isolated Postgres; restricted runtime role; external providers simulated.`);
    console.log('Use Ctrl-C to remove only this run’s temporary containers and data.');
    await stopped;
  } finally { cleanup(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
