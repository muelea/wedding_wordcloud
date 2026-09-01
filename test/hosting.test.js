'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');
const { publicAssetUrl } = require('../src/publicAssets');
const {
  assertGitReleaseCandidate,
  releaseSteps,
  validateFlySecretBoundary,
  validateHostedConfig,
  validateOperatorEnvironment,
} = require('../scripts/deploy-hosted');
const {
  BROWSER_DEPENDENCY_FILES,
  inspectDependencies,
  integrationStatus,
  validateRepositoryAssets,
} = require('../scripts/prepare-local');

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
  assert.ok((await html.text()).includes(publicAssetUrl('/js/wordcloud-core.js')));

  const directHtml = await fetch(`${baseUrl}/landing.html?v=stale-release`);
  assert.equal(directHtml.status, 404);
  assert.equal(directHtml.headers.get('cache-control'), 'no-cache');

  const locale = await fetch(`${baseUrl}/locales/en.json?v=20260829-2`);
  assert.equal(locale.status, 200);
  assert.equal(locale.headers.get('cache-control'), 'no-cache');

  const unversionedLocale = await fetch(`${baseUrl}/locales/en.json`);
  assert.equal(unversionedLocale.status, 200);
  assert.equal(unversionedLocale.headers.get('cache-control'), 'no-cache');

  const unversionedJs = await fetch(`${baseUrl}/js/site-header.js`);
  assert.equal(unversionedJs.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const versionedJs = await fetch(`${baseUrl}${publicAssetUrl('/js/wordcloud-core.js')}`);
  assert.equal(versionedJs.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const staleVersionedJs = await fetch(`${baseUrl}/js/wordcloud-core.js?v=stale-release`);
  assert.equal(staleVersionedJs.status, 200);
  assert.equal(staleVersionedJs.headers.get('cache-control'), 'no-cache');

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

test('container, Fly config and local deployment command enforce the hosting boundary', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const fly = fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8');
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
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

  const workflow = path.join(ROOT, '.github', 'workflows', 'deploy-hosted.yml');
  assert.equal(fs.existsSync(workflow), false);
  assert.equal(packageJson.scripts['deploy:hosted'], 'node scripts/deploy-hosted.js');

  validateHostedConfig(fly);
  const steps = releaseSteps('0123456789ab');
  assert.deepEqual(steps.map(({ label }) => label), [
    'Abhängigkeiten reproduzierbar installieren',
    'Vollständige Tests',
    'Produktionsimage lokal bauen',
    'Fly-Konfiguration streng validieren',
    'Datenbankmigrationen anwenden',
    'Freigegebenes Image zu Fly deployen',
    'Wartungs-Cron aktualisieren',
    'Hosted-Smoke-Test ausführen',
    'Finalen Fly-Status prüfen',
  ]);
  const commands = steps.map(({ command, args }) => [command, ...args].join(' '));
  assert.equal(commands[0], 'npm ci');
  assert.equal(commands[1], 'npm test');
  assert.equal(commands[2],
    'docker build --platform linux/amd64 --tag wolkenworte:0123456789ab .');
  assert.equal(commands[3], 'flyctl config validate --strict --config fly.toml --app wolkenworte');
  assert.equal(commands[4], 'npm run db:migrate');
  assert.equal(commands[5], 'flyctl deploy --remote-only --ha=false --config fly.toml --app wolkenworte --yes');
  assert.equal(commands[6],
    'npm run maintenance:configure-cron -- --url https://wolkenworte.fly.dev');
  assert.equal(commands[7], 'npm run smoke:hosted -- https://wolkenworte.io');
  assert.equal(commands[8], 'flyctl status --app wolkenworte');
  assert.equal(steps[4].releaseBoundary, true);

  const hostedSmoke = fs.readFileSync(path.join(ROOT, 'scripts', 'hosted-smoke.js'), 'utf8');
  assert.match(hostedSmoke, /finally\s*\{\s*await cleanupFixture\(fixture\)/);
  assert.match(hostedSmoke, /DELETE FROM public\.configurations WHERE event_id = \$1/);
  assert.match(hostedSmoke, /DELETE FROM public\.reserved_event_slugs WHERE slug = \$1/);

  assert.match(secretScript, /MIGRATION_DATABASE_URL darf niemals an Fly übertragen/);
  assert.doesNotMatch(secretScript.match(/const REQUIRED = \[[\s\S]*?\];/)?.[0] || '', /MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(
    secretScript.match(/const OPTIONAL = \[[\s\S]*?\];/)?.[0] || '',
    /STRIPE_TEST_HOSTED_WEBHOOK_SECRET|STRIPE_LIVE_WEBHOOK_SECRET/
  );
});

test('a fresh collaborator checkout has one deterministic local startup path', () => {
  const runLocal = fs.readFileSync(path.join(ROOT, 'run_local.sh'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), '22');
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(packageJson.scripts['local:prepare'], 'node scripts/prepare-local.js');
  assert.match(runLocal, /node scripts\/prepare-local\.js/);
  assert.doesNotMatch(runLocal, /\[\[ ! -d node_modules \]\]/);
  assert.doesNotMatch(runLocal, /npm install/);
  assert.match(readme, /fresh clone plus a securely supplied|Clone the repository[\s\S]*\.\/run_local\.sh/i);
  assert.match(readme, /there is no untracked 3D\s+model/i);
  assert.match(agents, /Collaborator startup is one guarded path/);

  const dependencyState = inspectDependencies(ROOT, { requireStamp: false });
  assert.deepEqual(dependencyState.problems, []);
  for (const filename of BROWSER_DEPENDENCY_FILES) {
    assert.equal(fs.existsSync(path.join(ROOT, filename)), true, `${filename} must be installed`);
  }
  const repositoryAssets = validateRepositoryAssets(ROOT);
  assert.ok(repositoryAssets.includes(path.join('public', 'js', 'mug-3d-viewer.js')));
  assert.ok(repositoryAssets.some((filename) => filename.endsWith('mug.svg')));
  assert.ok(repositoryAssets.some((filename) => filename.endsWith('coaster-flat.png')));
  assert.ok(repositoryAssets.some((filename) => filename.endsWith('jost-latin.woff2')));

  assert.deepEqual(
    integrationStatus({
      STRIPE_PAYMENT_MODE: 'test',
      STRIPE_TEST_SECRET_KEY: 'configured',
      PRINTFUL_API_KEY: 'configured',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'configured',
    }).map(({ ready }) => ready),
    [true, true, true]
  );
});

test('local deployment guard rejects unsafe config, credentials and Git state', () => {
  const fly = fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8');
  assert.throws(
    () => validateHostedConfig(fly.replace('EMAIL_DELIVERY_MODE = "mock"', 'EMAIL_DELIVERY_MODE = "live"')),
    /EMAIL_DELIVERY_MODE="mock"/
  );
  assert.throws(
    () => validateHostedConfig(`${fly}\nMIGRATION_DATABASE_URL = "forbidden"\n`),
    /Operator-Secrets/
  );

  const validEnvironment = {
    FLY_APP_NAME: 'wolkenworte',
    MIGRATION_DATABASE_URL: 'postgresql://migration.example.invalid/database',
    MAINTENANCE_SECRET: 'm'.repeat(32),
  };
  validateOperatorEnvironment(validEnvironment, '22.0.0');
  assert.throws(
    () => validateOperatorEnvironment({ ...validEnvironment, CI: 'true' }, '22.0.0'),
    /lokale Operator-Workstation/
  );
  assert.throws(
    () => validateOperatorEnvironment({ ...validEnvironment, FLY_APP_NAME: 'other-app' }, '22.0.0'),
    /nur wolkenworte/
  );
  assert.throws(
    () => validateOperatorEnvironment({ ...validEnvironment, MAINTENANCE_SECRET: 'short' }, '22.0.0'),
    /kürzer als 32 Zeichen/
  );

  const requiredFlySecrets = [
    'DATABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'RATE_LIMIT_HMAC_SECRET',
    'MAINTENANCE_SECRET',
  ].map((Name) => ({ Name, Digest: 'not-a-secret-value' }));
  validateFlySecretBoundary(JSON.stringify(requiredFlySecrets));
  assert.throws(
    () => validateFlySecretBoundary(JSON.stringify(requiredFlySecrets.slice(1))),
    /DATABASE_URL/
  );
  assert.throws(
    () => validateFlySecretBoundary(JSON.stringify([
      ...requiredFlySecrets,
      { Name: 'STRIPE_PAYMENT_MODE', Digest: 'not-a-secret-value' },
    ])),
    /Sicherheitskonfiguration/
  );
  assert.throws(
    () => validateFlySecretBoundary(JSON.stringify([
      ...requiredFlySecrets,
      { Name: 'MIGRATION_DATABASE_URL', Digest: 'not-a-secret-value' },
    ])),
    /Operator-Zugänge/
  );

  const cleanGit = new Map([
    ['git branch --show-current', 'main'],
    ['git status --porcelain --untracked-files=all', ''],
    ['git rev-parse HEAD', 'a'.repeat(40)],
    ['git ls-remote --exit-code origin refs/heads/main', `${'a'.repeat(40)}\trefs/heads/main`],
  ]);
  const run = (command, args) => cleanGit.get([command, ...args].join(' '));
  assert.equal(assertGitReleaseCandidate(run), 'a'.repeat(40));

  const dirtyGit = new Map(cleanGit);
  dirtyGit.set('git status --porcelain --untracked-files=all', ' M README.md');
  assert.throws(
    () => assertGitReleaseCandidate((command, args) => dirtyGit.get([command, ...args].join(' '))),
    /nicht sauber/
  );

  const staleGit = new Map(cleanGit);
  staleGit.set('git ls-remote --exit-code origin refs/heads/main', `${'b'.repeat(40)}\trefs/heads/main`);
  assert.throws(
    () => assertGitReleaseCandidate((command, args) => staleGit.get([command, ...args].join(' '))),
    /origin\/main/
  );
});

test('graceful shutdown disconnects Socket.io and closes the listener within its bound', async (t) => {
  const hosted = await startTestServer();
  t.after(hosted.close);
  const event = await createEvent(hosted.baseUrl, { title: 'Shutdown Schorsch' });

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
