'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const SAMPLE_INTERVAL_MS = 1_000;

let histogram = null;
let timer = null;
let previousCpu = null;
let previousSampleAt = null;
let activeSockets = 0;
let peakSockets = 0;
const activeSocketRooms = new Map();
let wordSnapshots = 0;
let wordSnapshotBytes = 0;
let estimatedRecipientBytes = 0;
const OPERATION_NAMES = Object.freeze([
  'socketRateLimited',
  'wordAccepted',
  'wordRateLimited',
  'wordFailed',
  'wordRemoved',
  'wordRemoveRateLimited',
  'wordRemoveNotFound',
  'wordRemoveFailed',
  'httpRateLimited',
  'quoteSucceeded',
  'quoteFailed',
  'checkoutSucceeded',
  'checkoutFailed',
  'webhookFailed',
]);
const operationCounts = Object.fromEntries(OPERATION_NAMES.map((name) => [name, 0]));
const EXTERNAL_PROVIDERS = Object.freeze(['printful', 'stripe', 'resend']);
const externalCalls = Object.fromEntries(EXTERNAL_PROVIDERS.map((provider) => [provider, {
  count: 0, failures: 0, totalDurationMs: 0, maxDurationMs: 0,
}]));
let latest = {
  sampledAt: null,
  cpuPercent: 0,
  rssBytes: 0,
  heapUsedBytes: 0,
  eventLoopDelayMs: { p50: 0, p95: 0, p99: 0, max: 0 },
};

function finiteMilliseconds(nanoseconds) {
  const value = Number(nanoseconds) / 1e6;
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function sample() {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  let cpuPercent = 0;
  if (previousCpu && previousSampleAt !== null) {
    const usedMicros = cpu.user - previousCpu.user + cpu.system - previousCpu.system;
    const elapsedMicros = Math.max(1, (now - previousSampleAt) * 1_000);
    cpuPercent = Number((usedMicros / elapsedMicros * 100).toFixed(2));
  }
  latest = {
    sampledAt: new Date().toISOString(),
    cpuPercent,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopDelayMs: histogram ? {
      p50: finiteMilliseconds(histogram.percentile(50)),
      p95: finiteMilliseconds(histogram.percentile(95)),
      p99: finiteMilliseconds(histogram.percentile(99)),
      max: finiteMilliseconds(histogram.max),
    } : { p50: 0, p95: 0, p99: 0, max: 0 },
  };
  histogram?.reset();
  previousCpu = cpu;
  previousSampleAt = now;
}

function start() {
  if (timer) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  previousCpu = process.cpuUsage();
  previousSampleAt = performance.now();
  timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  sample();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
  previousCpu = null;
  previousSampleAt = null;
}

function recordSocketConnected(eventId) {
  activeSockets += 1;
  peakSockets = Math.max(peakSockets, activeSockets);
  const key = String(eventId || '');
  if (key) activeSocketRooms.set(key, (activeSocketRooms.get(key) || 0) + 1);
}

function recordSocketDisconnected(eventId) {
  activeSockets = Math.max(0, activeSockets - 1);
  const key = String(eventId || '');
  const remaining = (activeSocketRooms.get(key) || 0) - 1;
  if (remaining > 0) activeSocketRooms.set(key, remaining);
  else activeSocketRooms.delete(key);
}

function recordOperation(name) {
  if (!Object.hasOwn(operationCounts, name)) return false;
  operationCounts[name] += 1;
  return true;
}

function recordExternalCall(provider, { durationMs, succeeded }) {
  if (!Object.hasOwn(externalCalls, provider)) return false;
  const duration = Math.max(0, Number(durationMs) || 0);
  const metric = externalCalls[provider];
  metric.count += 1;
  if (!succeeded) metric.failures += 1;
  metric.totalDurationMs += duration;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
  return true;
}

function recordWordSnapshot({ serializedBytes, recipients }) {
  const bytes = Math.max(0, Number(serializedBytes) || 0);
  const audience = Math.max(0, Number(recipients) || 0);
  wordSnapshots += 1;
  wordSnapshotBytes += bytes;
  estimatedRecipientBytes += bytes * audience;
}

function snapshot(pool) {
  return {
    sampledAt: latest.sampledAt,
    process: {
      cpuPercent: latest.cpuPercent,
      rssBytes: latest.rssBytes,
      heapUsedBytes: latest.heapUsedBytes,
    },
    eventLoopDelayMs: latest.eventLoopDelayMs,
    postgresPool: {
      total: Number(pool?.totalCount || 0),
      idle: Number(pool?.idleCount || 0),
      waiting: Number(pool?.waitingCount || 0),
    },
    socket: { active: activeSockets, peak: peakSockets, activeRooms: activeSocketRooms.size },
    operations: { ...operationCounts },
    externalApi: Object.fromEntries(EXTERNAL_PROVIDERS.map((provider) => {
      const metric = externalCalls[provider];
      return [provider, {
        calls: metric.count,
        failures: metric.failures,
        averageDurationMs: metric.count
          ? Number((metric.totalDurationMs / metric.count).toFixed(2)) : 0,
        maxDurationMs: Number(metric.maxDurationMs.toFixed(2)),
      }];
    })),
    wordBroadcasts: {
      snapshots: wordSnapshots,
      serializedBytes: wordSnapshotBytes,
      estimatedRecipientBytes,
    },
  };
}

function resetForTests() {
  activeSockets = 0;
  peakSockets = 0;
  activeSocketRooms.clear();
  wordSnapshots = 0;
  wordSnapshotBytes = 0;
  estimatedRecipientBytes = 0;
  for (const name of OPERATION_NAMES) operationCounts[name] = 0;
  for (const provider of EXTERNAL_PROVIDERS) {
    externalCalls[provider] = { count: 0, failures: 0, totalDurationMs: 0, maxDurationMs: 0 };
  }
}

module.exports = {
  recordSocketConnected,
  recordSocketDisconnected,
  recordOperation,
  recordExternalCall,
  recordWordSnapshot,
  resetForTests,
  snapshot,
  start,
  stop,
};
