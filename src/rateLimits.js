'use strict';

const GUEST_ID_RE = /^[a-f0-9]{32}$/;

const LIMITS = Object.freeze({
  eventCreate: Object.freeze({ max: 5, windowMs: 60 * 60 * 1000 }),
  wordBurst: Object.freeze({ max: 3, windowMs: 1000 }),
  wordGuest: Object.freeze({ max: 30, windowMs: 60 * 1000 }),
  wordSource: Object.freeze({ max: 300, windowMs: 60 * 1000 }),
  wordRemoveGuest: Object.freeze({ max: 60, windowMs: 60 * 1000 }),
  wordRemoveAdmin: Object.freeze({ max: 60, windowMs: 60 * 1000 }),
  themeGuest: Object.freeze({ max: 10, windowMs: 60 * 1000 }),
  themeEvent: Object.freeze({ max: 60, windowMs: 60 * 1000 }),
  socketEvent: Object.freeze({ max: 500 }),
  socketSource: Object.freeze({ max: 300 }),
  assetGuest: Object.freeze({ max: 12, windowMs: 60 * 60 * 1000 }),
  assetSource: Object.freeze({ max: 300, windowMs: 60 * 60 * 1000 }),
  configurationGuest: Object.freeze({ max: 30, windowMs: 60 * 60 * 1000 }),
  configurationSource: Object.freeze({ max: 300, windowMs: 60 * 60 * 1000 }),
  estimateGuest: Object.freeze({ max: 20, windowMs: 10 * 60 * 1000 }),
  estimateSource: Object.freeze({ max: 200, windowMs: 10 * 60 * 1000 }),
  checkoutGuest: Object.freeze({ max: 10, windowMs: 10 * 60 * 1000 }),
  checkoutSource: Object.freeze({ max: 100, windowMs: 10 * 60 * 1000 }),
});

const windows = new Map();
const tokenBuckets = new Map();
const connections = new Map();
const MAX_WINDOW_BUCKETS = 100_000;
let operations = 0;

function compact(now = Date.now()) {
  for (const [key, bucket] of windows) {
    const cutoff = now - bucket.windowMs;
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > cutoff);
    if (!bucket.timestamps.length) windows.delete(key);
  }
  for (const [key, bucket] of tokenBuckets) {
    if (bucket.updatedAt < now - Math.max(bucket.windowMs * 2, 60_000)) tokenBuckets.delete(key);
  }
  for (const [key, count] of connections) {
    if (count <= 0) connections.delete(key);
  }
}

/**
 * Atomic token buckets for the high-frequency Socket.io word path. Each rule
 * starts full and refills continuously to its exact per-window capacity.
 */
function consumeTokens(rules, now = Date.now()) {
  operations += 1;
  if (operations % 1000 === 0) compact(now);
  const prepared = rules.map((rule) => {
    const bucketKey = `${rule.name}:${rule.key}`;
    const existing = tokenBuckets.get(bucketKey);
    const elapsed = existing ? Math.max(0, now - existing.updatedAt) : 0;
    const tokens = existing?.windowMs === rule.windowMs && existing?.max === rule.max
      ? Math.min(rule.max, existing.tokens + elapsed * rule.max / rule.windowMs)
      : rule.max;
    return { ...rule, bucketKey, tokens };
  });
  if (prepared.some((rule) => rule.tokens < 1)) return false;
  for (const rule of prepared) {
    if (!tokenBuckets.has(rule.bucketKey) && tokenBuckets.size >= MAX_WINDOW_BUCKETS) {
      tokenBuckets.delete(tokenBuckets.keys().next().value);
    }
    tokenBuckets.set(rule.bucketKey, {
      max: rule.max,
      windowMs: rule.windowMs,
      tokens: rule.tokens - 1,
      updatedAt: now,
    });
  }
  return true;
}

/**
 * Atomically checks and consumes a collection of in-process windows. No rule
 * is charged when any sibling rule rejects the action.
 */
function consume(rules, now = Date.now()) {
  operations += 1;
  if (operations % 1000 === 0) compact(now);
  const prepared = rules.map((rule) => {
    const bucketKey = `${rule.name}:${rule.key}`;
    const existing = windows.get(bucketKey);
    const timestamps = existing?.windowMs === rule.windowMs
      ? existing.timestamps.filter((timestamp) => timestamp > now - rule.windowMs)
      : [];
    return { ...rule, bucketKey, timestamps };
  });
  if (prepared.some((rule) => rule.timestamps.length >= rule.max)) return false;
  for (const rule of prepared) {
    rule.timestamps.push(now);
    if (!windows.has(rule.bucketKey) && windows.size >= MAX_WINDOW_BUCKETS) {
      windows.delete(windows.keys().next().value);
    }
    windows.set(rule.bucketKey, { windowMs: rule.windowMs, timestamps: rule.timestamps });
  }
  return true;
}

function acquireSocket(eventId, sourceHash) {
  const eventKey = `socket:event:${eventId}`;
  const sourceKey = `socket:source:${eventId}:${sourceHash}`;
  const eventCount = connections.get(eventKey) || 0;
  const sourceCount = connections.get(sourceKey) || 0;
  if (eventCount >= LIMITS.socketEvent.max || sourceCount >= LIMITS.socketSource.max) return null;
  connections.set(eventKey, eventCount + 1);
  connections.set(sourceKey, sourceCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remainingEvent = Math.max(0, (connections.get(eventKey) || 1) - 1);
    const remainingSource = Math.max(0, (connections.get(sourceKey) || 1) - 1);
    if (remainingEvent) connections.set(eventKey, remainingEvent); else connections.delete(eventKey);
    if (remainingSource) connections.set(sourceKey, remainingSource); else connections.delete(sourceKey);
  };
}

function guestIdentity(value, sourceHash) {
  const candidate = String(value || '');
  return GUEST_ID_RE.test(candidate) ? candidate : `source-${sourceHash}`;
}

function resetForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Rate-limit reset is test-only.');
  windows.clear();
  tokenBuckets.clear();
  connections.clear();
  operations = 0;
}

module.exports = { LIMITS, consume, consumeTokens, acquireSocket, guestIdentity, resetForTests };
