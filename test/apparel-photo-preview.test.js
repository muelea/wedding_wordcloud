'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('canvas');
const { JSDOM } = require('jsdom');
const Photo = require('../public/js/product-photo-preview');
const { PRODUCTS, getPublicProduct } = require('../src/products');
const catalog = require('../src/apparelCatalog.json');

// Independent read-only Printful API check, 2026-10-27. Template coordinates
// use a 3000 px frame even though the provider serves 1000 px PNGs.
const providerAreas = {
  456: [930, 409, 1140, 1520],
  493: [930, 415, 1140, 1520],
  479: [1026, 687, 966, 966],
};
const garments = PRODUCTS.filter(product => product.familyKey === 'clothing');

test('offline Printful-generated proofs cover all 38 variants and the local calibration stays within one proof pixel', async () => {
  const evidence = require('./fixtures/apparel-photo-landmarks.json');
  assert.deepEqual(evidence.proofs.flatMap(proof => proof.variantIds).sort((a, b) => a - b),
    garments.map(product => product.printful.variantId).sort((a, b) => a - b));
  for (const proof of evidence.proofs) {
    const root = path.join(__dirname, '..', evidence.root);
    const providerBytes = fs.readFileSync(path.join(root, proof.provider));
    assert.equal(crypto.createHash('sha256').update(providerBytes).digest('hex'), proof.providerSha256);
    const source = await loadImage(path.join(root, proof.source));
    const product = getPublicProduct(garments.find(p => p.key === proof.key));
    const layer = await loadImage(path.join(__dirname, '../public', product.previewMockup.assets.front));
    const canvas = createCanvas(...evidence.proofSize), ctx = canvas.getContext('2d');
    Photo.paint(ctx, canvas, product, layer, ctx => ctx.drawImage(source, 0, 0));
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const p = (y * canvas.width + x) * 4;
      if (pixels[p] < 65 && pixels[p + 1] > 50 && pixels[p + 1] < 175 && pixels[p + 2] > 150) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    for (const [i, coordinate] of [left, top, right + 1, bottom + 1].entries()) {
      assert.ok(Math.abs(coordinate - proof.blueBounds[i]) <= 1, `${proof.key}: provider edge ${i}`);
    }
  }
});

test('all 38 clothing variants select their exact provider photo rectangle and pinned alpha layer', async () => {
  assert.equal(garments.length, 38);
  for (const record of catalog.products) {
    const bytes = fs.readFileSync(path.join(__dirname, '../public', record.previewLayer.src));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.previewLayer.sha256);
    const image = await loadImage(bytes);
    assert.deepEqual([image.width, image.height], [1000, 1000]);
    const canvas = createCanvas(1000, 1000), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const alpha = ctx.getImageData(0, 0, 1000, 1000).data;
    assert.ok(alpha.some((value, i) => i % 4 === 3 && value < 255), 'original fabric shading retains transparency');
    assert.equal(alpha[3], 255, 'the supplier masks the surrounding background');
    for (const variant of record.variants) {
      const product = garments.find(product => product.printful.variantId === variant.id);
      const template = record.templates.find(template => template.catalog_variant_ids.includes(variant.id));
      const view = getPublicProduct(product);
      assert.equal(view.previewType, 'photo');
      assert.equal(view.previewMockup.assets.front, record.previewLayer.src);
      assert.equal(view.previewMockup.backgroundColor, template.background_color);
      const area = view.previewMockup.canvas;
      for (const [i, value] of [area.left, area.top, area.width, area.height].entries()) {
        assert.ok(Math.abs(value * 30 - providerAreas[record.productId][i]) < 1e-8);
      }
      assert.deepEqual([view.printFile.width, view.printFile.height, view.printFile.dpi],
        [record.printfile.width, record.printfile.height, record.printfile.dpi]);
      assert.equal(product.printful.printfileId, record.printfile.printfile_id);
      assert.deepEqual(product.printful.placements, ['front']);
    }
  }
});

test('photo composition preserves complete-file margins, position, colour and portrait/square proportions for every variant', async () => {
  for (const product of garments) {
    const view = getPublicProduct(product);
    const layer = await loadImage(path.join(__dirname, '../public', view.previewMockup.assets.front));
    // Transparent synthetic ink has deliberately large asymmetric margins.
    const source = createCanvas(product.printFile.width, product.printFile.height), ink = source.getContext('2d');
    const marker = { x: 230, y: 310, width: 800, height: 900 };
    ink.fillStyle = '#e00070'; ink.fillRect(marker.x, marker.y, marker.width, marker.height);
    const canvas = createCanvas(1000, 1000), ctx = canvas.getContext('2d');
    Photo.paint(ctx, canvas, view, layer, (ctx, bounds) => {
      assert.deepEqual(bounds, { offsetX: 0, offsetY: 0,
        printWidth: product.printFile.width, printHeight: product.printFile.height });
      ctx.drawImage(source, 0, 0);
    });
    const [left, top, width, height] = providerAreas[product.printful.productId].map(value => value / 3);
    const expected = [left + marker.x / source.width * width,
      top + marker.y / source.height * height,
      left + (marker.x + marker.width) / source.width * width,
      top + (marker.y + marker.height) / source.height * height];
    const pixels = ctx.getImageData(0, 0, 1000, 1000).data;
    const hits = [];
    for (let y = 0; y < 1000; y++) for (let x = 0; x < 1000; x++) {
      const p = (y * 1000 + x) * 4;
      if (pixels[p] > 110 && pixels[p + 1] < pixels[p] * .4 && pixels[p + 2] > pixels[p + 1] + 25) hits.push([x, y]);
    }
    assert.ok(hits.length > 10000, `${product.key}: vivid artwork survives on white and black fabric`);
    const observed = [Math.min(...hits.map(p => p[0])), Math.min(...hits.map(p => p[1])),
      Math.max(...hits.map(p => p[0])) + 1, Math.max(...hits.map(p => p[1])) + 1];
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(observed[i] - expected[i]) < 2, `${product.key}: corner ${i}`);
    assert.deepEqual(Array.from(ctx.getImageData(0, 0, 1, 1).data), [255, 255, 255, 255]);
  }
});

test('photo viewers ignore late loads after disposal, retry failed layers and repaint the latest artwork without WebGL', async t => {
  const dom = new JSDOM('<div id="host"></div>');
  t.after(() => dom.window.close());
  const { document } = dom.window, host = document.getElementById('host');
  const create = document.createElement.bind(document), images = [], states = [];
  t.mock.method(document, 'createElement', tag => {
    const element = create(tag);
    if (tag === 'img') images.push(element);
    return element;
  });
  const product = getPublicProduct(garments[0]);
  const cancelled = Photo.create({ host, product, drawTexture() {}, onStatus: state => states.push(state) });
  cancelled.destroy();
  images[0].onerror();
  assert.equal(await cancelled.ready, false);
  assert.deepEqual(states, ['loading']);
  let drawn = '';
  const viewer = Photo.create({ host, product, drawTexture: () => { drawn = 'old'; } });
  assert.equal(images.length, 2, 'a rejected image does not remain cached');
  viewer.updateTexture(() => { drawn = 'latest'; });
  t.mock.method(viewer.canvas.getContext('2d'), 'drawImage', () => {});
  images[1].onload();
  assert.equal(await viewer.ready, true);
  assert.equal(drawn, 'latest');
  assert.equal(host.querySelectorAll('canvas').length, 1);
  viewer.destroy(); viewer.destroy();
  assert.equal(host.querySelector('canvas'), null);
});

test('small black garment previews keep their photo surround white at fractional display sizes', async () => {
  const product = getPublicProduct(garments.find(p => p.key === 'hoodie-12373'));
  const layer = await loadImage(path.join(__dirname, '../public', product.previewMockup.assets.front));
  for (const [width, height] of [[457, 500], [500, 457], [469, 633]]) {
    const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
    Photo.paint(ctx, canvas, product, layer, () => {}, .92);
    const side = Math.round(Math.min(width, height) * .92);
    const left = Math.round((width - side) / 2), top = Math.round((height - side) / 2);
    for (const x of [left, left + side - 1]) {
      assert.deepEqual([...ctx.getImageData(x, top + Math.floor(side / 2), 1, 1).data], [255, 255, 255, 255]);
    }
  }
});
