'use strict';

const db = require('./db');
const storage = require('./privateStorage');

/** Deletes one expired event after detaching retained paid commerce data. */
function hasBudget(deadline, reserveMs = 500) {
  return !deadline || Date.now() + reserveMs < deadline;
}

async function cleanupExpiredEvent(eventId, { deadline = null } = {}) {
  const plan = await db.prepareExpiredEventCleanup(eventId);
  if (!plan) return { eligible: false, deleted: false, retainedConfigurations: 0 };
  const deleted = hasBudget(deadline)
    ? await db.finishExpiredEventDeletion(eventId)
    : false;
  return {
    eligible: true,
    deleted,
    retainedConfigurations: plan.retainedConfigurationIds.length,
  };
}

async function cleanupOneExpiredPrintArtifact(excludeIds) {
  const artifact = await db.claimExpiredPrintArtifact([...excludeIds]);
  if (!artifact) return null;
  excludeIds.add(artifact.id);
  try {
    await storage.remove(artifact.object_key);
    await db.finishPrintArtifactDeletion(artifact.id, artifact.deletion_attempts);
  } catch {
    await db.failPrintArtifactDeletion(artifact.id, 'storage_delete_failed', artifact.deletion_attempts);
  }
  return artifact.id;
}

async function runRetentionBatch({
  deadline = null,
  eventLimit = 2,
  artifactLimit = 6,
  quoteLimit = 500,
} = {}) {
  const summary = { events: 0, artifacts: 0, quotes: 0 };
  const attemptedArtifacts = new Set();
  if (quoteLimit > 0 && hasBudget(deadline, 1_000)) {
    summary.quotes = await db.cleanupAbandonedQuotes(quoteLimit);
  }
  if (eventLimit > 0 && hasBudget(deadline)) {
    const eventIds = await db.getExpiredEventIds(eventLimit);
    for (const eventId of eventIds) {
      if (!hasBudget(deadline, 4_000)) break;
      const result = await cleanupExpiredEvent(eventId, { deadline });
      if (result.deleted) summary.events += 1;
    }
  }
  for (let index = 0; index < artifactLimit && hasBudget(deadline, 4_000); index += 1) {
    if (!await cleanupOneExpiredPrintArtifact(attemptedArtifacts)) break;
    summary.artifacts += 1;
  }
  return summary;
}

module.exports = { cleanupExpiredEvent, runRetentionBatch };
