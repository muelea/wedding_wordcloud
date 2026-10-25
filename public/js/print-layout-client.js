(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrintLayoutClient = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const copy = value => JSON.parse(JSON.stringify(value));
  const cancelled = () => Object.assign(new Error('layout_cancelled'), { name: 'AbortError' });
  const parallelism = threads => Math.min(4, Math.max(1, Math.floor((Number(threads) || 2) / 2)));

  // The existing live-cloud worker accepts only measured rectangles. Fonts,
  // glyph bounds and final print decisions remain in the page's layout engine.
  function create({ core, layout, workerUrl, coreUrl, version = '',
    WorkerClass = globalThis.Worker, timeoutMs = 10000, workerCount = 1,
    yieldControl }) {
    // Posted tasks yield without the nested-timer delay browsers apply after
    // several setTimeout turns. Keep a timer fallback for non-browser callers.
    const turns = [];
    const channel = !yieldControl && typeof window === 'object' && typeof MessageChannel === 'function'
      ? new MessageChannel() : null;
    if (channel) channel.port1.onmessage = () => turns.shift()?.();
    yieldControl ||= channel ? () => new Promise(resolve => {
      turns.push(resolve); channel.port2.postMessage(null);
    }) : () => new Promise(resolve => setTimeout(resolve, 0));
    let sequence = 0;
    const slots = Array.from({ length: Math.max(1, Math.min(4, Math.floor(workerCount) || 1)) },
      () => ({ worker: null, active: null, timer: null }));
    let disposed = false, workerUnavailable = false;
    const pending = [];
    const completed = new Map(), preparing = new Map();
    let cacheBytes = 0;

    function releaseWorker(slot) {
      slot.worker?.terminate();
      slot.worker = null;
    }

    function settle(job, error, placed) {
      const slot = job.slot;
      if (slot.active !== job) return;
      clearTimeout(slot.timer);
      slot.active = null;
      job.signal?.removeEventListener('abort', job.abort);
      if (error) job.reject(error);
      else job.resolve(placed);
      drain();
    }

    async function fallback(job) {
      const slot = job.slot;
      if (slot.active !== job || job.fallback) return;
      job.fallback = true;
      clearTimeout(slot.timer);
      workerUnavailable = true;
      releaseWorker(slot);
      // Unsupported/blocked workers retain exactly the same complete packing.
      try {
        await yieldControl();
        if (slot.active !== job || disposed) return;
        settle(job, null, core.layoutBoxesInArea(job.boxes, job.width, job.height));
      }
      catch (error) { settle(job, error); }
    }

    function ensureWorker(slot) {
      if (slot.worker || workerUnavailable) return;
      try {
        const candidate = new WorkerClass(workerUrl);
        slot.worker = candidate;
        candidate.onmessage = ({ data }) => {
          const active = slot.active;
          if (slot.worker !== candidate || !active || data.id !== active.id) return;
          if (data.error || !Array.isArray(data.placed) || data.placed.length !== active.boxes.length) {
            void fallback(active);
          } else settle(active, null, data.placed);
        };
        candidate.onerror = candidate.onmessageerror = () => {
          if (slot.worker === candidate && slot.active) void fallback(slot.active);
        };
      } catch { workerUnavailable = true; }
    }

    function drain() {
      if (disposed || !pending.length) return;
      for (const slot of slots) {
        if (slot.active || !pending.length) continue;
        pending.sort((a, b) => b.priority - a.priority || a.id - b.id);
        const job = slot.active = pending.shift();
        job.slot = slot;
        if (job.signal?.aborted) { settle(job, cancelled()); continue; }
        ensureWorker(slot);
        if (!slot.worker) { void fallback(job); continue; }
        slot.timer = setTimeout(() => { void fallback(job); }, timeoutMs);
        try { slot.worker.postMessage({ id: job.id, boxes: job.boxes, width: job.width, height: job.height, coreUrl }); }
        catch { void fallback(job); }
      }
    }

    function pack(boxes, width, height, { signal, priority = 0 } = {}) {
      if (disposed || signal?.aborted) return Promise.reject(cancelled());
      if (pending.length >= 16) return Promise.reject(new Error('layout_queue_full'));
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, boxes, width, height, signal, priority, resolve, reject };
        job.abort = () => {
          if (job.slot?.active === job) {
            releaseWorker(job.slot);
            settle(job, cancelled());
          } else {
            const index = pending.indexOf(job);
            if (index >= 0) pending.splice(index, 1);
            signal?.removeEventListener('abort', job.abort);
            reject(cancelled());
          }
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        pending.push(job);
        drain();
      });
    }
    pack.concurrency = slots.length;

    async function automatic(design, slots, measureContext, options = {}) {
      if (disposed || options.signal?.aborted) throw cancelled();
      // Geometry is independent of palette. Include exact origins and sizes:
      // equal aspect ratios alone do not preserve rounded print geometry.
      const source = copy(design);
      const key = JSON.stringify([version, options.printDpi || null, slots, source.map(item => {
        const { color, ...geometry } = item;
        return [geometry, typeof options.fontFamily === 'function'
          ? options.fontFamily(item) : options.fontFamily];
      })]);
      let result = completed.get(key)?.design;
      if (result) {
        const entry = completed.get(key);
        completed.delete(key); completed.set(key, entry);
      } else {
        let promise = preparing.get(key);
        if (!promise) {
          if (preparing.size >= 16) throw new Error('layout_queue_full');
          promise = layout.optimizeDesignAsync(source, slots, measureContext,
            { ...options, pack, yieldControl }).then(optimized => {
            if (!disposed) {
              const bytes = (key.length + JSON.stringify(optimized).length) * 2;
              if (bytes <= 2 * 1024 * 1024) {
                while (completed.size && (completed.size >= 24 || cacheBytes + bytes > 2 * 1024 * 1024)) {
                  const oldest = completed.keys().next().value;
                  cacheBytes -= completed.get(oldest).bytes;
                  completed.delete(oldest);
                }
                completed.set(key, { design: copy(optimized), bytes });
                cacheBytes += bytes;
              }
            }
            return optimized;
          }).finally(() => preparing.delete(key));
          preparing.set(key, promise);
        }
        result = await promise;
      }
      if (disposed || options.signal?.aborted) throw cancelled();
      return result.map((item, index) => ({ ...item, color: source[index].color }));
    }

    return {
      pack, automatic,
      dispose() {
        if (disposed) return;
        disposed = true;
        const jobs = [...pending];
        for (const slot of slots) {
          clearTimeout(slot.timer); releaseWorker(slot);
          if (slot.active) jobs.push(slot.active);
          slot.active = null;
        }
        pending.length = 0;
        for (const job of jobs) {
          job.signal?.removeEventListener('abort', job.abort);
          job.reject(cancelled());
        }
        completed.clear(); cacheBytes = 0;
        channel?.port1.close(); channel?.port2.close();
        while (turns.length) turns.shift()();
      },
    };
  }

  // Catalog jobs have dynamic viewport priority. The queue is bounded by the
  // catalog, and its idle promise also covers work added while a job is running.
  function createQueue({ limit, priority = () => 0, concurrency = 1, warmup = false,
    yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) }) {
    const jobs = new Map();
    const capacity = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
    const activeJobs = new Set();
    let running = false, paused = false, disposed = false, sequence = 0, warmed = !warmup;
    let idle = Promise.resolve(), resolveIdle = null;
    function finishIdle() {
      if (!running && !jobs.size && !activeJobs.size && resolveIdle) {
        resolveIdle(); resolveIdle = null;
      }
    }
    async function drain() {
      if (running || paused || disposed || !jobs.size || activeJobs.size >= (warmed ? capacity : 1)) {
        finishIdle(); return;
      }
      running = true;
      try {
        await yieldControl();
        if (paused || disposed) return;
        while (jobs.size && activeJobs.size < (warmed ? capacity : 1)) {
          const job = [...jobs.values()].sort((a, b) =>
            (b.priority + priority(b.key)) - (a.priority + priority(a.key)) || a.order - b.order)[0];
          jobs.delete(job.key); activeJobs.add(job);
          void (async () => {
            try { job.resolve(await job.run()); } catch (error) { job.reject(error); }
            finally {
              activeJobs.delete(job); warmed = true;
              finishIdle(); void drain();
            }
          })();
        }
      } finally {
        running = false;
        finishIdle();
        if (jobs.size && !activeJobs.size && !paused && !disposed) void drain();
      }
    }
    return {
      idle: () => idle,
      add(key, run, jobPriority = 0) {
        if (disposed) return Promise.reject(cancelled());
        if (jobs.has(key)) return jobs.get(key).promise;
        if (jobs.size >= limit) return Promise.reject(new Error('layout_queue_full'));
        if (!resolveIdle) idle = new Promise(resolve => { resolveIdle = resolve; });
        const job = { key, run, priority: jobPriority, order: ++sequence };
        const promise = job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
        jobs.set(key, job);
        void drain();
        return promise;
      },
      promote(key) { const job = jobs.get(key); if (job) job.priority = 100; },
      cancel(key) {
        const job = jobs.get(key);
        if (!job) return false;
        jobs.delete(key); job.reject(cancelled()); finishIdle(); return true;
      },
      pause() { paused = true; },
      resume() { paused = false; void drain(); },
      dispose() {
        disposed = true;
        for (const job of activeJobs) job.reject(cancelled());
        for (const job of jobs.values()) job.reject(cancelled());
        jobs.clear();
        resolveIdle?.(); resolveIdle = null;
      },
    };
  }

  return { create, createQueue, parallelism };
});
