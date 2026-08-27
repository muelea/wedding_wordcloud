'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function enabled(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function validateSafety() {
  if (!process.argv.includes('--confirm-email-smoke')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-email-smoke');
  }
  if (enabled('STRIPE_ALLOW_LIVE_PAYMENTS')) {
    throw new Error('Der Provider-Smoke läuft nicht bei freigeschalteten Live-Zahlungen.');
  }
  if (String(process.env.EMAIL_DELIVERY_MODE || '').trim().toLowerCase() !== 'live') {
    throw new Error('Der Smoke benötigt EMAIL_DELIVERY_MODE=live.');
  }
  for (const name of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_WEBHOOK_SECRET']) {
    if (!String(process.env[name] || '').trim()) throw new Error(`${name} fehlt.`);
  }
  const recipient = String(argument('--recipient') || '').trim().toLowerCase();
  if (!recipient) throw new Error('--recipient fehlt.');
  const allowlist = new Set(String(process.env.RESEND_SMOKE_RECIPIENTS || '')
    .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  if (!allowlist.has(recipient)) {
    throw new Error('Der explizite Empfänger steht nicht in RESEND_SMOKE_RECIPIENTS.');
  }
  const expected = String(argument('--expect') || 'none').trim().toLowerCase();
  if (!['none', 'delivered', 'bounced'].includes(expected)) {
    throw new Error('--expect muss none, delivered oder bounced sein.');
  }
  return { recipient, expected };
}

async function waitForOutcome(db, jobId, expected) {
  if (expected === 'none') return db.getEmailJobById(jobId);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const job = await db.getEmailJobById(jobId);
    if (job?.status === expected) return job;
    if (['blocked', 'failed', 'complained'].includes(job?.status)) {
      throw new Error(`Unerwarteter Resend-Status: ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Signierter Resend-${expected}-Webhook wurde nicht innerhalb von 60 Sekunden verarbeitet.`);
}

async function main() {
  const { recipient, expected } = validateSafety();
  const locale = String(argument('--locale') || 'de').trim().toLowerCase();
  const db = require('../src/db');
  const emailDelivery = require('../src/emailDelivery');
  await db.assertDatabaseReady();
  let smoke;
  try {
    smoke = await db.createEmailSmokeJob({ recipientEmail: recipient, locale });
    const accepted = await emailDelivery.processJob(smoke.emailJob.id, { providerSmoke: true });
    if (!accepted || !['sent', 'delivered', 'bounced'].includes(accepted.status)) {
      throw new Error('Die synthetische E-Mail wurde nicht sicher von Resend angenommen.');
    }
    const finalJob = await waitForOutcome(db, smoke.emailJob.id, expected);
    await db.finishEmailSmokeRun(smoke.smokeRun.id, {
      succeeded: true,
      outcomeCode: expected === 'none' ? 'provider_accepted' : `provider_${finalJob.status}`,
    });
    console.log(`[resend-smoke] Synthetische Bestellbestätigung erfolgreich geprüft (${finalJob.status}).`);
  } catch (error) {
    if (smoke?.smokeRun?.id) {
      await db.finishEmailSmokeRun(smoke.smokeRun.id, {
        succeeded: false,
        outcomeCode: error.code || 'email_smoke_failed',
      }).catch(() => {});
    }
    throw error;
  } finally {
    await db.closePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[resend-smoke] fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { validateSafety, waitForOutcome };
