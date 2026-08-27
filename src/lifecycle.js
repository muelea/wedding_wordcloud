'use strict';

const db = require('./db');
const storage = require('./privateStorage');

/**
 * Deletes one already-expired event without losing paid commerce or Storage
 * object keys. A failed object deletion leaves the event expired/invisible
 * and the metadata retryable for a later maintenance run.
 */
function hasBudget(deadline, reserveMs = 500) {
  return !deadline || Date.now() + reserveMs < deadline;
}

async function removeDesignAsset(asset) {
  try {
    await storage.remove(asset.object_key);
    await db.finishDesignAssetDeletion(asset.id);
    return true;
  } catch {
    try { await db.failDesignAssetDeletion(asset.id, 'storage_delete_failed'); } catch { /* overlapping retry */ }
    return false;
  }
}

async function cleanupExpiredEvent(eventId, { deadline = null } = {}) {
  const plan = await db.prepareExpiredEventCleanup(eventId);
  if (!plan) return { eligible: false, deleted: false, retainedConfigurations: 0, failedAssets: 0 };

  let failedAssets = 0;
  for (const asset of plan.assets) {
    if (!hasBudget(deadline, 4_000)) break;
    if (!await removeDesignAsset(asset)) failedAssets += 1;
  }
  const deleted = failedAssets === 0 && hasBudget(deadline)
    ? await db.finishExpiredEventDeletion(eventId)
    : false;
  return {
    eligible: true,
    deleted,
    retainedConfigurations: plan.retainedConfigurationIds.length,
    failedAssets,
  };
}

async function cleanupOneExpiredPrintArtifact(excludeIds) {
  const artifact = await db.claimExpiredPrintArtifact([...excludeIds]);
  if (!artifact) return null;
  excludeIds.add(artifact.id);
  try {
    await storage.remove(artifact.object_key);
    await db.finishPrintArtifactDeletion(artifact.id);
  } catch {
    await db.failPrintArtifactDeletion(artifact.id, 'storage_delete_failed');
  }
  return artifact.id;
}

async function cleanupOneExpiredDesignAsset(excludeIds) {
  const asset = await db.claimExpiredDesignAsset([...excludeIds]);
  if (!asset) return null;
  excludeIds.add(asset.id);
  await removeDesignAsset(asset);
  return asset.id;
}

async function runRetentionBatch({
  deadline = null,
  configurationLimit = 4,
  assetLimit = 6,
  eventLimit = 2,
  artifactLimit = 6,
} = {}) {
  const summary = { configurations: 0, assets: 0, events: 0, artifacts: 0 };
  const attemptedAssets = new Set();
  const attemptedArtifacts = new Set();

  for (let index = 0; index < configurationLimit && hasBudget(deadline); index += 1) {
    const result = await db.prepareExpiredPersonalConfigurationCleanup();
    if (!result) break;
    summary.configurations += 1;
  }
  for (let index = 0; index < assetLimit && hasBudget(deadline, 4_000); index += 1) {
    if (!await cleanupOneExpiredDesignAsset(attemptedAssets)) break;
    summary.assets += 1;
  }
  if (hasBudget(deadline)) {
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
