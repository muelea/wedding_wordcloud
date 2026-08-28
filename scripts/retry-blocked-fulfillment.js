'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const db = require('../src/db');
const fulfillment = require('../src/fulfillment');

const CONFIRM_FLAG = '--confirm-fulfillment-retry';

function parseArgs(argv = process.argv.slice(2)) {
  const options = { confirmed: argv.includes(CONFIRM_FLAG), orderId: null };
  const index = argv.indexOf('--order-id');
  if (index >= 0) options.orderId = argv[index + 1] || null;
  return options;
}

function validateOptions(options) {
  if (!options.confirmed) {
    const error = new Error(`Refusing without ${CONFIRM_FLAG}.`);
    error.code = 'confirmation_required';
    throw error;
  }
  if (!/^\d+$/.test(String(options.orderId || ''))) {
    const error = new Error('A numeric --order-id is required.');
    error.code = 'invalid_order_id';
    throw error;
  }
}

async function run(options = parseArgs(), dependencies = {}) {
  validateOptions(options);
  const database = dependencies.db || db;
  const processor = dependencies.processClaimedOrder || fulfillment.processClaimedOrder;
  const output = dependencies.output || console.log;
  await database.assertDatabaseReady();
  const lockedBy = `operator-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const claim = await database.claimBlockedFulfillmentForManualRetry({
    orderId: options.orderId,
    lockedBy,
  });
  if (claim.outcome !== 'claimed') {
    const error = new Error(claim.outcome === 'not_found'
      ? 'Paid order not found.' : 'Order is not blocked.');
    error.code = claim.outcome;
    throw error;
  }

  try {
    const result = await processor(claim.order);
    const succeeded = Boolean(result && ['mocked', 'draft', 'submitted'].includes(
      result.fulfillment_status
    ));
    await database.finishOperatorAction(claim.action.id, {
      succeeded,
      afterState: result?.fulfillment_status || 'unknown',
      errorCode: succeeded ? null : result?.fulfillment_error || 'retry_not_completed',
      summary: { orderId: String(claim.order.id), fulfillmentStatus: result?.fulfillment_status || null },
    });
    const summary = {
      operatorActionId: String(claim.action.id),
      orderId: String(claim.order.id),
      fulfillmentStatus: result?.fulfillment_status || null,
      succeeded,
    };
    output(JSON.stringify(summary, null, 2));
    if (!succeeded) {
      const error = new Error('Manual retry did not complete fulfillment.');
      error.code = 'retry_not_completed';
      throw error;
    }
    return summary;
  } catch (error) {
    await database.finishOperatorAction(claim.action.id, {
      succeeded: false,
      afterState: 'interrupted',
      errorCode: error?.code || 'manual_retry_failed',
    }).catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(`Manual fulfillment retry failed: ${error?.code || 'operation_failed'}`);
      process.exitCode = 1;
    })
    .finally(() => db.closePool().catch(() => {}));
}

module.exports = { CONFIRM_FLAG, parseArgs, run, validateOptions };
