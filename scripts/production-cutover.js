'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertGitReleaseCandidate, validateOperatorEnvironment } = require('./deploy-hosted');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'wolkenworte';
const PUBLIC_URL = 'https://wolkenworte.io';
const CONFIGS = Object.freeze({
  hosted: 'fly.toml',
  locked: 'fly.cutover-maintenance.toml',
  armed: 'fly.production-armed.toml',
  active: 'fly.production.toml',
});
const POSTURES = Object.freeze({
  hosted: Object.freeze({
    APP_ENVIRONMENT: 'hosted-test',
    EMAIL_DELIVERY_MODE: 'live',
    MAINTENANCE_MODE: 'false',
    ALLOW_TEST_DATA_RESET: 'false',
    STRIPE_PAYMENT_MODE: 'test',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock',
    PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
  }),
  locked: Object.freeze({
    APP_ENVIRONMENT: 'hosted-test',
    EMAIL_DELIVERY_MODE: 'live',
    MAINTENANCE_MODE: 'true',
    ALLOW_TEST_DATA_RESET: 'false',
    STRIPE_PAYMENT_MODE: 'test',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock',
    PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
  }),
  armed: Object.freeze({
    APP_ENVIRONMENT: 'production',
    EMAIL_DELIVERY_MODE: 'live',
    MAINTENANCE_MODE: 'true',
    ALLOW_TEST_DATA_RESET: 'false',
    STRIPE_PAYMENT_MODE: 'live',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock',
    PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
  }),
  active: Object.freeze({
    APP_ENVIRONMENT: 'production',
    EMAIL_DELIVERY_MODE: 'live',
    MAINTENANCE_MODE: 'false',
    ALLOW_TEST_DATA_RESET: 'false',
    STRIPE_PAYMENT_MODE: 'live',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'true',
    PRINTFUL_FULFILLMENT_MODE: 'live',
    PRINTFUL_ALLOW_ORDER_WRITES: 'true',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'true',
  }),
});
const MIN_MACHINES = Object.freeze({ hosted: 0, locked: 0, armed: 1, active: 1 });
const COMMON_RUNTIME_SECRETS = Object.freeze([
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'RATE_LIMIT_HMAC_SECRET',
  'MAINTENANCE_SECRET',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_WEBHOOK_SECRET',
  'PRINTFUL_API_KEY',
  'PRINTFUL_STORE_ID',
  'PRINTFUL_WEBHOOK_SECRET',
  'PRINTFUL_WEBHOOK_PUBLIC_KEY',
]);
const TEST_STRIPE_SECRETS = Object.freeze([
  'STRIPE_TEST_SECRET_KEY',
  'STRIPE_TEST_LOCAL_WEBHOOK_SECRET',
  'STRIPE_TEST_HOSTED_WEBHOOK_SECRET',
]);
const LIVE_STRIPE_SECRETS = Object.freeze([
  'STRIPE_LIVE_SECRET_KEY',
  'STRIPE_LIVE_WEBHOOK_SECRET',
]);
const IMPORTED_PRODUCTION_SECRETS = Object.freeze([
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'RATE_LIMIT_HMAC_SECRET',
  'MAINTENANCE_SECRET',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'PRINTFUL_API_KEY',
  'PRINTFUL_STORE_ID',
  ...LIVE_STRIPE_SECRETS,
]);
const CONFIG_ONLY_NAMES = new Set([
  ...Object.keys(POSTURES.active),
  'NODE_ENV',
  'PORT',
  'PUBLIC_URL',
  'DATABASE_CA_CERT_PATH',
  'SUPABASE_STORAGE_BUCKET',
  'MIGRATION_DATABASE_URL',
  'TEST_DATABASE_URL',
]);

function fail(message) {
  throw new Error(message);
}

function parseQuotedAssignments(text, sectionName = null) {
  const values = {};
  let activeSection = null;
  for (const line of String(text).split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      activeSection = section[1];
      continue;
    }
    if (activeSection !== sectionName) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/);
    if (assignment) {
      if (Object.hasOwn(values, assignment[1])) fail(`Duplicate ${assignment[1]} in Fly config.`);
      values[assignment[1]] = assignment[2];
    }
  }
  return values;
}

function parseMinimumMachines(text) {
  const matches = [...String(text).matchAll(/^\s*min_machines_running\s*=\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) fail('Fly config must define min_machines_running exactly once.');
  return Number(matches[0][1]);
}

function validateCutoverConfig(text, posture) {
  if (!Object.hasOwn(POSTURES, posture)) fail(`Unknown cutover posture: ${posture}.`);
  const root = parseQuotedAssignments(text);
  const env = parseQuotedAssignments(text, 'env');
  if (root.app !== APP_NAME) fail(`Fly config must target only ${APP_NAME}.`);
  if (root.primary_region !== 'fra') fail('Fly config must remain in fra.');
  const shared = {
    NODE_ENV: 'production',
    PORT: '8080',
    PUBLIC_URL,
    DATABASE_CA_CERT_PATH: 'certs/supabase-prod-ca-2021.crt',
    SUPABASE_STORAGE_BUCKET: 'wolkenworte-private',
  };
  for (const [name, expected] of Object.entries({ ...shared, ...POSTURES[posture] })) {
    if (env[name] !== expected) fail(`${CONFIGS[posture]} must set ${name}="${expected}".`);
  }
  if (parseMinimumMachines(text) !== MIN_MACHINES[posture]) {
    fail(`${CONFIGS[posture]} must set min_machines_running=${MIN_MACHINES[posture]}.`);
  }
  if (/^\s*release_command\s*=/m.test(text)) fail('Database migrations must not run as a Fly release_command.');
  for (const name of [...COMMON_RUNTIME_SECRETS, ...TEST_STRIPE_SECRETS, ...LIVE_STRIPE_SECRETS,
    'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL']) {
    if (new RegExp(`^\\s*${name}\\s*=`, 'm').test(text)) {
      fail(`${name} must not be committed to a Fly config.`);
    }
  }
  return { env, minMachines: MIN_MACHINES[posture] };
}

function validateConfigFamily(read = (filename) => fs.readFileSync(path.join(ROOT, filename), 'utf8')) {
  return Object.fromEntries(Object.entries(CONFIGS).map(([posture, filename]) => [
    posture,
    validateCutoverConfig(read(filename), posture),
  ]));
}

function normalized(value) {
  return String(value || '').trim();
}

function validateLocalCutoverEnvironment(env = process.env, nodeVersion = process.versions.node) {
  validateOperatorEnvironment(env, nodeVersion);
  const expectedLocal = {
    APP_ENVIRONMENT: 'local',
    STRIPE_PAYMENT_MODE: 'test',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock',
    PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
    ALLOW_TEST_DATA_RESET: 'false',
  };
  for (const [name, expected] of Object.entries(expectedLocal)) {
    if (normalized(env[name]).toLowerCase() !== expected) {
      fail(`Local operator environment must keep ${name}=${expected}.`);
    }
  }
  const missing = IMPORTED_PRODUCTION_SECRETS.filter((name) => !normalized(env[name]));
  if (missing.length) fail(`Missing production cutover values: ${missing.join(', ')}.`);
  let databaseUrl;
  try { databaseUrl = new URL(normalized(env.DATABASE_URL)); } catch { fail('DATABASE_URL is invalid.'); }
  if (databaseUrl.username !== 'wolkenworte_app') {
    fail('DATABASE_URL must use the least-privileged wolkenworte_app role.');
  }
  try {
    const supabaseUrl = new URL(normalized(env.SUPABASE_URL));
    if (supabaseUrl.protocol !== 'https:') fail('SUPABASE_URL must use HTTPS.');
  } catch {
    fail('SUPABASE_URL must be a valid HTTPS URL.');
  }
  if (!normalized(env.SUPABASE_SECRET_KEY).startsWith('sb_secret_')) {
    fail('SUPABASE_SECRET_KEY must be a backend-only sb_secret_ key.');
  }
  if (normalized(env.RATE_LIMIT_HMAC_SECRET).length < 32 ||
      normalized(env.MAINTENANCE_SECRET).length < 32) {
    fail('RATE_LIMIT_HMAC_SECRET and MAINTENANCE_SECRET must be at least 32 characters.');
  }
  if (normalized(env.RATE_LIMIT_HMAC_SECRET) === normalized(env.MAINTENANCE_SECRET)) {
    fail('RATE_LIMIT_HMAC_SECRET and MAINTENANCE_SECRET must be independent.');
  }
  if (!normalized(env.STRIPE_LIVE_SECRET_KEY).startsWith('sk_live_')) {
    fail('STRIPE_LIVE_SECRET_KEY must be an sk_live_ key.');
  }
  if (!normalized(env.STRIPE_LIVE_WEBHOOK_SECRET).startsWith('whsec_')) {
    fail('STRIPE_LIVE_WEBHOOK_SECRET must be a whsec_ secret.');
  }
  return true;
}

function productionSecretValues(env = process.env) {
  validateLocalCutoverEnvironment(env);
  return Object.fromEntries(IMPORTED_PRODUCTION_SECRETS.map((name) => [name, env[name]]));
}

function parseSecretRecords(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { fail('Fly secret list is not valid JSON.'); }
  const records = Array.isArray(parsed) ? parsed : parsed?.secrets;
  if (!Array.isArray(records)) fail('Fly secret list has an unexpected format.');
  return records.map((record) => {
    const name = record?.name || record?.Name || record?.NAME;
    const status = record?.status || record?.Status || 'Unknown';
    if (!name) fail('Fly secret list contains an unnamed entry.');
    return { name, status };
  });
}

function validateSecretBoundary(json, target, { allowStaged = false } = {}) {
  const records = parseSecretRecords(json);
  const byName = new Map(records.map((record) => [record.name, record]));
  const required = target === 'production'
    ? [...COMMON_RUNTIME_SECRETS, ...LIVE_STRIPE_SECRETS]
    : [...COMMON_RUNTIME_SECRETS, 'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET'];
  const forbiddenStripe = target === 'production'
    ? TEST_STRIPE_SECRETS
    : [...LIVE_STRIPE_SECRETS, 'STRIPE_TEST_LOCAL_WEBHOOK_SECRET'];
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length) fail(`Required ${target} Fly secrets are missing: ${missing.join(', ')}.`);
  const forbidden = records.map((record) => record.name)
    .filter((name) => forbiddenStripe.includes(name) || CONFIG_ONLY_NAMES.has(name));
  if (forbidden.length) fail(`Forbidden ${target} Fly secrets are present: ${forbidden.join(', ')}.`);
  const allowedStatuses = allowStaged ? new Set(['Deployed', 'Staged']) : new Set(['Deployed']);
  const unsafeStatuses = records.filter((record) => !allowedStatuses.has(record.status));
  if (unsafeStatuses.length) {
    fail(`Fly secrets have unsafe deployment status: ${unsafeStatuses
      .map((record) => `${record.name}:${record.status}`).join(', ')}.`);
  }
  return true;
}

function parseMachineRecords(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { fail('Fly machine list is not valid JSON.'); }
  if (!Array.isArray(parsed)) fail('Fly machine list has an unexpected format.');
  return parsed;
}

function machineMatchesPosture(machine, posture) {
  const env = machine?.config?.env || {};
  return Object.entries(POSTURES[posture]).every(([name, value]) => env[name] === value) &&
    Number(machine?.config?.services?.[0]?.min_machines_running) === MIN_MACHINES[posture];
}

function detectMachinePosture(json) {
  const machines = parseMachineRecords(json);
  if (machines.length !== 1) fail('Cutover requires exactly one Fly Machine.');
  const matches = Object.keys(POSTURES).filter((posture) => machineMatchesPosture(machines[0], posture));
  if (matches.length !== 1) fail('The Fly Machine is not in a recognized cutover posture.');
  return matches[0];
}

function validateMachinePosture(json, posture, { requireHealthy = false } = {}) {
  const machines = parseMachineRecords(json);
  if (machines.length !== 1) fail('Cutover requires exactly one Fly Machine.');
  const machine = machines[0];
  if (!machineMatchesPosture(machine, posture)) fail(`Fly Machine is not in ${posture} posture.`);
  if (machine.region !== 'fra') fail('Fly Machine must remain in fra.');
  if (requireHealthy) {
    if (machine.state !== 'started') fail('Fly Machine is not started.');
    const checks = machine.checks || [];
    if (!checks.length || checks.some((check) => check.status !== 'passing')) {
      fail('Fly Machine readiness checks are not all passing.');
    }
  }
  return true;
}

function parseOptions(argv = process.argv.slice(2)) {
  const allowedPhases = new Set(['preflight', 'lock', 'arm', 'activate', 'rearm']);
  const options = {
    phase: '', commit: '', confirmations: new Set(), preserveEventSlug: '', preserveNone: false,
  };
  for (const argument of argv) {
    if (argument.startsWith('--phase=')) options.phase = argument.slice('--phase='.length);
    else if (argument.startsWith('--confirm-commit=')) options.commit = argument.slice('--confirm-commit='.length);
    else if (argument.startsWith('--preserve-event-slug=')) {
      options.preserveEventSlug = argument.slice('--preserve-event-slug='.length);
    } else if (argument === '--preserve-none') options.preserveNone = true;
    else if ([
      '--confirm-maintenance-lock',
      '--confirm-production-arm',
      '--confirm-live-activation',
      '--confirm-emergency-rearm',
    ].includes(argument)) options.confirmations.add(argument);
    else fail(`Unknown cutover argument: ${argument}.`);
  }
  if (!allowedPhases.has(options.phase)) {
    fail('Use exactly one --phase=preflight|lock|arm|activate|rearm.');
  }
  const hasPreservedSlug = Boolean(options.preserveEventSlug);
  if (hasPreservedSlug && !/^[A-Za-z0-9_-]{1,120}$/.test(options.preserveEventSlug)) {
    fail('The preserved event slug is invalid.');
  }
  if (['arm', 'activate'].includes(options.phase)) {
    if (hasPreservedSlug === options.preserveNone) {
      fail('Arm and activate require exactly one --preserve-event-slug=<slug> or --preserve-none.');
    }
  } else if (hasPreservedSlug || options.preserveNone) {
    fail('A preservation choice is accepted only for arm and activate.');
  }
  return options;
}

function preservationArgument(options) {
  return options.preserveEventSlug
    ? `--preserve-event-slug=${options.preserveEventSlug}`
    : '--preserve-none';
}

function assertPhaseConfirmation(options, commit) {
  if (options.phase === 'preflight') return true;
  const required = {
    lock: '--confirm-maintenance-lock',
    arm: '--confirm-production-arm',
    activate: '--confirm-live-activation',
    rearm: '--confirm-emergency-rearm',
  }[options.phase];
  if (!options.confirmations.has(required)) fail(`Explicit confirmation missing: ${required}.`);
  if (!/^[a-f0-9]{40}$/.test(options.commit) || options.commit !== commit) {
    fail(`--confirm-commit must equal the exact approved commit ${commit}.`);
  }
  if (options.confirmations.size !== 1) fail('Only the confirmation for the selected phase is allowed.');
  return true;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed with exit ${result.status}.`);
  return String(result.stdout || '').trim();
}

function runStep({ label, command, args }) {
  console.log(`\n[cutover:production] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit ${result.status}.`);
}

function verificationSteps(posture, shortSha) {
  const config = CONFIGS[posture];
  return [
    { label: 'Install dependencies reproducibly', command: 'npm', args: ['ci'] },
    { label: 'Run complete test suite', command: 'npm', args: ['test'] },
    {
      label: 'Build the approved production image locally',
      command: 'docker',
      args: ['build', '--platform', 'linux/amd64', '--tag', `${APP_NAME}:${shortSha}`, '.'],
    },
    {
      label: `Validate ${config} strictly`,
      command: 'flyctl',
      args: ['config', 'validate', '--strict', '--config', config, '--app', APP_NAME],
    },
    { label: 'Apply ordered database migrations', command: 'npm', args: ['run', 'db:migrate'], releaseBoundary: true },
  ];
}

function deployStep(posture, label = `Deploy ${posture} posture`) {
  return {
    label,
    command: 'flyctl',
    args: ['deploy', '--remote-only', '--ha=false', '--config', CONFIGS[posture], '--app', APP_NAME, '--yes'],
  };
}

function smokeStep(expected) {
  return {
    label: `Run ${expected} production read-only smoke`,
    command: 'node',
    args: ['scripts/production-readiness-smoke.js',
      expected === 'active' ? '--expect-active' : '--expect-maintenance'],
  };
}

function stageProductionSecrets(values, spawn = spawnSync) {
  const payload = Object.entries(values)
    .map(([name, value]) => `${name}=${String(value).replace(/\r?\n/g, '\\n')}`)
    .join('\n');
  const imported = spawn('flyctl', ['secrets', 'import', '--stage', '--app', APP_NAME], {
    cwd: ROOT,
    input: `${payload}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
    env: process.env,
  });
  if (imported.error || imported.status !== 0) fail('Production secrets could not be staged.');
  const removed = spawn('flyctl', [
    'secrets', 'unset', '--stage', '--app', APP_NAME,
    'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET',
  ], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (removed.error || removed.status !== 0) {
    fail('Test Stripe secrets could not be staged for removal; no staged change was activated.');
  }
}

function loadLocalEnvironment() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) fail('The local ignored .env is missing.');
  const loaded = require('dotenv').config({ path: envPath, override: true });
  if (loaded.error) fail(`The local .env could not be loaded: ${loaded.error.message}`);
}

function runVerificationSteps(posture, commit) {
  for (const step of verificationSteps(posture, commit.slice(0, 12))) {
    if (step.releaseBoundary) {
      const rechecked = assertGitReleaseCandidate();
      if (rechecked !== commit) fail('Approved release commit changed during verification.');
    }
    runStep(step);
  }
}

function currentMachineJson() {
  return runCapture('flyctl', ['machine', 'list', '--app', APP_NAME, '--json']);
}

function currentSecretJson() {
  return runCapture('flyctl', ['secrets', 'list', '--app', APP_NAME, '--json']);
}

function verifyRemote(posture, secretTarget, { healthy = false } = {}) {
  validateMachinePosture(currentMachineJson(), posture, { requireHealthy: healthy });
  validateSecretBoundary(currentSecretJson(), secretTarget);
}

function verifyCertificates() {
  runCapture('flyctl', ['certs', 'check', 'wolkenworte.io', '--app', APP_NAME, '--json']);
  runCapture('flyctl', ['certs', 'check', 'www.wolkenworte.io', '--app', APP_NAME, '--json']);
}

function rearmAfterFailedActivation(originalError) {
  try {
    runStep(deployStep('armed', 'Re-arm maintenance and disable every live gate'));
    runStep(smokeStep('maintenance'));
    verifyRemote('armed', 'production', { healthy: true });
  } catch (rearmError) {
    fail(`Activation failed (${originalError.message}); automatic re-arm also failed (${rearmError.message}).`);
  }
  fail(`Activation failed and the app was safely re-armed: ${originalError.message}`);
}

function main() {
  const options = parseOptions();
  loadLocalEnvironment();
  validateConfigFamily();
  validateLocalCutoverEnvironment();
  const commit = assertGitReleaseCandidate();
  assertPhaseConfirmation(options, commit);

  runCapture('flyctl', ['auth', 'whoami']);
  runCapture('docker', ['info', '--format', '{{.ServerVersion}}']);
  verifyCertificates();
  const currentPosture = detectMachinePosture(currentMachineJson());
  validateSecretBoundary(
    currentSecretJson(),
    ['armed', 'active'].includes(currentPosture) ? 'production' : 'hosted',
  );

  if (options.phase === 'preflight') {
    for (const filename of Object.values(CONFIGS)) {
      runCapture('flyctl', ['config', 'validate', '--strict', '--config', filename, '--app', APP_NAME]);
    }
    console.log(JSON.stringify({ approvedCommit: commit, currentPosture, mutation: false }, null, 2));
    return;
  }

  const requiredPosture = {
    lock: 'hosted', arm: 'locked', activate: 'armed', rearm: 'active',
  }[options.phase];
  if (currentPosture !== requiredPosture) {
    fail(`Phase ${options.phase} requires ${requiredPosture} posture; found ${currentPosture}.`);
  }
  const targetPosture = {
    lock: 'locked', arm: 'armed', activate: 'active', rearm: 'armed',
  }[options.phase];
  if (options.phase === 'rearm') {
    runStep(deployStep('armed', 'Emergency re-arm: enable maintenance and disable every live gate'));
    runStep(smokeStep('maintenance'));
    verifyRemote('armed', 'production', { healthy: true });
    runStep({ label: 'Show final Fly status', command: 'flyctl', args: ['status', '--app', APP_NAME] });
    console.log(`\n[cutover:production] rearm complete for ${APP_NAME} @ ${commit}.`);
    return;
  }
  runVerificationSteps(targetPosture, commit);

  if (options.phase === 'lock') {
    runStep(deployStep('locked'));
    runStep(smokeStep('maintenance'));
    verifyRemote('locked', 'hosted', { healthy: true });
  } else if (options.phase === 'arm') {
    runStep({
      label: 'Prove rotated local credentials still identify the locked Fly target',
      command: 'node',
      args: ['scripts/verify-cutover-target.js'],
    });
    runStep({
      label: 'Verify the database and private Storage preservation boundary',
      command: 'npm',
      args: ['run', 'ops:verify-prelive-empty', '--', preservationArgument(options)],
    });
    stageProductionSecrets(productionSecretValues());
    validateSecretBoundary(currentSecretJson(), 'production', { allowStaged: true });
    runStep(deployStep('armed'));
    runStep({
      label: 'Update the maintenance Cron with the rotated secret',
      command: 'npm',
      args: ['run', 'maintenance:configure-cron', '--', '--url', 'https://wolkenworte.fly.dev'],
    });
    runStep(smokeStep('maintenance'));
    verifyRemote('armed', 'production', { healthy: true });
  } else {
    runStep({
      label: 'Re-verify the production preservation boundary',
      command: 'npm',
      args: ['run', 'ops:verify-prelive-empty', '--', preservationArgument(options)],
    });
    let activationStarted = false;
    try {
      activationStarted = true;
      runStep(deployStep('active'));
      runStep(smokeStep('active'));
      verifyRemote('active', 'production', { healthy: true });
    } catch (error) {
      if (activationStarted) rearmAfterFailedActivation(error);
      throw error;
    }
  }

  runStep({ label: 'Show final Fly status', command: 'flyctl', args: ['status', '--app', APP_NAME] });
  console.log(`\n[cutover:production] ${options.phase} complete for ${APP_NAME} @ ${commit}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n[cutover:production] aborted: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  APP_NAME,
  COMMON_RUNTIME_SECRETS,
  CONFIGS,
  IMPORTED_PRODUCTION_SECRETS,
  LIVE_STRIPE_SECRETS,
  MIN_MACHINES,
  POSTURES,
  TEST_STRIPE_SECRETS,
  assertPhaseConfirmation,
  detectMachinePosture,
  parseOptions,
  productionSecretValues,
  stageProductionSecrets,
  validateConfigFamily,
  validateCutoverConfig,
  validateLocalCutoverEnvironment,
  validateMachinePosture,
  validateSecretBoundary,
  verificationSteps,
};
