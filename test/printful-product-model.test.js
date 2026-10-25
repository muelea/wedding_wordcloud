'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const THREE = require('three');
const { createCanvas, loadImage } = require('canvas');
const models = require('../public/js/printful-product-model');
const manifest = require('../src/productPreviewModels.json');
const { PRODUCTS, getProduct, getPublicProduct } = require('../src/products');
const { readGlb, geometryOnly } = require('../scripts/prepare-product-models');
const { cacheControlForStaticRequest } = require('../src/httpCache');
const { renderProviderPng } = require('../src/printRaster');
const { drawItem } = require('../public/js/artwork-overlap');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const asset = url => fs.readFileSync(path.join(__dirname, '../public', url));

test('hashed meshes and mounted pinned Three modules keep immutable cache headers', () => {
  for (const model of manifest.models) {
    for (const url of [model.file, model.baseAtlas].filter(Boolean)) {
      assert.equal(cacheControlForStaticRequest({ path: url }), 'public, max-age=31536000, immutable');
    }
  }
  assert.equal(cacheControlForStaticRequest({ baseUrl: '/vendor/three', path: '/examples/jsm/loaders/GLTFLoader.js',
    query: { v: '0.160.1' } }), 'public, max-age=31536000, immutable');
});

async function sceneFor(descriptor) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const bytes = asset(descriptor.file);
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
}

test('landing can align the catalog mug to its established animated surface without changing print geometry', async () => {
  const product = getPublicProduct(getProduct('white-glossy-mug-duo-11oz'));
  product.previewMesh = { ...product.previewMesh, rotateY: 180, diameter: product.size.diameterCm };
  const scene = await sceneFor(product.previewMesh);
  const original = [];
  scene.traverse(object => {
    for (const name of ['position', 'uv']) {
      const values = object.geometry?.getAttribute(name)?.array;
      if (values) original.push([values, hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength))]);
    }
  });
  const model = models.prepareScene(THREE, scene, product, new THREE.Texture());
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true), size = bounds.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.z - 8.2) < .00001, 'flying word strips retain their 4.1 cm surface radius');
  assert.ok(Math.abs(size.y - 9.6) < .00001, 'the established mug height is preserved');
  assert.ok(bounds.min.x < -7 && bounds.max.x < 4.12, 'the handle starts on the original left side');
  for (const [values, before] of original) {
    assert.equal(hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength)), before);
  }
  models.disposeScene(model);
});

test('imported white and colored mugs turn around the cylinder like enamel without changing geometry or print UVs', async () => {
  for (const key of ['white-glossy-mug-duo-11oz', 'white-glossy-mug-15oz', 'white-glossy-mug-20oz', 'colored-mug-11051', 'enamel-mug']) {
    const product = getPublicProduct(getProduct(key)), scene = await sceneFor(product.previewMesh);
    const buffers = () => {
      const values = [];
      scene.traverse(object => {
        for (const name of ['position', 'uv']) {
          const array = object.geometry?.getAttribute(name)?.array;
          if (array) values.push(hash(Buffer.from(array.buffer, array.byteOffset, array.byteLength)));
        }
      });
      return values;
    };
    const before = buffers(), model = models.prepareScene(THREE, scene, product, new THREE.Texture());
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model, true), rim = new THREE.Box3(), point = new THREE.Vector3();
    model.traverse(object => {
      const positions = object.geometry?.getAttribute('position');
      for (let i = 0; i < (positions?.count || 0); i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
        if (point.y >= bounds.max.y - product.previewMesh.height * .02) rim.expandByPoint(point);
      }
    });
    const axis = rim.getCenter(new THREE.Vector3());
    assert.ok(Math.hypot(axis.x, axis.z) < .005, `${key}: the cylinder stays on the turn axis`);
    assert.deepEqual(buffers(), before, 'only the parent pivot moves; UVs and artwork geometry remain exact');
    models.disposeScene(model);
  }
});

test('frozen provider PNG landmarks keep their exact coordinates in imported and adapted model atlases', async () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#ff9900'];
  const sources = colors.map(color => {
    const canvas = createCanvas(4, 4), context = canvas.getContext('2d');
    context.fillStyle = color; context.fillRect(0, 0, 4, 4);
    return { canvas, src: canvas.toDataURL('image/png') };
  });
  for (const [key, orientation] of [
    ['water-bottle-10798', 'default'], ['water-bottle-16030', 'default'],
    ['spiral-notebook-dotted', 'default'], ['canvas-12x16in', 'landscape'], ['mouse-pad', 'default'],
    ['all-over-basic-pillow-49853', 'default'], ['all-over-basic-pillow-49854', 'default'],
  ]) {
    const product = getPublicProduct(getProduct(key), orientation);
    for (const surface of product.printSurfaces) {
      const area = product.designSafeAreas[surface.key] || product.designSafeAreas.default;
      const extent = Math.floor(Math.min(area.width, area.height) * .07);
      const marks = [[.06, .06], [.94, .06], [.06, .94], [.94, .94], [.5, .5]]
        .map(([x, y], index) => ({ id: `mark-${index}`, type: 'image', src: sources[index].src,
          x: Math.round(area.x + area.width * x), y: Math.round(area.y + area.height * y),
          width: extent, height: extent, angle: 0 }));
      const bytes = await renderProviderPng(product, marks);
      const frozen = await loadImage(bytes);
      assert.equal(frozen.width, product.printFile.width);
      assert.equal(frozen.height, product.printFile.height);
      const dimensions = models.atlasSizeFor(product, 1024);
      const atlas = createCanvas(dimensions.width, dimensions.height), context = atlas.getContext('2d');
      const rasterAtlas = createCanvas(dimensions.width, dimensions.height), rasterContext = rasterAtlas.getContext('2d');
      const direct = target => marks.forEach(item => drawItem(target, item, {
        image: src => sources.find(source => source.src === src).canvas,
      }));
      // The independent path draws the actual fulfillment PNG; the normal
      // preview path draws the editable objects directly at print-file pixels.
      models.paintAtlas(context, dimensions, product.previewMesh, product, null, null, null, direct, direct);
      models.paintAtlas(rasterContext, dimensions, product.previewMesh, product, frozen, frozen);
      const rect = surface.key === 'back' ? product.previewMesh.back : product.previewMesh.front;
      for (const [index, item] of marks.entries()) {
        const u = item.x / product.printFile.width, v = item.y / product.printFile.height;
        const clockwise = product.previewMesh.canvas && orientation === 'landscape';
        const x = Math.floor((rect[0] + (clockwise ? 1 - v : u) * rect[2]) * dimensions.width);
        const projection = product.previewMesh.frontProjection;
        const projectedV = projection ? (v - (projection.offsetY || 0)) / (projection.scaleY || 1) : v;
        const y = Math.floor((rect[1] + (clockwise ? u : projectedV) * rect[3]) * dimensions.height);
        const expected = colors[index].slice(1).match(/../g).map(hex => parseInt(hex, 16));
        assert.deepEqual([...context.getImageData(x, y, 1, 1).data].slice(0, 3), expected,
          `${key}/${surface.key}: preview landmark ${index}`);
        assert.deepEqual([...rasterContext.getImageData(x, y, 1, 1).data].slice(0, 3), expected,
          `${key}/${surface.key}: frozen-file landmark ${index}`);
      }
      atlas.width = rasterAtlas.width = 1;
    }
  }
});

test('all source meshes paint current front/back artwork directly and clip it to the correct cells', async () => {
  const front = createCanvas(10, 10);
  const input = front.getContext('2d'); input.fillStyle = '#ff0000'; input.fillRect(0, 0, 10, 10);
  const pixel = (loaded, rect) => [...loaded.canvas.getContext('2d').getImageData(
    (rect[0] + rect[2] / 2) * loaded.canvas.width, (rect[1] + rect[3] / 2) * loaded.canvas.height, 1, 1).data].slice(0, 3);
  for (const source of PRODUCTS.filter(product => product.previewMesh)) {
    const product = getPublicProduct(source);
    let color = '#0000ff';
    const fill = (ctx, value) => {
      ctx.fillStyle = value;
      ctx.fillRect(-product.printFile.width, -product.printFile.height, product.printFile.width * 3, product.printFile.height * 3);
    };
    const loaded = await models.load(THREE, product, front, front, {
      loadScene: sceneFor, loadImage: async url => loadImage(asset(url)), createCanvas: () => createCanvas(1, 1),
      maxTextureSize: 512, drawPrint: ctx => fill(ctx, color), drawBackPrint: ctx => fill(ctx, '#ff0000'),
    });
    assert.deepEqual(pixel(loaded, product.previewMesh.front), [0, 0, 255], source.key);
    if (product.previewMesh.back) assert.deepEqual(pixel(loaded, product.previewMesh.back), [255, 0, 0]);
    if (product.previewMesh.accentCell === 2) assert.deepEqual(pixel(loaded, [0, .5, .5, .5]), [1, 3, 5].map(start => parseInt(product.previewModel.accent.slice(start, start + 2), 16)));
    color = '#00ff00'; loaded.update();
    assert.deepEqual(pixel(loaded, product.previewMesh.front), [0, 255, 0], 'edits repaint the final texture');
    if (product.previewMesh.back) assert.deepEqual(pixel(loaded, product.previewMesh.back), [255, 0, 0], 'editing front cannot replace the back');
    loaded.dispose();
  }
});

test('detailed atlases respect GPU limits and wide wrap files use less memory', () => {
  const matched = PRODUCTS.filter(product => product.previewMesh);
  for (const product of matched) for (const limit of [2048, 4096, 8192]) {
    const dimensions = models.atlasSizeFor(getPublicProduct(product), limit);
    assert.ok(dimensions.width <= Math.min(4096, limit) && dimensions.height <= Math.min(4096, limit));
    assert.equal(Math.max(dimensions.width, dimensions.height), Math.min(4096, limit));
  }
  const approved = getPublicProduct(getProduct('white-glossy-mug-duo-11oz'));
  assert.deepEqual(models.atlasSizeFor(approved), { width: 4096, height: 4096 });
  const wrap = models.atlasSizeFor(getPublicProduct(getProduct('white-glossy-mug-15oz')));
  assert.ok(wrap.width > wrap.height);
});

test('direct landscape drawing fills a rectangular atlas cell with upright geometry correspondence', () => {
  const product = getPublicProduct(getProduct('canvas-12x16in'), 'landscape');
  const atlas = createCanvas(512, 1024), ctx = atlas.getContext('2d');
  const drawPrint = target => {
    target.fillStyle = '#ff0000'; target.fillRect(0, 0, product.printFile.width, product.printFile.height / 2);
    target.fillStyle = '#0000ff'; target.fillRect(0, product.printFile.height / 2, product.printFile.width, product.printFile.height / 2);
  };
  models.paintAtlas(ctx, { width: 512, height: 1024 }, product.previewMesh, product, null, null, null, drawPrint);
  const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
  assert.deepEqual(pixel(64, 128), [0, 0, 255]);
  assert.deepEqual(pixel(192, 384), [255, 0, 0]);
});

test('all exact product/print-file matches use pinned local geometry without changing fulfillment files', () => {
  const matched = PRODUCTS.filter(product => product.previewMesh && !product.previewMesh.adaptation);
  const expected = PRODUCTS.filter(product => manifest.models.some(model => model.productId === product.printful.productId && model.printfileIds.includes(product.printful.printfileId)));
  assert.deepEqual(matched.map(product => product.key), expected.map(product => product.key));
  assert.equal(new Set(matched.map(product => product.previewMesh.id)).size, 14);
  for (const product of matched) {
    const source = manifest.models.find(model => model.id === product.previewMesh.id);
    assert.equal(source.productId, product.printful.productId);
    assert.ok(source.printfileIds.includes(product.printful.printfileId));
    assert.deepEqual(getPublicProduct(product).printFile, { ...product.printFile });
    const bytes = asset(source.file), parsed = readGlb(bytes);
    assert.equal(hash(bytes), source.sha256);
    assert.ok(!parsed.json.images && !parsed.json.textures, 'provider sample artwork is not shipped in GLBs');
    assert.ok(parsed.json.buffers.every(buffer => !buffer.uri));
    for (const mesh of parsed.json.meshes) for (const primitive of mesh.primitives) {
      assert.ok(primitive.attributes.NORMAL !== undefined && primitive.attributes.TEXCOORD_0 !== undefined);
      assert.ok(parsed.json.accessors[primitive.attributes.POSITION].count > 0);
    }
    if (source.baseAtlas) assert.equal(hash(asset(source.baseAtlas)), source.baseAtlasSha256);
  }
  for (const key of ['cork-back-coaster', 'spiral-notebook-dotted', 'all-over-basic-pillow-18in']) assert.equal(getProduct(key).previewType, '3d');
  for (const product of PRODUCTS.filter(product => product.previewModel?.kind === 'case' ||
    product.key.startsWith('travel-mug-'))) {
    assert.equal(product.previewMesh, null, product.key);
  }
});

test('smaller square cushions reuse the pinned Printful mesh at their own size without changing print contracts', async () => {
  const source = manifest.models.find(model => model.id === 'square-pillow');
  const adaptation = manifest.adaptations.find(model => model.id === 'square-pillow-small');
  assert.equal(adaptation.sourceSha256, hash(asset(source.file)));
  const contracts = require('./fixtures/printful-geometry.json').products;
  for (const [key, height] of [['all-over-basic-pillow-49853', 35.56], ['all-over-basic-pillow-49854', 40.64]]) {
    const product = getProduct(key), publicProduct = getPublicProduct(product);
    assert.equal(publicProduct.previewMesh.adaptation, adaptation.id);
    assert.equal(publicProduct.previewMesh.file, getProduct('all-over-basic-pillow-18in').previewMesh.file);
    assert.equal(publicProduct.previewMesh.height, height);
    assert.equal(publicProduct.previewMesh.accentIslands, undefined);
    const contract = contracts.find(item => item.productKey === key);
    assert.equal(product.printful.productId, contract.productId);
    assert.equal(product.printful.variantId, contract.variant.variant_id);
    assert.equal(product.printful.printfileId, contract.printfile.printfile_id);
    assert.equal(product.printFile.width, contract.printfile.width);
    assert.equal(product.printFile.height, contract.printfile.height);
    assert.deepEqual(product.printful.placements, ['front', 'back']);
    const scene = await sceneFor(publicProduct.previewMesh), buffers = [];
    scene.traverse(mesh => {
      for (const name of ['position', 'normal', 'uv']) {
        const values = mesh.geometry?.getAttribute(name)?.array;
        if (values) buffers.push([values, hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength))]);
      }
    });
    const texture = new THREE.Texture(), model = models.prepareScene(THREE, scene, publicProduct, texture);
    model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(model, true).getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.y - height) < 1e-5, `${key}: correct physical height`);
    assert.ok(Math.abs(size.x / size.y - 1) < .02, `${key}: square source proportions are retained`);
    for (const [values, before] of buffers) assert.equal(hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength)), before,
      'scaling keeps all source geometry and UV buffers unchanged');
    models.disposeScene(model); texture.dispose();
    for (const surface of product.printSurfaces) {
      const design = [{ text: surface.key, x: product.printFile.width / 2, y: product.printFile.height / 2,
        fontSize: 100, angle: 0, color: surface.key === 'front' ? '#ff0000' : '#0000ff' }];
      assert.deepEqual(await renderProviderPng(product, design),
        await renderProviderPng({ ...product, previewMesh: null }, design), `${key}/${surface.key}: fulfillment pixels stay exact`);
    }
  }
});

test('every offered 444 ml colored mug reuses the white Printful mesh and colors only the coating islands', async () => {
  const variants = PRODUCTS.filter(product => product.previewModel?.kind === 'colored-mug' && product.size.volumeMl === 444);
  const records = require('../src/productCatalogManifest.json').products.filter(product => product.kind === 'colored-mug' && product.label === '444 ml');
  assert.ok(variants.length > 0);
  assert.deepEqual(variants.map(product => product.key).sort(), records.map(product => product.key).sort());
  const white = getProduct('white-glossy-mug-15oz');
  const source = manifest.models.find(model => model.id === white.previewMesh.id);
  const adaptation = manifest.adaptations.find(model => model.id === 'colored-interior-444');
  assert.equal(adaptation.sourceSha256, hash(asset(source.file)));
  const providerColors = { 17196: '#050505', 17197: '#1e9fcd', 22373: '#1b1b51', 17200: '#e32a2d', 17199: '#f6a1b1' };
  for (const product of variants) {
    assert.equal(product.previewModel.accent, providerColors[product.printful.variantId], 'the 444 ml accent matches its Printful swatch');
    assert.equal(product.previewMesh.file, white.previewMesh.file);
    assert.equal(product.previewMesh.adaptation, adaptation.id);
    assert.equal(product.printful.productId, 403);
    assert.equal(product.printful.variantId, Number(product.key.split('-').at(-1)));
    assert.equal(product.printful.printfileId, 44);
    assert.deepEqual(product.designSafeAreas, white.designSafeAreas);
    const scene = await sceneFor(product.previewMesh), texture = new THREE.Texture();
    let mesh;
    scene.traverse(object => { if (object.isMesh) mesh = object; });
    const geometry = mesh.geometry;
    const arrays = ['position', 'normal', 'uv'].map(name => geometry.getAttribute(name).array).concat([geometry.index.array]);
    const hashes = arrays.map(values => hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength)));
    const model = models.prepareScene(THREE, scene, product, texture);
    model.updateMatrixWorld(true);
    assert.equal(mesh.material.map, texture);
    assert.equal(mesh.material.vertexColors, true);
    assert.equal(mesh.material.color.getHexString(), 'ffffff');
    for (const [name, origin, direction, accent] of [
      ['printed exterior', [0, 1.4, 3], [0, 0, -1], false],
      ['white band below the rim', [0, 2.61, 3], [0, 0, -1], false],
      ['inner walls', [.068, 1.4, 0], [-1, 0, 0], true],
      ['inner base', [.068, 1.4, 0], [0, -1, 0], true],
      ['rim', [-.88, 4, 0], [0, -1, 0], true],
      ['handle', [1.9, 1.5, 3], [0, 0, -1], true],
      ['underside', [.068, -1, 0], [0, 1, 0], false],
    ]) {
      const hit = new THREE.Raycaster(new THREE.Vector3(...origin).applyMatrix4(mesh.matrixWorld),
        new THREE.Vector3(...direction).transformDirection(mesh.matrixWorld)).intersectObject(mesh)[0];
      assert.ok(hit, product.key + ': ' + name);
      const colors = geometry.getAttribute('color');
      for (const vertex of [hit.face.a, hit.face.b, hit.face.c]) {
        const color = new THREE.Color().fromBufferAttribute(colors, vertex).getHexString();
        assert.equal(color, accent ? product.previewModel.accent.slice(1) : 'ffffff', product.key + ': ' + name);
      }
    }
    for (let index = 0; index < geometry.getAttribute('uv').count; index++) {
      if (geometry.getAttribute('uv').getX(index) < .5) {
        assert.equal(new THREE.Color().fromBufferAttribute(geometry.getAttribute('color'), index).getHexString(), 'ffffff', 'artwork cannot be tinted');
      }
    }
    assert.deepEqual(arrays.map(values => hash(Buffer.from(values.buffer, values.byteOffset, values.byteLength))), hashes,
      'positions, normals, UVs and triangle indices remain byte-identical');
    models.disposeScene(model); texture.dispose();
    const marker = createCanvas(4, 4), context = marker.getContext('2d');
    context.fillStyle = '#e600b8'; context.fillRect(0, 0, 4, 4);
    const design = [{ id: 'mug-marker', type: 'image', src: marker.toDataURL('image/png'),
      x: 1350, y: 570, width: 100, height: 100, angle: 0 }];
    const before = await renderProviderPng({ ...product, previewMesh: null }, design);
    assert.deepEqual(await renderProviderPng(product, design), before, 'preview adaptation cannot change the fulfillment PNG');
  }
  const scene = await sceneFor(white.previewMesh), texture = new THREE.Texture();
  const model = models.prepareScene(THREE, scene, white, texture);
  model.traverse(mesh => { if (mesh.isMesh) assert.equal(mesh.geometry.getAttribute('color'), undefined, 'the white variant stays white'); });
  models.disposeScene(model); texture.dispose();
});

test('geometry preparation preserves every geometry buffer and node transform while dropping only image payloads', () => {
  const original = asset(manifest.models.find(model => model.id === 'coaster').file);
  const parsed = readGlb(original), before = structuredClone(parsed.json);
  // A second preparation is a lossless geometry operation, including meshes
  // with shared/accessor buffer views and nontrivial node transforms.
  const output = readGlb(geometryOnly(parsed));
  assert.deepEqual(output.json.nodes, before.nodes);
  assert.deepEqual(output.json.meshes, before.meshes);
  for (let index = 0; index < before.accessors.length; index++) {
    const a = before.accessors[index], b = output.json.accessors[index];
    const oldView = before.bufferViews[a.bufferView], newView = output.json.bufferViews[b.bufferView];
    assert.deepEqual(parsed.binary.subarray(oldView.byteOffset || 0, (oldView.byteOffset || 0) + oldView.byteLength),
      output.binary.subarray(newView.byteOffset || 0, (newView.byteOffset || 0) + newView.byteLength));
  }
});

test('front/back, accent colour and 591 ml placement remain independent inside the provider atlases', () => {
  const front = createCanvas(100, 100), back = createCanvas(100, 100), atlas = createCanvas(400, 400);
  front.getContext('2d').fillStyle = '#ff0000'; front.getContext('2d').fillRect(0, 0, 100, 100);
  back.getContext('2d').fillStyle = '#0000ff'; back.getContext('2d').fillRect(0, 0, 100, 100);
  const ctx = atlas.getContext('2d'), pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
  for (const key of ['spiral-notebook-dotted', 'all-over-basic-pillow-18in', 'all-over-basic-pillow-9513']) {
    const product = getPublicProduct(getProduct(key));
    models.paintAtlas(ctx, 400, product.previewMesh, product, front, back);
    assert.deepEqual(pixel(100, 100), [255, 0, 0]);
    assert.deepEqual(pixel(300, 100), [0, 0, 255]);
  }
  const colored = getPublicProduct(getProduct('colored-mug-11051'));
  models.paintAtlas(ctx, 400, colored.previewMesh, colored, front, null);
  assert.deepEqual(pixel(100, 300), [23, 23, 23]);
  const large = getPublicProduct(getProduct('white-glossy-mug-20oz'));
  models.paintAtlas(ctx, 400, large.previewMesh, large, front, null);
  assert.deepEqual(pixel(200, 70), [255, 0, 0]);
  assert.deepEqual(pixel(200, 175), [255, 255, 255]);
});

test('actual pillow and notebook meshes read front and back upright, and canvas rotates artwork with its geometry', async () => {
  const front = createCanvas(200, 200), back = createCanvas(200, 200);
  for (const [canvas, color] of [[front, '#ff0000'], [back, '#0000ff']]) {
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 200, 200);
  }
  for (const key of ['all-over-basic-pillow-18in', 'all-over-basic-pillow-49853', 'all-over-basic-pillow-49854',
    'all-over-basic-pillow-9513', 'spiral-notebook-dotted', 'canvas-12x16in']) {
    const source = getProduct(key);
    for (const orientation of source.orientationOptions.length ? ['portrait', 'landscape'] : ['default']) {
      const product = getPublicProduct(source, orientation);
      const loaded = await models.load(THREE, product, front, back, { loadScene: sceneFor,
        loadImage: async url => loadImage(asset(url)), createCanvas: () => createCanvas(1, 1) });
      loaded.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(loaded.model), size = box.getSize(new THREE.Vector3());
      const uv = (x, y, reverse = false) => new THREE.Raycaster(
        new THREE.Vector3(x * size.x, y * size.y, reverse ? box.min.z - 10 : box.max.z + 10),
        new THREE.Vector3(0, 0, reverse ? 1 : -1)).intersectObject(loaded.model, true)[0].uv;
      const center = uv(0, 0), right = uv(.15, 0), up = uv(0, .15);
      if (orientation !== 'landscape') {
        assert.ok(right.x > center.x && up.y < center.y, key);
      } else {
        assert.ok(right.y > center.y && up.x > center.x, 'landscape geometry and clockwise atlas placement cancel each other');
        assert.ok(size.x > size.y);
      }
      if (product.previewMesh.back) {
        const backCenter = uv(0, 0, true), backRight = uv(-.15, 0, true), backUp = uv(0, .15, true);
        assert.ok(backCenter.x > .5 && backRight.x > backCenter.x && backUp.y < backCenter.y, key);
      }
      loaded.dispose();
    }
  }
});
