'use strict';

const db = require('./db');
const fulfillment = require('./fulfillment');
const emailDelivery = require('./emailDelivery');
const lifecycle = require('./lifecycle');

const WALL_CLOCK_BUDGET_MS = 15_000;
const FULFILLMENT_BUDGET_MS = 7_000;
const EMAIL_BUDGET_MS = 12_000;
let running = null;

function sanitizedCode(error) {
  return String(error?.code || 'maintenance_failed')
    .toLowerCase().replace(/[^a-z0-9_:-]/g, '').slice(0, 120) || 'maintenance_failed';
}

async function execute(triggerKind) {
  const startedAt = Date.now();
  const run = await db.startMaintenanceRun(triggerKind);
  try {
    const fulfillmentSummary = await fulfillment.drainDueJobs({
      maxJobs: 1,
      deadline: startedAt + FULFILLMENT_BUDGET_MS,
    });
    const emailSummary = await emailDelivery.drainDueJobs({
      maxJobs: 1,
      deadline: startedAt + EMAIL_BUDGET_MS,
    });
    const retentionSummary = await lifecycle.runRetentionBatch({
      deadline: startedAt + WALL_CLOCK_BUDGET_MS - 250,
    });
    const summary = {
      fulfillmentClaimed: fulfillmentSummary.claimed,
      fulfillmentCompleted: fulfillmentSummary.completed,
      emailsClaimed: emailSummary.claimed,
      emailsCompleted: emailSummary.completed,
      emailsBlocked: emailSummary.blocked,
      configurationsCleaned: retentionSummary.configurations,
      assetsCleaned: retentionSummary.assets,
      eventsCleaned: retentionSummary.events,
      artifactsCleaned: retentionSummary.artifacts,
    };
    await db.finishMaintenanceRun(run.id, summary);
    return { status: 'ok', summary };
  } catch (error) {
    await db.failMaintenanceRun(run.id, sanitizedCode(error));
    throw error;
  }
}

async function run(triggerKind = 'http') {
  if (running) return { status: 'already_running' };
  running = execute(triggerKind);
  try {
    return await running;
  } finally {
    running = null;
  }
}

module.exports = { WALL_CLOCK_BUDGET_MS, FULFILLMENT_BUDGET_MS, EMAIL_BUDGET_MS, run };
