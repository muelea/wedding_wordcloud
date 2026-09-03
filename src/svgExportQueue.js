'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_PENDING_EXPORTS = 5;
const EXPORT_TIMEOUT_MS = 10_000;

function exportError(code) {
  return Object.assign(new Error(code), { code });
}

// One lazy worker and a small, time-bounded queue share the existing renderer.
// No export may block the HTTP/Socket.io event loop or leave an unlimited backlog.
function createSvgExportQueue({
  maxPending = MAX_PENDING_EXPORTS,
  timeoutMs = EXPORT_TIMEOUT_MS,
  createWorker = () => new Worker(path.join(__dirname, 'svgExportWorker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  }),
} = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 1 ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('invalid export queue bounds');
  const queue = [];
  let worker = null;
  let active = null;
  let terminating = false;
  let stopped = false;
  let stopPromise = null;
  let nextId = 0;

  function settle(job, error, svg) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(svg);
  }

  function terminateWorker() {
    if (!worker) return Promise.resolve();
    terminating = true;
    return worker.terminate();
  }

  function pump() {
    if (stopped || terminating || active) return;
    if (!queue.length) {
      worker?.unref();
      return;
    }
    active = queue.shift();
    try {
      if (!worker) {
        const current = createWorker();
        worker = current;
        current.on('message', (message) => {
          if (worker !== current || !active || active.id !== message.id) return;
          const job = active;
          active = null;
          if (typeof message.svg === 'string') settle(job, null, message.svg);
          else settle(job, exportError('export_failed'));
          pump();
        });
        current.on('error', () => {
          if (worker !== current) return;
          terminating = true;
          if (active) settle(active, exportError('export_failed'));
          active = null;
          // Worker errors are followed by exit. Start a replacement only then.
        });
        current.on('exit', () => {
          if (worker !== current) return;
          worker = null;
          terminating = false;
          if (active) settle(active, exportError('export_failed'));
          active = null;
          pump();
        });
      }
      worker.ref();
      worker.postMessage({ id: active.id, words: active.words, theme: active.theme });
    } catch {
      settle(active, exportError('export_failed'));
      active = null;
      if (worker) terminateWorker().catch(() => {});
      else pump();
    }
  }

  function cancel(job, code) {
    if (active === job) {
      active = null;
      settle(job, exportError(code));
      terminateWorker().catch(() => {});
    } else {
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
      settle(job, exportError(code));
    }
  }

  function render(words, theme, { signal } = {}) {
    if (stopped) return Promise.reject(exportError('export_stopped'));
    if (signal?.aborted) return Promise.reject(exportError('export_aborted'));
    if (queue.length + Number(Boolean(active)) >= maxPending) {
      return Promise.reject(exportError('export_busy'));
    }
    return new Promise((resolve, reject) => {
      const job = { id: ++nextId, words, theme, signal, resolve, reject };
      job.abort = () => cancel(job, 'export_aborted');
      job.timer = setTimeout(() => cancel(job, 'export_timeout'), timeoutMs);
      job.timer.unref();
      signal?.addEventListener('abort', job.abort, { once: true });
      queue.push(job);
      pump();
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    for (const job of queue.splice(0)) settle(job, exportError('export_stopped'));
    if (active) settle(active, exportError('export_stopped'));
    active = null;
    stopPromise = terminateWorker();
    return stopPromise;
  }

  return { render, stop, get pendingCount() { return queue.length + Number(Boolean(active)); } };
}

module.exports = { createSvgExportQueue, MAX_PENDING_EXPORTS, EXPORT_TIMEOUT_MS };
