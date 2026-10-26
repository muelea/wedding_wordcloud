'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('canvas');
const { PRODUCTS } = require('../src/products');
const { renderProviderPng } = require('../src/printRaster');

test('clothing print files retain provider dimensions and transparent artwork independently of garment colour', async () => {
  for (const kind of ['t-shirt', 'sweatshirt', 'hoodie']) {
    const variants = PRODUCTS.filter(p => p.previewShape === kind && p.size.label.startsWith('M · '));
    assert.equal(variants.length, 2);
    let whiteBytes;
    for (const product of variants) {
      const { width, height } = product.printFile;
      const design = [{ id: 'family', text: 'Glück & Familie', fontFamily: 'classic',
        x: width / 2, y: height / 2, fontSize: 180, angle: 0, color: '#ed2446' }];
      const bytes = await renderProviderPng(product, design);
      const image = await loadImage(bytes);
      assert.equal(image.width, width); assert.equal(image.height, height);
      const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      assert.equal(ctx.getImageData(0, 0, 1, 1).data[3], 0, 'fabric shading and garment colour never enter the print');
      const pixels = ctx.getImageData(width / 4, height / 2 - 120, width / 2, 240).data;
      let ink = 0;
      for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3] > 200 && pixels[p] > pixels[p + 1] * 2) ink++;
      assert.ok(ink > 1000, 'the actual artwork reaches the production PNG');
      if (!whiteBytes) whiteBytes = bytes;
      else assert.ok(bytes.equals(whiteBytes), 'the same design produces identical print bytes on white and black garments');
      canvas.width = canvas.height = 1;
    }
  }
});
