'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSvgExportQueue } = require('../src/svgExportQueue');
// The web process also uses node-canvas for product validation. Exercise the
// worker with the native renderer already loaded on the main thread.
require('../src/mugPrint');

class ControlledWorker extends EventEmitter {
  messages = [];
  terminations = 0;
  postMessage(message) { this.messages.push(message); }
  ref() {}
  unref() {}
  async terminate() {
    this.terminations += 1;
    await new Promise(setImmediate);
    this.emit('exit', 0);
  }
  complete(svg = '<svg/>') { this.emit('message', { id: this.messages.at(-1).id, svg }); }
}

test('a real 500-word export leaves the event loop responsive and preserves every word', async (t) => {
  const renderer = createSvgExportQueue();
  t.after(() => renderer.stop());
  const words = Array.from({ length: 500 }, (_, index) => [`freundschaft${index}`, 1 + index % 5]);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  t.after(() => clearInterval(timer));
  const svg = await renderer.render(words, 'pastel');
  assert.ok(ticks >= 3, 'timers must run while layout is computing, rather than after it finishes');
  assert.equal((svg.match(/<text /g) || []).length, words.length);
  for (const [word] of words) assert.ok(svg.includes(`>${word}</text>`), word);
});

test('export backlog is bounded and cancelling a queued request releases its slot', async (t) => {
  const worker = new ControlledWorker();
  const renderer = createSvgExportQueue({ maxPending: 2, createWorker: () => worker });
  t.after(() => renderer.stop());
  const first = renderer.render([['eins', 1]], 'pastel');
  const abort = new AbortController();
  const second = renderer.render([['zwei', 1]], 'pastel', { signal: abort.signal });
  const cancelled = assert.rejects(second, { code: 'export_aborted' });
  await assert.rejects(renderer.render([['drei', 1]], 'pastel'), { code: 'export_busy' });
  assert.equal(worker.messages.length, 1);
  abort.abort();
  await cancelled;
  assert.equal(renderer.pendingCount, 1);
  assert.equal(worker.terminations, 0, 'cancelling a queued request must not interrupt another export');
  worker.complete('first-svg');
  assert.equal(await first, 'first-svg');
});

test('a crashed or timed-out export worker is replaced without losing the next request', async (t) => {
  const workers = [];
  const renderer = createSvgExportQueue({ timeoutMs: 100, createWorker: () => {
    const worker = new ControlledWorker(); workers.push(worker); return worker;
  } });
  const keepAlive = setInterval(() => {}, 100);
  t.after(async () => { clearInterval(keepAlive); await renderer.stop(); });
  const failed = assert.rejects(renderer.render([], 'pastel'), { code: 'export_failed' });
  workers[0].emit('error', new Error('simulated worker failure'));
  const next = renderer.render([], 'pastel');
  workers[0].emit('exit', 1);
  workers[1].complete('recovered-svg');
  await failed;
  assert.equal(await next, 'recovered-svg');
  await assert.rejects(renderer.render([], 'pastel'), { code: 'export_timeout' });
  await new Promise(setImmediate);
  const last = renderer.render([], 'pastel');
  workers.at(-1).complete('after-timeout-svg');
  assert.equal(await last, 'after-timeout-svg');
});

test('export shutdown cancels active and queued work and terminates its worker', async () => {
  const worker = new ControlledWorker();
  const renderer = createSvgExportQueue({ createWorker: () => worker });
  const active = assert.rejects(renderer.render([], 'pastel'), { code: 'export_stopped' });
  const queued = assert.rejects(renderer.render([], 'pastel'), { code: 'export_stopped' });
  await renderer.stop();
  await Promise.all([active, queued]);
  await renderer.stop();
  assert.equal(worker.terminations, 1);
  assert.equal(renderer.pendingCount, 0);
  await assert.rejects(renderer.render([], 'pastel'), { code: 'export_stopped' });
});
