'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function requestWithHost(baseUrl, pathname, host) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
  });
}

test('health endpoints and static cache policy are deployment-safe', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const live = await fetch(`${baseUrl}/health/live`);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await live.json(), { status: 'ok' });

  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ready.json(), { status: 'ok' });

  const html = await fetch(`${baseUrl}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('cache-control'), 'no-cache');

  const directHtml = await fetch(`${baseUrl}/landing.html?v=stale-release`);
  assert.equal(directHtml.status, 404);
  assert.equal(directHtml.headers.get('cache-control'), 'no-cache');

  const locale = await fetch(`${baseUrl}/locales/en.json?v=20260829-2`);
  assert.equal(locale.status, 200);
  assert.equal(locale.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const unversionedLocale = await fetch(`${baseUrl}/locales/en.json`);
  assert.equal(unversionedLocale.status, 200);
  assert.equal(unversionedLocale.headers.get('cache-control'), 'no-cache');

  const unversionedJs = await fetch(`${baseUrl}/js/site-header.js`);
  assert.equal(unversionedJs.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const versionedJs = await fetch(`${baseUrl}/js/wordcloud-core.js?v=20260819-2`);
  assert.equal(versionedJs.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const bundledSerif = await fetch(`${baseUrl}/vendor/fonts/gelasio-latin-ext-400-normal.woff?v=5.3.0`);
  assert.equal(bundledSerif.status, 200);
  assert.equal(bundledSerif.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok((await bundledSerif.arrayBuffer()).byteLength > 10_000);

  const previousPublicUrl = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://wolkenworte.io';
  try {
    const www = await requestWithHost(baseUrl, '/start?locale=de', 'www.wolkenworte.io');
    assert.equal(www.statusCode, 308);
    assert.equal(www.headers.location, 'https://wolkenworte.io/start?locale=de');

    const canonicalHost = await requestWithHost(baseUrl, '/', 'wolkenworte.io');
    assert.equal(canonicalHost.statusCode, 200);
    assert.equal(canonicalHost.headers['x-robots-tag'], undefined);

    const infrastructureHost = await requestWithHost(baseUrl, '/', 'wolkenworte.fly.dev');
    assert.equal(infrastructureHost.statusCode, 200);
    assert.equal(infrastructureHost.headers['x-robots-tag'], 'noindex, nofollow');
  } finally {
    if (previousPublicUrl == null) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousPublicUrl;
  }
});

test('container, Fly config and deployment workflow enforce the hosting boundary', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const fly = fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8');
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-hosted.yml'), 'utf8');
  const secretScript = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-fly-secrets.js'), 'utf8');
  const dbConfig = fs.readFileSync(path.join(ROOT, 'src', 'dbConfig.js'), 'utf8');
  const databaseCa = path.join(ROOT, 'certs', 'supabase-prod-ca-2021.crt');

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /COPY --chown=node:node certs \.\/certs/);
  assert.match(dockerfile, /COPY --chown=node:node views \.\/views/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "-s", "--"\]/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./);
  assert.match(dockerignore, /^\.env$/m);
  assert.equal(fs.readFileSync(databaseCa, 'utf8').includes('BEGIN CERTIFICATE'), true);
  assert.doesNotMatch(dbConfig, /process\.env\.(?:DATABASE_CA_CERT|PGSSLROOTCERT)\b/);

  assert.match(fly, /primary_region = "fra"/);
  assert.match(fly, /APP_ENVIRONMENT = "hosted-test"/);
  assert.match(fly, /PUBLIC_URL = "https:\/\/wolkenworte\.io"/);
  assert.match(fly, /STRIPE_PAYMENT_MODE = "test"/);
  assert.match(fly, /STRIPE_LIVE_PAYMENTS_ENABLED = "false"/);
  assert.match(fly, /DATABASE_CA_CERT_PATH = "certs\/supabase-prod-ca-2021\.crt"/);
  assert.match(fly, /kill_signal = "SIGTERM"/);
  assert.match(fly, /kill_timeout = 30/);
  assert.match(fly, /auto_stop_machines = "stop"/);
  assert.match(fly, /min_machines_running = 0/);
  assert.match(fly, /type = "connections"/);
  assert.match(fly, /soft_limit = 3500/);
  assert.match(fly, /hard_limit = 5000/);
  assert.match(fly, /size = "shared-cpu-2x"/);
  assert.match(fly, /path = "\/health\/ready"/);
  assert.doesNotMatch(fly, /MIGRATION_DATABASE_URL|release_command/);
  for (const name of [
    'STRIPE_TEST_SECRET_KEY',
    'STRIPE_TEST_LOCAL_WEBHOOK_SECRET',
    'STRIPE_LIVE_SECRET_KEY',
    'STRIPE_LIVE_WEBHOOK_SECRET',
  ]) assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  assert.match(envExample, /`STRIPE_TEST_HOSTED_WEBHOOK_SECRET`/);
  assert.doesNotMatch(envExample, /^STRIPE_TEST_HOSTED_WEBHOOK_SECRET=/m);
  assert.match(envExample, /^DATABASE_CA_CERT_PATH=certs\/supabase-prod-ca-2021\.crt$/m);
  assert.doesNotMatch(envExample, /^DATABASE_CA_CERT=/m);
  assert.doesNotMatch(secretScript, /DATABASE_CA_CERT/);
  assert.doesNotMatch(envExample, /^STRIPE_(?:SECRET_KEY|WEBHOOK_SECRET|ALLOW_LIVE_PAYMENTS)=/m);

  const testIndex = workflow.indexOf('npm test');
  const buildIndex = workflow.indexOf('docker build');
  const migrationIndex = workflow.indexOf('npm run db:migrate');
  const deployIndex = workflow.indexOf('flyctl deploy');
  const cronIndex = workflow.indexOf('npm run maintenance:configure-cron');
  const smokeIndex = workflow.indexOf('npm run smoke:hosted');
  assert.ok(testIndex > -1 && testIndex < buildIndex);
  assert.ok(buildIndex < migrationIndex && migrationIndex < deployIndex &&
    deployIndex < cronIndex && cronIndex < smokeIndex);
  assert.match(workflow, /flyctl deploy --remote-only --ha=false/);
  assert.match(secretScript, /MIGRATION_DATABASE_URL darf niemals an Fly übertragen/);
  assert.doesNotMatch(secretScript.match(/const REQUIRED = \[[\s\S]*?\];/)?.[0] || '', /MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(
    secretScript.match(/const OPTIONAL = \[[\s\S]*?\];/)?.[0] || '',
    /STRIPE_TEST_HOSTED_WEBHOOK_SECRET|STRIPE_LIVE_WEBHOOK_SECRET/
  );
});

test('graceful shutdown disconnects Socket.io and closes the listener within its bound', async (t) => {
  const hosted = await startTestServer();
  t.after(hosted.close);
  const event = await createEvent(hosted.baseUrl, { coupleName: 'Shutdown Schorsch' });

  const socket = ioClient(hosted.baseUrl, {
    query: { slug: event.slug },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.io connection timed out')), 3_000);
    socket.once('word-update', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', reject);
  });

  const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
  const startedAt = Date.now();
  await hosted.shutdown('test');
  await disconnected;

  assert.equal(hosted.server.listening, false);
  assert.ok(Date.now() - startedAt < 10_000, 'ordinary shutdown must not consume the Fly kill timeout');
});
