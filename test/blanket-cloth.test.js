'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('three');
const Cloth = require('../public/js/blanket-cloth');
const { getProduct, getPublicProduct } = require('../src/products');
const contracts = require('./fixtures/printful-geometry.json').products;

test('both blanket sizes and orientations keep their provider files and exact physical face crop on a white 6 mm shell', () => {
  for (const [key, nativeWidth, nativeHeight] of [['throw-blanket-50x60in', 152.4, 127], ['throw-blanket-30x40in', 101.6, 76.2]]) {
    for (const orientation of ['default', 'portrait', 'landscape']) {
      const width = orientation === 'portrait' ? nativeHeight : nativeWidth;
      const height = orientation === 'portrait' ? nativeWidth : nativeHeight;
      const source = getProduct(key), product = getPublicProduct(source, orientation), model = product.previewModel;
      const contract = contracts.find(p => p.productKey === key);
      assert.equal(product.previewType, '3d'); assert.equal(model.kind, 'blanket');
      assert.equal(model.width, width); assert.equal(model.height, height); assert.equal(model.depth, .6);
      assert.equal(product.printFile.width, orientation === 'portrait' ? contract.printfile.height : contract.printfile.width);
      assert.equal(product.printFile.height, orientation === 'portrait' ? contract.printfile.width : contract.printfile.height);
      assert.equal(source.printful.variantId, contract.variant.variant_id);
      assert.equal(source.printful.printfileId, contract.printfile.printfile_id);
      assert.equal(model.face.x * product.printFile.width, 225);
      assert.ok(Math.abs(model.face.width * product.printFile.width - width / 2.54 * product.printFile.dpi) < 1e-7);
      const group = new THREE.Group(), artwork = new THREE.Texture(), cloth = Cloth.create(THREE, group, artwork, product);
      const mesh = cloth.mesh, vertices = mesh.geometry.attributes.position, count = vertices.count / 2, i = Math.floor(count / 2);
      const sim = cloth.simulation, hangingSpan = sim.rest[sim.nx * 3] - sim.rest[0];
      assert.ok(hangingSpan > sim.width * .95 && hangingSpan < sim.width,
        'the hanging points keep the top open without stretching beyond the fabric width');
      const topSag = sim.positions[1] - sim.positions[Math.floor(sim.nx / 2) * 3 + 1];
      assert.ok(topSag > 0 && topSag < sim.height * .18,
        'the upper hem keeps a gentle sag instead of folding down over the top of the print');
      const front = new THREE.Vector3().fromBufferAttribute(vertices, i), back = new THREE.Vector3().fromBufferAttribute(vertices, i + count);
      assert.ok(Math.abs(front.distanceTo(back) - .6) < .00002, 'the depth is physical, not a scaled visual layer');
      assert.equal(mesh.material[0].map, artwork);
      assert.equal(mesh.material[1].map, null, 'the reverse never repeats or mirrors the print');
      assert.ok(mesh.material.every(material => material.color.getHexString() === 'ffffff'));
      const uv = mesh.geometry.attributes.uv;
      assert.ok(Math.abs(uv.getX(0) - model.face.x) < 1e-7);
      assert.ok(Math.abs(uv.getY(0) - (1 - model.face.y)) < 1e-7);
      cloth.dispose(); artwork.dispose(); assert.equal(group.children.length, 0);
    }
  }
});

test('a point pull propagates through the cloth, keeps both pins fixed, and settles without changing artwork UVs', () => {
  const product = getPublicProduct(getProduct('throw-blanket-50x60in')), group = new THREE.Group();
  const artwork = new THREE.Texture(), cloth = Cloth.create(THREE, group, artwork, product), sim = cloth.simulation;
  const uv = Array.from(cloth.mesh.geometry.attributes.uv.array), before = sim.positions.slice();
  const i = Math.round(sim.ny * .7) * (sim.nx + 1) + 30, point = Array.from(before.subarray(i * 3, i * 3 + 3));
  assert.equal(sim.grab(0), false); assert.equal(sim.grab(sim.nx), false);
  assert.equal(sim.grab(-1), false); assert.equal(sim.grab(Infinity), false);
  sim.grab(i); sim.move([point[0] - .6, point[1] + .6, point[2] + .7]);
  for (let f = 0; f < 60; f++) cloth.advance(1 / 60);
  const neighbor = (i - 1) * 3;
  assert.ok(Math.hypot(...Array.from(sim.positions.subarray(neighbor, neighbor + 3), (v, k) => v - before[neighbor + k])) > .1);
  assert.ok(Array.from(sim.positions).every(Number.isFinite));
  for (const pin of [0, sim.nx]) for (let k = 0; k < 3; k++) assert.equal(sim.positions[pin * 3 + k], before[pin * 3 + k]);
  cloth.release();
  let frames = 0; while (cloth.active && frames++ < 900) cloth.advance(1 / 60);
  assert.equal(cloth.active, false, 'no permanent animation loop remains after settling');
  assert.deepEqual(Array.from(cloth.mesh.geometry.attributes.uv.array), uv);
  assert.equal(cloth.mesh.material[0].map, artwork);
  const settled = sim.positions.slice(); assert.equal(cloth.advance(100), false); assert.deepEqual(sim.positions, settled);
  cloth.dispose(); artwork.dispose();
});

test('extreme drags and delayed frames stay bounded, and separate previews own their simulation and GPU resources', () => {
  const product = getPublicProduct(getProduct('throw-blanket-30x40in'));
  const a = Cloth.create(THREE, new THREE.Group(), new THREE.Texture(), product);
  const b = Cloth.create(THREE, new THREE.Group(), new THREE.Texture(), product), untouched = b.simulation.positions.slice();
  const sim = a.simulation;
  sim.grab(1); sim.move([1e12, 1e12, -1e12]); a.advance(60);
  assert.ok(Array.from(sim.positions).every(value => Number.isFinite(value) && Math.abs(value) < 10));
  assert.deepEqual(b.simulation.positions, untouched);
  const resources = new Set([a.mesh.geometry, ...a.mesh.material, a.mesh.material[0].bumpMap, a.mesh.material[0].roughnessMap]);
  const disposed = new Map(); resources.forEach(resource => resource.addEventListener('dispose', () => disposed.set(resource, (disposed.get(resource) || 0) + 1)));
  a.dispose(); a.dispose();
  assert.ok([...resources].every(resource => disposed.get(resource) === 1));
  assert.equal(a.advance(1), false); b.demonstrate(); assert.equal(b.active, true); b.dispose();
});
