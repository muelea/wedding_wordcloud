'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas } = require('canvas');
const DesignFonts = require('../src/designFonts');
const WordCloudCore = require('../public/js/wordcloud-core');
const EmojiCatalog = require('../public/js/emoji-catalog');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');

function createEditor(scale = .5, product) {
  const { width = 2700, height = 1050 } = product?.printFile || {};
  const margin = product?.designSafeMargin ?? 24;
  const root = { fabric, DesignContentBounds: require('../public/js/design-content-bounds'), DesignFonts, WordCloudCore, WolkenworteEmoji: {
    ...EmojiCatalog, async preloadTexts() {},
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, {
    width, height, canvasWidth: width * scale, canvasHeight: height * scale,
    editorScale: scale, printMargin: margin, margin: margin * scale, idCounter: 0,
    textInput: { value: '' }, textChangeRevision: 0,
    measureContext: createCanvas(1, 1).getContext('2d'),
    canvas: new fabric.Canvas(null, { width: width * scale, height: height * scale, enableRetinaScaling: false }),
  });
  for (const method of ['updateSelectionPanel', 'emitChange', 'recordHistory', 'flashBoundary']) {
    editor[method] = () => {};
  }
  return editor;
}

test('resizing boundary-sized text commits printable geometry that stays stable after reload', async () => {
  const { getProduct, resolveProductOrientation } = require('../src/products');
  for (const product of [getProduct('white-glossy-mug-duo-11oz'),
    resolveProductOrientation(getProduct('canvas-19299'), 'landscape'),
    resolveProductOrientation(getProduct('thin-canvas-17624'), 'landscape')]) for (const scale of [.25, .5]) {
    const editor = createEditor(scale, product);
    try {
      for (const font of DesignFonts.FONTS) for (const text of ['test', 'sonnenschein', 'Ägyp']) {
        for (const angle of [0, 27, 90]) for (const fontWeight of [400, 700]) {
          const label = `${product.key}/${scale}/${font.key}/${text}/${angle}/${fontWeight}`;
          editor.setDesign([{ id: 'edge', text, x: editor.width / 2, y: editor.height / 2,
            fontSize: Math.min(editor.width, editor.height) * .8,
            color: '#2455f5', fontFamily: font.key, angle, fontWeight, underline: fontWeight === 700 }]);
          editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
          editor.resizeActive(1.25);
          const saved = editor.getDesign();
          assert.ok(isPrintDesignWithinBounds(saved, editor.width, editor.height, editor.printMargin), label + ': printable');
          editor.setDesign(saved);
          const restored = editor.getDesign()[0];
          for (const key of ['x', 'y', 'fontSize']) {
            assert.ok(Math.abs(restored[key] - saved[0][key]) <= 2, label + ': reload moved ' + key);
          }
          assert.ok(isPrintDesignWithinBounds(editor.getDesign(), editor.width, editor.height, editor.printMargin), label + ': restored');
        }
      }
    } finally { await editor.canvas.dispose(); }
  }
});

test('lengthening an editor word stays inside the exact server print bounds', async () => {
  const editor = createEditor();
  try {
    for (const font of DesignFonts.FONTS) {
      for (const angle of [0, 27, 90]) {
        editor.canvas.clear();
        const object = editor.makeObject({ id: 'word', type: 'text', text: 'sonne',
          x: 1350, y: 525, fontSize: 778.5, color: '#2455f5', fontFamily: font.key, angle });
        editor.canvas.add(object);
        editor.canvas.setActiveObject(object);
        await editor.applyTextChange(object, 'sonnenschein', { finalize: true, record: true });
        const design = editor.getDesign();
        assert.equal(isPrintDesignWithinBounds(design, 2700, 1050, 24), true,
          `${font.key} at ${angle}: ${JSON.stringify(design)}`);
      }
    }
  } finally {
    await editor.canvas.dispose();
  }
});

test('notebook manual editing respects each side’s binding and trim boundaries', async () => {
  const { getProduct } = require('../src/products');
  const product = getProduct('spiral-notebook-dotted');
  const editor = createEditor();
  Object.assign(editor, { width: 1725, height: 2625 });
  const styles = new Map();
  editor.shell = { style: { setProperty: (key,value) => styles.set(key,value) } };
  try {
    for (const side of ['front','back']) {
      const area = product.designSafeAreas[side];
      editor.setSafeArea(area);
      assert.equal(styles.get('--print-safe-left'), `${area.x/1725*100}%`);
      assert.equal(styles.get('--print-safe-right'), `${(1725-area.x-area.width)/1725*100}%`);
      for (const [x,y] of [[0,0],[1725,0],[0,2625],[1725,2625]]) {
        for (const angle of [0,27,90]) {
          editor.canvas.clear();
          const object = editor.makeObject({ id: 'edge', type: 'text', text: 'Gemeinsam',
            x,y,fontSize:450,angle,color:'#2455f5',fontFamily:'classic', fontStyle:'italic', underline:true });
          editor.canvas.add(object);
          editor.keepInside(object);
          assert.ok(isPrintDesignWithinBounds(editor.getDesign(),1725,2625,area), `${side}/${x}/${y}/${angle}`);
        }
      }
    }
  } finally { await editor.canvas.dispose(); }
});
