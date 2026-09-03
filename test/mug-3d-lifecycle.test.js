'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Three = require('three');

function fixture() {
  const renderers = [];
  const element = () => ({ listeners: new Map(), removed: false,
    classList: { add() {}, remove() {} },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
    remove() { this.removed = true; },
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
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
  host.prepend = canvas => { host.canvas = canvas; };
  const root = { cancelAnimationFrame() {}, requestAnimationFrame: () => 1 };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-3d-viewer'), 'utf8'), {
    window: root, document: { createElement: element },
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
