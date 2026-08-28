'use strict';

const db = require('./db');
const privateStorage = require('./privateStorage');
const { cleanupTargetFingerprint } = require('./cleanupTarget');

const CONFIRM_FLAG = '--confirm-prelive-cleanup';
const HOSTED_TEST_ORIGIN = 'https://wolkenworte.fly.dev';

function normalizedFlag(env, name, fallback = 'false') {
  return String(env[name] || fallback).trim().toLowerCase();
}

function assertSafetyConfiguration(env = process.env) {
  const required = {
    ALLOW_TEST_DATA_RESET: 'true',
    STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
    PRINTFUL_FULFILLMENT_MODE: 'mock',
    PRINTFUL_ALLOW_ORDER_WRITES: 'false',
    PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
    EMAIL_DELIVERY_MODE: 'mock',
  };
  for (const [name, expected] of Object.entries(required)) {
    if (normalizedFlag(env, name, name.endsWith('_MODE') ? 'mock' : 'false') !== expected) {
      const error = new Error(`${name} must be ${expected}.`);
      error.code = 'unsafe_runtime_configuration';
      throw error;
    }
  }
  return true;
}

function assertTargetUrl(value, env = process.env) {
  let target;
  try {
    target = new URL(value);
  } catch {
    const error = new Error('PUBLIC_URL is not a valid target URL.');
    error.code = 'invalid_cleanup_target';
    throw error;
  }
  const allowedTestTarget = env.NODE_ENV === 'test' &&
    target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname);
  if (target.origin !== HOSTED_TEST_ORIGIN && !allowedTestTarget) {
    const error = new Error(`Cleanup is restricted to ${HOSTED_TEST_ORIGIN}.`);
    error.code = 'invalid_cleanup_target';
    throw error;
  }
  return target.origin;
}

async function verifyMaintenanceMode(targetUrl, env = process.env, fetchImpl = fetch) {
  const response = await fetchImpl(`${targetUrl}/`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 503 || response.headers.get('x-wolkenworte-maintenance') !== 'active') {
    const error = new Error('Target is not in verified maintenance mode.');
    error.code = 'maintenance_mode_required';
    throw error;
  }
  const targetResponse = await fetchImpl(`${targetUrl}/internal/performance/cleanup-target`, {
    headers: { Authorization: `Bearer ${String(env.MAINTENANCE_SECRET || '')}` },
    signal: AbortSignal.timeout(5_000),
  });
  const target = targetResponse.ok ? await targetResponse.json() : null;
  let expectedFingerprint;
  try {
    expectedFingerprint = cleanupTargetFingerprint(env);
  } catch {
    const error = new Error('Local cleanup credentials have no valid target identity.');
    error.code = 'cleanup_target_mismatch';
    throw error;
  }
  if (!target || target.fingerprint !== expectedFingerprint) {
    const error = new Error('Local database/Storage credentials do not match the maintenance target.');
    error.code = 'cleanup_target_mismatch';
    throw error;
  }
  return true;
}

async function runPreliveCleanup(options = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (!options.confirmed) {
    const error = new Error(`Refusing without ${CONFIRM_FLAG}.`);
    error.code = 'confirmation_required';
    throw error;
  }
  assertSafetyConfiguration(env);
  const targetUrl = assertTargetUrl(options.targetUrl || env.PUBLIC_URL, env);
  const database = dependencies.db || db;
  const storage = dependencies.storage || privateStorage;
  const output = dependencies.output || console.log;

  await verifyMaintenanceMode(targetUrl, env, dependencies.fetch || fetch);
  await database.assertDatabaseReady();
  const objectsBefore = await storage.listAllObjectKeys();
  await storage.removeMany(objectsBefore);
  const remainingObjects = await storage.listAllObjectKeys();
  if (remainingObjects.length) {
    const error = new Error('Storage bucket is not empty after deletion.');
    error.code = 'storage_cleanup_incomplete';
    throw error;
  }

  const result = await database.clearPreliveBusinessData();
  const after = await database.getPreliveCleanupCounts();
  if (Object.values(after).some((count) => Number(count) !== 0)) {
    const error = new Error('Database cleanup verification failed.');
    error.code = 'database_cleanup_incomplete';
    throw error;
  }
  const summary = {
    operatorActionId: String(result.action.id),
    storageObjectsDeleted: objectsBefore.length,
    databaseRowsDeleted: Object.values(result.before).reduce((sum, count) => sum + Number(count), 0),
    verifiedEmpty: true,
  };
  output(JSON.stringify(summary, null, 2));
  return summary;
}

module.exports = {
  CONFIRM_FLAG,
  HOSTED_TEST_ORIGIN,
  assertSafetyConfiguration,
  assertTargetUrl,
  runPreliveCleanup,
  verifyMaintenanceMode,
};
