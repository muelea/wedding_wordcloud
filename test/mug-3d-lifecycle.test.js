'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Three = require('three');

function fixture() {
  const renderers = [];
  const element = () => ({ listeners: new Map(), removed: false, captures: new Set(), classes: new Set(),
    classList: {
      add(value) { this.owner.classes.add(value); },
      remove(value) { this.owner.classes.delete(value); },
      contains(value) { return this.owner.classes.has(value); },
      owner: null,
    },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
    setPointerCapture(id) { this.captures.add(id); },
    hasPointerCapture(id) { return this.captures.has(id); },
    releasePointerCapture(id) { this.captures.delete(id); },
    remove() { this.removed = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    getContext: () => ({ fillRect() {}, clearRect() {} }),
  });
  class Renderer {
    constructor() { this.lost = false; this.renders = 0; this.capabilities = { getMaxAnisotropy: () => 4 }; renderers.push(this); }
    setClearColor() {} setPixelRatio() {} setSize() {}
    getContext() { return { isContextLost: () => this.lost }; }
    render() { this.renders += 1; }
    dispose() { this.disposed = true; }
    forceContextLoss() { this.released = true; }
  }
  const host = element();
  host.classList.owner = host;
  host.prepend = canvas => { host.canvas = canvas; };
  const root = { devicePixelRatio: 1, cancelAnimationFrame() {}, requestAnimationFrame: () => 1 };
  const document = { createElement() {
    const created = element();
    created.classList.owner = created;
    return created;
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-3d-viewer'), 'utf8'), {
    window: root, document,
  });
  return { root, host, renderers, THREE: { ...Three, WebGLRenderer: Renderer } };
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
  assert.equal(viewer.canvas.listeners.size, 0);
  assert.equal(host.listeners.size, 0);
});

test('failed initial texture rendering releases the partial viewer instead of leaking a GPU context', () => {
  const { root, host, THREE, renderers } = fixture();
  assert.throws(() => root.Mug3DViewer.create({ host, THREE, drawTexture() { throw new Error('texture failed'); } }), /texture failed/);
  assert.equal(renderers[0].disposed, true);
  assert.equal(renderers[0].released, true);
  assert.equal(host.canvas.removed, true);
});

test('touch gestures scroll vertically and rotate horizontally only when they start on the mug', () => {
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
  assert.equal(verticalStart.prevented, false);
  assert.equal(verticalMove.prevented, false);
  assert.equal(viewer.group.rotation.x, initialX);
  assert.equal(viewer.group.rotation.y, initialY);
  assert.equal(host.classList.contains('dragging'), false);

  const horizontalStart = touch(2, 200, 150);
  pointerDown(horizontalStart);
  const horizontalMove = touch(2, 232, 152);
  pointerMove(horizontalMove);
  assert.equal(horizontalStart.prevented, false);
  assert.equal(horizontalMove.prevented, true);
  assert.equal(viewer.group.rotation.x, initialX, 'touch rotation stays horizontal');
  assert.ok(viewer.group.rotation.y > initialY);
  assert.equal(host.classList.contains('dragging'), true);
  pointerUp(touch(2, 232, 152));
  assert.equal(host.classList.contains('dragging'), false);

  const afterMugDrag = viewer.group.rotation.y;
  pointerDown(touch(3, 8, 150));
  pointerMove(touch(3, 60, 151));
  assert.equal(viewer.group.rotation.y, afterMugDrag, 'transparent viewer space stays inert');

  const mouseStart = { ...touch(4, 8, 150), pointerType: 'mouse', button: 0 };
  pointerDown(mouseStart);
  pointerMove({ ...touch(4, 8, 175), pointerType: 'mouse', button: 0 });
  assert.equal(mouseStart.prevented, true);
  assert.ok(viewer.group.rotation.x > initialX, 'desktop keeps vertical mouse rotation');
  viewer.destroy();
});
