'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('three');
const Cloth = require('../public/js/garment-cloth');
const Geometry = require('../public/js/product-3d-geometry');
const { PRODUCTS, getProduct, getPublicProduct } = require('../src/products');
const catalog = require('../src/apparelCatalog.json');
const { catalogPrice } = require('../src/pricing');

const garments = PRODUCTS.filter(p => p.familyKey === 'clothing');
const sample = kind => getPublicProduct(garments.find(p => p.previewShape === kind && p.size.label === 'M · Weiß'));

test('all 38 clothing variants retain their exact provider identity, measurements and fixed front print dimensions', () => {
  assert.equal(garments.length, 38);
  for (const record of catalog.products) {
    const offered = garments.filter(p => p.printful.productId === record.productId);
    assert.equal(offered.length, record.variants.length);
    for (const variant of record.variants) {
      const p = getProduct(variant.key), m = p.previewModel;
      assert.equal(p.printful.variantId, variant.id);
      assert.equal(p.printful.technique, 'dtg');
      assert.equal(p.printful.printfileId, record.printfile.printfile_id);
      assert.deepEqual(p.printful.placements, ['front']);
      assert.deepEqual(p.printSurfaces.map(s => s.key), ['front']);
      assert.equal(m.color, variant.color === 'White' ? '#ffffff' : '#0b0b0b');
      assert.deepEqual([m.width, m.height, m.sleeve],
        [record.measurements[variant.size].width, record.measurements[variant.size].height, record.measurements[variant.size].sleeve]);
      assert.equal(m.printWidth, record.printfile.width / record.printfile.dpi * 2.54);
      assert.equal(m.printHeight, record.printfile.height / record.printfile.dpi * 2.54);
      assert.ok(catalogPrice(variant.id).unitGrossCents > 0);
      assert.ok(p.designSafeAreas.front.x > 0);
      assert.ok(m.printTop + m.printHeight < m.height - 5);
    }
    const dimensions = offered.map(p => [p.previewModel.width, p.previewModel.height]);
    assert.ok(new Set(dimensions.map(([w, h]) => (w / h).toFixed(4))).size > 1, 'sizes change proportions rather than uniformly scaling');
  }
});

test('sewn garment panels have real openings, separate reverse faces and physical print coordinates', () => {
  for (const kind of ['t-shirt', 'sweatshirt', 'hoodie']) {
    const product = sample(kind), group = new THREE.Group(), texture = new THREE.Texture();
    const cloth = Geometry.build(THREE, group, texture, product), front = cloth.meshes.find(m => m.name === 'garment-front');
    const back = cloth.meshes.find(m => m.name === 'garment-back');
    const frontMaterials = Array.isArray(front.material) ? front.material : [front.material];
    assert.equal(frontMaterials[0].map, texture);
    assert.ok((Array.isArray(back.material) ? back.material : [back.material]).every(m => m.map === null), 'reverse is unprinted');
    const ids = front.userData.garmentPart.ids, uv = front.geometry.attributes.uv, rest = cloth.pattern.rest;
    for (let i = 0; i < ids.length; i += 13) {
      const p = ids[i] * 3;
      assert.ok(Math.abs((uv.getX(i) - .5) * product.previewModel.printWidth - rest[p]) < .00001);
      assert.ok(Math.abs(product.previewModel.height / 2 - product.previewModel.printTop - (1 - uv.getY(i)) * product.previewModel.printHeight - rest[p + 1]) < .00001);
    }
    const backIds = new Set(back.userData.garmentPart.ids);
    assert.ok(ids.filter(id => backIds.has(id)).length > 40, 'front and back actually share stitched seam nodes');
    assert.ok(ids.some(id => !backIds.has(id)), 'front and back remain distinct cloth faces');
    const minY = Math.min(...Array.from(front.geometry.attributes.position.array).filter((_, i) => i % 3 === 1));
    assert.ok(Math.abs(minY + product.previewModel.height / 2) < .001);
    if (kind === 'hoodie') {
      for (const name of ['garment-hood', 'garment-hood-lining', 'garment-kangaroo-pocket', 'garment-drawstring', 'garment-eyelet']) assert.ok(group.children.some(m => m.name === name));
      assert.ok(cloth.pattern.stitches.length > 80, 'hood and pocket are sewn to the body');
    }
    cloth.dispose(); texture.dispose(); assert.equal(group.children.length, 0);
  }
});

test('cloth pulls propagate across neighbours, keep shoulders fixed and settle without moving print UVs', () => {
  for (const kind of ['t-shirt', 'hoodie']) {
    const product = sample(kind), group = new THREE.Group(), texture = new THREE.Texture();
    const cloth = Cloth.create(THREE, group, texture, product), sim = cloth.simulation, front = cloth.meshes[0];
    const uv = front.geometry.attributes.uv.array.slice(), before = sim.positions.slice();
    const id = front.userData.garmentPart.ids[10 * 33 + 25], p = id * 3;
    assert.equal(sim.grab(sim.pins[0]), false); assert.equal(sim.grab(-1), false);
    assert.equal(sim.grab(id), true);
    sim.move([before[p] * 100 + 12, before[p + 1] * 100 + 10, before[p + 2] * 100 + 14]);
    for (let i = 0; i < 10; i++) cloth.advance(1 / 60);
    assert.ok(Math.abs(sim.positions[p] - before[p]) > .02);
    const neighbor = front.userData.garmentPart.ids[10 * 33 + 24] * 3;
    assert.ok(Math.hypot(...[0, 1, 2].map(k => sim.positions[neighbor + k] - before[neighbor + k])) > .01);
    for (const pin of sim.pins) for (let k = 0; k < 3; k++) assert.equal(sim.positions[pin * 3 + k], before[pin * 3 + k]);
    cloth.release(); let frames = 0; while (cloth.active && frames++ < 800) cloth.advance(1 / 60);
    assert.equal(cloth.active, false);
    assert.ok(Array.from(sim.positions).every(Number.isFinite));
    assert.deepEqual(front.geometry.attributes.uv.array, uv);
    assert.equal(cloth.advance(100), false);
    cloth.dispose(); texture.dispose();
  }
});

test('extreme drags stay bounded, previews remain independent, and resources dispose exactly once', () => {
  const product = sample('sweatshirt'), a = Cloth.create(THREE, new THREE.Group(), new THREE.Texture(), product);
  const b = Cloth.create(THREE, new THREE.Group(), new THREE.Texture(), product), untouched = b.simulation.positions.slice();
  const sim = a.simulation, id = a.pattern.parts[0].ids[200]; sim.grab(id); sim.move([1e12, -1e12, 1e12]); a.advance(60);
  assert.ok(Array.from(sim.positions).every(value => Number.isFinite(value) && Math.abs(value) < 2));
  assert.deepEqual(b.simulation.positions, untouched);
  const resources = new Set(); a.meshes.forEach(mesh => { resources.add(mesh.geometry); (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => { resources.add(m); resources.add(m.bumpMap); }); });
  const disposed = new Map(); resources.forEach(r => r.addEventListener('dispose', () => disposed.set(r, (disposed.get(r) || 0) + 1)));
  a.dispose(); a.dispose(); assert.ok([...resources].every(r => disposed.get(r) === 1));
  assert.equal(a.advance(1), false); b.demonstrate(); assert.equal(b.active, true); b.dispose();
});
