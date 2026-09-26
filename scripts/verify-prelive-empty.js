'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const db = require('../src/db');
const privateStorage = require('../src/privateStorage');

async function run({ database = db, storage = privateStorage, output = console.log } = {}) {
  await database.assertDatabaseReady();
  const [counts, objectKeys] = await Promise.all([
    database.getPreliveCleanupCounts(),
    storage.listAllObjectKeys(),
  ]);
  const remainingRows = Object.values(counts).reduce((sum, count) => sum + Number(count), 0);
  if (remainingRows || objectKeys.length) {
    const error = new Error(
      `Pre-live target is not empty (${remainingRows} business rows, ${objectKeys.length} Storage objects).`,
    );
    error.code = 'prelive_target_not_empty';
    throw error;
  }
  const result = { verifiedEmpty: true, businessRows: 0, storageObjects: 0 };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(`[cutover:empty] verification failed: ${error.code || error.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.closePool().catch(() => {}));
}

module.exports = { run };
