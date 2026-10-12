'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas } = require('canvas');
const { CanvasTouch } = require('../public/js/canvas-touch');
const DesignFonts = require('../src/designFonts');
const WordCloudCore = require('../public/js/wordcloud-core');
const EmojiCatalog = require('../public/js/emoji-catalog');
const { PRODUCTS, resolveProductOrientation } = require('../src/products');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');

function setup(t, product, side = 'front') {
  const root = { fabric, CanvasTouch, DesignFonts, WordCloudCore, WolkenworteEmoji: EmojiCatalog,
    PointerEvent: function () {}, matchMedia: () => ({ matches: true, addEventListener() {} }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const editor = Object.create(root.MugPrintEditor.prototype);
  const { width, height } = product.printFile;
  const scale = Math.min(.5, 1536 / Math.max(width, height));
  Object.assign(editor, { width, height, canvasWidth: width * scale, canvasHeight: height * scale,
    editorScale: scale, printMargin: product.designSafeMargin, safeArea: product.designSafeAreas?.[side],
    idCounter: 0, history: [], historyIndex: -1, textInput: { value: '' },
    measureContext: createCanvas(1, 1).getContext('2d'),
    canvas: new fabric.Canvas(null, { width: width * scale, height: height * scale, enableRetinaScaling: false }),
    scroll: { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 300 }) },
    shell: { getBoundingClientRect: () => ({ left: 0, top: 0, width: width * scale, height: height * scale }) },
  });
  for (const name of ['updateSelectionPanel', 'emitChange', 'flashBoundary', 'setFeedback']) editor[name] = () => {};
  editor.bindTouchEvents();
  t.after(() => editor.canvas.dispose());
  return editor;
}

test('touch transforms serialize safely for every product, orientation and print side', async t => {
  for (const base of PRODUCTS) {
    for (const orientation of base.orientationOptions.length ? ['portrait', 'landscape'] : ['default']) {
      const product = orientation === 'default' ? base : resolveProductOrientation(base, orientation);
      for (const side of product.designSafeAreas?.back ? ['front', 'back'] : ['front']) {
        const editor = setup(t, product, side), area = editor.getSafeArea();
        editor.setDesign([{ id: 'word', text: 'Gemeinsam', x: area.x + area.width / 2,
          y: area.y + area.height / 2, fontSize: Math.min(area.width, area.height) / 8,
          color: '#2455f5', fontFamily: 'classic', angle: 0 }], { resetHistory: true });
        const object = editor.canvas.getObjects()[0], center = object.getCenterPoint();
        const touch = editor.touchController;
        touch.down(99, { x: center.x, y: center.y }); touch.up(99);
        touch.down(1, { x: center.x, y: center.y });
        touch.move(1, { x: center.x + 10, y: center.y + 10 });
        touch.down(2, { x: center.x + 110, y: center.y + 10 });
        touch.move(2, { x: center.x + 10, y: center.y + 210 });
        touch.up(2); touch.up(1);
        const design = editor.getDesign();
        assert.equal(design[0].angle, 90, `${base.key}/${orientation}/${side}`);
        assert.ok(isPrintDesignWithinBounds(design, editor.width, editor.height, editor.getSafeArea()));
        assert.equal(editor.history.length, 2, 'combined drag/resize/rotate is one Undo step');
        editor.undo();
        assert.equal(editor.getDesign()[0].angle, 0);
        assert.equal(editor.historyIndex, 0);
        editor.redo();
        assert.equal(editor.getDesign()[0].angle, 90);
      }
    }
  }
});

test('a second finger on another element retains the original gesture target', t => {
  const editor = setup(t, PRODUCTS[0]);
  editor.setDesign([{ id: 'a', text: 'Liebe', x: 800, y: 500, fontSize: 100, color: '#2455f5' },
    { id: 'b', text: 'Glück', x: 1300, y: 500, fontSize: 100, color: '#2455f5' }], { resetHistory: true });
  editor.touchController.down(99, { x: 400, y: 250 }); editor.touchController.up(99);
  editor.touchController.down(1, { x: 400, y: 250 });
  editor.touchController.down(2, { x: 650, y: 250 });
  editor.touchController.move(2, { x: 800, y: 250 });
  editor.touchController.up(2); editor.touchController.up(1);
  const [a, b] = editor.getDesign();
  assert.ok(a.fontSize > 100);
  assert.equal(b.fontSize, 100);
  assert.equal(b.x, 1300);
  assert.equal(editor.canvas.getActiveObject().editorId, 'a');
});

test('large touch transforms remain printable and Undo can finish an active contact sequence', t => {
  const editor = setup(t, PRODUCTS[0]);
  editor.setDesign([{ id: 'word', text: 'Gemeinsam', x: 1350, y: 525, fontSize: 140,
    color: '#2455f5', fontFamily: 'classic' }], { resetHistory: true });
  const original = JSON.stringify(editor.getDesign());
  editor.touchController.down(99, { x: 675, y: 262.5 }); editor.touchController.up(99);
  editor.touchController.down(1, { x: 675, y: 262.5 });
  editor.touchController.down(2, { x: 725, y: 262.5 });
  editor.touchController.move(2, { x: 3000, y: 3500 });
  assert.ok(isPrintDesignWithinBounds(editor.getDesign(), editor.width, editor.height, editor.getSafeArea()));
  editor.undo();
  assert.equal(JSON.stringify(editor.getDesign()), original);
  assert.equal(editor.touchController.points.size, 0);
  editor.redo();
  assert.ok(isPrintDesignWithinBounds(editor.getDesign(), editor.width, editor.height, editor.getSafeArea()));
});

test('a locked word ignores other-word taps, moves from anywhere and stays selected through mobile Undo', async t => {
  const editor = setup(t, PRODUCTS[0]);
  editor.mobileViewport = true;
  editor.setDesign([{ id: 'a', text: 'Liebe', x: 800, y: 500, fontSize: 100, color: '#2455f5' },
    { id: 'b', text: 'Glück', x: 1300, y: 500, fontSize: 100, color: '#2455f5' }], { resetHistory: true });
  const touch = editor.touchController;
  const tap = point => { touch.down(1, point); touch.up(1); };
  tap({ x: 400, y: 250 }); tap({ x: 650, y: 250 });
  assert.equal(editor.canvas.getActiveObject().editorId, 'a');
  touch.down(1, { x: 650, y: 250 }); touch.move(1, { x: 670, y: 260 }); touch.up(1);
  assert.equal(editor.getDesign()[0].x, 840);
  assert.equal(editor.getDesign()[1].x, 1300);
  editor.undo();
  assert.equal(editor.canvas.getActiveObject().editorId, 'a');
  assert.equal(editor.getDesign()[0].x, 800);
  editor.redo();
  assert.equal(editor.canvas.getActiveObject().editorId, 'a');
  tap({ x: 420, y: 260 });
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(editor.canvas.getActiveObject(), undefined);
  tap({ x: 650, y: 250 });
  assert.equal(editor.canvas.getActiveObject().editorId, 'b');
});
