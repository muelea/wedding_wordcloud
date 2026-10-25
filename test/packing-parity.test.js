'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Core = require('../public/js/wordcloud-core');
const reference = require('./support/packing-reference.json');

test('accelerated packing retains the original decisions across count thresholds and aspect ratios', () => {
  let seed = reference.seed;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const expected of reference.cases) {
    const width = 100 + random() * 4000, height = 100 + random() * 4000;
    assert.equal(width, expected.width); assert.equal(height, expected.height);
    const boxes = Array.from({ length: expected.count }, () => ({
      width: 2 + random() * 1200, height: 2 + random() * 300,
      priority: 1 + Math.floor(random() * 8), emoji: random() < .25,
    }));
    const output = Core.layoutBoxesInArea(boxes, width, height);
    const serialized = JSON.stringify(output, (_, value) => typeof value === 'number'
      ? Math.round(value * 1e8) / 1e8 : value);
    assert.equal(createHash('sha256').update(serialized).digest('hex'), expected.hash,
      `${expected.count} boxes in ${width} × ${height}`);
  }
});

test('touching edges, tiny gutters and narrow search grids retain every box without overlap', () => {
  for (const [width, height] of [[64, 4096], [4096, 64], [96, 96], [1000.00000001, 999.99999999]]) {
    const boxes = Array.from({ length: 33 }, (_, index) => ({
      width: index % 2 ? 32 : 32.00000001, height: index % 3 ? 16 : 16.00000001,
      priority: 1, emoji: false,
    }));
    const result = Core.layoutBoxesInArea(boxes, width, height);
    assert.equal(result.length, boxes.length);
    for (const [index, box] of result.entries()) {
      assert.ok(box.x1 >= -1e-8 && box.y1 >= -1e-8 && box.x2 <= width + 1e-8 && box.y2 <= height + 1e-8);
      for (const other of result.slice(0, index)) assert.ok(
        box.x1 >= other.x2 - 1e-8 || box.x2 <= other.x1 + 1e-8 ||
        box.y1 >= other.y2 - 1e-8 || box.y2 <= other.y1 + 1e-8);
    }
  }
});
