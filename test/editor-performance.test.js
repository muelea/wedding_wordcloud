'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
function source(name) {
  const start = template.indexOf(`    function ${name}(`);
  assert.ok(start >= 0);
  return template.slice(start, template.indexOf('\n    }', start) + 6);
}
function clock() {
  const timers = new Map(), frames = new Map();
  let sequence = 0, now = 0;
  return { timers, frames,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

test('continuous edits never paint a product texture or capture a stale thumbnail; settlement paints the latest design once', () => {
  const time = clock(), painted = [];
  let revision = 0, checks = 0, staleCaptures = 0;
  const page = vm.createContext({ ...time, renderFrame: null, productPreviewRenderTimer: null,
    selectedProductThumbnailTimer: time.setTimeout(() => staleCaptures++, 150),
    overlapWarnings: { schedule() { checks++; } }, renderProductPreview() { painted.push(revision); },
  });
  vm.runInContext(source('renderAll'), page);
  for (let i = 0; i < 120; i++) {
    revision++;
    page.renderAll(); page.renderAll();
    assert.equal(time.frames.size, 1);
    time.frame(); time.advance(16);
    assert.equal(painted.length, 0, 'GPU uploads must not interrupt active canvas frames');
    assert.equal(time.timers.size, 1, 'pending work remains bounded');
  }
  assert.equal(staleCaptures, 0);
  assert.equal(checks, 120, 'advisory checks retain their own debounce/cancellation behavior');
  time.advance(103);
  assert.equal(painted.length, 0, 'the last edit restarts the quiet period');
  time.advance(1);
  assert.deepEqual(painted, [120]);
  time.advance(1000);
  assert.deepEqual(painted, [120]);
});

test('the phone Canvas view skips every preview type and Product catches up with the latest artwork', () => {
  const paints = [], thumbnails = [];
  let design = ['before'];
  const page = vm.createContext({ editorElement: { hidden: false }, product: {},
    workspace: { mobileCanvas: { active: true, view: 'canvas' } },
    updateMug3DTexture() { paints.push(design); },
    paintFlatProductPreview(_canvas, _view, current) { paints.push(current); },
    flatCanvas: {}, productView: () => ({}), activeSurface: 'front', getCurrentDesign: () => design,
    scheduleSelectedProductThumbnail() { thumbnails.push(design); },
  });
  vm.runInContext(source('renderProductPreview'), page);
  for (const previewType of ['mug', '3d', 'photo', 'flat']) {
    page.product = { previewType };
    page.workspace.mobileCanvas.view = 'canvas';
    const before = paints.length;
    page.renderProductPreview(); design = [previewType, 'latest']; page.renderProductPreview();
    assert.equal(paints.length, before);
    assert.equal(thumbnails.length, before);
    page.workspace.mobileCanvas.view = 'product'; page.renderProductPreview();
    assert.equal(paints.at(-1), design);
    assert.equal(thumbnails.at(-1), design);
  }
  page.workspace.mobileCanvas.active = false; page.workspace.mobileCanvas.view = 'canvas';
  page.renderProductPreview(); assert.equal(paints.length, 5, 'ordinary desktop/phone previews still paint');
  page.editorElement.hidden = true; page.renderProductPreview(); assert.equal(paints.length, 5);
});

test('leaving or replacing a viewer cancels both queued and settled preview work', () => {
  const time = clock(); let paints = 0, destroyed = 0;
  const page = vm.createContext({ ...time, renderFrame: null, productPreviewRenderTimer: null,
    selectedProductThumbnailTimer: null, mug3DGeneration: 0, mug3DLoadPromise: null,
    mug3D: { destroy() { destroyed++; } }, overlapWarnings: null, renderProductPreview() { paints++; },
    mugViewer: { classList: { remove() {} }, querySelectorAll: () => [] },
  });
  vm.runInContext(source('renderAll') + source('destroyMug3D'), page);
  page.renderAll(); page.destroyMug3D(); time.frame(); time.advance(1000);
  assert.equal(paints, 0);
  page.renderAll(); time.frame(); page.destroyMug3D(); time.advance(1000);
  assert.equal(paints, 0); assert.equal(destroyed, 1);
  assert.equal(time.frames.size + time.timers.size, 0);
});

test('editor source meshes receive a bounded screen atlas without altering their print geometry', async () => {
  const product = require('../src/products').getPublicProduct(require('../src/products').DEFAULT_PRODUCT);
  const before = JSON.stringify(product); let options;
  const page = vm.createContext({ product, editorElement: { hidden: false }, selectedOrientation: 'default',
    mug3D: null, mug3DLoadPromise: null, mug3DGeneration: 0, mugViewer: {}, window: { THREE: {} },
    productView: () => product, setMugPreviewState() {}, console,
    Mug3DViewer: { create(input) { options = input; return { ready: Promise.resolve(true) }; } },
  });
  vm.runInContext(source('initMug3D'), page);
  await page.initMug3D();
  assert.equal(options.modelOptions.maxTextureSize, 2048);
  assert.equal(options.product, product);
  assert.equal(JSON.stringify(product), before);
});
