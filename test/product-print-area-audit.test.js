'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createCanvas, loadImage } = require('canvas');
const THREE = require('three');
const { getProduct } = require('../src/products');
const Geometry = require('../public/js/product-3d-geometry');
const landmarks = require('./fixtures/printful-preview-landmarks.json');

test('mouse-pad atlas and mesh project all four independent Printful proof margins within two proof pixels', async () => {
  const sample = landmarks.mousePad, product = getProduct(sample.productKey);
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const bytes = fs.readFileSync(require('node:path').join(__dirname, '../public', product.previewMesh.file));
  const scene = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  const models = require('../public/js/printful-product-model');
  const model = models.prepareScene(THREE, scene, product, new THREE.Texture());
  model.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(model, true).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 22) < 1e-5 && Math.abs(size.y - 18) < 1e-5);
  const source = createCanvas(product.printFile.width, product.printFile.height), sourceCtx = source.getContext('2d');
  const [left, top, right, bottom] = sample.inputMarker;
  sourceCtx.fillStyle = '#0072d9'; sourceCtx.fillRect(left, top, right - left + 1, bottom - top + 1);
  sourceCtx.clearRect(left + 30, top + 30, right - left - 59, bottom - top - 59);
  const sizeAtlas = models.atlasSizeFor(product), atlas = createCanvas(sizeAtlas.width, sizeAtlas.height), ctx = atlas.getContext('2d');
  models.paintAtlas(ctx, sizeAtlas, product.previewMesh, product, source);
  const pixels = ctx.getImageData(0, 0, atlas.width, atlas.height).data;
  const blueAt = (x, y) => {
    const hit = new THREE.Raycaster(new THREE.Vector3((x - .5) * size.x, (.5 - y) * size.y, 30),
      new THREE.Vector3(0, 0, -1)).intersectObject(model, true)[0];
    if (!hit) return false;
    const offset = (Math.floor(hit.uv.y * atlas.height) * atlas.width + Math.floor(hit.uv.x * atlas.width)) * 4;
    return pixels[offset] < 60 && pixels[offset + 1] > 50 && pixels[offset + 1] < 170 && pixels[offset + 2] > 150;
  };
  for (const axis of [0, 1]) {
    const hits = [];
    for (let i = 0; i <= 1000; i++) if (blueAt(axis ? .5 : i / 1000, axis ? i / 1000 : .5)) hits.push(i / 1000);
    assert.ok(hits.length);
    const observed = [hits[0], hits.at(-1)], extent = sample.providerBody[axis + 2] - sample.providerBody[axis];
    for (const corner of [0, 1]) {
      const expected = (sample.providerMarker[corner * 2 + axis] - sample.providerBody[axis]) / extent;
      assert.ok(Math.abs(observed[corner] - expected) * extent < 2, 'calibration border agrees with the provider proof');
    }
  }
  assert.deepEqual(product.designSafeAreas.default, { x: 120, y: 120, width: 2460, height: 2010 });
  assert.deepEqual(product.printFile, { width: 2700, height: 2250, dpi: 300, placement: 'default', fillMode: 'cover', canRotate: false });
});

test('organic tote blank colors cover the full composition and reset when selecting an untinted product', t => {
  const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
  const extract = name => {
    const start = template.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1);
    return template.slice(start, template.indexOf('\n    }', start) + 6);
  };
  const dom = new JSDOM('<div id="preview"><span class="flat-product-composite"><img></span></div>');
  t.after(() => dom.window.close());
  const preview = dom.window.document.getElementById('preview'), image = preview.querySelector('img');
  const context = vm.createContext({ preview, image });
  vm.runInContext(['currentProductMockupAsset', 'configureProductMockup'].map(extract).join('\n'), context);
  const snapshot = require('./fixtures/printful-geometry.json');
  for (const key of ['eco-tote-10458', 'eco-tote-10457', 'matte-poster-30x40cm', 'eco-tote-10458']) {
    context.view = getProduct(key);
    vm.runInContext('configureProductMockup(view, "front", preview, image)', context);
    const expected = key.startsWith('eco-tote')
      ? snapshot.products.find(p => p.productKey === key).previews[0].background_color : 'transparent';
    assert.equal(preview.style.getPropertyValue('--product-mockup-background'), expected, key);
    assert.equal(preview.style.getPropertyValue('--product-mockup-canvas-left'), `${context.view.previewMockup.canvas.left}%`);
  }
  const compositeRule = template.match(/\.flat-product-preview\.has-product-mockup \.flat-product-composite\s*\{([^}]+)\}/)[1];
  assert.match(compositeRule, /background-color:\s*var\(--product-mockup-background, transparent\)/,
    'the fabric tint belongs to the complete provider composition, including the handles');
});

test('the provider fabric layers over natural and black blank colors match the original Printful mockups', async () => {
  const path = require('node:path');
  for (const sample of landmarks.organicToteColors) {
    const key = sample.productKey, product = getProduct(key);
    const layer = await loadImage(path.join(__dirname, '../public', product.previewMockup.assets.front));
    const canvas = createCanvas(1000, 1000), ctx = canvas.getContext('2d');
    ctx.fillStyle = product.previewMockup.backgroundColor; ctx.fillRect(0, 0, 1000, 1000);
    ctx.drawImage(layer, 0, 0, 1000, 1000);
    // Unprinted body, handle and bottom hem. This catches the original error,
    // which left everything outside the artwork rectangle white.
    for (const { x, y, rgb: providerPixel } of sample.samples) {
      const actualPixel = ctx.getImageData(x, y, 1, 1).data;
      for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(actualPixel[channel] - providerPixel[channel]) <= 4, `${key}: ${x},${y} channel ${channel}`);
    }
    for (const [x, y] of [[0, 0], [500, 200]]) assert.deepEqual(Array.from(ctx.getImageData(x, y, 1, 1).data), [255, 255, 255, 255],
      `${key}: the image background and space between handles stay white`);
  }
});

test('both sleeve sizes project the calibration corners at the provider mockup positions', () => {
  for (const sample of landmarks.sleeves) {
    const product = getProduct(sample.productKey), m = product.previewModel;
    const group = new THREE.Group(); Geometry.build(THREE, group, new THREE.Texture(), product);
    group.updateMatrixWorld(true);
    for (const corner of [0, 1]) {
      const u = sample.inputMarker[corner * 2] / product.printFile.width;
      const v = sample.inputMarker[corner * 2 + 1] / product.printFile.height;
      const x = (u - m.face.x) / m.face.width;
      const y = (v - m.face.y) / m.face.height;
      const expectedX = (sample.providerMarker[corner * 2] - sample.providerBody[0]) /
        (sample.providerBody[2] - sample.providerBody[0]);
      const expectedY = (sample.providerMarker[corner * 2 + 1] - sample.providerBody[1]) /
        (sample.providerBody[3] - sample.providerBody[1]);
      assert.ok(Math.abs(x - expectedX) < .003, `${sample.productKey}: horizontal marker drift`);
      assert.ok(Math.abs(y - expectedY) < .003, `${sample.productKey}: vertical marker drift`);
      // Also exercise the geometry's UV attributes rather than metadata alone.
      const hit = new THREE.Raycaster(new THREE.Vector3((x - .5) * m.width,
        (.5 - y) * m.height, 30), new THREE.Vector3(0, 0, -1)).intersectObjects(group.children, true)[0];
      assert.ok(hit);
      assert.ok(Math.abs(hit.uv.x - u) < 1e-6 && Math.abs(hit.uv.y - (1 - v)) < 1e-6);
    }
  }
});

test('black-handle tote photo projects the full input at Printful calibration landmarks', () => {
  const sample = landmarks.blackHandleTote, product = getProduct(sample.productKey);
  const m = product.previewMockup, r = m.canvas;
  const width = m.width * r.width / 100, height = m.height * r.height / 100;
  const scale = Math.max(width / product.printFile.width, height / product.printFile.height);
  for (const corner of [0, 1]) {
    const x = m.width * r.left / 100 + (width - product.printFile.width * scale) / 2 + sample.inputMarker[corner * 2] * scale;
    const y = m.height * r.top / 100 + (height - product.printFile.height * scale) / 2 + sample.inputMarker[corner * 2 + 1] * scale;
    assert.ok(Math.abs(x + sample.photoTranslation[0] - sample.providerMarker[corner * 2]) < 1.5);
    assert.ok(Math.abs(y + sample.photoTranslation[1] - sample.providerMarker[corner * 2 + 1]) < 1.5);
  }
});
