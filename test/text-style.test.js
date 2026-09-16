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
const {
  buildProductPrintSvg,
  buildProviderPrintSvg,
  isPrintDesignWithinBounds,
} = require('../src/mugPrint');
const { PRODUCTS, resolveProductOrientation } = require('../src/products');
const { MAX_DESIGN_ELEMENTS } = require('../public/js/cloud-limits');
const { MAX_WORD_LENGTH } = require('../src/words');

function alphaBounds(canvas, area = { x: 0, y: 0, width: canvas.width, height: canvas.height }) {
  const context = canvas.getContext('2d');
  const pixels = context.getImageData(area.x, area.y, area.width, area.height).data;
  let left = area.width;
  let top = area.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < area.height; y += 1) {
    for (let x = 0; x < area.width; x += 1) {
      if (!pixels[(y * area.width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { left, top, right, bottom };
}

function assertBoundsClose(actual, expected, label, tolerance = 1) {
  assert.ok(actual, `${label}: provider output is empty`);
  assert.ok(expected, `${label}: browser-equivalent output is empty`);
  for (const key of ['left', 'top', 'right', 'bottom']) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance,
      `${label}: ${key} ${actual[key]} vs ${expected[key]}`);
  }
}

function drawBrowserEquivalent(context, item) {
  context.save();
  context.translate(item.x, item.y);
  context.rotate((item.angle || 0) * Math.PI / 180);
  WordCloudCore.drawRichText(context, item.text, 0, 0, item.fontSize, {
    fontFamily: DesignFonts.cssFamily(item.fontFamily),
    color: item.color,
    fontWeight: item.fontWeight,
    fontStyle: item.fontStyle,
    underline: item.underline,
    linethrough: item.linethrough,
  });
  context.restore();
}

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
    editorScale: .5, printFileDpi: 300, printMargin: 24, margin: 12, idCounter: 0,
    textInput: { value: '' }, textChangeRevision: 0, history: [], historyIndex: -1,
    fontSizeInput: { value: '', valueAsNumber: NaN, disabled: true, select() {}, blur() {} },
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

test('exact point sizing updates selected text and emoji, leaves motifs unchanged and undoes once', async t => {
  const editor = await createEditor(t);
  const feedback = [];
  editor.setFeedback = (message, params) => feedback.push([message, params]);
  editor.setDesign([
    { id: 'word', text: 'Liebe', x: 650, y: 525, fontSize: 120, angle: 0,
      color: '#2455f5', fontFamily: 'classic' },
    { id: 'emoji', text: '❤️', x: 1350, y: 525, fontSize: 160, angle: 0,
      color: '#d90368', fontFamily: 'lora' },
    { id: 'motif', type: 'icon', icon: 'heart', x: 2050, y: 525, size: 140,
      angle: 0, color: '#168f83' },
  ], { resetHistory: true });
  editor.selectAll();

  const selectedText = editor.selectedObjects().filter(object => object.editorKind === 'text');
  editor.syncFontSizeInput(selectedText);
  assert.equal(editor.fontSizeInput.disabled, false);
  assert.equal(editor.fontSizeInput.value, '', 'mixed sizes use the dash placeholder');

  const historyLength = editor.history.length;
  assert.equal(editor.setActiveFontSize(11), true);
  const [word, emoji, motif] = editor.getDesign();
  assert.equal(word.fontSize, 45.8);
  assert.equal(emoji.fontSize, 45.8);
  assert.equal(motif.size, 140);
  assert.equal(editor.history.length, historyLength + 1, 'one action creates one undo step');
  assert.equal(editor.selectedObjects().length, 3, 'the mixed selection remains active');
  assert.equal(feedback.at(-1)[0], 'Schriftgröße auf {{size}} pt gesetzt');
  assert.equal(feedback.at(-1)[1].size, '11');

  editor.syncFontSizeInput(editor.selectedObjects().filter(object => object.editorKind === 'text'));
  assert.equal(editor.fontSizeInput.value, '11');
  editor.undo();
  assert.deepEqual(editor.getDesign().map(item => item.type === 'icon' ? item.size : item.fontSize),
    [120, 160, 140]);
});

test('exact point sizing rejects a value that cannot fit without changing the design', async t => {
  const editor = await createEditor(t);
  const feedback = [];
  editor.setFeedback = message => feedback.push(message);
  editor.setDesign([{ id: 'word', text: 'Wolkenworte', x: 1350, y: 525,
    fontSize: 120, angle: 0, color: '#2455f5', fontFamily: 'classic' }],
  { resetHistory: true });
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  const before = JSON.stringify(editor.getDesign());
  const historyLength = editor.history.length;

  assert.equal(editor.setActiveFontSize(1000), false);
  assert.equal(JSON.stringify(editor.getDesign()), before);
  assert.equal(editor.history.length, historyLength);
  assert.equal(feedback.at(-1), 'Diese Schriftgröße passt nicht auf die aktuelle Druckfläche.');
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
    const providerSvg = buildProviderPrintSvg(product, design);
    assert.match(providerSvg, /data-font-rendering="outlined"/);
    assert.match(providerSvg, /data-emoji="2764_fe0f"/);
    assert.doesNotMatch(providerSvg, /<text\b|@font-face|font-family=/);
    const providerRendered = await loadImage(Buffer.from(providerSvg));
    assert.equal(providerRendered.width, 2700);
    assert.equal(providerRendered.height, 1050);

    const canvas = createCanvas(600, 180);
    const context = canvas.getContext('2d');
    context.font = `400 100px ${font.cssFamily}`;
    const normalWidth = context.measureText('Wolkenworte').width;
    context.font = `700 100px ${font.cssFamily}`;
    const boldWidth = context.measureText('Wolkenworte').width;
    assert.notEqual(boldWidth, normalWidth, `${font.key}: bold face fell back to normal`);
  }
});

test('provider print freezes every offered font, style and palette color as exact glyph outlines', async () => {
  const styles = [];
  for (const fontWeight of [400, 700]) {
    for (const fontStyle of ['normal', 'italic']) {
      for (const underline of [false, true]) {
        for (const linethrough of [false, true]) {
          styles.push({ fontWeight, fontStyle, underline, linethrough });
        }
      }
    }
  }
  const colors = [...new Set(PRODUCTS[0].themes.flatMap((theme) => theme.colors))];
  const cellWidth = 220;
  const cellHeight = 150;
  const width = cellWidth * styles.length;
  const height = cellHeight * DesignFonts.FONTS.length;
  const product = { printFile: { width, height }, designSafeMargin: 0 };
  const design = DesignFonts.FONTS.flatMap((font, row) => styles.map((style, column) => ({
    id: `${font.key}-${column}`,
    type: 'text',
    text: column % 2 ? 'office' : 'AgWi',
    x: column * cellWidth + cellWidth / 2,
    y: row * cellHeight + cellHeight / 2,
    fontSize: 62,
    angle: 0,
    color: colors[(row * styles.length + column) % colors.length],
    fontFamily: font.key,
    ...style,
  })));
  const expected = createCanvas(width, height);
  const expectedContext = expected.getContext('2d');
  design.forEach((item) => drawBrowserEquivalent(expectedContext, item));

  const svg = buildProviderPrintSvg(product, design);
  assert.match(svg, /data-font-rendering="outlined"/);
  assert.doesNotMatch(svg, /<text\b|@font-face|font-family=/);
  assert.ok((svg.match(/data-outlined-text="true"/g) || []).length >= design.length);
  for (const color of colors) assert.ok(svg.includes(`fill="${color}"`), color);
  const image = await loadImage(Buffer.from(svg));
  const actual = createCanvas(width, height);
  actual.getContext('2d').drawImage(image, 0, 0);

  for (let row = 0; row < DesignFonts.FONTS.length; row += 1) {
    for (let column = 0; column < styles.length; column += 1) {
      const area = { x: column * cellWidth, y: row * cellHeight,
        width: cellWidth, height: cellHeight };
      assertBoundsClose(
        alphaBounds(actual, area),
        alphaBounds(expected, area),
        `${DesignFonts.FONTS[row].key}/${JSON.stringify(styles[column])}`
      );
    }
  }
});

test('provider print preserves representative rotations for every offered font', async () => {
  const width = 1800;
  const height = 480;
  const cellWidth = width / DesignFonts.FONTS.length;
  const product = { printFile: { width, height }, designSafeMargin: 0 };
  const angles = [-73, -27, 0, 27, 73];
  const design = DesignFonts.FONTS.map((font, index) => ({
    id: `rotation-${font.key}`,
    type: 'text',
    text: 'Drehung',
    x: index * cellWidth + cellWidth / 2,
    y: height / 2,
    fontSize: 72,
    angle: angles[index],
    color: '#123456',
    fontFamily: font.key,
    fontWeight: 700,
    fontStyle: 'italic',
    underline: true,
    linethrough: true,
  }));
  const expected = createCanvas(width, height);
  design.forEach((item) => drawBrowserEquivalent(expected.getContext('2d'), item));
  const image = await loadImage(Buffer.from(buildProviderPrintSvg(product, design)));
  const actual = createCanvas(width, height);
  actual.getContext('2d').drawImage(image, 0, 0);
  design.forEach((item, index) => {
    const area = { x: index * cellWidth, y: 0, width: cellWidth, height };
    assertBoundsClose(alphaBounds(actual, area), alphaBounds(expected, area), item.id, 2);
  });
});

test('outlined provider print stays valid on every product orientation and surface', async () => {
  for (const base of PRODUCTS) {
    const orientations = base.orientationOptions.length
      ? base.orientationOptions
      : [{ key: 'default' }];
    for (const orientation of orientations) {
      const product = resolveProductOrientation(base, orientation.key);
      for (const surface of product.printSurfaces) {
        const safe = product.designSafeAreas[surface.key];
        const item = {
          id: `${product.key}-${orientation.key}-${surface.key}`,
          type: 'text',
          text: 'Caveat',
          x: safe.x + safe.width / 2,
          y: safe.y + safe.height / 2,
          fontSize: Math.min(140, safe.width / 5, safe.height / 3),
          angle: 27,
          color: '#ed2446',
          fontFamily: 'caveat',
          fontWeight: 700,
          fontStyle: 'italic',
          underline: true,
          linethrough: true,
        };
        assert.equal(isPrintDesignWithinBounds(
          [item], product.printFile.width, product.printFile.height, safe
        ), true, item.id);
        const svg = buildProviderPrintSvg(product, [item]);
        assert.match(svg, /data-font-rendering="outlined"/);
        assert.match(svg, /data-font="caveat"/);
        assert.doesNotMatch(svg, /<text\b|@font-face|font-family=/);
      }
    }
  }
});

test('maximum allowed Caveat design remains inside the immutable artifact budget', () => {
  const product = resolveProductOrientation(
    PRODUCTS.find((candidate) => candidate.key === 'throw-blanket-50x60in'),
    'default'
  );
  const text = 'favouritepeople'.repeat(3).slice(0, MAX_WORD_LENGTH);
  const design = Array.from({ length: MAX_DESIGN_ELEMENTS }, (_, index) => ({
    id: `maximum-${index}`,
    type: 'text',
    text,
    x: product.printFile.width / 2,
    y: product.printFile.height / 2,
    fontSize: 24,
    angle: 0,
    color: '#123456',
    fontFamily: 'caveat',
    fontWeight: 700,
    fontStyle: 'italic',
    underline: true,
    linethrough: true,
  }));
  const bytes = Buffer.byteLength(buildProviderPrintSvg(product, design));
  assert.ok(bytes < 24 * 1024 * 1024, `${bytes} exceeds the private artifact limit`);
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
