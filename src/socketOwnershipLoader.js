'use strict';

const DEFAULT_WINDOW_MS = 15;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_PENDING = 5_000;

function requestKey(eventId, ownerId) {
  return `${eventId}:${ownerId}`;
}

/**
 * Coalesces the private ownership lookup performed during Socket.io
 * connection hydration. A restart can reconnect thousands of browsers at
 * once; batching those independent indexed lookups avoids turning that burst
 * into thousands of Postgres network round trips.
 *
 * Results remain private to the exact (event, owner) pair. Nothing is cached
 * after the batch completes, so a later reconnect cannot receive stale
 * receipts after adding or removing a contribution.
 */
function createSocketOwnershipLoader({
  loadBatch,
  windowMs = DEFAULT_WINDOW_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  maxPending = DEFAULT_MAX_PENDING,
  logger = console,
}) {
  if (typeof loadBatch !== 'function') throw new TypeError('loadBatch must be a function');
  const pending = new Map();
  let timer = null;
  let loading = false;
  let stopped = false;

  function arm() {
    if (timer || loading || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch((error) => logger.error('[socket-ownership] Batch failed:', error));
    }, windowMs);
    timer.unref?.();
  }

  async function flush() {
    if (stopped || loading || !pending.size) return;
    loading = true;
    const entries = [...pending.entries()].slice(0, batchSize);
    for (const [key] of entries) pending.delete(key);

    const requests = entries.map(([, entry]) => ({
      eventId: entry.eventId,
      ownerId: entry.ownerId,
    }));
    try {
      const results = await loadBatch(requests);
      for (const [key, entry] of entries) {
        const value = results instanceof Map ? results.get(key) : undefined;
        for (const waiter of entry.waiters) {
          if (stopped) waiter.reject(new Error('socket ownership loader stopped'));
          else waiter.resolve(Array.isArray(value) ? value : []);
        }
      }
    } catch (error) {
      for (const [, entry] of entries) {
        for (const waiter of entry.waiters) waiter.reject(error);
      }
    } finally {
      loading = false;
      if (pending.size) arm();
    }
  }

  function load(eventId, ownerId) {
    if (stopped) return Promise.reject(new Error('socket ownership loader stopped'));
    const key = requestKey(eventId, ownerId);
    let entry = pending.get(key);
    if (!entry) {
      if (pending.size >= maxPending) {
        return Promise.reject(new Error('socket ownership queue is full'));
      }
      entry = { eventId, ownerId, waiters: [] };
      pending.set(key, entry);
    }
    const promise = new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
    if (entry.waiters.length === 1) arm();
    return promise;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const entry of pending.values()) {
      for (const waiter of entry.waiters) waiter.reject(new Error('socket ownership loader stopped'));
    }
    pending.clear();
  }

  return {
    load,
    flush,
    stop,
    get pendingCount() { return pending.size; },
  };
}

module.exports = {
  createSocketOwnershipLoader,
  requestKey,
  DEFAULT_WINDOW_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_PENDING,
};
