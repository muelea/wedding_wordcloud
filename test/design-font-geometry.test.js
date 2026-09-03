'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { capture, verify } = require('./support/font-geometry-matrix');

test('all five fonts survive real editor sizing, rotation, layout and reload on every product/orientation', async () => {
  const result = verify(await capture());
  assert.equal(result.fonts.length, 5);
  assert.ok(result.designs >= 3600, 'Do not silently skip orientation-free products such as mugs');
});
