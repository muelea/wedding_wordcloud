'use strict';

const performanceProbe = require('./performanceProbe');

const DEFAULT_WINDOW_MS = 100;
const DEFAULT_MAX_PENDING_ROOMS = 5_000;
const MAX_FETCH_FAILURES = 3;

/**
 * Coalesces complete word snapshots independently per event room.
 *
 * A database mutation schedules only after its transaction has committed.
 * One room owns at most one timer and one in-flight fetch, so a burst cannot
 * create an unbounded callback/query queue. Entries disappear as soon as the
 * room is clean. The explicit global ceiling is a final one-Machine guard;
 * normal capacity is bounded much earlier by the socket and write limits.
 */
function createWordUpdateBroadcaster({
  io,
  getWords,
  windowMs = DEFAULT_WINDOW_MS,
  maxPendingRooms = DEFAULT_MAX_PENDING_ROOMS,
  logger = console,
} = {}) {
  if (!io || typeof io.to !== 'function') throw new TypeError('Socket.io instance is required.');
  if (typeof getWords !== 'function') throw new TypeError('getWords function is required.');
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be positive.');
  if (!Number.isInteger(maxPendingRooms) || maxPendingRooms < 1) {
    throw new TypeError('maxPendingRooms must be positive.');
  }

  const pending = new Map();
  const initialLoads = new Map();
  // Versions exist only while sockets initialize. They are not a state cache.
  const initialReaders = new Map();
  let readerCount = 0;
  let stopped = false;

  function beginInitial(event, ownerId) {
    if (stopped || readerCount >= maxPendingRooms) throw new Error('socket initialization is busy');
    let room = initialReaders.get(event.slug);
    if (!room) {
      room = { broadcastVersion: 0, ownershipVersion: 0, owners: new Map(), readers: 0 };
      initialReaders.set(event.slug, room);
    }
    let owner = room.owners.get(ownerId);
    if (!owner) {
      owner = { version: 0, readers: 0 };
      room.owners.set(ownerId, owner);
    }
    room.readers += 1;
    owner.readers += 1;
    readerCount += 1;
    let released = false;
    return {
      get broadcastVersion() { return room.broadcastVersion; },
      get ownershipVersion() { return `${room.ownershipVersion}:${owner.version}`; },
      release() {
        if (released) return;
        released = true;
        if (initialReaders.get(event.slug) !== room) return;
        readerCount -= 1;
        room.readers -= 1;
        owner.readers -= 1;
        if (!owner.readers) room.owners.delete(ownerId);
        if (!room.readers) initialReaders.delete(event.slug);
      },
    };
  }

  function changedOwnership(slug, ownerId) {
    const room = initialReaders.get(slug);
    if (!room) return;
    if (ownerId == null) room.ownershipVersion += 1;
    else {
      const owner = room.owners.get(ownerId);
      if (owner) owner.version += 1;
    }
  }

  function roomSize(slug) {
    return Number(io.sockets?.adapter?.rooms?.get(slug)?.size || 0);
  }

  function emitSnapshot(slug, words) {
    initialLoads.delete(slug);
    const readers = initialReaders.get(slug);
    if (readers) readers.broadcastVersion += 1;
    io.to(slug).emit('word-update', words);
    performanceProbe.recordWordSnapshot({
      serializedBytes: Buffer.byteLength(JSON.stringify(words)),
      recipients: roomSize(slug),
    });
  }

  function arm(entry, delayMs = windowMs) {
    if (stopped || entry.timer || entry.loading) return;
    entry.timer = setTimeout(() => flush(entry), delayMs);
    entry.timer.unref?.();
  }

  async function flush(entry) {
    if (stopped) return;
    entry.timer = null;
    entry.loading = true;
    entry.dirty = false;
    const generation = entry.generation;
    let succeeded = false;
    try {
      const words = await getWords(entry.eventId);
      if (!stopped && entry.generation === generation) {
        emitSnapshot(entry.slug, words);
        entry.lastEmittedAt = Date.now();
        entry.failures = 0;
        succeeded = true;
      }
    } catch (error) {
      entry.failures += 1;
      logger.error(
        `[socket:${entry.slug}] Could not load coalesced word state:`,
        error?.message || error
      );
    } finally {
      entry.loading = false;
    }

    if (stopped) {
      pending.delete(entry.slug);
      return;
    }

    const changedDuringFetch = entry.dirty || entry.generation !== generation;
    const retryFetch = !succeeded && entry.failures < MAX_FETCH_FAILURES;
    if (changedDuringFetch || retryFetch) {
      const earliest = entry.lastEmittedAt + windowMs;
      arm(entry, Math.max(1, earliest - Date.now()));
      return;
    }
    pending.delete(entry.slug);
  }

  function schedule(event, { ownerId } = {}) {
    if (stopped || !event || event.id === undefined || typeof event.slug !== 'string') return false;
    initialLoads.delete(event.slug);
    changedOwnership(event.slug, ownerId);
    let entry = pending.get(event.slug);
    if (!entry) {
      if (pending.size >= maxPendingRooms) {
        logger.error('[socket] Coalesced word-update room ceiling reached.');
        return false;
      }
      entry = {
        slug: event.slug,
        eventId: event.id,
        timer: null,
        loading: false,
        dirty: false,
        failures: 0,
        generation: 0,
        lastEmittedAt: 0,
      };
      pending.set(event.slug, entry);
    }
    entry.dirty = true;
    arm(entry);
    return true;
  }

  function loadInitial(event) {
    if (stopped) return getWords(event.id);
    const existing = initialLoads.get(event.slug);
    if (existing) return existing;
    const load = Promise.resolve(getWords(event.id)).finally(() => {
      if (initialLoads.get(event.slug) === load) initialLoads.delete(event.slug);
    });
    if (initialLoads.size < maxPendingRooms) initialLoads.set(event.slug, load);
    return load;
  }

  function invalidate(slug) {
    const entry = pending.get(slug);
    if (!entry) return;
    entry.generation += 1;
    entry.dirty = false;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.loading) pending.delete(slug);
  }

  function resetRoom(event, words = []) {
    changedOwnership(event.slug);
    invalidate(event.slug);
    emitSnapshot(event.slug, words);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.dirty = false;
    }
    pending.clear();
    initialLoads.clear();
    initialReaders.clear();
    readerCount = 0;
  }

  return {
    schedule,
    invalidate,
    loadInitial,
    beginInitial,
    resetRoom,
    stop,
    get pendingRoomCount() { return pending.size; },
    get initialReaderCount() { return readerCount; },
  };
}

module.exports = {
  DEFAULT_MAX_PENDING_ROOMS,
  DEFAULT_WINDOW_MS,
  createWordUpdateBroadcaster,
};
