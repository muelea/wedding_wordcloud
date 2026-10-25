'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Three = require('three');

function fixture({ modelOptions = {} } = {}) {
  const renderers = [];
  const element = () => ({ listeners: new Map(), removed: false, captures: new Set(), classes: new Set(), attributes: new Map(), style: {},
    classList: {
      add(value) { this.owner.classes.add(value); },
      remove(value) { this.owner.classes.delete(value); },
      contains(value) { return this.owner.classes.has(value); },
      owner: null,
    },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    setPointerCapture(id) { this.captures.add(id); },
    hasPointerCapture(id) { return this.captures.has(id); },
    releasePointerCapture(id) { this.captures.delete(id); },
    remove() { this.removed = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    getContext: () => ({ fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      beginPath() {}, rect() {}, clip() {},
      createLinearGradient() { return { addColorStop() {} }; } }),
  });
  class Renderer {
    constructor() { this.lost = false; this.renders = 0; this.capabilities = { getMaxAnisotropy: () => 4 }; renderers.push(this); }
    setClearColor() {} setPixelRatio(value) { this.pixelRatio = value; } setSize() {}
    getContext() { return { isContextLost: () => this.lost }; }
    render() { this.renders += 1; }
    dispose() { this.disposed = true; }
    forceContextLoss() { this.released = true; }
  }
  const host = element();
  host.classList.owner = host;
  host.prepend = canvas => { host.canvas = canvas; };
  host.append = child => { host.appended = child; };
  const models = require('../public/js/printful-product-model');
  const root = { Product3DGeometry: require('../public/js/product-3d-geometry'), PrintfulProductModel: {
    load(THREE, product, front, back, options) { return models.load(THREE, product, front, back, {
      ...options, loadScene: async descriptor => {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const bytes = fs.readFileSync(require('node:path').join(__dirname, '../public', descriptor.file));
        return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
      }, loadImage: async () => ({}), createCanvas: () => document.createElement('canvas'), ...modelOptions,
    }); },
  }, devicePixelRatio: 1, cancelAnimationFrame() {}, requestAnimationFrame: () => 1 };
  const document = { createElement() {
    const created = element();
    created.classList.owner = created;
    return created;
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-3d-viewer'), 'utf8'), {
    window: root, document,
  });
  return { root, host, document, renderers, THREE: { ...Three, WebGLRenderer: Renderer } };
}

test('the real mug viewer reports context loss/restoration and releases the context when leaving', () => {
  const { root, host, THREE, renderers } = fixture();
  const states = [];
  const viewer = root.Mug3DViewer.create({ host, THREE, onStatus: state => states.push(state) });
  const renderer = renderers[0];
  renderer.lost = true;
  let prevented = false;
  viewer.canvas.listeners.get('webglcontextlost')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(states.at(-1), 'error');
  renderer.lost = false;
  viewer.canvas.listeners.get('webglcontextrestored')();
  assert.equal(states.at(-1), 'ready');
  assert.ok(renderer.renders > 1);
  viewer.destroy(); viewer.destroy();
  assert.equal(renderer.disposed, true);
  assert.equal(renderer.released, true);
  assert.equal(viewer.canvas.removed, true);
  assert.equal(viewer.interactionRegion.removed, true);
  assert.equal(viewer.canvas.listeners.size, 0);
  assert.equal(viewer.interactionRegion.listeners.size, 0);
  assert.equal(host.listeners.size, 0);
});

test('failed initial texture rendering releases the partial viewer instead of leaking a GPU context', () => {
  const { root, host, THREE, renderers } = fixture();
  assert.throws(() => root.Mug3DViewer.create({ host, THREE, drawTexture() { throw new Error('texture failed'); } }), /texture failed/);
  assert.equal(renderers[0].disposed, true);
  assert.equal(renderers[0].released, true);
  assert.equal(host.canvas.removed, true);
});

function clothFixture() {
  const f = fixture(), frames = new Map(), listeners = new Map();
  let next = 0, clock = 0, observer;
  f.root.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  f.root.cancelAnimationFrame = id => frames.delete(id);
  f.document.addEventListener = (name, callback) => listeners.set(name, callback);
  f.document.removeEventListener = name => listeners.delete(name);
  f.root.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {} disconnect() { this.disconnected = true; }
  };
  const product = require('../src/products').getPublicProduct(require('../src/products').getProduct('throw-blanket-50x60in'));
  const viewer = f.root.Mug3DViewer.create({ host: f.host, THREE: f.THREE, product, fitToView: true });
  const tick = () => { clock += 1000 / 60; const pending = [...frames]; frames.clear(); pending.forEach(([, callback]) => callback(clock)); };
  const atFabric = () => {
    viewer.scene.updateMatrixWorld(true); viewer.camera.updateMatrixWorld();
    const p = new Three.Vector3().fromBufferAttribute(viewer.cloth.mesh.geometry.attributes.position, 2000);
    viewer.cloth.mesh.localToWorld(p); p.project(viewer.camera);
    return { pointerId: 17, pointerType: 'touch', isPrimary: true, clientX: (p.x + 1) * 200, clientY: (1 - p.y) * 150,
      preventDefault() { this.prevented = true; } };
  };
  return { ...f, viewer, frames, listeners, observer, tick, atFabric };
}

test('blanket gestures pull the fabric, preserve rotation and print pixels, and stop rendering once settled', () => {
  const f = clothFixture(), { viewer, host, frames } = f;
  assert.equal(frames.size, 0, 'blanket previews are idle before a deliberate interaction');
  const uv = Array.from(viewer.cloth.mesh.geometry.attributes.uv.array), rotation = viewer.group.rotation.toArray(), camera = viewer.camera.position.clone();
  const start = f.atFabric(); host.listeners.get('pointerdown')(start);
  assert.ok(viewer.cloth.simulation.grabbed >= 0); assert.equal(start.prevented, true);
  const before = viewer.cloth.simulation.positions.slice();
  host.listeners.get('pointermove')({ ...start, clientX: start.clientX + 36, clientY: start.clientY - 25 });
  for (let i = 0; i < 20; i++) f.tick();
  assert.notDeepEqual(viewer.cloth.simulation.positions, before);
  assert.deepEqual(viewer.group.rotation.toArray(), rotation);
  assert.ok(viewer.camera.position.distanceTo(camera) < 1e-8);
  host.listeners.get('pointerup')(start);
  let count = 0; while (frames.size && count++ < 900) f.tick();
  assert.equal(frames.size, 0); assert.equal(viewer.cloth.active, false);
  assert.deepEqual(Array.from(viewer.cloth.mesh.geometry.attributes.uv.array), uv);
  const turns = viewer.group.rotation.y;
  host.listeners.get('pointerdown')({ ...start, pointerType: 'mouse', clientX: 1, clientY: 1 });
  host.listeners.get('pointermove')({ ...start, pointerType: 'mouse', clientX: 30, clientY: 1 });
  host.listeners.get('pointerup')(start); assert.notEqual(viewer.group.rotation.y, turns);
  const outside = { ...start, prevented: false, clientX: 1, clientY: 1 };
  host.listeners.get('pointerdown')(outside); assert.equal(outside.prevented, false, 'touches outside the cloth still scroll the page');
  viewer.destroy();
});

test('blanket motion pauses offscreen, releases cancelled grips, and cleans up frames, listeners and textures', () => {
  const f = clothFixture(), { viewer, host, frames, observer, listeners, renderers } = f;
  const start = f.atFabric(); host.listeners.get('pointerdown')(start); f.tick();
  host.listeners.get('lostpointercapture')(start);
  assert.equal(viewer.cloth.simulation.grabbed, -1);
  const beforeHidden = viewer.cloth.simulation.positions.slice();
  f.document.hidden = true; listeners.get('visibilitychange')();
  assert.equal(frames.size, 0); assert.deepEqual(viewer.cloth.simulation.positions, beforeHidden);
  observer.callback([{ isIntersecting: false }]); f.document.hidden = false; listeners.get('visibilitychange')();
  assert.equal(frames.size, 0);
  observer.callback([{ isIntersecting: true }]); assert.equal(frames.size, 1); f.tick();
  const key = { key: ' ', preventDefault() { this.prevented = true; } };
  host.listeners.get('keydown')(key); assert.equal(key.prevented, true); assert.equal(frames.size, 1);
  const pending = [...frames.values()][0];
  viewer.destroy(); const renders = renderers[0].renders; pending(1e6);
  assert.equal(frames.size, 0); assert.equal(listeners.size, 0); assert.equal(observer.disconnected, true);
  assert.equal(viewer.cloth.active, false); assert.equal(renderers[0].renders, renders);
  assert.equal(host.listeners.size, 0); assert.equal(host.captures.size, 0);
});

test('all 3D variants use neutral lighting and repaint their latest artwork on both sides', async () => {
  const products = require('../src/products');
  for (const source of products.PRODUCTS.filter(product => ['mug', '3d'].includes(product.previewType))) {
    const { root, host, THREE } = fixture();
    const product = products.getPublicProduct(source);
    let firstDraws = 0, editedDraws = 0, backDraws = 0;
    const viewer = root.Mug3DViewer.create({ host, THREE, product, drawTexture: () => { firstDraws++; }, drawBackTexture: () => { backDraws++; } });
    assert.equal(await viewer.ready, true, product.key);
    assert.equal(Boolean(viewer.cloth), source.previewModel?.kind === 'blanket', product.key);
    assert.equal(viewer.renderer.toneMapping, THREE.LinearToneMapping, product.key);
    assert.ok(viewer.scene.children.filter(object => object.isLight).every(light => light.color.getHex() === 0xffffff));
    assert.ok(firstDraws >= (source.previewMesh ? 2 : 1));
    const beforeBack = backDraws;
    viewer.updateTexture(() => { editedDraws++; });
    assert.equal(editedDraws, source.previewMesh ? 2 : 1, 'editing replaces the callback used by the final atlas as well');
    if (source.previewMesh?.back) assert.equal(backDraws - beforeBack, 2, 'the back also reaches its independent atlas cell');
    viewer.destroy();
  }
});

test('provider meshes receive the complete unshifted print file, including both water bottle colours', async () => {
  const products = require('../src/products');
  for (const source of products.PRODUCTS.filter(product => product.previewMesh)) {
    for (const orientation of source.orientationOptions.length ? ['portrait', 'landscape'] : ['default']) {
      const { root, host, THREE } = fixture();
      const product = products.getPublicProduct(source, orientation), calls = [];
      const draw = (_ctx, options) => calls.push(options);
      const viewer = root.Mug3DViewer.create({ host, THREE, product, drawTexture: draw, drawBackTexture: draw });
      assert.equal(await viewer.ready, true, product.key);
      viewer.updateTexture(draw);
      assert.ok(calls.length >= 2);
      for (const options of calls) {
        assert.equal(options.offsetX, 0, product.key);
        assert.equal(options.offsetY, 0, product.key + ': legacy physical shifts must not move an existing UV print area');
        assert.equal(options.printWidth, product.printFile.width);
        assert.equal(options.printHeight, product.printFile.height);
      }
      viewer.destroy();
    }
  }
  // The fallback model still maps a smaller print file into its full body.
  for (const source of products.PRODUCTS.filter(product => !product.previewMesh && product.previewModel?.printCenterY)) {
    const { root, host, THREE } = fixture(), calls = [];
    const viewer = root.Mug3DViewer.create({ host, THREE, product: products.getPublicProduct(source),
      drawTexture: (_ctx, options) => calls.push(options) });
    assert.equal(await viewer.ready, true);
    assert.notEqual(calls[0].offsetY, 0, source.key);
    viewer.destroy();
  }
});

test('portrait preview fits every verified 3D product, including rotation, and restores landscape framing', async () => {
  for (const product of require('../src/products').getPublicProducts().filter(product => ['mug', '3d'].includes(product.previewType))) {
    const { root, host, THREE } = fixture();
    let width = 844, height = 310;
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
    const viewer = root.Mug3DViewer.create({ host, THREE, product });
    assert.equal(await viewer.ready, true, product.key);
    const landscapeDistance = viewer.camera.position.length();
    width = 350; height = 650; viewer.resize();
    assert.ok(viewer.camera.position.length() > landscapeDistance);
    for (const yaw of [0, Math.PI / 2, Math.PI]) {
      viewer.group.rotation.set(Math.PI / 6, yaw, 0);
      viewer.group.updateMatrixWorld(true);
      viewer.camera.updateMatrixWorld();
      const point = new THREE.Vector3();
      viewer.group.traverse(object => {
        const positions = object.geometry?.attributes.position;
        for (let index = 0; index < (positions?.count || 0); index++) {
          point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(viewer.camera);
          assert.ok(Math.abs(point.x) < .9 && Math.abs(point.y) < .9, `${product.key}: the entire mug retains padding`);
        }
      });
    }
    width = 844; height = 310; viewer.resize();
    assert.equal(viewer.camera.position.length(), landscapeDistance);
    viewer.destroy();
  }
});

test('editor framing enlarges every mesh and keeps rotated products inside wide and narrow viewports without repainting artwork', async () => {
  const catalog = require('../src/products');
  const views = catalog.getPublicProducts().filter(product => ['mug', '3d'].includes(product.previewType))
    .flatMap(product => product.orientations.length
      ? product.orientations.map(option => catalog.getPublicProduct(catalog.getProduct(product.key), option.key)) : [product]);
  for (const product of views) {
    const { root, host, THREE } = fixture();
    let width = 500, height = 440, draws = 0;
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
    const ordinary = root.Mug3DViewer.create({ host, THREE, product });
    const editor = root.Mug3DViewer.create({ host, THREE, product, fitToView: true, framingFill: () => .92,
      drawTexture() { draws++; } });
    assert.equal(await ordinary.ready, true, product.key);
    assert.equal(await editor.ready, true, product.key);
    const projectedBounds = viewer => {
      viewer.group.updateMatrixWorld(true); viewer.camera.updateMatrixWorld();
      const result = { left: 1, right: -1, top: -1, bottom: 1 }, point = new THREE.Vector3();
      viewer.group.traverse(object => {
        const positions = object.geometry?.attributes.position;
        for (let index = 0; index < (positions?.count || 0); index++) {
          point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(viewer.camera);
          result.left = Math.min(result.left, point.x); result.right = Math.max(result.right, point.x);
          result.top = Math.max(result.top, point.y); result.bottom = Math.min(result.bottom, point.y);
        }
      });
      return result;
    };
    const before = projectedBounds(ordinary), after = projectedBounds(editor);
    assert.ok((after.right - after.left) > (before.right - before.left) * 1.05, `${product.key}: editor framing retains its larger scale`);
    const painted = draws, texture = editor.texture;
    for (const size of [[500, 440], [310, 500]]) {
      [width, height] = size;
      for (const pitch of [-Math.PI / 6, 0, Math.PI / 6]) for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        editor.group.rotation.set(pitch, yaw, 0);
        editor.resize();
        const bounds = projectedBounds(editor);
        assert.ok(Object.values(bounds).every(value => Math.abs(value) <= .921), `${product.key}: no clipping at ${size}, ${pitch}, ${yaw}`);
      }
    }
    assert.equal(draws, painted, 'camera fitting cannot change print layout or artwork');
    assert.equal(editor.texture, texture);
    editor.destroy(); ordinary.destroy();
  }
});

test('adaptive clipping preserves thin poster depth precision without clipping rotated products', async () => {
  const catalog = require('../src/products');
  for (const key of ['matte-poster-50x70cm', 'framed-poster-11792', 'laptop-sleeve-10984', 'tough-case-20328']) {
    const { root, host, THREE } = fixture();
    const product = catalog.getPublicProduct(catalog.getProduct(key));
    for (const fitToView of [false, true]) {
      const viewer = root.Mug3DViewer.create({ host, THREE, product, fitToView });
      assert.equal(await viewer.ready, true);
      assert.ok(viewer.camera.near > 1, key);
      const distance = viewer.camera.position.distanceTo(viewer.group.position), n = viewer.camera.near, f = viewer.camera.far;
      const quantization = distance * distance * (f - n) / (f * n * (2 ** 24 - 1));
      assert.ok(quantization < .0001, `${key}: sub-micron depth steps resolve paper faces and accessory details`);
      for (const pitch of [-Math.PI / 6, 0, Math.PI / 6]) for (let turn = 0; turn < 8; turn++) {
        viewer.group.rotation.set(pitch, turn * Math.PI / 4, 0); viewer.render();
        viewer.group.traverse(mesh => {
          const p = mesh.geometry?.attributes.position;
          for (let i = 0; i < (p?.count || 0); i++) {
            const v = new Three.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld).project(viewer.camera);
            assert.ok(v.z >= -1 && v.z <= 1, `${key}: near/far planes retain a full turn`);
          }
        });
      }
      viewer.destroy();
    }
  }
});

test('every 3D product and orientation keeps its camera fixed through a full turn and supported tilt', async () => {
  const catalog = require('../src/products');
  const views = catalog.getPublicProducts().filter(product => ['mug', '3d'].includes(product.previewType))
    .flatMap(product => product.orientations.length
      ? product.orientations.map(option => catalog.getPublicProduct(catalog.getProduct(product.key), option.key)) : [product]);
  for (const product of views) {
    const { root, host, THREE } = fixture();
    let width = 500, height = 440;
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
    const viewer = root.Mug3DViewer.create({ host, THREE, product, fitToView: true });
    assert.equal(await viewer.ready, true, product.key);
    for (const size of [[500, 440], [310, 500]]) {
      [width, height] = size; viewer.resize();
      const camera = viewer.camera.position.clone(), direction = viewer.camera.quaternion.clone(), point = new THREE.Vector3();
      for (const pitch of [-Math.PI / 6, -.23, 0, .17, Math.PI / 6]) for (let step = 0; step < 16; step++) {
        const yaw = .13 + step * Math.PI / 8;
        viewer.group.rotation.set(pitch, yaw, 0); viewer.render();
        assert.ok(camera.distanceTo(viewer.camera.position) < 1e-8, `${product.key}: turning cannot move or zoom the camera`);
        assert.ok(direction.angleTo(viewer.camera.quaternion) < 1e-6, `${product.key}: rotation cannot move the framing center`);
        viewer.group.traverse(object => {
          const positions = object.geometry?.getAttribute('position');
          for (let i = 0; i < (positions?.count || 0); i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).project(viewer.camera);
            assert.ok(Math.abs(point.x) < .96 && Math.abs(point.y) < .96, `${product.key}: the entire product remains visible`);
          }
        });
      }
    }
    viewer.destroy();
  }
});

test('mouse-pad framing changes only with viewport proportions or the requested fill and returns exactly', async () => {
  const { root, host, THREE } = fixture();
  const product = require('../src/products').getPublicProducts().find(product => product.key === 'mouse-pad');
  let width = 500, height = 440, fill = .92, draws = 0;
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  const viewer = root.Mug3DViewer.create({ host, THREE, product, fitToView: true,
    framingFill: () => fill, drawTexture() { draws++; } });
  assert.equal(await viewer.ready, true);
  const initial = viewer.camera.position.clone(), texture = viewer.texture, painted = draws;
  const attributes = [];
  viewer.group.traverse(mesh => {
    for (const name of ['position', 'uv']) {
      const attribute = mesh.geometry?.getAttribute(name);
      if (attribute) attributes.push({ attribute, before: attribute.array.slice() });
    }
  });
  viewer.group.rotation.set(.29, 1.37, 0); viewer.render();
  assert.ok(initial.distanceTo(viewer.camera.position) < 1e-8);
  width = 310; height = 500; viewer.resize();
  assert.ok(initial.distanceTo(viewer.camera.position) > 1, 'a narrow viewport must refit the product');
  width = 500; height = 440; viewer.resize();
  assert.ok(initial.distanceTo(viewer.camera.position) < 1e-8, 'resizing back restores the original framing at any angle');
  fill = .8; viewer.render();
  const padded = viewer.camera.position.clone();
  assert.ok(padded.length() > initial.length(), 'more padding moves the camera back');
  viewer.group.rotation.set(-.21, 3.93, 0); viewer.render();
  assert.ok(padded.distanceTo(viewer.camera.position) < 1e-8);
  fill = .92; viewer.render();
  assert.ok(initial.distanceTo(viewer.camera.position) < 1e-8);
  assert.equal(viewer.texture, texture);
  assert.equal(draws, painted, 'camera changes never repaint or rearrange the artwork');
  for (const { attribute, before } of attributes) assert.deepEqual(attribute.array, before, 'mesh and UV coordinates stay exact');
  viewer.destroy();
});

test('compact purchase framing enlarges the mug without cropping rotation or leaking into other views', async () => {
  for (const product of require('../src/products').getPublicProducts().filter(product => product.previewType === 'mug')) {
    for (const size of [{ before: 247, after: 275, scale: 1.15 }, { before: 317, after: 345, scale: 1.25 }]) {
      const { root, host, THREE } = fixture();
      let width = size.before, height = 250, purchasePreview = false;
      host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
      const viewer = root.Mug3DViewer.create({ host, THREE, product,
        framingFill: () => purchasePreview ? .96 : .88 });
      assert.equal(await viewer.ready, true);
      const bounds = () => {
        viewer.group.updateMatrixWorld(true); viewer.camera.updateMatrixWorld();
        const point = new THREE.Vector3(), result = { left: 1, right: -1, top: -1, bottom: 1 };
        viewer.group.traverse(object => {
          const positions = object.geometry?.attributes.position;
          for (let index = 0; index < (positions?.count || 0); index++) {
            point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(viewer.camera);
            result.left = Math.min(result.left, point.x); result.right = Math.max(result.right, point.x);
            result.top = Math.max(result.top, point.y); result.bottom = Math.min(result.bottom, point.y);
          }
        });
        return result;
      };
      const before = bounds(), oldHeight = (before.top - before.bottom) * height;
      width = size.after; height = 302; purchasePreview = true; viewer.resize();
      const after = bounds(), purchaseDistance = viewer.camera.position.length();
      assert.ok((after.top - after.bottom) * height > oldHeight * size.scale, 'the purchase preview is noticeably larger');
      for (const pitch of [-Math.PI / 6, 0, Math.PI / 6]) {
        for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 4) {
          viewer.group.rotation.set(pitch, yaw, 0);
          const rotated = bounds();
          assert.ok(Object.values(rotated).every(value => Math.abs(value) < .98), `${product.key}: rotation retains visible padding`);
        }
      }
      width = 844; height = 310; purchasePreview = false; viewer.resize();
      const ordinary = root.Mug3DViewer.create({ host, THREE, product });
      assert.equal(await ordinary.ready, true);
      assert.equal(viewer.camera.position.length(), ordinary.camera.position.length(), 'desktop and canvas Product views keep their existing framing');
      ordinary.destroy();
      width = size.after; height = 302; purchasePreview = true; viewer.resize();
      assert.equal(viewer.camera.position.length(), purchaseDistance, 'returning to the purchase preview does not accumulate zoom');
      viewer.destroy();
    }
  }
});

test('touches on the mug exclusively rotate in both axes while transparent space remains scrollable', () => {
  const { root, host, THREE } = fixture();
  const viewer = root.Mug3DViewer.create({ host, THREE });
  const pointerDown = host.listeners.get('pointerdown');
  const pointerMove = host.listeners.get('pointermove');
  const pointerUp = host.listeners.get('pointerup');
  const touch = (pointerId, clientX, clientY) => ({
    pointerId, clientX, clientY, pointerType: 'touch', isPrimary: true,
    prevented: false,
    preventDefault() { this.prevented = true; },
  });

  const initialX = viewer.group.rotation.x;
  const initialY = viewer.group.rotation.y;
  const verticalStart = touch(1, 200, 150);
  pointerDown(verticalStart);
  const verticalMove = touch(1, 202, 182);
  pointerMove(verticalMove);
  assert.equal(verticalStart.prevented, true, 'the page gesture is stopped as soon as the mug is touched');
  assert.equal(verticalMove.prevented, true);
  assert.ok(viewer.group.rotation.x > initialX, 'vertical touch movement tilts the mug');
  assert.ok(viewer.group.rotation.y > initialY, 'diagonal touch movement still turns the mug');
  assert.equal(host.classList.contains('dragging'), true);
  pointerUp(touch(1, 202, 182));

  const afterVerticalX = viewer.group.rotation.x;
  const afterVerticalY = viewer.group.rotation.y;
  const horizontalStart = touch(2, 200, 150);
  pointerDown(horizontalStart);
  const horizontalMove = touch(2, 232, 152);
  pointerMove(horizontalMove);
  assert.equal(horizontalStart.prevented, true);
  assert.equal(horizontalMove.prevented, true);
  assert.ok(viewer.group.rotation.x > afterVerticalX);
  assert.ok(viewer.group.rotation.y > afterVerticalY);
  assert.equal(host.classList.contains('dragging'), true);
  pointerUp(touch(2, 232, 152));
  assert.equal(host.classList.contains('dragging'), false);

  const afterMugDrag = viewer.group.rotation.y;
  const outsideStart = touch(3, 8, 150);
  pointerDown(outsideStart);
  const outsideMove = touch(3, 60, 151);
  pointerMove(outsideMove);
  assert.equal(outsideStart.prevented, false);
  assert.equal(outsideMove.prevented, false);
  assert.equal(viewer.group.rotation.y, afterMugDrag, 'transparent viewer space stays inert');

  const mouseStart = { ...touch(4, 8, 150), pointerType: 'mouse', button: 0 };
  pointerDown(mouseStart);
  pointerMove({ ...touch(4, 8, 175), pointerType: 'mouse', button: 0 });
  assert.equal(mouseStart.prevented, true);
  assert.ok(viewer.group.rotation.x > afterVerticalX, 'desktop keeps vertical mouse rotation');

  assert.equal(host.appended, viewer.interactionRegion);
  assert.equal(viewer.interactionRegion.classList.contains('mug-interaction-region'), true);
  assert.ok(parseFloat(viewer.interactionRegion.style.width) > 0);
  for (const eventName of ['contextmenu', 'dragstart', 'selectstart']) {
    const nativeEvent = touch(5, 200, 150);
    viewer.interactionRegion.listeners.get(eventName)(nativeEvent);
    assert.equal(nativeEvent.prevented, true, `${eventName} is suppressed on the mug interaction region`);
  }
  viewer.destroy();
});

test('immersive product preview rotates from transparent space and restores page scrolling on exit', () => {
  const { root, host, THREE } = fixture();
  let immersive = true;
  const viewer = root.Mug3DViewer.create({ host, THREE, rotateAnywhere: () => immersive });
  const event = (id, x) => ({ pointerId: id, clientX: x, clientY: 150, pointerType: 'touch',
    isPrimary: true, preventDefault() { this.prevented = true; } });
  const before = viewer.group.rotation.y;
  const start = event(1, 8);
  host.listeners.get('pointerdown')(start);
  host.listeners.get('pointermove')(event(1, 50));
  assert.equal(start.prevented, true);
  assert.ok(viewer.group.rotation.y > before);
  host.listeners.get('pointercancel')(event(1, 50));
  assert.equal(host.classList.contains('dragging'), false);
  immersive = false;
  const after = viewer.group.rotation.y, outside = event(2, 8);
  host.listeners.get('pointerdown')(outside);
  host.listeners.get('pointermove')(event(2, 50));
  assert.equal(outside.prevented, undefined);
  assert.equal(viewer.group.rotation.y, after);
  viewer.destroy();
});

test('an original mesh finishing after navigation releases its geometry without attaching or reporting ready', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { root, host, THREE } = fixture({ modelOptions: { loadScene: () => pending } });
  const product = require('../src/products').getPublicProduct(require('../src/products').MUG_11);
  const states = [];
  const viewer = root.Mug3DViewer.create({ host, THREE, product, onStatus: state => states.push(state) });
  await Promise.resolve();
  assert.equal(viewer.loading, true);
  assert.equal(states.at(-1), 'loading');
  viewer.destroy();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  let disposed = 0;
  geometry.addEventListener('dispose', () => { disposed++; });
  finish(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  assert.equal(await viewer.ready, false);
  assert.equal(disposed, 1);
  assert.equal(viewer.group.children.length, 0);
  assert.equal(states.includes('ready'), false);
});

test('failed original-mesh loading remains an explicit error and never reveals an empty ready preview', async () => {
  const { root, host, THREE, renderers } = fixture({ modelOptions: { loadScene: async () => { throw new Error('missing asset'); } } });
  const product = require('../src/products').getPublicProduct(require('../src/products').MUG_11), states = [];
  const viewer = root.Mug3DViewer.create({ host, THREE, product, onStatus: state => states.push(state) });
  assert.equal(await viewer.ready, false);
  assert.equal(viewer.loading, false);
  assert.deepEqual(states, ['loading', 'error']);
  host.canvas.listeners.get('webglcontextrestored')();
  assert.equal(states.at(-1), 'error');
  viewer.destroy();
  assert.equal(renderers[0].released, true);
});

test('animated demos can bound pixel density and defer pointer bounds until interaction', () => {
  const { root, host, THREE, renderers } = fixture();
  root.devicePixelRatio = 3;
  const viewer = root.Mug3DViewer.create({ host, THREE, maxPixelRatio: 1.5 });
  assert.equal(renderers[0].pixelRatio, 1.5);
  let reads = 0;
  viewer.canvas.getBoundingClientRect = () => { reads++; return { left: 0, top: 0, width: 400, height: 300 }; };
  const before = renderers[0].renders;
  viewer.render({ updateInteractionRegion: false });
  assert.equal(reads, 0);
  assert.equal(renderers[0].renders, before + 1);
  viewer.render();
  assert.equal(reads, 1, 'normal rendering still refreshes pointer bounds');
  viewer.destroy();
  const defaultViewer = root.Mug3DViewer.create({ host, THREE });
  assert.equal(renderers[1].pixelRatio, 2, 'configurator keeps its existing resolution');
  defaultViewer.destroy();
});


test('full-window demo rendering stays within its pixel budget through resize', () => {
  const { root, host, THREE, renderers } = fixture();
  root.devicePixelRatio = 2;
  let width = 1920, height = 1080;
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  const viewer = root.Mug3DViewer.create({ host, THREE, maxPixelRatio: 1.5, maxRenderPixels: 1200000 });
  for (const size of [[1920, 1080], [3840, 2160], [400, 300], [1080, 1920]]) {
    [width, height] = size; viewer.resize();
    const ratio = renderers[0].pixelRatio;
    assert.ok(Math.floor(width * ratio) * Math.floor(height * ratio) <= 1200000);
    assert.ok(ratio <= 1.5);
    if (width === 400) assert.equal(ratio, 1.5, 'small previews retain their existing sharpness');
    assert.equal(viewer.camera.aspect, width / height, 'render budget preserves framing proportions');
  }
  viewer.destroy();
});
