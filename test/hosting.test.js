'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

const ROOT = path.join(__dirname, '..');

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
  assert.equal(directHtml.headers.get('cache-control'), 'no-cache');

  const locale = await fetch(`${baseUrl}/locales/de.json?v=stale-release`);
  assert.equal(locale.headers.get('cache-control'), 'no-cache');

  const unversionedJs = await fetch(`${baseUrl}/js/site-header.js`);
  assert.equal(unversionedJs.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const versionedJs = await fetch(`${baseUrl}/js/wordcloud-core.js?v=20260819-2`);
  assert.equal(versionedJs.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const bundledSerif = await fetch(`${baseUrl}/vendor/fonts/gelasio-latin-ext-400-normal.woff?v=5.3.0`);
  assert.equal(bundledSerif.status, 200);
  assert.equal(bundledSerif.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok((await bundledSerif.arrayBuffer()).byteLength > 10_000);
});

test('container, Fly config and deployment workflow enforce the Phase 2 boundary', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const fly = fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-hosted.yml'), 'utf8');
  const secretScript = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-fly-secrets.js'), 'utf8');

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS runtime/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "-s", "--"\]/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./);
  assert.match(dockerignore, /^\.env$/m);

  assert.match(fly, /primary_region = "fra"/);
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
