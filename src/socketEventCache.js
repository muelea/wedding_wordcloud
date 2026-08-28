'use strict';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_EVENTS = 5_000;

/**
 * Bounded active-event lookup cache for connection storms. Event deletion is
 * expiry-driven, so a cached row is valid only until the earlier of its exact
 * database expiry or this short TTL. Concurrent cold lookups share one query.
 */
function createSocketEventCache({
  getEventBySlug,
  ttlMs = DEFAULT_TTL_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
} = {}) {
  if (typeof getEventBySlug !== 'function') throw new TypeError('getEventBySlug is required.');
  const entries = new Map();
  let stopped = false;

  function evictOne(now) {
    for (const [slug, entry] of entries) {
      if (entry.cachedUntil <= now) {
        entries.delete(slug);
        return;
      }
    }
    entries.delete(entries.keys().next().value);
  }

  async function get(slug) {
    if (stopped) return getEventBySlug(slug);
    const now = Date.now();
    const existing = entries.get(slug);
    if (existing?.promise) return existing.promise;
    if (existing?.event && existing.cachedUntil > now) return existing.event;
    if (existing) entries.delete(slug);
    if (entries.size >= maxEvents) evictOne(now);

    const entry = { event: null, promise: null, cachedUntil: now };
    entry.promise = Promise.resolve(getEventBySlug(slug)).then((event) => {
      entry.promise = null;
      if (!event || stopped) {
        entries.delete(slug);
        return event;
      }
      const expiresAt = Date.parse(event.expires_at || event.expiresAt);
      entry.event = event;
      entry.cachedUntil = Math.min(now + ttlMs, Number.isFinite(expiresAt) ? expiresAt : now);
      if (entry.cachedUntil <= Date.now()) entries.delete(slug);
      return event;
    }, (error) => {
      entries.delete(slug);
      throw error;
    });
    entries.set(slug, entry);
    return entry.promise;
  }

  function stop() {
    stopped = true;
    entries.clear();
  }

  return {
    get,
    stop,
    get size() { return entries.size; },
  };
}

module.exports = { DEFAULT_MAX_EVENTS, DEFAULT_TTL_MS, createSocketEventCache };
