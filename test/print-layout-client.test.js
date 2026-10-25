'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../public/js/print-layout-client');
const tick = () => new Promise(resolve => setImmediate(resolve));
const boxes = [{ width: 100, height: 30, priority: 1, emoji: false }];
const placed = [{ ...boxes[0], x: 150, y: 50, scale: 1 }];

test('parallelism reserves processor capacity and stays bounded on small or unknown devices', () => {
  for (const [threads, expected] of [[undefined, 1], [2, 1], [4, 2], [6, 3], [8, 4], [64, 4], [0, 1]]) {
    assert.equal(Client.parallelism(threads), expected);
  }
});

function harness(t, extra = {}) {
  const workers = [], calls = [];
  class Worker {
    constructor(url) { this.url = url; this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    complete(result = placed, id = this.messages.at(-1).id) { this.onmessage({ data: { id, placed: result } }); }
  }
  const client = Client.create({ core: { layoutBoxesInArea: (...args) => { calls.push(args); return placed; } },
    workerUrl: '/js/cloud-layout-worker.js?v=worker', coreUrl: '/js/wordcloud-core.js?v=core',
    WorkerClass: Worker, ...extra });
  t.after(() => client.dispose());
  return { client, workers, calls };
}

test('print packing sends measured boxes through one worker and prioritizes explicit work', async t => {
  const h = harness(t);
  const first = h.client.pack(boxes, 300, 100);
  const background = h.client.pack(boxes, 301, 100);
  const explicit = h.client.pack(boxes, 302, 100, { priority: 100 });
  assert.equal(h.workers.length, 1);
  const worker = h.workers[0];
  assert.equal(worker.messages.length, 1);
  assert.deepEqual(worker.messages[0], { id: 1, boxes, width: 300, height: 100, coreUrl: '/js/wordcloud-core.js?v=core' });
  worker.complete(); assert.deepEqual(await first, placed);
  assert.equal(worker.messages[1].width, 302);
  worker.complete(); await explicit;
  assert.equal(worker.messages[2].width, 301);
  worker.complete(); await background;
  assert.equal(h.calls.length, 0);
});

test('cancellation terminates active work and a stale worker cannot complete its replacement', async t => {
  const h = harness(t), controller = new AbortController();
  const first = h.client.pack(boxes, 300, 100, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = h.client.pack(boxes, 301, 100);
  const old = h.workers[0];
  controller.abort(); await rejected;
  assert.equal(old.terminated, true);
  assert.equal(h.workers.length, 2);
  let finished = false; second.then(() => { finished = true; });
  old.complete(); await tick(); assert.equal(finished, false);
  h.workers[1].complete(); await second;
});

test('queued cancellation removes only that job and disposal rejects every waiter', async t => {
  const h = harness(t), controller = new AbortController();
  const first = h.client.pack(boxes, 300, 100);
  const second = h.client.pack(boxes, 301, 100, { signal: controller.signal });
  const third = h.client.pack(boxes, 302, 100);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  controller.abort(); await rejected;
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const thirdRejected = assert.rejects(third, { name: 'AbortError' });
  h.client.dispose(); await Promise.all([firstRejected, thirdRejected]);
  assert.equal(h.workers[0].terminated, true);
  await assert.rejects(h.client.pack(boxes, 303, 100), { name: 'AbortError' });
});

test('aborting a shared gallery signal does not start its already-cancelled queued work', async t => {
  const h = harness(t), controller = new AbortController();
  const jobs = Array.from({ length: 4 }, () => h.client.pack(boxes, 300, 100, { signal: controller.signal }));
  const settled = Promise.allSettled(jobs);
  controller.abort();
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].terminated, true);
});

for (const failure of ['unavailable', 'error', 'timeout', 'incomplete']) {
  test(`${failure} worker yields and falls back to the same complete packing`, async t => {
    let pauses = 0;
    const h = harness(t, { timeoutMs: 5, ...(failure === 'unavailable' ? { WorkerClass: null } : {}),
      yieldControl: async () => { pauses++; } });
    const result = h.client.pack(boxes, 300, 100);
    if (failure === 'error') h.workers[0].onerror();
    if (failure === 'incomplete') h.workers[0].complete([]);
    assert.deepEqual(await result, placed);
    assert.equal(pauses, 1);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(await h.client.pack(boxes, 301, 100), placed);
    assert.equal(h.workers.length, failure === 'unavailable' ? 0 : 1);
  });
}

test('worker queue overload is bounded and every accepted job is settled on dispose', async t => {
  const h = harness(t), jobs = [];
  for (let index = 0; index < 17; index++) jobs.push(h.client.pack(boxes, 300, 100));
  await assert.rejects(h.client.pack(boxes, 300, 100), /layout_queue_full/);
  const results = Promise.allSettled(jobs);
  h.client.dispose();
  assert.ok((await results).every(result => result.status === 'rejected'));
});

test('a bounded worker pool runs independent packings concurrently and fences cancelled responses', async t => {
  const h = harness(t, { workerCount: 2 });
  const controller = new AbortController();
  const first = h.client.pack(boxes, 300, 100, { signal: controller.signal });
  const second = h.client.pack(boxes, 301, 100);
  const third = h.client.pack(boxes, 302, 100);
  const explicit = h.client.pack(boxes, 303, 100, { priority: 100 });
  assert.equal(h.workers.length, 2);
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  controller.abort(); await cancelled;
  assert.equal(h.workers.length, 3);
  assert.equal(h.workers[2].messages[0].width, 303);
  h.workers[0].complete();
  h.workers[1].complete(); await second;
  assert.equal(h.workers[1].messages.at(-1).width, 302);
  h.workers[2].complete(); await explicit;
  h.workers[1].complete(); await third;
  assert.equal(h.calls.length, 0);
});

test('one failed pool worker cannot settle another worker’s job and keeps exact fallback', async t => {
  const h = harness(t, { workerCount: 2, yieldControl: async () => {} });
  const first = h.client.pack(boxes, 300, 100);
  const second = h.client.pack(boxes, 301, 100);
  const third = h.client.pack(boxes, 302, 100);
  const failed = h.workers[0];
  failed.onerror(); await first; await third;
  assert.equal(failed.terminated, true);
  assert.deepEqual(h.calls.map(call => call[1]), [300, 302]);
  let finished = false; second.then(() => { finished = true; });
  failed.complete(); await tick(); assert.equal(finished, false);
  h.workers[1].complete(); await second;
  assert.equal(h.workers.length, 2);
});

const source = [{ id: 'word', text: 'Liebe', x: 500, y: 500, fontSize: 100,
  color: '#123456', fontFamily: 'classic' }];
const slots = [{ x: 10, y: 20, width: 1000, height: 900, optimize: true }];

test('automatic cache shares matching sides and palettes while returning independent exact copies', async t => {
  let calculations = 0, finish;
  const h = harness(t, { version: 'engine-1', layout: { optimizeDesignAsync: input => {
    calculations++;
    return new Promise(resolve => { finish = () => resolve(input.map(item => ({ ...item, x: 123.4 }))); });
  } } });
  const front = h.client.automatic(source, slots, null, { fontFamily: 'bundled' });
  const back = h.client.automatic(source, slots, null, { fontFamily: 'bundled' });
  assert.equal(calculations, 1);
  finish(); const [a, b] = await Promise.all([front, back]);
  assert.deepEqual(a, b); assert.notEqual(a, b); assert.notEqual(a[0], b[0]);
  a[0].text = 'edited';
  const recolored = await h.client.automatic([{ ...source[0], color: '#fedcba' }], slots, null, { fontFamily: 'bundled' });
  assert.equal(recolored[0].x, 123.4); assert.equal(recolored[0].text, 'Liebe');
  assert.equal(recolored[0].color, '#fedcba'); assert.equal(calculations, 1);
});

test('cache invalidates exact geometry, contents, sizes and resolved fonts, and remains page-local', async t => {
  let calculations = 0;
  const layout = { optimizeDesignAsync: async input => { calculations++; return input; } };
  const h = harness(t, { layout });
  const fill = (design = source, area = slots, fontFamily = 'bundled') =>
    h.client.automatic(design, area, null, { fontFamily });
  await fill(); await fill();
  await fill([{ ...source[0], text: 'Glück' }]);
  await fill([{ ...source[0], fontSize: 110 }]);
  await fill(source, [{ ...slots[0], x: 11 }]);
  await fill(source, [{ ...slots[0], width: 2000, height: 1800 }]);
  await fill(source, slots, 'another font');
  await h.client.automatic(source, slots, null, { fontFamily: 'bundled', printDpi: 150 });
  await h.client.automatic(source, slots, null, { fontFamily: 'bundled', printDpi: 300 });
  assert.equal(calculations, 8, 'physical size constraints cannot share an unconstrained or different-DPI cache entry');
  const anotherPage = harness(t, { layout });
  await anotherPage.client.automatic(source, slots, null, { fontFamily: 'bundled' });
  assert.equal(calculations, 9);
});

test('failed automatic work is retryable and the completed cache evicts older entries', async t => {
  let calculations = 0, fail = true;
  const h = harness(t, { layout: { optimizeDesignAsync: async input => {
    calculations++; if (fail) throw new Error('font failed'); return input;
  } } });
  await assert.rejects(h.client.automatic(source, slots, null), /font failed/);
  fail = false; await h.client.automatic(source, slots, null);
  for (let index = 1; index <= 25; index++) await h.client.automatic([{ ...source[0], text: `word-${index}` }], slots, null);
  await h.client.automatic(source, slots, null);
  assert.equal(calculations, 28);
});

test('catalog queue responds to viewport priority, explicit choices, cancellation and suspension', async () => {
  const calls = [], visible = new Set();
  let finish;
  const queue = Client.createQueue({ limit: 4, priority: key => visible.has(key) ? 50 : 0,
    yieldControl: async () => {} });
  const a = queue.add('a', () => new Promise(resolve => { calls.push('a'); finish = resolve; }));
  await tick();
  const b = queue.add('b', async () => { calls.push('b'); });
  const c = queue.add('c', async () => { calls.push('c'); });
  const d = queue.add('d', async () => { calls.push('d'); });
  visible.add('c'); queue.promote('d');
  queue.pause(); finish(); await a; await tick(); assert.deepEqual(calls, ['a']);
  queue.resume(); await queue.idle(); await Promise.all([b, c, d]);
  assert.deepEqual(calls, ['a', 'd', 'c', 'b']);
  queue.pause();
  const obsolete = queue.add('old', async () => assert.fail('obsolete work must not run'));
  const rejected = assert.rejects(obsolete, { name: 'AbortError' });
  assert.equal(queue.cancel('old'), true); await rejected; await queue.idle();
  const pending = queue.add('left', async () => assert.fail('disposed work must not run'));
  const disposed = assert.rejects(pending, { name: 'AbortError' });
  queue.dispose(); await disposed; await queue.idle();
});

test('catalog warms its first product alone, then bounds concurrency and waits for all active jobs', async () => {
  const started = [], finishes = new Map();
  const queue = Client.createQueue({ limit: 5, concurrency: 2, warmup: true, yieldControl: async () => {} });
  const jobs = ['a', 'b', 'c', 'd'].map(key => queue.add(key, () => new Promise(resolve => {
    started.push(key); finishes.set(key, resolve);
  })));
  await tick(); assert.deepEqual(started, ['a']);
  finishes.get('a')(); await jobs[0]; await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  let idle = false;
  queue.idle().then(() => { idle = true; });
  queue.pause(); finishes.get('b')(); await jobs[1]; await tick();
  assert.equal(idle, false); assert.equal(started.length, 3);
  queue.resume(); await tick(); assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  finishes.get('d')(); await jobs[3]; await tick(); assert.equal(idle, false);
  finishes.get('c')(); await Promise.all(jobs); await queue.idle();
  assert.equal(idle, true); queue.dispose();
});
