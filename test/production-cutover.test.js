'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripeConfig = require('../src/stripeConfig');
const cutover = require('../scripts/production-cutover');
const cutoverTarget = require('../scripts/verify-cutover-target');
const emptyTarget = require('../scripts/verify-prelive-empty');
const productionSmoke = require('../scripts/production-readiness-smoke');

const ROOT = path.join(__dirname, '..');

function localCutoverEnv(overrides = {}) {
  return {
    APP_ENVIRONMENT: 'local',
    NODE_ENV: 'development',
    FLY_APP_NAME: 'wolkenworte',
    MIGRATION_DATABASE_URL: 'postgresql://postgres:secret@db.example.test:5432/postgres',
    DATABASE_URL: 'postgresql://wolkenworte_app:secret@db.example.test:5432/postgres',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fixture',
    RATE_LIMIT_HMAC_SECRET: 'r'.repeat(32),
    MAINTENANCE_SECRET: 'm'.repeat(32),
    RESEND_API_KEY: 're_fixture',
    RESEND_FROM_EMAIL: 'Wolkenworte <bestellung@mail.wolkenworte.io>',
    PRINTFUL_API_KEY: 'printful_fixture',
    PRINTFUL_STORE_ID: 'store_fixture',
    STRIPE_PAYMENT_MODE: 'test',
    STRIPE_LIVE_SECRET_KEY: 'sk_live_fixture',
    STRIPE_LIVE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock',
    PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
    ALLOW_TEST_DATA_RESET: 'false',
    ...overrides,
  };
}

function secretList(target, status = 'Deployed') {
  const stripe = target === 'production'
    ? cutover.LIVE_STRIPE_SECRETS
    : ['STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET'];
  return JSON.stringify([...cutover.COMMON_RUNTIME_SECRETS, ...stripe]
    .map((name) => ({ name, status })));
}

function machine(posture, overrides = {}) {
  return {
    state: 'started',
    region: 'fra',
    config: {
      env: { ...cutover.POSTURES[posture] },
      services: [{ min_machines_running: cutover.MIN_MACHINES[posture] }],
    },
    checks: [{ status: 'passing' }],
    ...overrides,
  };
}

test('reviewed Fly configs encode each one-way cutover posture', () => {
  const configs = cutover.validateConfigFamily();
  assert.equal(configs.hosted.env.MAINTENANCE_MODE, 'false');
  assert.equal(configs.locked.env.MAINTENANCE_MODE, 'true');
  assert.equal(configs.armed.env.APP_ENVIRONMENT, 'production');
  assert.equal(configs.armed.env.STRIPE_PAYMENT_MODE, 'live');
  assert.equal(configs.armed.env.STRIPE_LIVE_PAYMENTS_ENABLED, 'false');
  assert.equal(configs.armed.env.PRINTFUL_ALLOW_ORDER_WRITES, 'false');
  assert.equal(configs.active.env.STRIPE_LIVE_PAYMENTS_ENABLED, 'true');
  assert.equal(configs.active.env.PRINTFUL_FULFILLMENT_MODE, 'live');
  assert.equal(configs.active.env.PRINTFUL_CONFIRM_LIVE_ORDERS, 'true');
  assert.equal(configs.armed.minMachines, 0);
  assert.equal(configs.active.minMachines, 0);

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['cutover:production'], 'node scripts/production-cutover.js');
  assert.equal(packageJson.scripts['ops:verify-cutover-target'], 'node scripts/verify-cutover-target.js');
  assert.equal(packageJson.scripts['ops:verify-prelive-empty'], 'node scripts/verify-prelive-empty.js');
});

test('production can be armed only behind maintenance with payments still disabled', () => {
  const armed = {
    APP_ENVIRONMENT: 'production',
    STRIPE_PAYMENT_MODE: 'live',
    STRIPE_LIVE_SECRET_KEY: 'sk_live_fixture',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    MAINTENANCE_MODE: 'true',
  };
  assert.deepEqual(stripeConfig.validationErrors(armed), []);
  assert.match(stripeConfig.validationErrors({ ...armed, MAINTENANCE_MODE: 'false' }).join(' '),
    /STRIPE_PAYMENT_MODE=live verlangt/);
});

test('local cutover material is explicit, least-privileged and locally inert', () => {
  assert.equal(cutover.validateLocalCutoverEnvironment(localCutoverEnv(), '22.0.0'), true);
  assert.throws(
    () => cutover.validateLocalCutoverEnvironment(
      localCutoverEnv({ STRIPE_LIVE_SECRET_KEY: 'sk_test_wrong' }), '22.0.0'),
    /sk_live_/,
  );
  assert.throws(
    () => cutover.validateLocalCutoverEnvironment(
      localCutoverEnv({ PRINTFUL_ALLOW_ORDER_WRITES: 'true' }), '22.0.0'),
    /PRINTFUL_ALLOW_ORDER_WRITES=false/,
  );
  assert.throws(
    () => cutover.validateLocalCutoverEnvironment(
      localCutoverEnv({ DATABASE_URL: 'postgresql://postgres:secret@db.example.test/postgres' }), '22.0.0'),
    /wolkenworte_app/,
  );
});

test('secret boundaries reject mixed Stripe modes and partial deployment', () => {
  assert.equal(cutover.validateSecretBoundary(secretList('hosted'), 'hosted'), true);
  assert.equal(cutover.validateSecretBoundary(secretList('production'), 'production'), true);
  assert.equal(cutover.validateSecretBoundary(
    secretList('production', 'Staged'), 'production', { allowStaged: true }), true);
  assert.throws(
    () => cutover.validateSecretBoundary(secretList('production', 'Partial'), 'production',
      { allowStaged: true }),
    /unsafe deployment status/,
  );
  const mixed = JSON.parse(secretList('production'));
  mixed.push({ name: 'STRIPE_TEST_SECRET_KEY', status: 'Deployed' });
  assert.throws(() => cutover.validateSecretBoundary(JSON.stringify(mixed), 'production'),
    /Forbidden production/);
});

test('secret staging keeps values on stdin and removes test credentials before deployment', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, input: options.input || '' });
    return { status: 0 };
  };
  cutover.stageProductionSecrets({
    STRIPE_LIVE_SECRET_KEY: 'sk_live_private',
    STRIPE_LIVE_WEBHOOK_SECRET: 'whsec_private',
  }, spawn);
  assert.deepEqual(calls[0].args, ['secrets', 'import', '--stage', '--app', 'wolkenworte']);
  assert.match(calls[0].input, /STRIPE_LIVE_SECRET_KEY=sk_live_private/);
  assert.equal(calls[0].args.join(' ').includes('sk_live_private'), false);
  assert.deepEqual(calls[1].args, [
    'secrets', 'unset', '--stage', '--app', 'wolkenworte',
    'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET',
  ]);
});

test('machine posture is exact, single-machine and health checked', () => {
  const armed = JSON.stringify([machine('armed')]);
  assert.equal(cutover.detectMachinePosture(armed), 'armed');
  assert.equal(cutover.validateMachinePosture(armed, 'armed', { requireHealthy: true }), true);
  assert.equal(cutover.detectMachinePosture(JSON.stringify([machine('armedPinned')])), 'armedPinned');
  assert.throws(() => cutover.validateMachinePosture(
    JSON.stringify([machine('armed'), machine('armed')]), 'armed'), /exactly one/);
  assert.throws(() => cutover.validateMachinePosture(
    JSON.stringify([machine('armed', { checks: [{ status: 'critical' }] })]),
    'armed', { requireHealthy: true }), /not all passing/);
});

test('each mutating phase requires its own flag and exact approved commit', () => {
  const commit = 'a'.repeat(40);
  const lock = cutover.parseOptions([
    '--phase=lock', `--confirm-commit=${commit}`, '--confirm-maintenance-lock',
  ]);
  assert.equal(cutover.assertPhaseConfirmation(lock, commit), true);
  assert.throws(() => cutover.assertPhaseConfirmation(
    cutover.parseOptions(['--phase=arm', `--confirm-commit=${commit}`, '--preserve-none']), commit),
  /confirm-production-arm/);
  assert.throws(() => cutover.assertPhaseConfirmation(
    cutover.parseOptions([
      '--phase=activate', `--confirm-commit=${'b'.repeat(40)}`, '--confirm-live-activation',
      '--preserve-none',
    ]), commit), /exact approved commit/);
  assert.equal(cutover.parseOptions([
    '--phase=arm', `--confirm-commit=${commit}`, '--confirm-production-arm',
    '--preserve-event-slug=RimGaoN4-RJkaTJfIN26lg',
  ]).preserveEventSlug, 'RimGaoN4-RJkaTJfIN26lg');
  assert.throws(() => cutover.parseOptions([
    '--phase=arm', `--confirm-commit=${commit}`, '--confirm-production-arm',
  ]), /preserve-event-slug/);
  const rearm = cutover.parseOptions([
    '--phase=rearm', `--confirm-commit=${commit}`, '--confirm-emergency-rearm',
  ]);
  assert.equal(cutover.assertPhaseConfirmation(rearm, commit), true);
  const autosleep = cutover.parseOptions([
    '--phase=autosleep', `--confirm-commit=${commit}`, '--confirm-production-autosleep',
  ]);
  assert.equal(cutover.assertPhaseConfirmation(autosleep, commit), true);
  const release = cutover.parseOptions([
    '--phase=release', `--confirm-commit=${commit}`, '--confirm-production-release',
  ]);
  assert.equal(cutover.assertPhaseConfirmation(release, commit), true);
  assert.throws(() => cutover.assertPhaseConfirmation(
    cutover.parseOptions(['--phase=release', `--confirm-commit=${commit}`]), commit),
  /confirm-production-release/);
  assert.throws(() => cutover.assertPhaseConfirmation(release, 'b'.repeat(40)), /exact approved commit/);
  assert.throws(() => cutover.assertPhaseConfirmation(
    cutover.parseOptions(['--phase=release', `--confirm-commit=${commit}`, '--confirm-live-activation']), commit),
  /confirm-production-release/);
  assert.throws(() => cutover.parseOptions([
    '--phase=release', `--confirm-commit=${commit}`, '--confirm-production-release', '--preserve-none',
  ]), /only for arm and activate/);
});

test('Linux candidate checks stop the release before migrations on failed image or font verification', () => {
  const commit = 'a'.repeat(40);
  const steps = cutover.verificationSteps('active', commit.slice(0, 12));
  const linux = steps.find(step => step.args.includes('test/print-raster.test.js'));
  assert.equal(linux.command, 'docker');
  assert.ok(linux.args.includes('--read-only'));
  assert.ok(linux.args.includes('--pull=never'));
  assert.equal(linux.args[linux.args.indexOf('--network') + 1], 'none');
  assert.ok(linux.args.includes(`wolkenworte:${commit.slice(0, 12)}`));
  assert.ok(linux.args.includes('test/design-font-contract.test.js'));
  assert.ok(linux.args.includes('test/design-font-geometry.test.js'));
  const executed = [];
  assert.throws(() => cutover.runVerificationSteps('active', commit, {
    checkCommit() { assert.fail('Failed Linux verification must precede the migration boundary'); },
    execute(step) {
      executed.push(step);
      if (step === linux || step.args.includes('test/print-raster.test.js')) throw new Error('Linux pixels missing');
    },
  }), /Linux pixels missing/);
  assert.equal(executed.some(step => step.args.includes('db:migrate')), false);
  assert.equal(executed.at(-1).args.includes('test/print-raster.test.js'), true);
});

test('post-launch release rechecks production then deploys and verifies without initial-cutover work', () => {
  const commit = 'a'.repeat(40);
  const calls = [];
  cutover.deployActiveRelease(commit, {
    checkCommit() { calls.push('commit'); return commit; },
    verify(posture, secretTarget, options = {}) {
      calls.push(options.healthy ? 'health' : 'boundary');
      cutover.validateMachinePosture(JSON.stringify([machine('active')]), posture,
        { requireHealthy: options.healthy });
      cutover.validateSecretBoundary(secretList('production'), secretTarget);
    },
    execute(step) { calls.push(step); },
    recover() { assert.fail('Successful release must not re-arm'); },
  });
  assert.equal(calls[0], 'commit');
  assert.equal(calls[1], 'boundary');
  assert.deepEqual(calls[2].args, [
    'deploy', '--remote-only', '--ha=false', '--config', 'fly.production.toml', '--app', 'wolkenworte', '--yes',
  ]);
  assert.deepEqual(calls[3].args, ['scripts/production-readiness-smoke.js', '--expect-active']);
  assert.equal(calls[4], 'health');
  assert.equal(calls.length, 5, 'Release must not stage secrets, configure cron or run pre-live cleanup');
});

test('post-launch release refuses a changed commit, changed posture or mixed secrets before deployment', () => {
  const commit = 'a'.repeat(40);
  for (const scenario of ['commit', 'posture', 'secrets']) {
    assert.throws(() => cutover.deployActiveRelease(commit, {
      checkCommit() { return scenario === 'commit' ? 'b'.repeat(40) : commit; },
      verify(posture, secretTarget) {
        cutover.validateMachinePosture(JSON.stringify([machine(
          scenario === 'posture' ? 'armed' : 'active')]), posture);
        const records = JSON.parse(secretList('production'));
        if (scenario === 'secrets') records.push({ name: 'STRIPE_TEST_SECRET_KEY', status: 'Deployed' });
        cutover.validateSecretBoundary(JSON.stringify(records), secretTarget);
      },
      execute() { assert.fail('Unsafe boundary must prevent deployment'); },
      recover() { assert.fail('A pre-deployment refusal must not change production'); },
    }), /commit changed|not in active posture|Forbidden production/);
  }
});

test('post-launch release invokes the existing maintenance recovery on deploy, smoke or health failure', () => {
  const commit = 'a'.repeat(40);
  for (const failedStep of ['deploy', 'smoke', 'health']) {
    const failure = new Error(`${failedStep} failed`);
    const executed = [];
    let recovered = 0;
    assert.throws(() => cutover.deployActiveRelease(commit, {
      checkCommit() { return commit; },
      verify(posture, secretTarget, options = {}) {
        if (options.healthy && failedStep === 'health') throw failure;
      },
      execute(step) {
        const name = step.command === 'flyctl' ? 'deploy' : 'smoke';
        executed.push(name);
        if (name === failedStep) throw failure;
      },
      recover(error, action) {
        assert.equal(error, failure);
        assert.equal(action, 'Production release');
        recovered += 1;
        throw new Error('safely re-armed');
      },
    }), /safely re-armed/);
    assert.equal(recovered, 1);
    assert.deepEqual(executed, failedStep === 'deploy' ? ['deploy'] : ['deploy', 'smoke']);
  }
});

test('the cleanup-boundary verifier is read-only and rejects unrelated rows', async () => {
  const database = {
    async assertDatabaseReady() {},
    async getPreliveCleanupCounts() { return { events: 0, orders: 0, maintenance_runs: 1 }; },
  };
  const storage = { async listAllObjectKeys() { return []; } };
  assert.deepEqual(await emptyTarget.run({
    database, storage, output() {}, preserveNone: true,
  }), {
    verifiedClean: true,
    verifiedEmpty: true,
    preservedEventSlug: null,
    businessRows: 0,
    storageObjects: 0,
  });
  await assert.rejects(
    emptyTarget.run({
      database: { ...database, async getPreliveCleanupCounts() { return { events: 1 }; } },
      storage,
      output() {},
      preserveNone: true,
    }),
    (error) => error.code === 'prelive_target_not_empty',
  );

  const preservedDatabase = {
    async assertDatabaseReady() {},
    async getPreliveCleanupCounts() {
      return { events: 1, words: 2, orders: 0, maintenance_runs: 1 };
    },
    async getPrelivePreservationState(slug) {
      assert.equal(slug, 'RimGaoN4-RJkaTJfIN26lg');
      return {
        counts: { events: 1, words: 2, orders: 0, maintenance_runs: 0 },
        storageObjectKeys: ['print-artifacts/preserved.png'],
      };
    },
  };
  assert.deepEqual(await emptyTarget.run({
    database: preservedDatabase,
    storage: { async listAllObjectKeys() { return ['print-artifacts/preserved.png']; } },
    output() {},
    preserveEventSlug: 'RimGaoN4-RJkaTJfIN26lg',
  }), {
    verifiedClean: true,
    verifiedEmpty: false,
    preservedEventSlug: 'RimGaoN4-RJkaTJfIN26lg',
    businessRows: 3,
    storageObjects: 1,
  });
});

test('the arm handoff proves target identity with the old secret without staging it', async () => {
  let received;
  const result = await cutoverTarget.run({
    env: {
      MAINTENANCE_SECRET: 'n'.repeat(32),
      CUTOVER_CURRENT_MAINTENANCE_SECRET: 'o'.repeat(32),
      DATABASE_URL: 'postgresql://wolkenworte_app:new@db.example.test/postgres',
      SUPABASE_URL: 'https://example.supabase.co',
    },
    async verify(target, env) { received = { target, env }; },
    output() {},
  });
  assert.equal(result.identityMatch, true);
  assert.equal(received.env.MAINTENANCE_SECRET, 'o'.repeat(32));
  assert.equal(cutover.IMPORTED_PRODUCTION_SECRETS.includes(
    'CUTOVER_CURRENT_MAINTENANCE_SECRET'), false);
});

test('production smoke checks health, maintenance, canonical redirect and signature-bound webhooks', async () => {
  const requested = [];
  const fakeFetch = async (url, options = {}) => {
    requested.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/health/live') || url.endsWith('/health/ready')) return new Response('{}');
    if (url.startsWith(productionSmoke.WWW_URL)) {
      return new Response('', { status: 308, headers: { location: `${productionSmoke.PUBLIC_URL}/` } });
    }
    if (url.includes('/webhook/')) return new Response('invalid webhook signature', { status: 400 });
    return new Response('maintenance', {
      status: 503,
      headers: { 'x-wolkenworte-maintenance': 'active', 'content-type': 'text/html' },
    });
  };
  const result = await productionSmoke.run({
    expected: 'maintenance', fetchImpl: fakeFetch, output() {},
  });
  assert.equal(result.publicStatus, 503);
  assert.equal(result.webhookReachability, 'ok');
  assert.equal(requested.filter((request) => request.method === 'GET').length, 4);
  assert.equal(requested.filter((request) => request.method === 'POST').length, 3);
  assert.equal(requested.length, 7);
});
