'use strict';

/** Single-concurrency, Postgres-leased transactional email worker. */

const crypto = require('crypto');
const db = require('./db');
const resend = require('./resend');
const log = require('./structuredLog');

const MAX_ATTEMPTS = 4;
const LEASE_MS = 120_000;
const IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const POLL_MS = 5_000;
const WORKER_ID = `email-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;

let stopping = false;
let workerBusy = false;
let pollTimer = null;
let scheduledKick = null;
const requestedJobs = new Set();

class EmailLeaseLostError extends Error {
  constructor() {
    super('Der E-Mail-Lease wurde von einem neueren Versuch übernommen.');
    this.name = 'EmailLeaseLostError';
    this.code = 'EMAIL_LEASE_LOST';
  }
}

class EmailSafetyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EmailSafetyError';
    this.code = code;
  }
}

function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function configuredMode() {
  const mode = String(process.env.EMAIL_DELIVERY_MODE || 'mock').trim().toLowerCase();
  if (!['mock', 'live'].includes(mode)) throw new EmailSafetyError('email_mode_invalid');
  return mode;
}

function smokeAllowlist() {
  return new Set(String(process.env.RESEND_SMOKE_RECIPIENTS || '')
    .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function resolveMode(order, job, { providerSmoke = false } = {}) {
  if (providerSmoke) {
    if (!order?.provider_smoke || !job?.provider_smoke || envFlag('STRIPE_LIVE_PAYMENTS_ENABLED') ||
        configuredMode() !== 'live' || !resend.isConfigured() ||
        !smokeAllowlist().has(String(job.recipient_email || '').toLowerCase()) ||
        (process.env.NODE_ENV === 'test' && !resend.hasTestAdapter())) {
      throw new EmailSafetyError('email_provider_smoke_not_safely_enabled');
    }
    return 'live';
  }
  // Manual sandbox purchases may exercise real email independently of payment
  // and fulfillment mode. Automated tests must never use the real provider.
  if (process.env.NODE_ENV === 'test' || !['test', 'live'].includes(order?.mode) ||
      !['paid_test', 'paid', 'fulfilled'].includes(order?.status)) {
    return 'mock';
  }
  const mode = configuredMode();
  if (mode === 'live' && !resend.isConfigured()) throw new EmailSafetyError('resend_not_configured');
  return mode;
}

function leaseFor(job) {
  return { lockedBy: job.locked_by, leaseVersion: Number(job.lease_version) };
}

function retryWindowExpired(job, now = Date.now()) {
  if (!job.delivery_ambiguous || !job.first_send_attempt_at) return false;
  return Date.parse(job.first_send_attempt_at) + IDEMPOTENCY_RETRY_WINDOW_MS <= now;
}

function providerTimeout(deadline) {
  if (!deadline) return 10_000;
  return Math.max(1_000, Math.min(10_000, deadline - Date.now() - 500));
}

async function executeClaimedJob(job, { deadline = null, providerSmoke = false } = {}) {
  const lease = leaseFor(job);
  try {
    const order = await db.getOrderById(job.order_id);
    if (!order) throw new EmailSafetyError('email_order_missing');
    const mode = resolveMode(order, job, { providerSmoke });
    if (mode === 'mock') {
      const completed = await db.completeMockEmail(job.id, lease);
      if (!completed) throw new EmailLeaseLostError();
      log.info('email_mock_completed', {
        jobId: job.id, orderId: job.order_id, outcome: 'mocked', mode: 'mock',
      });
      return completed;
    }
    if (retryWindowExpired(job)) {
      const blocked = await db.blockExpiredAmbiguousEmail(job.id, lease);
      if (!blocked) throw new EmailLeaseLostError();
      log.error('email_blocked', {
        jobId: job.id, orderId: job.order_id, outcome: 'blocked',
        errorCode: 'delivery_outcome_unknown',
      });
      return blocked;
    }
    if (deadline && Date.now() + 1_500 >= deadline) {
      return db.failEmailJob(job.id, lease, 'email_maintenance_checkpoint');
    }
    const attempted = await db.beginEmailProviderAttempt(job.id, lease);
    if (!attempted) throw new EmailLeaseLostError();
    let result;
    try {
      result = await resend.sendEmail(attempted, { timeoutMs: providerTimeout(deadline) });
    } catch (error) {
      const boundaryExpired = error.ambiguous && retryWindowExpired({
        ...attempted,
        delivery_ambiguous: true,
      });
      const failed = await db.failEmailJob(job.id, lease, error.code || 'email_delivery_failed', {
        // A definitive rejection of this retry cannot resolve an earlier
        // attempt whose response was lost. Keep that earlier uncertainty.
        ambiguous: Boolean(job.delivery_ambiguous || error.ambiguous),
        blocked: boundaryExpired || !error.retryable,
      });
      if (failed?.status === 'blocked') {
        log.error('email_blocked', {
          jobId: job.id, orderId: job.order_id, outcome: 'blocked',
          errorCode: failed.last_error || 'email_delivery_blocked',
        });
      } else {
        log.warn('email_retry_scheduled', {
          jobId: job.id, orderId: job.order_id, outcome: 'retry',
          errorCode: log.errorCode(error, 'email_delivery_failed'),
          attempt: job.attempt_count,
        });
      }
      return failed || db.getEmailJobById(job.id);
    }
    if (!await db.renewEmailLease(job.id, lease, LEASE_MS)) return db.getEmailJobById(job.id);
    const completed = await db.completeEmailProviderAcceptance(job.id, lease, result.messageId);
    return completed || db.getEmailJobById(job.id);
  } catch (error) {
    if (error.code === 'EMAIL_LEASE_LOST') return db.getEmailJobById(job.id);
    const failed = await db.failEmailJob(job.id, lease, error.code || 'email_delivery_failed', {
      blocked: error instanceof EmailSafetyError,
    });
    if (failed?.status === 'blocked') log.error('email_blocked', {
      jobId: job.id, orderId: job.order_id, outcome: 'blocked',
      errorCode: failed.last_error || 'email_delivery_blocked',
    });
    return failed || db.getEmailJobById(job.id);
  }
}

async function processJob(jobId, options = {}) {
  if (stopping || workerBusy) return db.getEmailJobById(jobId);
  workerBusy = true;
  try {
    const job = await db.claimEmailJob({
      jobId,
      lockedBy: WORKER_ID,
      leaseMs: LEASE_MS,
      providerSmoke: Boolean(options.providerSmoke),
    });
    if (!job) return db.getEmailJobById(jobId);
    // Shutdown and the poller must see this job as active until it settles.
    return await executeClaimedJob(job, options);
  } finally {
    workerBusy = false;
  }
}

async function drainDueJobs({ maxJobs = 1, deadline = null } = {}) {
  if (stopping || workerBusy) return { claimed: 0, completed: 0, blocked: 0 };
  workerBusy = true;
  let claimed = 0;
  let completed = 0;
  let blocked = 0;
  try {
    while (claimed < maxJobs && (!deadline || Date.now() + 500 < deadline)) {
      const job = await db.claimEmailJob({ lockedBy: WORKER_ID, leaseMs: LEASE_MS });
      if (!job) break;
      claimed += 1;
      const result = await executeClaimedJob(job, { deadline });
      if (result && ['sent', 'delivered'].includes(result.status)) completed += 1;
      if (result?.status === 'blocked') blocked += 1;
    }
    return { claimed, completed, blocked };
  } finally {
    workerBusy = false;
  }
}

async function drainRequested() {
  if (stopping || workerBusy) return;
  const jobId = requestedJobs.values().next().value;
  if (jobId == null) return;
  requestedJobs.delete(jobId);
  await processJob(jobId);
  if (requestedJobs.size) scheduleKick();
}

function scheduleKick() {
  if (stopping || scheduledKick) return false;
  scheduledKick = setImmediate(() => {
    scheduledKick = null;
    drainRequested().catch((error) => log.error('email_worker_failed', {
      errorCode: log.errorCode(error, 'email_worker_failed'),
    }));
  });
  scheduledKick.unref();
  return true;
}

function scheduleJob(jobId) {
  if (stopping || jobId == null) return false;
  requestedJobs.add(String(jobId));
  return scheduleKick();
}

async function resumePendingJobs() {
  if (stopping) return 0;
  await db.recoverStaleEmailJobs();
  const pending = await db.getPendingEmailJobs(20);
  pending.forEach((job) => requestedJobs.add(String(job.id)));
  if (pending.length) scheduleKick();
  return pending.length;
}

function start() {
  if (stopping || pollTimer) return false;
  pollTimer = setInterval(() => {
    drainDueJobs({ maxJobs: 1 }).catch((error) => log.error('email_poll_failed', {
      errorCode: log.errorCode(error, 'email_poll_failed'),
    }));
  }, POLL_MS);
  pollTimer.unref();
  resumePendingJobs().catch((error) => log.error('email_resume_failed', {
    errorCode: log.errorCode(error, 'email_resume_failed'),
  }));
  return true;
}

async function stop({ timeoutMs = 15_000 } = {}) {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (scheduledKick) clearImmediate(scheduledKick);
  scheduledKick = null;
  requestedJobs.clear();
  const deadline = Date.now() + timeoutMs;
  while (workerBusy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  return { drained: !workerBusy, activeJobs: workerBusy ? 1 : 0 };
}

module.exports = {
  MAX_ATTEMPTS,
  LEASE_MS,
  IDEMPOTENCY_RETRY_WINDOW_MS,
  EmailLeaseLostError,
  EmailSafetyError,
  configuredMode,
  resolveMode,
  retryWindowExpired,
  processJob,
  drainDueJobs,
  scheduleJob,
  resumePendingJobs,
  start,
  stop,
};
