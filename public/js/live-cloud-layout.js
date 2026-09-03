(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveCloudLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create({ core, workerUrl, coreUrl, onLayout, onError,
    WorkerClass = globalThis.Worker, timeoutMs = 10000 }) {
    let worker;
    let active = null;
    let pending = null;
    let sequence = 0;
    let generation = 0;
    let timer;
    let disposed = false;

    function finish(job, placed) {
      if (active !== job || disposed) return;
      clearTimeout(timer);
      active = null;
      if (job.generation === generation) {
        if (placed?.length === job.boxes.length) onLayout(core.finalizeWords(placed), job);
        else onError?.();
      }
      if (pending) {
        const next = pending;
        pending = null;
        start(next);
      }
    }

    function fallback() {
      worker?.terminate();
      worker = null;
      const job = active;
      clearTimeout(timer);
      if (!job) return;
      // A worker may be unavailable/blocked. Use exactly the same complete
      // layout, never an empty cloud or a different font/geometry algorithm.
      timer = setTimeout(() => {
        if (active !== job || disposed) return;
        try { finish(job, core.layoutBoxesInArea(job.boxes, job.width, job.height)); }
        catch { finish(job, null); }
      }, 0);
    }

    try {
      worker = new WorkerClass(workerUrl);
      worker.onmessage = ({ data }) => {
        if (!active || data.id !== active.id) return;
        if (data.error) fallback();
        else finish(active, data.placed);
      };
      worker.onerror = fallback;
      worker.onmessageerror = fallback;
    } catch { worker = null; }

    function start(job) {
      active = job;
      if (!worker) { fallback(); return; }
      timer = setTimeout(fallback, timeoutMs);
      try { worker.postMessage({ ...job, coreUrl }); }
      catch { fallback(); }
    }

    return {
      request(boxes, width, height) {
        if (disposed) return;
        const job = { id: ++sequence, generation, boxes, width, height };
        // One running job and one latest snapshot: no unbounded worker queue,
        // no starvation while guests keep submitting new words.
        if (active) pending = job;
        else start(job);
      },
      clear() {
        generation++;
        pending = null;
      },
      dispose() {
        disposed = true;
        pending = active = null;
        clearTimeout(timer);
        worker?.terminate();
      },
    };
  }
  return { create };
});
