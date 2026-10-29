'use strict';

const db = require('./db');
const lifecycle = require('./lifecycle');
const storage = require('./privateStorage');
const auth = require('./accountAuth');
const savedDesigns = require('./savedDesigns');

const CATEGORIES = ['discovery', 'events', 'designs', 'accounts', 'artifacts', 'commerce', 'metadata', 'objects', 'accountDeletions', 'preparedFiles', 'mockups', 'designImages'];
const PAGE_SIZE = 50;
const SLICE_MS = 10_000;
const room = deadline => Date.now() + 2_000 < deadline;

async function processCandidate(category, id) {
  if (category === 'designImages') return require('./designImageAssets').cleanupOne(id);
  if (category === 'preparedFiles') {
    const file=await db.claimExpiredPreparedPrintFile(id);
    if (!file) return await db.retentionCandidateExists(category,id) ? {reason:'prepared_file_protected_or_busy'} : {skipped:1};
    try {
      await storage.remove(file.object_key);
      if (!await db.finishPreparedPrintFileDeletion(id,file.lease,true)) throw new Error('prepared_file_lease_lost');
      return {deleted:1};
    } catch(error) {await db.finishPreparedPrintFileDeletion(id,file.lease,false);throw error;}
  }
  if (category === 'mockups') {
    if (await db.pruneMockupJobs(Date.now(),id)) return {deleted:1};
    return await db.retentionCandidateExists(category,id) ? {reason:'mockup_job_busy'} : {skipped:1};
  }
  if (category === 'events') {
    const result = await lifecycle.cleanupExpiredEvent(id);
    if (result.deleted) return { deleted: 1 };
    return await db.retentionCandidateExists(category,id) ? { reason:'event_checkout_or_busy' } : { skipped:1 };
  }
  if (category === 'designs') return { deleted:Number(await db.expireSavedDesign(id)) };
  if (category === 'accounts') return { queued:Number(await db.expireDesignAccount(id)) };
  if (category === 'accountDeletions') {
    if (!auth.providerReady()) return await db.retentionCandidateExists(category,id) ? {reason:'account_provider_unavailable'} : {skipped:1};
    const job=await db.claimDesignAccountDeletion(id);
    if (!job) return await db.retentionCandidateExists(category,id) ? {reason:'account_delete_pending'} : {skipped:1};
    try {
      await auth.provider('deleteUser',{id});
      if (!await db.finishDesignAccountDeletion(id,job.lease,true)) throw new Error('account_delete_lease_lost');
      return {deleted:1};
    } catch(error) {await db.finishDesignAccountDeletion(id,job.lease,false);throw error;}
  }
  if (category === 'objects') {
    const objects=await db.claimDesignObjectDeletionBatch(null,1,id);
    if (!objects.length) return await db.retentionCandidateExists(category,id) ? {reason:'object_delete_pending'} : {skipped:1};
    const lease=objects[0].lease;
    try {
      await savedDesigns.storage().remove(id);
      if (!await db.finishDesignObjectDeletionBatch([id],lease,true)) throw new Error('object_delete_lease_lost');
      return {deleted:1};
    } catch(error) {await db.finishDesignObjectDeletionBatch([id],lease,false);throw error;}
  }
  if (category === 'artifacts') {
    const artifact = await db.claimExpiredPrintArtifact([],id);
    if (!artifact) return await db.retentionCandidateExists(category,id) ? { reason:'artifact_protected_or_busy' } : { skipped:1 };
    try {
      if (!artifact.source_file_id) await storage.remove(artifact.object_key);
      if (!await db.finishPrintArtifactDeletion(artifact.id,artifact.deletion_attempts)) throw new Error('artifact_lease_lost');
      return { deleted:1 };
    } catch (error) {
      await db.failPrintArtifactDeletion(artifact.id,'storage_delete_failed',artifact.deletion_attempts);
      throw error;
    }
  }
  if (category === 'commerce') {
    const result = await db.cleanupOneCommerceRecord(id);
    if (!result) return await db.retentionCandidateExists(category,id) ? { reason:'commerce_protected_or_busy' } : { skipped:1 };
    return { deleted:result.unpaid + result.orders, technical:result.technical,
      operational:result.operational, emails:result.emails,
      protected:Number(!result.unpaid && !result.orders && !result.technical && !result.operational && !result.emails) };
  }
  if (category === 'metadata') return { deleted:await db.cleanupRetentionMetadata({strict:true}) };
  throw new Error('invalid retention category');
}

async function attempt(category,id) {
  let result;
  try { result = await processCandidate(category,id); }
  catch (error) {
    if (error.code === 'RETENTION_LEASE_LOST') throw error;
    result = { reason:error.code || 'retention_delete_failed', failed:1 };
  }
  if (result.reason) await db.deferRetention(category,id,result.reason);
  else await db.clearRetentionDeferral(category,id);
  return result;
}

function addStats(state,result) {
  state.checked = (state.checked || 0) + 1;
  for (const key of ['deleted','queued','skipped','protected','technical','operational','emails','failed']) {
    state[key] = (state[key] || 0) + (result[key] || 0);
  }
  if (result.reason) state.deferred = (state.deferred || 0) + 1;
}

async function run({deadline = Date.now()+SLICE_MS} = {}) {
  deadline = Math.min(deadline,Date.now()+SLICE_MS);
  if (!room(deadline)) return { status:'budget_exhausted' };
  const run = await db.claimDailyRetentionRun();
  if (!run) return retry({deadline});
  const progress = run.progress || {};
  const before = structuredClone(progress);
  function report(status) {
    const counts = {};
    for (const category of CATEGORIES) {
      counts[category] = {};
      for (const key of ['checked','deleted','queued','skipped','protected','technical','operational','emails','failed','deferred']) {
        counts[category][key] = (progress[category]?.[key] || 0) - (before[category]?.[key] || 0);
      }
    }
    return {status,counts};
  }
  try {
    while (room(deadline)) {
      const remaining = CATEGORIES.filter(key=>!progress[key]?.done);
      if (!remaining.length) {
        const deferred = CATEGORIES.some(key=>progress[key]?.deferred);
        await db.checkpointDailyRetention(run,progress,deferred?'completed_with_deferrals':'completed');
        return report(deferred?'completed_with_deferrals':'completed');
      }
      const index = (progress.turn || 0) % CATEGORIES.length;
      const category = CATEGORIES[index];
      progress.turn = (index + 1) % CATEGORIES.length;
      const state = progress[category] ||= {};
      if (state.done) continue;
      await db.checkpointDailyRetention(run,progress);
      if (category === 'discovery') {
        if (!auth.providerReady()) state.done = true;
        else {
          // Discovery precedes account expiry; page is durable across wake-ups.
          if (Date.now()+5_000>=deadline) return report('running');
          const data = await auth.provider('listUsers',{page:state.page || 1});
          await db.discoverDesignAccounts(data.users || []);
          state.page = (state.page || 1) + 1;
          state.done = (data.users || []).length < PAGE_SIZE;
        }
      } else if (category === 'accounts' && (!progress.discovery?.done || !progress.designs?.done)) {
        continue;
      } else if (['objects','accountDeletions'].includes(category) && (!progress.designs?.done || !progress.accounts?.done)) {
        continue;
      } else if (category === 'preparedFiles' && (!progress.artifacts?.done || !progress.commerce?.done)) {
        continue;
      } else if (category === 'metadata') {
        const result = await attempt(category,'batch');
        addStats(state,result);
        state.done = Boolean(result.reason || !result.deleted);
      } else {
        const ids = await db.retentionPage(category,run.cutoff,state.cursor,PAGE_SIZE);
        if (!ids.length) state.done = true;
        for (const id of ids) {
          if (!room(deadline)) break;
          if (['objects','accountDeletions','artifacts','preparedFiles','designImages'].includes(category) && Date.now()+5_000>=deadline) return report('running');
          await db.checkpointDailyRetention(run,progress);
          addStats(state,await attempt(category,id));
          state.cursor = id;
          await db.checkpointDailyRetention(run,progress);
        }
      }
      await db.checkpointDailyRetention(run,progress);
    }
    return report('running');
  } catch(error) {
    await db.recordDailyRetentionFailure(run,error.code || 'retention_run_failed');
    throw error;
  } finally { await db.releaseDailyRetention(run); }
}

async function retry({deadline}) {
  let attempted=0;
  const counts={};
  // Independent short leases let retries continue after a day's scan completes.
  // Each failed target backs off, so it cannot starve fresh daily candidates.
  while (Date.now()+5_000<deadline) {
    const item=await db.claimRetentionDeferral();
    if (!item) break;
    try {
      const result=await processCandidate(item.category,item.target_id);
      const reason=result.reason || (item.category==='metadata' && result.deleted ? 'metadata_remaining' : null);
      await db.finishRetentionDeferral(item,reason);
      addStats(counts[item.category] ||= {},{...result,reason});
    } catch(error) {
      await db.finishRetentionDeferral(item,error.code || 'retention_delete_failed');
      addStats(counts[item.category] ||= {},{failed:1,reason:'retention_delete_failed'});
    }
    attempted++;
  }
  return {status:attempted?'retrying':'idle',retried:attempted,counts};
}

module.exports = {run,processCandidate,CATEGORIES,PAGE_SIZE,SLICE_MS};
