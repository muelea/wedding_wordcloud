'use strict';

require('dotenv').config();

const db = require('../src/db');

async function run({ output = console.log } = {}) {
  await db.assertDatabaseReady();
  const status = await db.getOperationalStatus();
  output(JSON.stringify(status, null, 2));
  return status;
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(`Operational status failed: ${error?.code || 'operation_failed'}`);
      process.exitCode = 1;
    })
    .finally(() => db.closePool().catch(() => {}));
}

module.exports = { run };
