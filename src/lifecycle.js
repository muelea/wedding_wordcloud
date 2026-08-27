'use strict';

const db = require('./db');
const storage = require('./privateStorage');

/**
 * Deletes one already-expired event without losing paid commerce or Storage
 * object keys. A failed object deletion leaves the event expired/invisible
 * and the metadata retryable for a later maintenance run.
 */
async function cleanupExpiredEvent(eventId) {
  const plan = await db.prepareExpiredEventCleanup(eventId);
  if (!plan) return { eligible: false, deleted: false, retainedConfigurations: 0, failedAssets: 0 };

  let failedAssets = 0;
  for (const asset of plan.assets) {
    try {
      await storage.remove(asset.object_key);
      await db.finishDesignAssetDeletion(asset.id);
    } catch {
      failedAssets += 1;
      try {
        await db.failDesignAssetDeletion(asset.id, 'storage_delete_failed');
      } catch {
        // The row may already have been finalized by an overlapping retry.
      }
    }
  }
  const deleted = failedAssets === 0
    ? await db.finishExpiredEventDeletion(eventId)
    : false;
  return {
    eligible: true,
    deleted,
    retainedConfigurations: plan.retainedConfigurationIds.length,
    failedAssets,
  };
}

module.exports = { cleanupExpiredEvent };
