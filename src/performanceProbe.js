'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const SAMPLE_INTERVAL_MS = 1_000;

let histogram = null;
let timer = null;
let previousCpu = null;
let previousSampleAt = null;
let activeSockets = 0;
let peakSockets = 0;
let wordSnapshots = 0;
let wordSnapshotBytes = 0;
let estimatedRecipientBytes = 0;
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

function recordSocketConnected() {
  activeSockets += 1;
  peakSockets = Math.max(peakSockets, activeSockets);
}

function recordSocketDisconnected() {
  activeSockets = Math.max(0, activeSockets - 1);
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
    socket: { active: activeSockets, peak: peakSockets },
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
  wordSnapshots = 0;
  wordSnapshotBytes = 0;
  estimatedRecipientBytes = 0;
}

module.exports = {
  recordSocketConnected,
  recordSocketDisconnected,
  recordWordSnapshot,
  resetForTests,
  snapshot,
  start,
  stop,
};
