'use strict';

require('dotenv').config();

const db = require('../src/db');
const { CONFIRM_FLAG, runPreliveCleanup } = require('../src/preliveCleanup');

function parseArgs(argv = process.argv.slice(2)) {
  const targetIndex = argv.indexOf('--target-url');
  const preserveArgument = argv.find((argument) => argument.startsWith('--preserve-event-slug='));
  const known = new Set([CONFIRM_FLAG, '--preserve-none']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (known.has(argument) || argument.startsWith('--preserve-event-slug=')) continue;
    if (argument === '--target-url' && argv[index + 1]) {
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete cleanup argument: ${argument}.`);
  }
  return {
    confirmed: argv.includes(CONFIRM_FLAG),
    targetUrl: targetIndex >= 0 ? argv[targetIndex + 1] : null,
    preserveEventSlug: preserveArgument?.slice('--preserve-event-slug='.length) || null,
    preserveNone: argv.includes('--preserve-none'),
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
