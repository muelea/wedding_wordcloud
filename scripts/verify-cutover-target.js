'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const { HOSTED_TEST_ORIGIN, verifyMaintenanceMode } = require('../src/preliveCleanup');

async function run({
  env = process.env,
  verify = verifyMaintenanceMode,
  output = console.log,
} = {}) {
  const currentSecret = String(
    env.CUTOVER_CURRENT_MAINTENANCE_SECRET || env.MAINTENANCE_SECRET || '',
  );
  if (currentSecret.length < 32) {
    throw new Error('Current maintenance credential is missing or shorter than 32 characters.');
  }
  await verify(HOSTED_TEST_ORIGIN, { ...env, MAINTENANCE_SECRET: currentSecret });
  const result = { target: HOSTED_TEST_ORIGIN, maintenance: true, identityMatch: true };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[cutover:target] verification failed:', error.code || error.message);
    process.exitCode = 1;
  });
}

module.exports = { run };
