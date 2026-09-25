'use strict';

require('dotenv').config();
const db = require('../src/db');

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => {
    const index = argv.indexOf(name);
    return index < 0 ? null : argv[index + 1];
  };
  if (!argv.includes('--confirm-retention-change')) throw new Error('confirmation_required');
  const holdReason = get('--hold');
  if (Boolean(holdReason) === argv.includes('--release')) throw new Error('choose_hold_or_release');
  const years = get('--years');
  return {
    orderId: get('--order-id'), holdReason,
    reviewAt: get('--review-at'), years: years == null ? null : Number(years),
  };
}

async function run(options = parseArgs(), { database = db, output = console.log } = {}) {
  await database.assertDatabaseReady();
  const result = await database.setOrderRetentionPolicy(options);
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  Promise.resolve().then(() => run()).catch((error) => {
    console.error(`Retention change failed: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.closePool().catch(() => {}));
}

module.exports = { parseArgs, run };
