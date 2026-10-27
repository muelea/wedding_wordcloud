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
    const shoulders = cloth.pattern.neckFront.filter(id => Math.abs(rest[id * 3]) > product.previewModel.width * .17);
    assert.ok(shoulders.length > 10 && shoulders.every(id => backIds.has(id)), 'rest-pose folds never open the sewn shoulder seams');
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

test('every size has a draped torso, restrained sleeve spread and a raised rounded hood', () => {
  for (const product of garments) {
    const model = product.previewModel, data = Cloth.pattern(model);
    const bounds = part => {
      const points = part.ids.map(id => Array.from(data.rest.subarray(id * 3, id * 3 + 3)));
      return [0, 1, 2].map(k => [Math.min(...points.map(p => p[k])), Math.max(...points.map(p => p[k]))]);
    };
    const body = bounds(data.parts[0]);
    assert.ok(body[0][1] - body[0][0] < model.width * .9, `${product.key}: the flat chest measurement wraps around the torso`);
    const left = bounds(data.parts.find(p => p.name === 'garment-sleeve--1'));
    const right = bounds(data.parts.find(p => p.name === 'garment-sleeve-1'));
    assert.ok(right[0][1] - left[0][0] < model.width * (model.garment === 't-shirt' ? 1.6 : 1.3), `${product.key}: sleeves hang close to the body`);
    assert.ok(data.parts.reduce((n, p) => n + p.triangles.length / 3, 0) < 12000, 'bounded render and simulation mesh, including the two-layer rounded hood');
    if (model.garment === 'hoodie') {
      const hood = bounds(data.parts.find(p => p.name === 'garment-hood'));
      assert.ok(hood[1][1] > model.height * .62 && hood[1][1] < model.height * .69, 'the rounded crown rises above the shoulders as in the supplier photo');
      assert.ok(hood[1][0] < model.height * .48, 'the hood joins the neckline rather than floating above it');
      assert.ok(hood[2][0] < -model.width * .15, 'the hood retains depth behind the neckline');
    }
  }
});

test('T-shirt sleeve caps retain upper-arm volume in every size instead of flaring from a thin strip', () => {
  for (const product of garments.filter(p => p.previewShape === 't-shirt')) {
    const data = Cloth.pattern(product.previewModel);
    for (const sleeve of data.parts.filter(p => p.name.includes('sleeve'))) {
      const width = row => {
        const xs = sleeve.ids.slice(row * (sleeve.columns + 1), (row + 1) * (sleeve.columns + 1)).map(id => data.rest[id * 3]);
        return Math.max(...xs) - Math.min(...xs);
      };
      const cuff = width(sleeve.rows);
      assert.ok(width(Math.round(sleeve.rows * .2)) > cuff * .6, `${product.key}: full upper arm at one fifth of the sleeve`);
      assert.ok(width(Math.round(sleeve.rows * .3)) > cuff * .9, `${product.key}: smooth transition into the sleeve opening`);
    }
  }
});

test('raised hood has a sloped open mouth, a rounded crown and separate lining outside the torso', () => {
  for (const record of garments.filter(p => p.previewShape === 'hoodie')) {
    const product = getPublicProduct(record), group = new THREE.Group(), texture = new THREE.Texture();
    const cloth = Cloth.create(THREE, group, texture, product), { rest, hoodRim } = cloth.pattern;
    const rim = hoodRim.map(id => new THREE.Vector3().fromArray(rest, id * 3));
    const h = product.previewModel.height, w = product.previewModel.width;
    assert.ok(rim[0].distanceTo(rim.at(-1)) < .001, 'the mouth has a continuous sewn lip');
    assert.ok(Math.max(...rim.map(p => p.y)) - Math.min(...rim.map(p => p.y)) > h * .17, 'high back and low throat leave a visible open mouth');
    assert.ok(Math.max(...rim.map(p => p.x)) - Math.min(...rim.map(p => p.x)) > w * .43, 'the hood opening has the supplier silhouette');
    const hood = cloth.meshes.find(m => m.name === 'garment-hood');
    const lining = cloth.meshes.find(m => m.name === 'garment-hood-lining');
    assert.equal(hood.geometry.attributes.position.count, lining.geometry.attributes.position.count);
    assert.ok(Array.from(hood.geometry.attributes.position.array).some((v, i) => Math.abs(v - lining.geometry.attributes.position.array[i]) > .15), 'outer cloth and lining have real thickness');
    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(); let supported = 0;
    for (const mesh of [hood, lining]) {
      const points = mesh.geometry.attributes.position;
      for (let i = 0; i < points.count; i += 3) {
        const p = new THREE.Vector3().fromBufferAttribute(points, i);
        ray.set(new THREE.Vector3(p.x, p.y, 100), new THREE.Vector3(0, 0, -1));
        const front = ray.intersectObject(cloth.meshes[0])[0], back = ray.intersectObject(cloth.meshes[1])[0];
        if (!front || !back) continue;
        assert.ok(p.z <= back.point.z + .15 || p.z >= front.point.z - .15, `${record.key}: both layers stay outside the chest`);
        supported++;
      }
    }
    assert.ok(supported > 35, 'checks contact around both sides of the neckline');
    cloth.dispose(); texture.dispose();
  }
});

test('sewn armholes share smooth outward normals before and during a pull, without idle geometry uploads', () => {
  for (const kind of ['t-shirt', 'sweatshirt', 'hoodie']) {
    const product = sample(kind), texture = new THREE.Texture();
    const cloth = Cloth.create(THREE, new THREE.Group(), texture, product);
    function checkSeams() {
      const byNode = new Map(); let shared = 0;
      for (const mesh of cloth.meshes.filter(m => /garment-(front|back|sleeve)/.test(m.name))) {
        const normals = mesh.geometry.attributes.normal;
        mesh.userData.garmentPart.ids.forEach((id, i) => {
          const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
          assert.ok(Math.abs(normal.length() - 1) < 1e-5, 'finite unit seam normal');
          if (byNode.has(id)) { assert.ok(normal.distanceTo(byNode.get(id)) < 1e-6, 'no hard shading boundary between sewn panels'); shared++; }
          else byNode.set(id, normal);
        });
      }
      assert.ok(shared > 80, 'covers both armholes and the body seams');
      for (const sleeve of cloth.meshes.filter(m => m.name.includes('sleeve'))) {
        const normals = sleeve.geometry.attributes.normal;
        const sign = sleeve.name.endsWith('--1') ? -1 : 1;
        assert.ok(sign * normals.getX(normals.count - 25) > .5, 'outer cuff normals face away from the garment');
      }
    }
    checkSeams();
    const versions = cloth.meshes.map(m => [m.geometry.attributes.position.version, m.geometry.attributes.normal.version]);
    assert.equal(cloth.advance(1), false);
    assert.deepEqual(cloth.meshes.map(m => [m.geometry.attributes.position.version, m.geometry.attributes.normal.version]), versions);
    cloth.demonstrate(); for (let i = 0; i < 15; i++) cloth.advance(1 / 60);
    checkSeams();
    for (const mesh of cloth.meshes) {
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) assert.ok(mesh.geometry.boundingSphere.containsPoint(new THREE.Vector3().fromBufferAttribute(positions, i)), 'conservative raycast bound covers displaced fabric');
    }
    cloth.dispose(); texture.dispose();
  }
});

test('cotton weave keeps physical density across print templates and heavy garments reserve real ribbed bands', () => {
  for (const kind of ['t-shirt', 'sweatshirt', 'hoodie']) {
    const product = sample(kind), texture = new THREE.Texture();
    const a = Cloth.create(THREE, new THREE.Group(), texture, product);
    const b = Cloth.create(THREE, new THREE.Group(), texture, {
      ...product, previewModel: { ...product.previewModel, printWidth: product.previewModel.printWidth * 2 },
    });
    const front = a.meshes[0], other = b.meshes[0];
    assert.deepEqual(front.geometry.attributes.fabricUv.array, other.geometry.attributes.fabricUv.array,
      'changing print dimensions cannot enlarge the knitted yarn');
    assert.notDeepEqual(front.geometry.attributes.uv.array, other.geometry.attributes.uv.array);
    assert.ok(a.meshes.filter(mesh => !mesh.name.startsWith('garment-hood')).every(mesh => mesh.castShadow && mesh.receiveShadow));
    const lining = a.meshes.find(mesh => mesh.name === 'garment-hood-lining');
    if (lining) assert.equal(lining.castShadow || lining.receiveShadow, false, 'thin lining avoids self-shadow bands');
    if (kind !== 't-shirt') {
      const rib = front.material[1];
      assert.notEqual(rib.bumpMap, front.material[0].bumpMap, 'ribbing has a distinct vertical knit');
      const band = front.geometry.groups.filter(group => group.materialIndex === 1);
      assert.ok(band.length > 0);
      for (const group of band) for (let i = group.start; i < group.start + group.count; i++) {
        const index = front.geometry.index.getX(i);
        assert.ok(front.geometry.attributes.position.getY(index) <= -product.previewModel.height / 2 + 7.001);
      }
    }
    a.dispose(); b.dispose(); texture.dispose();
  }
});
