'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const db = require('../src/db');
const privateStorage = require('../src/privateStorage');

// A successful step-7 cron proof necessarily creates this bounded, non-customer
// heartbeat before activation. It must remain observable, but it is not hosted
// test business data and therefore cannot make the preservation boundary fail.
const OPERATIONAL_TABLES = new Set(['maintenance_runs']);

function parseArgs(argv = process.argv.slice(2)) {
  const preserveArgument = argv.find((argument) => argument.startsWith('--preserve-event-slug='));
  const preserveNone = argv.includes('--preserve-none');
  if (argv.some((argument) => argument !== '--preserve-none' &&
      !argument.startsWith('--preserve-event-slug='))) {
    throw new Error('Unknown pre-live verification argument.');
  }
  const preserveEventSlug = preserveArgument?.slice('--preserve-event-slug='.length) || null;
  if (Boolean(preserveEventSlug) === preserveNone) {
    throw new Error('Choose exactly one preserved event slug or explicitly preserve none.');
  }
  return { preserveEventSlug, preserveNone };
}

function sameEntries(actual, expected) {
  const normalized = (values) => [...new Set((values || []).map(String).filter(Boolean))].sort();
  return JSON.stringify(normalized(actual)) === JSON.stringify(normalized(expected));
}

async function run({
  database = db,
  storage = privateStorage,
  output = console.log,
  preserveEventSlug = null,
  preserveNone = false,
} = {}) {
  if (Boolean(preserveEventSlug) === (preserveNone === true)) {
    throw new Error('Choose exactly one preserved event slug or explicitly preserve none.');
  }
  await database.assertDatabaseReady();
  const [counts, objectKeys, preservation] = await Promise.all([
    database.getPreliveCleanupCounts(),
    storage.listAllObjectKeys(),
    preserveEventSlug ? database.getPrelivePreservationState(preserveEventSlug) : null,
  ]);
  const expectedCounts = preservation?.counts || Object.fromEntries(
    Object.keys(counts).map((name) => [name, 0]),
  );
  const businessTables = Object.keys(counts).filter((name) => !OPERATIONAL_TABLES.has(name));
  const unexpectedRows = businessTables.reduce(
    (sum, name) => sum + Math.max(0, Number(counts[name]) - Number(expectedCounts[name] || 0)), 0,
  );
  const expectedObjectKeys = preservation?.storageObjectKeys || [];
  if (unexpectedRows || businessTables.some(
    (name) => Number(counts[name]) !== Number(expectedCounts[name] || 0),
  ) || !sameEntries(objectKeys, expectedObjectKeys)) {
    const error = new Error(
      `Pre-live target is outside its preservation boundary ` +
      `(${unexpectedRows} unexpected business rows, ${objectKeys.length} Storage objects).`,
    );
    error.code = 'prelive_target_not_empty';
    throw error;
  }
  const result = {
    verifiedClean: true,
    verifiedEmpty: !preserveEventSlug,
    preservedEventSlug: preserveEventSlug,
    businessRows: businessTables.reduce((sum, name) => sum + Number(counts[name]), 0),
    storageObjects: objectKeys.length,
  };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs();
  } catch (error) {
    console.error(`[cutover:empty] verification failed: ${error.message}`);
    process.exitCode = 1;
  }
  (options ? run(options) : Promise.resolve())
    .catch((error) => {
      console.error(`[cutover:empty] verification failed: ${error.code || error.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.closePool().catch(() => {}));
}

module.exports = { parseArgs, run };
