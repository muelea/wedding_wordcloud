'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('canvas');
require('../src/designFonts');
const Core = require('../public/js/wordcloud-core');
const Live = require('../public/js/live-cloud-layout');
const Quality = require('../public/js/text-print-quality');
const { GAP_WORDS, FIVE_WORDS } = require('./support/area-layout-cases');
const { largestEmptyFraction, occupiedFraction, envelope } = require('./support/layout-space');

function safe(placed, words, width, height) {
  assert.deepEqual(placed.map(item => item.word).sort(), words.map(([word]) => word).sort());
  for (const [index, item] of placed.entries()) {
    assert.ok(item.x1 >= 0 && item.x2 <= width && item.y1 >= 0 && item.y2 <= height);
    for (const other of placed.slice(0, index)) {
      assert.ok(item.x2 <= other.x1 || item.x1 >= other.x2 || item.y2 <= other.y1 || item.y1 >= other.y2);
    }
  }
}

test('the reported live clouds avoid internal holes at desktop, phone and print proportions', () => {
  const context = createCanvas(1, 1).getContext('2d');
  for (const [width, height] of [[1460, 984], [390, 620], [2628, 978], [1200, 1200]]) {
    for (const words of [GAP_WORDS, FIVE_WORDS]) {
      const label = `${words.length} words at ${width}x${height}`;
      const placed = Core.layoutWordsInArea(words, width, height, context);
      safe(placed, words, width, height);
      const used = envelope(placed);
      const sparse = words === FIVE_WORDS;
      const area = sparse ? used : { x1: 0, y1: 0, x2: width, y2: height };
      assert.ok(largestEmptyFraction(placed, area) < (sparse ? .14 : .035),
        label + ': bounded internal whitespace');
      assert.ok(occupiedFraction(placed, {
        x1: width * .25, y1: height * .25, x2: width * .75, y2: height * .75,
      }) > (sparse ? .7 : .5), label + ': words occupy the centre');
      if (sparse) {
        assert.ok(occupiedFraction(placed, used) > .65, label + ': a compact composition');
        assert.ok(Math.abs(used.x1 + used.x2 - width) < .01 &&
          Math.abs(used.y1 + used.y2 - height) < .01, label + ': balanced outer margins');
      }
      assert.deepEqual(Core.layoutWordsInArea(words, width, height, context), placed,
        label + ': deterministic');
    }
  }
});

test('dense rectangular live clouds keep every word at portrait, phone and projector sizes', () => {
  const context = createCanvas(1, 1).getContext('2d');
  for (const n of [200, 500]) {
    const words = Array.from({ length: n }, (_, index) => [
      ['wort', 'zusammengehörigkeit', 'liebe ❤️', 'WWW', 'glück'][index % 5] + index,
      1 + index * 7 % 20,
    ]);
    for (const [width, height] of [[350, 500], [700, 1200], [1600, 700], [3200, 1000]]) {
      const placed = Core.layoutWordsInArea(words, width, height, context);
      safe(placed, words, width, height);
      assert.ok(Core.cornerCoverage(placed, width, height) > .25, 'the corners participate in packing');
    }
  }
});

test('print guidance measures physical text size and excludes images, icons and standalone emoji', () => {
  const design = [{ text: 'gut', fontSize: 100 / 3 }, { text: 'klein', fontSize: 30 },
    { text: 'sehr klein', fontSize: 20 }, { text: '❤️', fontSize: 1 },
    { type: 'icon', size: 48 }, { type: 'image', width: 24, height: 24 }];
  assert.deepEqual(Quality.evaluate(design, 300), { minPt: 4.8, small: 2, tiny: 1, level: 'low' });
  assert.equal(Quality.evaluate(design, 150).level, 'good', 'DPI changes physical size, not element count');
  assert.equal(Quality.evaluate([{ text: 'Liebe ❤️', fontSize: 20 }], 300).tiny, 1);
  assert.equal(Quality.evaluate([{ text: '❤️', fontSize: 1 }], 300), null);
  assert.equal(Quality.evaluate(design, 0), null);
});

test('live worker keeps only the newest pending snapshot, fences resets and releases resources', () => {
  let worker;
  const jobs = [];
  const drawn = [];
  class Worker {
    constructor() { worker = this; }
    postMessage(job) { jobs.push(job); }
    terminate() { this.terminated = true; }
    finish(job) { this.onmessage({ data: { id: job.id, placed: job.boxes } }); }
  }
  const layout = Live.create({ core: { finalizeWords: items => items }, WorkerClass: Worker,
    workerUrl: '/worker.js', coreUrl: '/core.js', onLayout: items => drawn.push(items[0]) });
  try {
    layout.request(['one'], 100, 100);
    layout.request(['two'], 200, 100);
    layout.request(['three'], 300, 100);
    assert.equal(jobs.length, 1);
    worker.finish(jobs[0]);
    assert.deepEqual(drawn, ['one']);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs[1].boxes, ['three']);
    layout.clear();
    layout.request(['after-reset'], 100, 200);
    worker.finish(jobs[1]);
    assert.deepEqual(drawn, ['one'], 'reset prevents an old layout from returning');
    worker.finish(jobs[2]);
    assert.deepEqual(drawn, ['one', 'after-reset']);
  } finally { layout.dispose(); }
  assert.equal(worker.terminated, true);
  layout.request(['disposed'], 100, 100);
  assert.equal(jobs.length, 3);
});

test('a failed/unavailable worker falls back to the same complete layout', async () => {
  for (const failure of ['construction', 'message', 'timeout']) {
    const result = await new Promise((resolve, reject) => {
      class Worker {
        constructor() { if (failure === 'construction') throw new Error('blocked'); }
        postMessage(job) {
          if (failure === 'message') queueMicrotask(() => this.onmessage({ data: { id: job.id, error: true } }));
        }
        terminate() {}
      }
      const layout = Live.create({
        core: { layoutBoxesInArea: boxes => boxes, finalizeWords: boxes => boxes },
        WorkerClass: Worker, workerUrl: '/worker.js', coreUrl: '/core.js', timeoutMs: 5,
        onLayout: boxes => { layout.dispose(); resolve(boxes); }, onError: reject,
      });
      layout.request(['all', 'words'], 100, 100);
    });
    assert.deepEqual(result, ['all', 'words'], failure);
  }
});
