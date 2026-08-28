'use strict';

require('dotenv').config();

const db = require('../src/db');
const { CONFIRM_FLAG, runPreliveCleanup } = require('../src/preliveCleanup');

function parseArgs(argv = process.argv.slice(2)) {
  const targetIndex = argv.indexOf('--target-url');
  return {
    confirmed: argv.includes(CONFIRM_FLAG),
    targetUrl: targetIndex >= 0 ? argv[targetIndex + 1] : null,
  };
}

if (require.main === module) {
  runPreliveCleanup(parseArgs())
    .catch((error) => {
      console.error(`Pre-live cleanup failed: ${error?.code || 'operation_failed'}`);
      process.exitCode = 1;
    })
    .finally(() => db.closePool().catch(() => {}));
}

module.exports = { parseArgs };
