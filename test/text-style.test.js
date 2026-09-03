'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas, loadImage } = require('canvas');
const DesignFonts = require('../src/designFonts');
const WordCloudCore = require('../public/js/wordcloud-core');
const EmojiCatalog = require('../public/js/emoji-catalog');
const MugIcons = require('../public/js/mug-icons');
const { loadBrowserSvg } = require('../src/emojiBrowserAssets');
const { buildProductPrintSvg, isPrintDesignWithinBounds } = require('../src/mugPrint');

async function createEditor(t) {
  const images = new Map();
  for (const run of EmojiCatalog.parse('❤️')) {
    if (run.type === 'emoji') {
      images.set(run.asset, await loadImage(Buffer.from(await loadBrowserSvg(run.asset))));
    }
  }
  const root = { fabric, DesignFonts, WordCloudCore, MugIcons, WolkenworteEmoji: {
    ...EmojiCatalog,
    getLoadedImage: run => images.get(run.asset),
    async preloadTexts() {},
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, {
    width: 2700, height: 1050, canvasWidth: 1350, canvasHeight: 525,
    editorScale: .5, printMargin: 24, margin: 12, idCounter: 0,
    textInput: { value: '' }, textChangeRevision: 0, history: [], historyIndex: -1,
    imageElements: new Map(), imageRefsBySource: new Map(), imageSourcesByRef: new Map(),
    measureContext: createCanvas(1, 1).getContext('2d'),
    styleButtons: { fontWeight: {}, fontStyle: {}, underline: {}, linethrough: {} },
    canvas: new fabric.Canvas(null, { width: 1350, height: 525, enableRetinaScaling: false }),
  });
  for (const method of ['updateSelectionPanel', 'emitChange', 'updateHistoryButtons',
    'flashBoundary', 'setFeedback']) editor[method] = () => {};
  t.after(() => editor.canvas.dispose());
  return editor;
}

test('whole-word styles survive selection changes, duplicate, undo, redo and reload', async t => {
  const editor = await createEditor(t);
  editor.setDesign([{ id: 'word', type: 'text', text: 'Liebe', x: 1350, y: 525,
    fontSize: 180, angle: 0, color: '#2455f5', fontFamily: 'classic' }], { resetHistory: true });
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  for (const property of ['fontWeight', 'fontStyle', 'underline', 'linethrough']) {
    editor.toggleActiveTextStyle(property);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(editor.getDesign()[0])), {
    id: 'word', x: 1350, y: 525, angle: 0, color: '#2455f5', text: 'Liebe',
    fontSize: 180, fontFamily: 'classic', fontWeight: 700, fontStyle: 'italic',
    underline: true, linethrough: true,
  });
  const styled = JSON.parse(JSON.stringify(editor.getDesign()));
  editor.duplicateActive();
  assert.equal(editor.getDesign().length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(editor.getDesign()[1])), { ...styled[0], id: editor.getDesign()[1].id,
    x: editor.getDesign()[1].x, y: editor.getDesign()[1].y });
  editor.undo();
  assert.deepEqual(JSON.parse(JSON.stringify(editor.getDesign())), styled);
  editor.redo();
  assert.equal(editor.getDesign()[1].fontWeight, 700);
  assert.equal(editor.getDesign()[1].fontStyle, 'italic');
  const saved = JSON.parse(JSON.stringify(editor.getDesign()));
  editor.setDesign(saved, { resetHistory: true });
  assert.deepEqual(JSON.parse(JSON.stringify(editor.getDesign())), saved);
});

test('mixed selections style words only and leave standalone emoji unformatted', async t => {
  const editor = await createEditor(t);
  editor.setDesign([
    { id: 'word', text: 'Liebe ❤️', x: 900, y: 525, fontSize: 160, angle: 0,
      color: '#2455f5', fontFamily: 'lora' },
    { id: 'emoji', text: '❤️', x: 1800, y: 525, fontSize: 160, angle: 0,
      color: '#d90368', fontFamily: 'lora', fontWeight: 700, fontStyle: 'italic',
      underline: true, linethrough: true },
  ], { resetHistory: true });
  editor.selectAll();
  editor.toggleActiveTextStyle('fontWeight');
  const [mixed, emoji] = editor.getDesign();
  assert.equal(mixed.fontWeight, 700);
  assert.equal(mixed.text, 'Liebe ❤️');
  assert.deepEqual({ fontWeight: emoji.fontWeight, fontStyle: emoji.fontStyle,
    underline: emoji.underline, linethrough: emoji.linethrough }, {
    fontWeight: 400, fontStyle: 'normal', underline: false, linethrough: false,
  });
});

test('all five fonts render bold styled text identically through the print contract', async () => {
  const product = { printFile: { width: 2700, height: 1050 }, designSafeMargin: 24 };
  for (const font of DesignFonts.FONTS) {
    const design = [{ id: `word-${font.key}`, type: 'text', text: 'Glück ❤️',
      x: 1350, y: 525, fontSize: 190, angle: 17, color: '#2455f5', fontFamily: font.key,
      fontWeight: 700, fontStyle: 'italic', underline: true, linethrough: true }];
    assert.equal(isPrintDesignWithinBounds(design, 2700, 1050, 24), true, font.key);
    const svg = buildProductPrintSvg(product, design);
    assert.match(svg, new RegExp(`data-font="${font.key}"`));
    assert.match(svg, /font-weight="700"/);
    assert.match(svg, /skewX\(-12\)/);
    assert.equal((svg.match(/<line /g) || []).length, 2);
    assert.match(svg, /data-emoji="2764_fe0f"/);
    assert.match(svg, /font-weight:700;font-style:normal/);
    const rendered = await loadImage(Buffer.from(svg));
    assert.equal(rendered.width, 2700);
    assert.equal(rendered.height, 1050);

    const canvas = createCanvas(600, 180);
    const context = canvas.getContext('2d');
    context.font = `400 100px ${font.cssFamily}`;
    const normalWidth = context.measureText('Wolkenworte').width;
    context.font = `700 100px ${font.cssFamily}`;
    const boldWidth = context.measureText('Wolkenworte').width;
    assert.notEqual(boldWidth, normalWidth, `${font.key}: bold face fell back to normal`);
  }
});

test('legacy text styles default safely and standalone emoji ignore meaningless styles', () => {
  const context = createCanvas(1, 1).getContext('2d');
  assert.deepEqual(WordCloudCore.textStyle({}), {
    fontWeight: 400, fontStyle: 'normal', underline: false, linethrough: false,
  });
  assert.equal(WordCloudCore.hasTextRun('❤️'), false);
  assert.equal(WordCloudCore.hasTextRun('Liebe ❤️'), true);
  const normal = WordCloudCore.measureTextBox('Wolkenworte', 100, context,
    DesignFonts.cssFamily('classic'), { fontWeight: 400 });
  const bold = WordCloudCore.measureTextBox('Wolkenworte', 100, context,
    DesignFonts.cssFamily('classic'), { fontWeight: 700 });
  assert.notEqual(normal.width, bold.width);
  assert.ok(WordCloudCore.styledTextBox(normal, { fontStyle: 'italic' }).width > normal.width);
});
