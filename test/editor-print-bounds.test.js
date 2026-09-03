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

function createEditor() {
  const root = { fabric, DesignFonts, WordCloudCore, WolkenworteEmoji: {
    ...EmojiCatalog, async preloadTexts() {},
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, {
    width: 2700, height: 1050, canvasWidth: 1350, canvasHeight: 525,
    editorScale: .5, printMargin: 24, margin: 12, idCounter: 0,
    textInput: { value: '' }, textChangeRevision: 0,
    measureContext: createCanvas(1, 1).getContext('2d'),
    canvas: new fabric.Canvas(null, { width: 1350, height: 525, enableRetinaScaling: false }),
  });
  for (const method of ['updateSelectionPanel', 'emitChange', 'recordHistory', 'flashBoundary']) {
    editor[method] = () => {};
  }
  return editor;
}

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
