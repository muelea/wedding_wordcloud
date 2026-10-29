'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createCanvas } = require('canvas');
const { getProduct, resolveProductOrientation } = require('../src/products');
const { renderProviderPng } = require('../src/printRaster');
const db = require('../src/db');
const assets = require('../src/designImageAssets');

function photo(index) {
  const canvas = createCanvas(40, 32), context = canvas.getContext('2d');
  context.fillStyle = `rgb(${index * 11},${255 - index * 9},${index * 7})`;
  context.fillRect(0, 0, 40, 32);
  context.clearRect(10, 8, 12, 10);
  context.fillStyle = '#123456'; context.fillRect(index % 10, 20, 8, 8);
  return canvas.toDataURL(index % 2 ? 'image/jpeg' : 'image/png');
}

test('private Storage references produce byte-identical prints for twenty photos, duplicate sources and both sides', async t => {
  const oldMode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => { assets.setStorageForTests(null); if (oldMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode; });
  const sourceFiles = new Map(), rows = new Map(), sourceIds = new Map();
  const sources = Array.from({ length: 20 }, (_, index) => photo(index));
  for (const src of sources) {
    const id = crypto.randomUUID(), bytes = Buffer.from(src.split(',')[1], 'base64');
    const objectKey = `design-images/${id}`;
    sourceIds.set(src, id); sourceFiles.set(objectKey, bytes);
    rows.set(id, { id, object_key: objectKey, byte_size: bytes.length,
      mime_type: src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  t.mock.method(db, 'getDesignImageAssets', async ids => ids.map(id => rows.get(id)).filter(Boolean));
  assets.setStorageForTests({ async download(key) { assert.ok(sourceFiles.has(key)); return sourceFiles.get(key); } });
  for (const productKey of ['white-glossy-mug-duo-11oz', 'all-over-basic-pillow-18in']) {
    const product = resolveProductOrientation(getProduct(productKey), 'default');
    const inline = { version: 2, surfaces: {} };
    for (const [side, surface] of product.printSurfaces.entries()) {
      const area = product.designSafeAreas[surface.key];
      inline.surfaces[surface.key] = [
        { id: 'styled', type: 'text', text: 'Liebe ❤️', fontFamily: 'classic', fontSize: 56,
          fontWeight: 700, fontStyle: 'italic', underline: true, linethrough: false,
          x: area.x + area.width * .5, y: area.y + area.height * .12, angle: 0, color: '#a40e4c' },
        ...sources.map((src, index) => ({ id: `photo-${index}`, type: 'image', src,
          x: area.x + area.width * (.1 + (index % 5) * .2),
          y: area.y + area.height * (.3 + Math.floor(index / 5) * .17),
          width: 100, height: 80, angle: (index % 2 ? -1 : 1) * (side ? 17 : 11) })),
        { id: 'source-copy', type: 'image', src: sources[0], x: area.x + area.width * .5,
          y: area.y + area.height * .88, width: 130, height: 104, angle: -7 },
        { id: 'motif', type: 'icon', icon: 'heart', size: 70, x: area.x + area.width * .75,
          y: area.y + area.height * .88, angle: 15, color: '#2455f5' },
      ];
    }
    const compact = JSON.parse(JSON.stringify(inline), (key, value) => {
      if (value?.type !== 'image') return value;
      const { src, ...geometry } = value;
      return { ...geometry, assetId: sourceIds.get(src) };
    });
    assert.doesNotMatch(JSON.stringify(compact), /data:image/);
    const hydrated = await assets.hydrate(compact);
    for (const surface of product.printSurfaces) {
      const original = await renderProviderPng(product, inline.surfaces[surface.key]);
      const restored = await renderProviderPng(product, hydrated.surfaces[surface.key]);
      assert.deepEqual(restored, original, `${productKey}/${surface.key}: Storage must not alter photo pixels, alpha, text styles, geometry or layer order`);
    }
  }
});
