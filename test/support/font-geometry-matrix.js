'use strict';

// Test-only: capture real editor output on one OS and validate the exact same
// serialized designs with the production print validator on another OS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas, loadImage } = require('canvas');
const DesignFonts = require('../../src/designFonts');
const WordCloudCore = require('../../public/js/wordcloud-core');
const EmojiCatalog = require('../../public/js/emoji-catalog');
const DesignLayout = require('../../public/js/design-layout');
const { loadBrowserSvg } = require('../../src/emojiBrowserAssets');
const { PRODUCTS, resolveProductOrientation } = require('../../src/products');
const { isPrintDesignWithinBounds } = require('../../src/mugPrint');

const TEXTS = ['test', 'sonnenschein', 'größtes Glück', 'aşk ışık', 'cœur été',
  'español', 'cafe\u0301'.normalize('NFC'), '1234567890', 'W'.repeat(30), 'i'.repeat(30),
  '❤️', 'test ❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇩🇪'];

async function capture() {
  const images = new Map();
  for (const text of TEXTS) for (const run of EmojiCatalog.parse(text)) {
    if (run.type === 'emoji' && !images.has(run.asset)) {
      images.set(run.asset, await loadImage(Buffer.from(await loadBrowserSvg(run.asset))));
    }
  }
  const root = { fabric, DesignFonts, WordCloudCore, WolkenworteEmoji: {
    ...EmojiCatalog, getLoadedImage: run => images.get(run.asset), async preloadTexts() {},
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/mug-editor'), 'utf8'), { window: root });
  const records = [];
  for (const base of PRODUCTS) {
    for (const orientation of (base.orientationOptions.length ? base.orientationOptions : [{ key: 'default' }])) {
      const product = resolveProductOrientation(base, orientation.key);
      const { width, height } = product.printFile;
      const margin = product.designSafeMargin;
      const editor = Object.create(root.MugPrintEditor.prototype);
      Object.assign(editor, {
        width, height, editorScale: .25, canvasWidth: width / 4, canvasHeight: height / 4,
        printMargin: margin, margin: margin / 4, idCounter: 0,
        textInput: { value: '' }, textChangeRevision: 0,
        measureContext: createCanvas(1, 1).getContext('2d'),
        canvas: new fabric.Canvas(null, { width: width / 4, height: height / 4, enableRetinaScaling: false }),
      });
      for (const method of ['updateSelectionPanel', 'emitChange', 'recordHistory', 'flashBoundary']) editor[method] = () => {};
      const record = (label, expectedItems) => {
        const design = JSON.parse(JSON.stringify(editor.getDesign()));
        assert.equal(design.length, expectedItems, label + ': objects must not disappear');
        records.push({ id: `${product.key}/${orientation.key}/${label}`, width, height, margin, design });
        // Exercise the same reconstruction used after returning from shipping.
        editor.setDesign(design);
        const restored = JSON.parse(JSON.stringify(editor.getDesign()));
        assert.equal(restored.length, design.length);
        design.forEach((item, index) => {
          const next = restored[index];
          for (const key of ['id', 'text', 'fontFamily', 'color', 'angle']) {
            assert.equal(next[key], item[key], label + ': reload changed ' + key);
          }
          // Boundary-sized Fabric objects may be clamped by a sub-print-pixel
          // amount after rounding/reconstruction; never lose text or change font.
          for (const key of ['x', 'y', 'fontSize']) {
            assert.ok(Math.abs(next[key] - item[key]) <= 2, label + ': reload moved ' + key);
          }
        });
        records.push({ id: `${product.key}/${orientation.key}/${label}/reopened`, width, height, margin, design: restored });
      };
      try {
        for (const font of DesignFonts.FONTS) {
          for (const text of TEXTS) for (const angle of [0, 27, 90]) {
            editor.setDesign([{ id: 'text', type: 'text', text, fontFamily: font.key,
              x: width / 2, y: height / 2, fontSize: Math.min(width, height) * .8, angle, color: '#2455f5' }]);
            editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
            editor.resizeActive(1.25);
            record(`${font.key}/${text}/${angle}`, 1);
          }
          for (const [layoutName, slots] of Object.entries(product.layoutGeometry)) {
            const input = ['test', '❤️', 'größtes Glück', 'aşk ışık'].map((text, index) => ({
              id: `word-${index}`, type: 'text', text, fontFamily: font.key,
              x: 100 + index * 250, y: 200, fontSize: 100, angle: index * 5, color: '#2455f5',
            }));
            const design = DesignLayout.applyLayoutAction(input, slots, editor.measureContext,
              { fontFamily: item => DesignFonts.cssFamily(item.fontFamily) });
            editor.setDesign(design);
            record(`${font.key}/layout-${layoutName}`, design.length);
            assert.ok(design.length >= input.length, layoutName + ': all content retained');
          }
        }
      } finally { await editor.canvas.dispose(); }
    }
  }
  return { platform: process.platform, fonts: DesignFonts.FONTS.map(font => font.key), records };
}

function verify(payload) {
  const failures = payload.records.filter(({ design, width, height, margin }) =>
    !isPrintDesignWithinBounds(design, width, height, margin)).map(record => record.id);
  assert.deepEqual(failures, [], `Print validation on ${process.platform}, captured on ${payload.platform}`);
  return { capturedOn: payload.platform, verifiedOn: process.platform, fonts: payload.fonts,
    designs: payload.records.length, failures: failures.length };
}

module.exports = { capture, verify };
if (require.main === module) {
  (async () => {
    if (process.argv[2] === 'capture') {
      const payload = await capture();
      console.log(JSON.stringify(verify(payload)));
      fs.writeFileSync(process.argv[3], JSON.stringify(payload));
    } else if (process.argv[2] === 'verify') {
      console.log(JSON.stringify(verify(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')))));
    } else throw new Error('Usage: font-geometry-matrix.js capture|verify <capture.json>');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
