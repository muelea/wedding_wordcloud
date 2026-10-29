'use strict';

const db = require('./db');
const fulfillment = require('./fulfillment');
const emailDelivery = require('./emailDelivery');
const dailyRetention = require('./dailyRetention');
const mockups = require('./printfulMockups');
const log = require('./structuredLog');
const storage = require('./privateStorage');
const savedDesigns = require('./savedDesigns');

const WALL_CLOCK_BUDGET_MS = 15_000;
const FULFILLMENT_BUDGET_MS = 14_000;
const EMAIL_BUDGET_MS = 14_750;
let running = null;

function sanitizedCode(error) {
  return String(error?.code || 'maintenance_failed')
    .toLowerCase().replace(/[^a-z0-9_:-]/g, '').slice(0, 120) || 'maintenance_failed';
}

async function execute(triggerKind) {
  const startedAt = Date.now();
  const run = await db.startMaintenanceRun(triggerKind);
  log.info('maintenance_started', {
    maintenanceRunId: run.id, operation: 'maintenance', outcome: 'running',
  });
  try {
    // Address-bearing abandoned quotes have a fixed retention promise.
    // Run this bounded delete before provider work can consume the wake-up.
    const quotesCleaned = await db.cleanupAbandonedQuotes(500);
    // Waking is cheap when no mockup job exists; there is no idle worker timer.
    mockups.wake();
    const daily = await dailyRetention.run({ deadline: startedAt + 10_000 }).catch(error => {
      log.error('daily_retention_failed',{errorCode:sanitizedCode(error)});
      return {status:'failed',counts:{}};
    });
    const counts = daily.counts || {};
    const commerce = counts.commerce || {};
    const metadataCleaned = counts.metadata?.deleted || 0;
    const fulfillmentSummary = await fulfillment.drainDueJobs({
      maxJobs: 1,
      deadline: startedAt + FULFILLMENT_BUDGET_MS,
    });
    const emailSummary = await emailDelivery.drainDueJobs({
      maxJobs: 1,
      deadline: startedAt + EMAIL_BUDGET_MS,
    });
    // One list and one delete each have a 3.5s timeout. Only use spare time;
    // paid fulfillment, email and retention keep their existing priority.
    if (Date.now() + 7_250 < startedAt + WALL_CLOCK_BUDGET_MS) {
      await storage.cleanupExpiredMockupSources().catch(error => {
        log.error('mockup_source_cleanup_failed', { errorCode: sanitizedCode(error) });
      });
    }
    const imagesRemoved = await require('./designImageAssets').cleanup({
      deadline: startedAt + WALL_CLOCK_BUDGET_MS - 250,
    }).catch(error => {
      log.error('design_image_cleanup_failed', { errorCode: sanitizedCode(error) });
      return 0;
    });
    let accounts = {};
    if (Date.now() + 1000 < startedAt + WALL_CLOCK_BUDGET_MS - 250) {
      accounts = await savedDesigns.maintenance({ deadline: startedAt + WALL_CLOCK_BUDGET_MS - 250, shortLivedOnly: true }).catch(error=> {
        log.error('design_account_maintenance_failed',{errorCode:sanitizedCode(error)});
        return {failed:true};
      });
    }
    const summary = {
      designsExpired: counts.designs?.deleted || 0,
      accountsExpired: counts.accounts?.queued || 0,
      designObjectsRemoved: accounts.objectsRemoved || 0,
      designImagesRemoved: imagesRemoved,
      designAccountMaintenanceFailed: accounts.failed ? 1 : 0,
      fulfillmentClaimed: fulfillmentSummary.claimed,
      fulfillmentCompleted: fulfillmentSummary.completed,
      emailsClaimed: emailSummary.claimed,
      emailsCompleted: emailSummary.completed,
      emailsBlocked: emailSummary.blocked,
      eventsCleaned: counts.events?.deleted || 0,
      artifactsCleaned: counts.artifacts?.deleted || 0,
      quotesCleaned,
      commerceChecked: commerce.checked || 0,
      unpaidOrdersCleaned: commerce.unpaid || 0,
      technicalCopiesCleaned: commerce.technical || 0,
      operationalCopiesCleaned: commerce.operational || 0,
      emailContentsCleaned: commerce.emails || 0,
      paidOrdersCleaned: commerce.orders || 0,
      metadataCleaned,
      mockupJobsCleaned: counts.mockups?.deleted || 0,
      preparedFilesCleaned: counts.preparedFiles?.deleted || 0,
      retentionDeferred: Object.values(counts).reduce((n,s)=>n+(s.deferred||0),0),
      retentionFailed: Object.values(counts).reduce((n,s)=>n+(s.failed||0),0),
      dailyRetentionStatus: daily.status,
      dailyRetentionFailed: Number(daily.status === 'failed'),
    };
    await db.finishMaintenanceRun(run.id, summary);
    log.info('maintenance_completed', {
      maintenanceRunId: run.id,
      operation: 'maintenance',
      outcome: 'succeeded',
      durationMs: Date.now() - startedAt,
      count: Object.values(summary).reduce((total, value) => total + (typeof value === 'number' ? value : 0), 0),
    });
    return { status: 'ok', summary };
  } catch (error) {
    const code = sanitizedCode(error);
    await db.failMaintenanceRun(run.id, code);
    log.error('maintenance_failed', {
      maintenanceRunId: run.id,
      operation: 'maintenance',
      outcome: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: code,
    });
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
