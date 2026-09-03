'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createCanvas } = require('canvas');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');
const MugIcons = require('../public/js/mug-icons.js');
const DesignLayout = require('../public/js/design-layout.js');
const DesignFonts = require('../public/js/design-fonts.js');
const ImagePrintQuality = require('../public/js/image-quality.js');
const EmojiCatalog = require('../public/js/emoji-catalog.js');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const { publicAssetUrl } = require('../src/publicAssets');
const { PRODUCTS, getProduct, resolveProductOrientation } = require('../src/products');
const { buildProductPrintSvg, isPrintDesignWithinBounds } = require('../src/mugPrint');

const mugEditorBrowserRoot = {};
vm.runInNewContext(
  fs.readFileSync(require.resolve('../public/js/mug-editor.js'), 'utf8'),
  { window: mugEditorBrowserRoot }
);
const { MugPrintEditor } = mugEditorBrowserRoot;

function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 2000);
    socket.once('word-update', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function submitWord(socket, word) {
  return new Promise((resolve, reject) => {
    // The first submission can take nearly two seconds against remote
    // Postgres. This checks print behavior, not submission latency.
    const timer = setTimeout(() => reject(new Error(`submission timed out: ${word}`)), 5000);
    socket.once('word-accepted', (accepted) => {
      clearTimeout(timer);
      resolve(accepted);
    });
    socket.emit('submit-word', word);
  });
}

function oneSurfaceDesign(design) {
  return { designs: { default: design } };
}

test('duplicating a selection respects the design limit atomically and preserves existing objects', () => {
  const editor = Object.create(MugPrintEditor.prototype);
  const objects = Array.from({ length: 799 }, (_, id) => ({ id }));
  const feedback = [];
  editor.canvas = {
    getObjects: () => objects,
    discardActiveObject() {},
    add: (...copies) => objects.push(...copies),
    requestRenderAll() {},
  };
  editor.nextId = () => String(objects.length);
  editor.makeObject = item => item;
  editor.setActiveObjects = copies => copies;
  editor.keepInside = editor.recordHistory = editor.emitChange = editor.updateSelectionPanel = () => {};
  editor.setFeedback = (message, params) => feedback.push({ message, params });
  const selected = Array.from({ length: 401 }, (_, id) => ({ id: String(id), x: 50, y: 50 }));
  assert.equal(editor.duplicateDesignItems(selected).length, 401);
  assert.equal(objects.length, 1200);
  const before = JSON.stringify(objects);
  assert.equal(editor.duplicateDesignItems(selected).length, 0);
  editor.addWord();
  assert.equal(JSON.stringify(objects), before, 'no partial insertion or existing-object mutation');
  assert.equal(feedback.length, 2);
  assert.equal(feedback[0].params.count, 1200);
});

test('double-clicking emoji text focuses the dedicated editor field', () => {
  const calls = [];
  const editor = Object.create(MugPrintEditor.prototype);
  editor.canvas = {
    setActiveObject: (object) => calls.push(['activate', object]),
    requestRenderAll: () => calls.push(['render']),
  };
  editor.textInput = {
    focus: () => calls.push(['focus']),
    select: () => calls.push(['select']),
  };
  editor.updateSelectionPanel = () => calls.push(['sync']);
  const emojiText = { editorKind: 'text', editorText: '💍 Hochzeit' };

  assert.equal(editor.beginTextEditing(emojiText), true);
  assert.deepEqual(calls, [
    ['activate', emojiText],
    ['sync'],
    ['focus'],
    ['select'],
    ['render'],
  ]);
});

test('double-clicking plain text keeps direct canvas editing', () => {
  const calls = [];
  const editor = Object.create(MugPrintEditor.prototype);
  editor.canvas = {
    setActiveObject: (object) => calls.push(['activate', object]),
    requestRenderAll: () => calls.push(['render']),
  };
  editor.textInput = {
    focus: () => calls.push(['toolbar-focus']),
    select: () => calls.push(['toolbar-select']),
  };
  editor.updateSelectionPanel = () => calls.push(['sync']);
  const plainText = {
    editorKind: 'text',
    enterEditing: () => calls.push(['enter-editing']),
    selectAll: () => calls.push(['select-all']),
    hiddenTextarea: { focus: () => calls.push(['canvas-focus']) },
  };

  assert.equal(editor.beginTextEditing(plainText), true);
  assert.deepEqual(calls, [
    ['activate', plainText],
    ['enter-editing'],
    ['select-all'],
    ['canvas-focus'],
    ['sync'],
    ['render'],
  ]);
});

test('ending a text sheet commits normalization and an undoable history entry', async () => {
  const editor = Object.create(MugPrintEditor.prototype);
  const active = { editorKind: 'text' };
  const calls = [];
  editor.canvas = { getActiveObject: () => active };
  editor.textInput = { value: 'edited 🎲' };
  editor.applyTextChange = async (...args) => calls.push(args);
  await editor.commitTextInput();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], active);
  assert.equal(calls[0][1], 'edited 🎲');
  assert.equal(calls[0][2].finalize, true);
  assert.equal(calls[0][2].record, true);
});

test('compact text editing does not leave Fabric inline editing active', () => {
  const editor = Object.create(MugPrintEditor.prototype);
  const calls = [];
  editor.canvas = { setActiveObject() {}, requestRenderAll() {} };
  editor.updateSelectionPanel = () => calls.push('sync');
  editor.openTextEditor = () => { calls.push('sheet'); return true; };
  const object = { editorKind: 'text', isEditing: true, enterEditing() {},
    exitEditing: () => calls.push('exit-inline') };
  assert.equal(editor.beginTextEditing(object), true);
  assert.deepEqual(calls, ['sync', 'sheet', 'exit-inline']);
});

test('the configurator adds a picked emoji as a standalone editable design object', async () => {
  const calls = [];
  mugEditorBrowserRoot.DesignFonts = DesignFonts;
  mugEditorBrowserRoot.WolkenworteEmoji = {
    canonicalizeText: EmojiCatalog.canonicalizeText,
    parse: EmojiCatalog.parse,
    preloadTexts: async (values) => calls.push(['preload', values]),
  };
  const editor = Object.create(MugPrintEditor.prototype);
  editor.palette = ['#9c1c4c'];
  editor.defaultX = 600;
  editor.defaultY = 240;
  editor.idCounter = 0;
  editor.canvas = {
    getObjects: () => [],
    add: (object) => calls.push(['add', object]),
    setActiveObject: (object) => calls.push(['activate', object]),
    requestRenderAll: () => calls.push(['render']),
  };
  let designItem = null;
  const object = {
    left: 300,
    top: 120,
    set(updates) { Object.assign(this, updates); },
  };
  editor.makeObject = (item) => {
    designItem = item;
    return object;
  };
  editor.closeIconPicker = () => calls.push(['close-icons']);
  editor.closeFontPicker = () => calls.push(['close-fonts']);
  editor.keepInside = (item) => calls.push(['bound', item]);
  editor.recordHistory = () => calls.push(['history']);
  editor.emitChange = () => calls.push(['change']);
  editor.updateSelectionPanel = () => calls.push(['sync']);
  editor.setFeedback = (source) => calls.push(['feedback', source]);

  assert.equal(await editor.addEmoji('🫶🏽'), object);
  assert.equal(designItem.type, 'text');
  assert.equal(designItem.text, '🫶🏽');
  assert.equal(designItem.x, 600);
  assert.equal(designItem.y, 240);
  assert.equal(designItem.fontSize, 170);
  assert.equal(designItem.fontFamily, DesignFonts.DEFAULT_FONT_KEY);
  assert.match(designItem.id, /^emoji-/);
  assert.equal(calls[0][0], 'preload');
  assert.equal(calls[0][1].length, 1);
  assert.equal(calls[0][1][0], '🫶🏽');
  assert.ok(calls.some(([name]) => name === 'add'));
  assert.ok(calls.some(([name]) => name === 'activate'));
  assert.deepEqual(calls.at(-1), ['feedback', 'Emoji hinzugefügt']);
  await assert.rejects(() => editor.addEmoji('Liebe ❤️'), /single supported emoji/);
});

test('uploaded-image quality follows effective print DPI and product targets', () => {
  const optimal = ImagePrintQuality.evaluate({
    sourceWidth: 1200,
    sourceHeight: 600,
    printWidth: 1200,
    printHeight: 600,
    printFileDpi: 300,
  });
  assert.deepEqual(optimal, {
    effectiveDpi: 300,
    targetDpi: 300,
    minimumDpi: 150,
    widthCm: 10.16,
    heightCm: 5.08,
    level: 'optimal',
  });

  const goodForFineDetail = ImagePrintQuality.evaluate({
    sourceWidth: 1200,
    sourceHeight: 600,
    printWidth: 2400,
    printHeight: 1200,
    printFileDpi: 300,
  });
  assert.equal(goodForFineDetail.effectiveDpi, 150);
  assert.equal(goodForFineDetail.level, 'good');

  const goodForLargeFormat = ImagePrintQuality.evaluate({
    sourceWidth: 960,
    sourceHeight: 480,
    printWidth: 1200,
    printHeight: 600,
    printFileDpi: 150,
  });
  assert.equal(goodForLargeFormat.effectiveDpi, 120);
  assert.equal(goodForLargeFormat.minimumDpi, 120);
  assert.equal(goodForLargeFormat.level, 'good');

  const low = ImagePrintQuality.evaluate({
    sourceWidth: 600,
    sourceHeight: 300,
    printWidth: 1800,
    printHeight: 900,
    printFileDpi: 300,
  });
  assert.equal(low.effectiveDpi, 100);
  assert.equal(low.level, 'low');
  assert.equal(ImagePrintQuality.evaluate({ sourceWidth: 0 }), null);
});

function automaticFitAreaDesign(product, words) {
  const context = createCanvas(10, 10).getContext('2d');
  const slots = product.layoutGeometry['fit-area'];
  assert.ok(Array.isArray(slots) && slots.length, `${product.key} must expose its initial fit-area`);
  const design = [];
  slots.forEach((slot, slotIndex) => {
    const width = slot.width || slot.side;
    const height = slot.height || slot.side;
    const placed = WordCloudCore.layoutWordsInArea(
      words,
      width,
      height,
      context,
      WordCloudCore.makeColorAssigner('pastel')
    );
    placed.forEach((item, itemIndex) => design.push({
      id: `fit-area-${slotIndex + 1}-${itemIndex + 1}`,
      text: item.word,
      x: Math.round((slot.x + item.x) * 10) / 10,
      y: Math.round((slot.y + item.y) * 10) / 10,
      fontSize: Math.round(item.fontPx * 10) / 10,
      angle: item.rotated ? -90 : 0,
      color: item.color,
      fontFamily: DesignFonts.DEFAULT_FONT_KEY,
    }));
  });
  return design;
}

test('automatic fit-area geometry is accepted by every product and orientation', () => {
  const sparse = [['liebe', 1]];
  for (const baseProduct of PRODUCTS) {
    const orientations = baseProduct.orientationOptions.length
      ? baseProduct.orientationOptions : [{ key: 'default' }];
    for (const orientation of orientations) {
      const product = resolveProductOrientation(baseProduct, orientation.key);
      const design = automaticFitAreaDesign(product, sparse);
      assert.equal(design.length, sparse.length, `${product.key}/${orientation.key} keeps the sparse cloud`);
      assert.equal(
        isPrintDesignWithinBounds(
          design,
          product.printFile.width,
          product.printFile.height,
          product.designSafeMargin
        ),
        true,
        `${product.key}/${orientation.key} browser layout must satisfy server print bounds`
      );
      assert.doesNotThrow(() => buildProductPrintSvg(product, design));
    }
  }

  const dense = [
    ['liebe', 15], ['glück', 12], ['humor', 11], ['vertrauen', 10],
    ['abenteuer', 9], ['freundschaft', 8], ['zusammenhalt', 7], ['familie', 6],
    ['reisen', 5], ['musik', 4], ['tanzen', 4], ['respekt', 3],
    ['wärme', 3], ['zukunft', 2], ['romantik', 2], ['gemeinsam', 1],
  ];
  for (const [productKey, orientation] of [
    ['white-glossy-mug-duo-11oz', 'default'],
    ['matte-poster-30x40cm', 'portrait'],
    ['matte-poster-30x40cm', 'landscape'],
  ]) {
    const product = resolveProductOrientation(getProduct(productKey), orientation);
    const design = automaticFitAreaDesign(product, dense);
    assert.equal(design.length, dense.length, `${productKey}/${orientation} keeps the dense cloud`);
    assert.equal(
      isPrintDesignWithinBounds(
        design,
        product.printFile.width,
        product.printFile.height,
        product.designSafeMargin
      ),
      true,
      `${productKey}/${orientation} dense browser layout must satisfy server print bounds`
    );
  }
});

test('every placement action can be applied repeatedly to the complete current design', () => {
  const measurementContext = {
    font: '',
    measureText(text) {
      const fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1]) || 12;
      return { width: String(text).length * fontSize * .55 };
    },
  };
  const currentDesign = [
    { id: 'wort-ausgang', text: 'Liebe', x: 25, y: 40, fontSize: 18, angle: 0, color: '#a40e4c' },
    { id: 'wort-ergaenzt', text: 'Zusammenhalt', x: 75, y: 60, fontSize: 14, angle: -8, color: '#168f83' },
    { id: 'motiv-ergaenzt', type: 'icon', icon: 'heart', x: 50, y: 75, size: 20, angle: 5, color: '#d90368' },
    { id: 'bild-ergaenzt', type: 'image', src: 'data:image/png;base64,upload', x: 60, y: 45, width: 40, height: 30, angle: -4 },
  ];
  const actions = {
    single: [{ x: 10, y: 20, width: 200, height: 120 }],
    'both-sides': [
      { x: 0, y: 0, width: 80, height: 80 },
      { x: 120, y: 0, width: 80, height: 80 },
    ],
    'full-wrap': [{ x: 5, y: 10, width: 240, height: 90 }],
    centered: [{ x: 50, y: 30, width: 120, height: 120 }],
    'fit-area': [{ x: 10, y: 20, width: 800, height: 500, optimize: true }],
  };

  for (const [key, slots] of Object.entries(actions)) {
    const applied = DesignLayout.applyLayoutAction(currentDesign, slots, measurementContext);
    const expectedLength = key === 'both-sides' ? currentDesign.length * 2 : currentDesign.length;
    assert.equal(applied.length, expectedLength, `${key} must preserve the complete design`);
    assert.equal(new Set(applied.map((item) => item.id)).size, applied.length);

    const edited = applied.map((item, index) => index === 0
      ? { ...item, x: item.x + 19, y: item.y + 11, fontSize: item.fontSize + 7 }
      : { ...item });
    const appliedAgain = DesignLayout.applyLayoutAction(edited, slots, measurementContext);
    assert.equal(appliedAgain.length, expectedLength, `${key} must be safe to execute again`);
    assert.deepEqual(
      [...appliedAgain.map((item) => item.id)].sort(),
      [...applied.map((item) => item.id)].sort(),
      `${key} must not add or remove elements when repeated`
    );
    assert.notDeepEqual(appliedAgain, edited, `${key} must process the edited canvas again`);
    const image = appliedAgain.find((item) => item.id.startsWith('bild-ergaenzt'));
    assert.equal(image.type, 'image');
    assert.ok(image.width > 0 && image.height > 0, `${key} must preserve uploaded-image geometry`);
  }
});

test('area optimization fills the target with the complete current design', () => {
  const measurementContext = {
    font: '',
    measureText(text) {
      const fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1]) || 12;
      return { width: String(text).length * fontSize * .55 };
    },
  };
  const currentDesign = [
    { id: 'wort-a', text: 'Liebe', x: 40, y: 40, fontSize: 18, angle: 0, color: '#a40e4c' },
    { id: 'wort-b', text: 'Wir', x: 55, y: 55, fontSize: 14, angle: -8, color: '#168f83' },
    { id: 'motiv-a', type: 'icon', icon: 'heart', x: 45, y: 60, size: 48, angle: 5, color: '#d90368' },
  ];
  const target = [{ x: 100, y: 200, width: 800, height: 500, optimize: true }];
  const optimized = DesignLayout.optimizeDesign(currentDesign, target, measurementContext, {
    fontFamily: 'Georgia',
  });

  assert.deepEqual(optimized.map((item) => item.id), currentDesign.map((item) => item.id));
  assert.deepEqual(optimized.map((item) => item.color), currentDesign.map((item) => item.color));
  assert.deepEqual(optimized.map((item) => item.angle), currentDesign.map((item) => item.angle));
  assert.ok(optimized[0].fontSize > currentDesign[0].fontSize * 2);
  assert.ok(optimized.every((item) => item.x >= 100 && item.x <= 900));
  assert.ok(optimized.every((item) => item.y >= 200 && item.y <= 700));

  const oneWord = DesignLayout.optimizeDesign(
    [{ id: 'solo', text: 'Ja', x: 10, y: 10, fontSize: 12, angle: 0, color: '#400f26' }],
    target,
    measurementContext,
    { fontFamily: 'Georgia' }
  );
  assert.ok(oneWord[0].fontSize > 400, 'a single word should grow to use the available height');
  assert.equal(oneWord[0].x, 500);
  assert.equal(oneWord[0].y, 450);

  const editedAfterOptimization = [{
    ...oneWord[0],
    x: 150,
    y: 240,
    fontSize: 24,
    color: '#168f83',
  }];
  const optimizedAgain = DesignLayout.optimizeDesign(
    editedAfterOptimization,
    target,
    measurementContext,
    { fontFamily: 'Georgia' }
  );
  assert.ok(optimizedAgain[0].fontSize > 400, 'the active option must be safe to execute again');
  assert.equal(optimizedAgain[0].x, 500);
  assert.equal(optimizedAgain[0].y, 450);
  assert.equal(optimizedAgain[0].color, '#168f83', 'manual edits remain the optimization input');
});

test('area optimization measures every text with its selected design font', () => {
  const measuredFonts = [];
  const measurementContext = {
    _font: '',
    set font(value) {
      this._font = value;
      measuredFonts.push(value);
    },
    get font() { return this._font; },
    measureText(text) {
      const fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(this._font)?.[1]) || 12;
      return { width: String(text).length * fontSize * .5 };
    },
  };
  const design = [
    { id: 'klassisch', text: 'Liebe', x: 50, y: 50, fontSize: 24, angle: 0, color: '#a40e4c', fontFamily: 'classic' },
    { id: 'handschrift', text: 'Glück', x: 80, y: 70, fontSize: 22, angle: 0, color: '#168f83', fontFamily: 'caveat' },
  ];
  const optimized = DesignLayout.optimizeDesign(
    design,
    [{ x: 0, y: 0, width: 500, height: 300, optimize: true }],
    measurementContext,
    { fontFamily: (item) => DesignFonts.cssFamily(item.fontFamily) }
  );

  assert.equal(optimized.length, design.length);
  assert.ok(measuredFonts.some((font) => font.includes('Georgia')));
  assert.ok(measuredFonts.some((font) => font.includes('Wolkenworte Caveat')));
  assert.deepEqual(optimized.map((item) => item.fontFamily), ['classic', 'caveat']);
});

test('configurator exposes every curated product with verified Printful geometry', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Mara & Theo' });

  const empty = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(empty.status, 409, 'an empty cloud cannot be configured');

  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());
  await submitWord(socket, 'Liebe');

  const res = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.product.key, 'white-glossy-mug-duo-11oz');
  assert.deepEqual(data.product.printFile, { width: 2700, height: 1050, dpi: 300, placement: 'default' });
  assert.equal(data.product.size.volumeMl, 325);
  assert.equal(data.product.defaultQuantity, 1);
  assert.equal(data.product.minQuantity, 1);
  assert.equal(data.product.maxQuantity, 99);
  assert.equal(data.product.unitPriceCents, undefined, 'the configurator must not expose a stale fixed retail price');
  assert.deepEqual(
    data.products.map((product) => ({ key: product.key, label: product.size.label, printFile: product.printFile })),
    [
      {
        key: 'white-glossy-mug-duo-11oz',
        label: '11 oz',
        printFile: { width: 2700, height: 1050, dpi: 300, placement: 'default' },
      },
      {
        key: 'white-glossy-mug-15oz',
        label: '15 oz',
        printFile: { width: 2700, height: 1140, dpi: 300, placement: 'default' },
      },
      {
        key: 'white-glossy-mug-20oz',
        label: '20 oz',
        printFile: { width: 3071, height: 1205, dpi: 300, placement: 'default' },
      },
      {
        key: 'cork-back-coaster',
        label: '95 × 95 mm',
        printFile: {
          width: 1181, height: 1181, dpi: 300, fillMode: 'cover', placement: 'default',
        },
      },
      {
        key: 'matte-poster-30x40cm',
        label: '30 × 40 cm',
        printFile: {
          width: 3544, height: 4724, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'matte-poster-50x70cm',
        label: '50 × 70 cm',
        printFile: {
          width: 5906, height: 8268, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'framed-matte-poster-black-30x40cm',
        label: '30 × 40 cm',
        printFile: {
          width: 3600, height: 4800, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'framed-matte-poster-black-50x70cm',
        label: '50 × 70 cm',
        printFile: {
          width: 5906, height: 8268, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'all-over-tote-black-handles',
        label: '39 × 39 cm',
        printFile: {
          width: 2550, height: 2475, dpi: 150, fillMode: 'cover', placement: 'default',
        },
      },
      {
        key: 'throw-blanket-50x60in',
        label: '127 × 153 cm',
        printFile: {
          width: 9450, height: 7950, dpi: 150, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'all-over-basic-pillow-18in',
        label: '46 × 46 cm',
        printFile: {
          width: 2850, height: 2850, dpi: 150, fillMode: 'cover', placement: 'front',
        },
      },
      {
        key: 'spiral-notebook-dotted',
        label: '14,5 × 21 cm',
        printFile: {
          width: 1725, height: 2625, dpi: 300, fillMode: 'cover', placement: 'front',
        },
      },
    ]
  );
  assert.deepEqual(
    data.productFamilies.map((family) => family.key),
    ['mugs', 'posters', 'home', 'bags', 'notebooks']
  );
  assert.ok(data.productFamilies.every((family) => family.thumbnail.startsWith('/assets/product-thumbnails/')));
  const pillow = data.products.find((candidate) => candidate.key === 'all-over-basic-pillow-18in');
  assert.deepEqual(pillow.printSurfaces, [
    { key: 'front', label: 'Vorderseite' },
    { key: 'back', label: 'Rückseite' },
  ]);
  const mockupAssets = Object.fromEntries(data.products
    .filter((candidate) => candidate.previewMockup)
    .map((candidate) => [candidate.key, candidate.previewMockup.assets]));
  assert.deepEqual(mockupAssets, {
    'cork-back-coaster': { default: '/assets/product-mockups/coaster-flat.png' },
    'matte-poster-30x40cm': { default: '/assets/product-mockups/matte-poster-30x40.png' },
    'matte-poster-50x70cm': { default: '/assets/product-mockups/matte-poster-50x70.png' },
    'framed-matte-poster-black-30x40cm': {
      default: '/assets/product-mockups/framed-poster-black-30x40.png',
    },
    'framed-matte-poster-black-50x70cm': {
      default: '/assets/product-mockups/framed-poster-black-50x70.png',
    },
    'all-over-tote-black-handles': { default: '/assets/product-mockups/tote-front.jpg' },
    'throw-blanket-50x60in': {
      default: '/assets/product-mockups/throw-blanket-flat-horizontal.png',
    },
    'spiral-notebook-dotted': {
      front: '/assets/product-mockups/spiral-notebook-front.png',
      back: '/assets/product-mockups/spiral-notebook-back.png',
    },
    'all-over-basic-pillow-18in': {
      front: '/assets/product-mockups/basic-pillow-flat.png',
      back: '/assets/product-mockups/basic-pillow-flat.png',
    },
  });
  const mockupCanvases = Object.fromEntries(data.products
    .filter((candidate) => candidate.previewMockup)
    .map((candidate) => [candidate.key, candidate.previewMockup.canvas]));
  assert.deepEqual(mockupCanvases, {
    'cork-back-coaster': {
      left: 17.5, top: 17.7, width: 65.3, height: 64.9, fit: 'cover', clipPath: 'none',
    },
    'matte-poster-30x40cm': {
      left: 25, top: 17.7, width: 49.2, height: 65.5, fit: 'cover', clipPath: 'none',
    },
    'matte-poster-50x70cm': {
      left: 21.4, top: 10, width: 57.2, height: 80, fit: 'cover', clipPath: 'none',
    },
    'framed-matte-poster-black-30x40cm': {
      left: 24.1, top: 15.1, width: 51.9, height: 69.7, fit: 'cover', clipPath: 'none',
    },
    'framed-matte-poster-black-50x70cm': {
      left: 22.8, top: 11.3, width: 54.5, height: 77.4, fit: 'cover', clipPath: 'none',
    },
    'all-over-tote-black-handles': {
      left: 5,
      top: 35.5,
      width: 90,
      height: 58.5,
      fit: 'cover',
      clipPath: 'polygon(0 0, 100% 0, 96% 100%, 3% 100%)',
    },
    'throw-blanket-50x60in': {
      left: 6.3, top: 13.7, width: 86.8, height: 71.9, fit: 'cover', clipPath: 'none',
    },
    'spiral-notebook-dotted': {
      left: 19.9, top: 4.7, width: 57.6, height: 90.4, fit: 'cover', clipPath: 'none',
    },
    'all-over-basic-pillow-18in': {
      left: 17.1, top: 18.7, width: 64.8, height: 63.1, fit: 'cover', clipPath: 'none',
    },
  });
  const tote = data.products.find((candidate) => candidate.key === 'all-over-tote-black-handles');
  assert.deepEqual(
    [tote.previewMockup.width, tote.previewMockup.height],
    [700, 1000]
  );
  assert.equal(tote.previewMockup.blendMode, 'multiply');
  assert.deepEqual(
    data.product.themes.map((theme) => theme.key),
    ['konfetti', 'dopamin-pop', 'pastel', 'sage-gold', 'ocean', 'custom']
  );
  assert.ok(data.product.themes.every((theme) => theme.colors.length >= 6));
  assert.deepEqual(data.product.layouts.map((layout) => layout.key), ['single', 'both-sides', 'full-wrap', 'fit-area']);
  assert.ok(data.products.every((candidate) => {
    const fitArea = candidate.layouts.find((layout) => layout.key === 'fit-area');
    return !fitArea || fitArea.label === 'Fläche optimal nutzen';
  }));
  const poster = data.products.find((candidate) => candidate.key === 'matte-poster-30x40cm');
  assert.equal(poster.defaultOrientation, 'portrait');
  assert.deepEqual(poster.orientations.map((orientation) => orientation.key), ['portrait', 'landscape']);
  assert.deepEqual(
    poster.orientations.map((orientation) => [
      orientation.size.label,
      orientation.printFile.width,
      orientation.printFile.height,
    ]),
    [['30 × 40 cm', 3544, 4724], ['40 × 30 cm', 4724, 3544]]
  );
  const posterProducts = data.products.filter((candidate) => candidate.familyKey === 'posters');
  assert.equal(posterProducts.length, 4);
  assert.ok(posterProducts.every((candidate) =>
    candidate.orientations.map((orientation) => orientation.key).join(',') === 'portrait,landscape'
  ));
  assert.ok(data.products.filter((candidate) => candidate.familyKey !== 'posters')
    .every((candidate) => candidate.orientations.length === 0));
  assert.equal(data.product.defaultOrientation, 'default');
  assert.deepEqual(data.product.orientations, []);
  assert.deepEqual(data.product.layoutGeometry.single, [{ x: 127, y: 65, side: 920 }]);
  assert.deepEqual(data.product.layoutGeometry['full-wrap'], [{ x: 130, y: 65, width: 2440, height: 920 }]);
  assert.deepEqual(data.product.layoutGeometry['fit-area'], [{ x: 36, y: 36, width: 2628, height: 978, optimize: true }]);
  assert.deepEqual(data.words, [['liebe', 1]]);

  const db = require('../src/db');
  for (const expected of [
    { key: 'white-glossy-mug-15oz', variantId: 4830, width: 2700, height: 1140 },
    { key: 'white-glossy-mug-20oz', variantId: 16586, width: 3071, height: 1205 },
    { key: 'cork-back-coaster', variantId: 15662, width: 1181, height: 1181 },
    { key: 'matte-poster-30x40cm', variantId: 8948, width: 3544, height: 4724 },
    { key: 'matte-poster-50x70cm', variantId: 8952, width: 5906, height: 8268 },
    { key: 'framed-matte-poster-black-30x40cm', variantId: 9357, width: 3600, height: 4800 },
    { key: 'framed-matte-poster-black-50x70cm', variantId: 9358, width: 5906, height: 8268 },
    { key: 'all-over-tote-black-handles', variantId: 4533, width: 2550, height: 2475 },
    { key: 'throw-blanket-50x60in', variantId: 10986, width: 9450, height: 7950 },
    { key: 'all-over-basic-pillow-18in', variantId: 4532, width: 2850, height: 2850 },
    { key: 'spiral-notebook-dotted', variantId: 12141, width: 1725, height: 2625 },
  ]) {
    const saveResponse = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productKey: expected.key,
        quantity: 1,
        theme: 'pastel',
        words: [['liebe', 1]],
        ...productDesignPayload(expected.key),
      }),
    });
    assert.equal(saveResponse.status, 201);
    const saved = await saveResponse.json();
    const stored = await db.getConfiguration(saved.id);
    assert.equal(stored.product_key, expected.key);
    assert.equal(Number(stored.printful_variant_id), expected.variantId);
    assert.equal(Number(stored.print_width), expected.width);
    assert.equal(Number(stored.print_height), expected.height);
    const svg = await fetch(baseUrl + saved.printFileUrl).then((response) => response.text());
    assert.match(svg, new RegExp(`width="${expected.width}" height="${expected.height}"`));
  }

  const landscapeSave = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'matte-poster-30x40cm',
      orientation: 'landscape',
      quantity: 1,
      theme: 'pastel',
      words: [['liebe', 1]],
      ...productDesignPayload('matte-poster-30x40cm', 'landscape'),
    }),
  });
  assert.equal(landscapeSave.status, 201);
  const landscapeConfiguration = await landscapeSave.json();
  assert.equal(landscapeConfiguration.orientation, 'landscape');
  const storedLandscape = await db.getConfiguration(landscapeConfiguration.id);
  assert.equal(storedLandscape.orientation, 'landscape');
  assert.equal(Number(storedLandscape.printful_variant_id), 8948,
    'orientation must not create a different priced Printful variant');
  assert.equal(Number(storedLandscape.print_width), 4724);
  assert.equal(Number(storedLandscape.print_height), 3544);
  const landscapeSvg = await fetch(baseUrl + landscapeConfiguration.printFileUrl)
    .then((response) => response.text());
  assert.match(landscapeSvg, /width="4724" height="3544"/);
  const landscapeEdit = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${landscapeConfiguration.id}/edit`
  ).then((response) => response.json());
  assert.equal(landscapeEdit.orientation, 'landscape');
  assert.equal(landscapeEdit.product.size.label, '40 × 30 cm');
  assert.equal(landscapeEdit.product.printFile.width, 4724);
  assert.equal(landscapeEdit.product.printFile.height, 3544);

  const invalidOrientation = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productKey: 'matte-poster-30x40cm', orientation: 'diagonal' }),
  });
  assert.equal(invalidOrientation.status, 400);
  assert.equal((await invalidOrientation.json()).error, 'invalid_orientation');

  const threeBrowserBuild = await fetch(`${baseUrl}/vendor/three.min.js?v=0.160.1`);
  assert.equal(threeBrowserBuild.status, 200);
  assert.match(threeBrowserBuild.headers.get('cache-control') || '', /immutable/);
  assert.ok((await threeBrowserBuild.text()).length > 600000, 'the local Three.js build should be served in full');

  const sharedMugViewer = await fetch(`${baseUrl}${publicAssetUrl('/js/mug-3d-viewer.js')}`);
  assert.equal(sharedMugViewer.status, 200);
  assert.match(sharedMugViewer.headers.get('cache-control') || '', /immutable/);
  assert.match(await sharedMugViewer.text(), /Mug3DViewer/);

  assert.deepEqual(DesignFonts.FONTS.map((font) => font.key), [
    'classic', 'lora', 'montserrat', 'caveat', 'baloo-2',
  ]);
  for (const font of DesignFonts.FONTS) {
    for (const file of [font.file, font.boldFile]) {
      const bundledFont = await fetch(`${baseUrl}${publicAssetUrl(file)}`);
      assert.equal(bundledFont.status, 200, file);
      assert.match(bundledFont.headers.get('cache-control') || '', /immutable/, file);
      assert.ok((await bundledFont.arrayBuffer()).byteLength > 50000, file);
    }
  }

  const [landingPage, configurePage] = await Promise.all([
    fetch(`${baseUrl}/`).then((response) => response.text()),
    fetch(`${baseUrl}/e/${event.slug}/configure`).then((response) => response.text()),
  ]);
  assert.ok(landingPage.includes(publicAssetUrl('/js/mug-3d-viewer.js')));
  assert.match(landingPage, /x: 200, y: 450, angle: -90/);
  assert.match(landingPage, /fontSize: configuration\.fontSize \|\| Math\.round\(configuration\.displayScale \* 100\)/);
  assert.match(landingPage, /x: configuration\.x,[\s\S]*?y: configuration\.y,[\s\S]*?angle: configuration\.angle/);
  assert.ok(configurePage.includes(publicAssetUrl('/js/mug-3d-viewer.js')));
  assert.match(configurePage, /id="product-options"/);
  assert.match(configurePage, /id="variant-options"/);
  assert.match(configurePage, /id="flat-product-preview"/);
  assert.match(configurePage, /class="flat-product-composite"/);
  assert.match(configurePage, /id="flat-product-mockup"/);
  assert.match(configurePage, /class="preview-disclaimer"[^>]*>Die Vorschau dient zur Orientierung – Farben, Position und Beschnitt können auf dem fertigen Produkt leicht abweichen\.<\/p>/);
  assert.match(configurePage, /id="placement-options"/);
  assert.match(configurePage, /id="orientation-step" hidden/);
  assert.match(configurePage, /id="orientation-options"/);
  assert.match(configurePage, /function activateOrientation\(orientation\)/);
  assert.match(configurePage, /orientation: selectedOrientation/);
  assert.match(configurePage, /--product-mockup-rotation/);
  assert.match(configurePage, /id="surface-tabs"/);
  assert.match(configurePage, /id="surface-editor"[\s\S]*?class="editor-tools editor-tools-primary"[^>]*>[\s\S]*?id="editor-add"/);
  assert.match(configurePage, /id="editor-add"[\s\S]*?id="editor-emoji-toggle"[\s\S]*?id="editor-image"/);
  assert.match(configurePage, /id="editor-emoji-toggle"[^>]*aria-label="Emoji hinzufügen"/);
  assert.match(configurePage, /class="editor-motif-picker" hidden[^>]*>[\s\S]*?id="editor-icon-toggle"/);
  assert.match(configurePage, /id="selected-theme-swatches"/);
  assert.doesNotMatch(configurePage, /id="selected-theme-detail"/);
  assert.match(configurePage, /class="workspace-tools"/);
  assert.match(configurePage, /\.workspace-tools \{[\s\S]*?position: relative;[\s\S]*?z-index: 20;/);
  assert.match(configurePage, /--workspace-stage-height: clamp\(440px, 58vh, 600px\)/);
  assert.match(configurePage, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  for (const assetPath of [
    '/emoji-picker.css',
    '/js/emoji-data.js',
    '/js/emoji-catalog.js',
    '/js/emoji-search.js',
    '/js/emoji-virtual-grid.js',
    '/js/emoji-picker.js',
    '/js/wordcloud-core.js',
    '/js/design-fonts.js',
    '/js/design-layout.js',
    '/js/mug-icons.js',
    '/js/image-quality.js',
    '/js/mug-editor.js',
  ]) assert.ok(configurePage.includes(publicAssetUrl(assetPath)), assetPath);
  assert.match(configurePage, /id="editor-image"[^>]*type="button"/);
  assert.match(configurePage, /id="editor-image-input"[^>]*type="file"[^>]*accept="image\/png,image\/jpeg/);
  assert.match(configurePage, /id="editor-image-quality"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(configurePage, /printFileDpi: view\.printFile\.dpi/);
  assert.doesNotMatch(configurePage, /id="editor-font"|editor-font-select|fontSelect:/);
  assert.match(configurePage, /id="editor-font-toggle"[^>]*aria-haspopup="listbox"/);
  assert.match(configurePage, /id="editor-font-menu"[^>]*role="listbox"/);
  for (const id of ['editor-bold', 'editor-italic', 'editor-underline', 'editor-linethrough']) {
    assert.match(configurePage, new RegExp(`id="${id}"[^>]*aria-pressed="false"`));
  }
  assert.match(configurePage, /\.editor-font-toggle \{[\s\S]*?font-size: 11px;/);
  assert.match(configurePage, /setFontPickerInline: inline => mugEditor\?\.setFontPickerInline\(inline\)/);
  assert.match(configurePage, /fontButton: document\.getElementById\('editor-font-toggle'\)/);
  assert.match(configurePage, /DesignFonts\.cssFamily\(item\.fontFamily\)/);
  assert.match(configurePage, /async function ensureDesignFonts\(fontKeys\)/);
  assert.match(configurePage, /await WolkenworteConfiguratorSession\.withTimeout\(ensureDesignFonts\(\[DesignFonts\.DEFAULT_FONT_KEY\]\)\)/);
  assert.match(configurePage, /WordCloudCore\.TEXT_BASELINE_OFFSET/);
  assert.match(configurePage, /id="editor-bring-front"[^>]*aria-label="Ganz nach vorn"/);
  assert.match(configurePage, /id="editor-duplicate"[^>]*aria-label="Duplizieren"[^>]*data-editor-tooltip/);
  assert.match(configurePage, /id="editor-select-all"[^>]*aria-label="Alles auswählen"[^>]*data-editor-tooltip/);
  assert.doesNotMatch(configurePage, /Gestaltet eure persönliche Erinnerung/);
  assert.doesNotMatch(configurePage, /getElementById\('placement-step'\)\.hidden = true/);
  assert.match(configurePage, /WolkenworteConfiguratorSession\.createCart\(slug\)/);
  assert.match(configurePage, /<strong id="placement-summary-name"[^>]*>Design anordnen<\/strong>/);
  assert.match(configurePage, /Wählt eine Anordnung für euer aktuelles Design\./);
  assert.match(configurePage, /DesignLayout\.applyLayoutAction\(currentDesign, slots/);
  assert.match(configurePage, /button\.className = 'option placement-action'/);
  assert.match(configurePage, /button\.addEventListener\('click', \(\) => activatePlacement\(layout\)\)/);
  assert.match(
    configurePage,
    /const initialLayoutKey = view\.layouts\.find\(\(layout\) => layout\.key === 'fit-area'\)\?\.key \|\|/,
    'a new shared cloud must initially fill the printable product area'
  );
  assert.doesNotMatch(configurePage, /selectedPlacement/);
  assert.doesNotMatch(configurePage, /name = 'placement'/);
  assert.doesNotMatch(configurePage, /Fläche füllen/);
  assert.doesNotMatch(configurePage, /input\.addEventListener\('change',[\s\S]{0,400}mugEditor\.setDesign\(buildAutomaticDesign\(\)/);
  assert.match(configurePage, /function refreshFlatProductPreviewFit\(\)/);
  assert.match(configurePage, /function updateProductMockup\(\)/);
  assert.match(configurePage, /view\.previewMockup\.canvas\.fit === 'cover'/);
  assert.match(configurePage, /--product-mockup-canvas-clip/);
  assert.match(configurePage, /function refreshWorkspaceLayout\(\)/);
  assert.match(configurePage, /Math\.max\([\s\S]*?availableWidth \/ printAspect,[\s\S]*?availableWidth \/ previewAspect[\s\S]*?\) \+ 24/);
  assert.match(configurePage, /requestAnimationFrame\(refreshWorkspaceLayout\)/);
  assert.doesNotMatch(configurePage, /const flatPreviewHeight =/);
  assert.match(configurePage, /\.editor-scroll \{[\s\S]*?padding: 12px;[\s\S]*?border: 0;[\s\S]*?background: transparent;/);
  assert.match(configurePage, /\.editor-canvas-shell \{[\s\S]*?border: 1px solid rgba\(64, 15, 38, \.08\);[\s\S]*?box-shadow: none;/);
  assert.match(configurePage, /\.order-item \+ \.order-item::before \{[\s\S]*?rgba\(123, 70, 82, \.12\)/);
  assert.match(configurePage, /setText\(edit, isEditing \? 'Geöffnet' : 'Öffnen'\)/);
  assert.match(configurePage, /edit\.disabled = isEditing/);
  assert.match(configurePage, /edit\.setAttribute\('aria-current', 'true'\)/);
  assert.doesNotMatch(configurePage, /save-button/);
  assert.doesNotMatch(configurePage, /design-save-button/);
  assert.match(configurePage, /class="secondary-button" id="design-another" type="button"[^>]*>/);
  assert.match(configurePage, /class="primary-button continue-button" id="continue-order" type="button"[^>]*>/);
  assert.match(configurePage, /async function saveCurrentDesign\(activeButton\)/);
  assert.match(configurePage, /if \(!currentDesignNeedsSave\) return true/);
  assert.match(configurePage, /if \(await confirmLeaving\(options\)\) await action\(\)/);
  assert.match(configurePage, /await loadOrderItem\(configurationId\)/);
  assert.match(configurePage, /function saveBeforeLeaving\(event\)/);
  assert.match(configurePage, /\[brandLink, backLink\]\.forEach\(\(link\) => link\.addEventListener\('click', saveBeforeLeaving\)\)/);
  assert.match(configurePage, /location\.assign\(destination\)/);
  assert.doesNotMatch(configurePage, /location\.assign\(event\.currentTarget\.href\)/);
  assert.match(configurePage, /Euer Warenkorb/);
  assert.match(configurePage, /href="\/datenschutz" target="_blank" rel="noopener"/);
  assert.match(configurePage, /href="\/impressum" target="_blank" rel="noopener"/);
  assert.match(configurePage, /id="save-design"/);
  assert.match(configurePage, /runNavigation\(navigateToShipping, \{ shipping: true \}\)/);
  assert.match(configurePage, /const missingSurface = productSurfaces\(\)\.find/);
  assert.match(configurePage, /function createOrderItemThumbnail\(item, itemProduct\)/);
  assert.match(configurePage, /if \(fallbackUrl\) fallback\.src = fallbackUrl/);
  assert.match(configurePage, /ready = preview\.decode\(\)/);
  assert.match(configurePage, /fallback\.replaceWith\(preview\)/);
  assert.doesNotMatch(configurePage, /image\.src = item\.printFileUrl/);

  const fabricBrowserBuild = await fetch(`${baseUrl}/vendor/fabric.min.js?v=7.4.0`);
  assert.equal(fabricBrowserBuild.status, 200);
  assert.match(fabricBrowserBuild.headers.get('cache-control') || '', /immutable/);
  assert.ok((await fabricBrowserBuild.text()).length > 250000, 'the local Fabric.js build should be served in full');

  const qualityRuntime = await fetch(`${baseUrl}${publicAssetUrl('/js/image-quality.js')}`);
  assert.equal(qualityRuntime.status, 200);
  assert.match(await qualityRuntime.text(), /effectiveDpi/);

  const mugEditor = await fetch(`${baseUrl}${publicAssetUrl('/js/mug-editor.js')}`);
  assert.equal(mugEditor.status, 200);
  const mugEditorSource = await mugEditor.text();
  assert.match(mugEditorSource, /resizePrintArea/);
  assert.match(mugEditorSource, /refreshViewport/);
  assert.match(mugEditorSource, /bringActiveToFront\(\)/);
  assert.match(mugEditorSource, /bringObjectToFront\(object\)/);
  assert.match(mugEditorSource, /copyActive\(\)/);
  assert.match(mugEditorSource, /pasteClipboard\(\)/);
  assert.match(mugEditorSource, /command && event\.key\.toLowerCase\(\) === 'c'/);
  assert.match(mugEditorSource, /command && event\.key\.toLowerCase\(\) === 'v'/);
  assert.match(mugEditorSource, /selection: true/);
  assert.match(mugEditorSource, /selectionKey: \['shiftKey', 'ctrlKey', 'metaKey'\]/);
  assert.match(mugEditorSource, /new root\.fabric\.ActiveSelection\(selectable/);
  assert.match(mugEditorSource, /command && event\.key\.toLowerCase\(\) === 'a'/);
  assert.match(mugEditorSource, /async addImageFile\(file\)/);
  assert.match(mugEditorSource, /async addEmoji\(value\)/);
  assert.match(mugEditorSource, /this\.nextId\('emoji'\)/);
  assert.match(mugEditorSource, /new root\.fabric\.FabricImage\(element/);
  assert.match(mugEditorSource, /MAX_EMBEDDED_IMAGE_BYTES/);
  assert.match(mugEditorSource, /ImagePrintQuality\.evaluate/);
  assert.match(mugEditorSource, /updateImageQualityBadge\(object\)/);
  assert.match(mugEditorSource, /root\.fabric\.util\.qrDecompose\(object\.calcTransformMatrix\(\)\)/);
  assert.match(mugEditorSource, /setActiveFont\(fontKey\)/);
  assert.match(mugEditorSource, /name\.style\.fontFamily = font\.cssFamily/);
  assert.match(mugEditorSource, /syncFontPicker\(fontKey, placeholder, disabled\)/);
  assert.match(mugEditorSource, /fontFamily: root\.DesignFonts\.normalizeKey\(object\.editorFontKey\)/);
  assert.doesNotMatch(mugEditorSource, /Mindestens ein Element muss bleiben/);
  assert.match(await fetch(`${baseUrl}/assets/product-thumbnails/pillow.svg`).then((response) => response.text()), /Dekokissen/);
  for (const [asset, contentType] of [
    ['/assets/product-mockups/tote-front.jpg', 'image/jpeg'],
    ['/assets/product-mockups/coaster-flat.png', 'image/png'],
    ['/assets/product-mockups/matte-poster-30x40.png', 'image/png'],
    ['/assets/product-mockups/matte-poster-50x70.png', 'image/png'],
    ['/assets/product-mockups/framed-poster-black-30x40.png', 'image/png'],
    ['/assets/product-mockups/framed-poster-black-50x70.png', 'image/png'],
    ['/assets/product-mockups/throw-blanket-flat-horizontal.png', 'image/png'],
    ['/assets/product-mockups/spiral-notebook-front.png', 'image/png'],
    ['/assets/product-mockups/spiral-notebook-back.png', 'image/png'],
    ['/assets/product-mockups/basic-pillow-flat.png', 'image/png'],
  ]) {
    const response = await fetch(baseUrl + asset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.ok((await response.arrayBuffer()).byteLength > 2000);
  }

  const motifLibrary = await fetch(`${baseUrl}${publicAssetUrl('/js/mug-icons.js')}`);
  assert.equal(motifLibrary.status, 200);
  assert.equal(MugIcons.VIEWBOX_SIZE, 48);
  assert.equal(MugIcons.STROKE_WIDTH, 1.5);
  assert.equal(MugIcons.ICONS.length, 10);
  assert.ok(MugIcons.ICONS.every((icon) => icon.id && icon.label && icon.path));
});

test('confirmed configuration freezes the approved words in a permanent Printful-sized SVG', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Freeze Frieda & Emil' });
  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());

  await submitWord(socket, 'Liebe');
  await submitWord(socket, 'Liebe');
  await submitWord(socket, 'Glück');

  const snapshot = [['liebe', 2], ['glück', 1]];
  const design = [
    { id: 'liebe', text: 'liebe', x: 900, y: 500, fontSize: 120, angle: 0, color: '#a40e4c' },
    { id: 'glueck', text: 'glück', x: 1750, y: 560, fontSize: 90, angle: 0, color: '#d90368' },
  ];
  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 7,
      theme: 'pastel',
      words: snapshot,
      ...oneSurfaceDesign(design),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  assert.match(configuration.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(configuration.quantity, 7);
  assert.equal(configuration.unitPriceCents, undefined);
  assert.equal(configuration.totalPriceCents, undefined);

  // The live event keeps changing after approval.
  await submitWord(socket, 'Später');

  const printRes = await fetch(baseUrl + configuration.printFileUrl);
  assert.equal(printRes.status, 200);
  assert.match(printRes.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.match(printRes.headers.get('cache-control') || '', /immutable/);
  const svg = await printRes.text();
  assert.match(svg, /width="2700" height="1050"/);
  assert.match(svg, /data-background="transparent"/);
  assert.doesNotMatch(svg, /<rect\b/, 'the Printful file must not print a background');
  assert.ok(svg.includes('>liebe</text>'));
  assert.ok(svg.includes('>glück</text>'));
  assert.ok(!svg.includes('später'), 'words submitted after approval must never enter the saved print file');
  assert.equal((svg.match(/<text /g) || []).length, snapshot.length);
});

test('a sparse automatic design saves and freezes the exact preview geometry', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Geometrie Greta & Linus' });
  const product = resolveProductOrientation(getProduct('white-glossy-mug-duo-11oz'), 'default');
  const words = [['liebe', 1]];
  const design = automaticFitAreaDesign(product, words);

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: product.key,
      orientation: 'default',
      quantity: 1,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign(design),
    }),
  });
  const saveBody = await save.text();
  assert.equal(save.status, 201, saveBody);
  const configuration = JSON.parse(saveBody);
  const print = await fetch(baseUrl + configuration.printFileUrl);
  assert.equal(print.status, 200);
  assert.equal(await print.text(), buildProductPrintSvg(product, design),
    'the immutable print must preserve the exact saved coordinates, size, rotation, color and font');
});

test('200, 201 and 500 word snapshots save, reopen and freeze complete multi-product designs', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const event = await createEvent(app.baseUrl, { title: 'Große vollständige Wolke' });
  const other = await createEvent(app.baseUrl, { title: 'Andere Wolke' });
  const endpoint = `${app.baseUrl}/api/events/${event.slug}/configurations`;
  const save = body => fetch(endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let lastPayload;
  for (const [count, key, orientation] of [
    [200, 'white-glossy-mug-duo-11oz', 'default'],
    [201, 'matte-poster-30x40cm', 'landscape'],
    [500, 'all-over-basic-pillow-18in', 'default'],
    [500, 'cork-back-coaster', 'default'],
    [500, 'white-glossy-mug-duo-11oz', 'default'],
  ]) {
    const product = resolveProductOrientation(getProduct(key), orientation);
    const words = Array.from({ length: count }, (_, i) => [
      (key === 'cork-back-coaster' ? 'w'.repeat(27) : 'wort') + String(i).padStart(3, '0'),
      1 + i * 7 % 20,
    ]);
    let design = automaticFitAreaDesign(product, words);
    if (count === 500 && key.includes('mug')) {
      const context = createCanvas(1, 1).getContext('2d');
      design = DesignLayout.applyLayoutAction(design, product.layoutGeometry.single, context,
        { fontFamily: item => DesignFonts.cssFamily(item.fontFamily) });
      design = DesignLayout.applyLayoutAction(design, product.layoutGeometry['both-sides'], context,
        { fontFamily: item => DesignFonts.cssFamily(item.fontFamily) });
      assert.equal(design.length, 1000, 'both mug placements can retain a full copy');
      design.push({ id: 'extra-heart', type: 'icon', icon: 'heart', x: 1350, y: 525,
        size: 48, angle: 0, color: '#a40e4c' });
    }
    const payload = { productKey: key, orientation, theme: 'pastel', words,
      designs: Object.fromEntries(product.printSurfaces.map(surface => [surface.key, design])) };
    // Large synchronous layouts can outlast an idle HTTP connection under
    // parallel test load. Let the client process its pending socket close
    // before issuing the next request; all persistence assertions stay exact.
    await new Promise(resolve => setImmediate(resolve));
    const response = await save(payload);
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    const restored = await fetch(`${endpoint}/${created.id}/edit`);
    const body = await restored.json();
    assert.equal(restored.status, 200);
    assert.deepEqual(body.words, words);
    for (const surface of product.printSurfaces) {
      assert.equal(body.designs[surface.key].length, design.length);
      body.designs[surface.key].forEach((item, index) => {
        for (const field of Object.keys(design[index])) assert.equal(item[field], design[index][field], field);
      });
      const print = await fetch(app.baseUrl + created.printFileUrls[surface.key]);
      assert.equal(print.status, 200);
      const svg = await print.text();
      assert.equal(svg, buildProductPrintSvg(product, body.designs[surface.key]));
      assert.equal((svg.match(/<text /g) || []).length, count === 500 && key.includes('mug') ? 1000 : count);
    }
    const foreign = await fetch(`${app.baseUrl}/api/events/${other.slug}/configurations/${created.id}/edit`);
    assert.equal(foreign.status, 404);
    lastPayload = payload;
  }
  const excessWords = await save({ ...lastPayload, words: [...lastPayload.words, ['zu-viel', 1]] });
  assert.equal(excessWords.status, 400);
  assert.equal((await excessWords.json()).error, 'invalid_words');
  const tooMany = Array.from({ length: 1201 }, (_, i) => ({ ...lastPayload.designs.default[0], id: 'extra-' + i }));
  const excessDesign = await save({ ...lastPayload, designs: { default: tooMany } });
  assert.equal(excessDesign.status, 400);
  assert.equal((await excessDesign.json()).error, 'invalid_design');
});

test('configurations require the exact canvas and store no placement state', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Canvas Carla' });

  const missingDesign = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'pastel', words: [['liebe', 1]] }),
  });
  assert.equal(missingDesign.status, 400);
  assert.equal((await missingDesign.json()).error, 'invalid_design');

  const invalidQuantity = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 100,
      theme: 'pastel',
      words: [['liebe', 1]],
      ...productDesignPayload(),
    }),
  });
  assert.equal(invalidQuantity.status, 400);
  assert.equal((await invalidQuantity.json()).error, 'invalid_quantity');

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 1,
      theme: 'sage-gold',
      words: [['liebe', 1]],
      ...productDesignPayload(),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  assert.equal(Object.hasOwn(configuration, 'placement'), false);

  const db = require('../src/db');
  const columns = (await db.getPool().query(`
    SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'configurations'
  `)).rows.map((column) => column.name);
  assert.equal(columns.includes('placement'), false);
  const svg = await fetch(baseUrl + configuration.printFileUrl).then((res) => res.text());
  assert.doesNotMatch(svg, /data-cloud=/);
});

test('custom editor design is frozen exactly and cannot leave the printable area', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { title: 'Editor Ella & Finn' });
  const words = [['ursprünglich', 2], ['liebe', 1]];
  const uploadCanvas = createCanvas(120, 80);
  const uploadContext = uploadCanvas.getContext('2d');
  uploadContext.fillStyle = '#168f83';
  uploadContext.fillRect(0, 0, 120, 80);
  uploadContext.fillStyle = '#ffffff';
  uploadContext.fillRect(30, 20, 60, 40);
  const imageSrc = uploadCanvas.toDataURL('image/png');
  const design = [
    { id: 'wort-1', text: 'Unser Wort', x: 1280, y: 460, fontSize: 118, angle: 15, color: '#123456', fontFamily: 'lora',
      fontWeight: 700, fontStyle: 'italic', underline: true, linethrough: true },
    { id: 'wort-2', text: 'für immer', x: 1550, y: 655, fontSize: 82, angle: -30, color: '#abcdef', fontFamily: 'caveat' },
    { id: 'motiv-1', type: 'icon', icon: 'heart', x: 1880, y: 390, size: 170, angle: -12, color: '#d90368' },
    { id: 'bild-1', type: 'image', src: imageSrc, x: 2200, y: 700, width: 240, height: 160, angle: 10 },
  ];

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 2,
      theme: 'custom',
      words,
      ...oneSurfaceDesign(design),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  const svg = await fetch(baseUrl + configuration.printFileUrl).then((res) => res.text());
  assert.match(svg, /translate\(1280\.0 460\.0\) skewX\(-12\)/);
  assert.match(svg, /font-size="118\.0"/);
  assert.match(svg, /transform="rotate\(15\.0 1280\.0 460\.0\)"/);
  assert.match(svg, /fill="#123456"/);
  assert.match(svg, /data-font="lora"/);
  assert.match(svg, /data-font="caveat"/);
  assert.match(svg, /font-family="'Wolkenworte Lora', Georgia, serif"/);
  assert.match(svg, /font-family="'Wolkenworte Caveat', cursive"/);
  assert.match(svg, /font-weight="700"/);
  assert.match(svg, /skewX\(-12\)/);
  assert.equal((svg.match(/<line /g) || []).length, 2);
  assert.match(svg, /@font-face\{font-family:'Wolkenworte Lora';src:url\(data:font\/ttf;base64,/);
  assert.match(svg, /@font-face\{font-family:'Wolkenworte Caveat';src:url\(data:font\/ttf;base64,/);
  assert.match(svg, />Unser Wort<\/text>/);
  assert.match(svg, />für immer<\/text>/);
  assert.match(svg, /data-motif="heart"/);
  assert.ok(svg.includes(`d="${MugIcons.get('heart').path}"`));
  assert.match(svg, /stroke="#d90368"/);
  assert.match(svg, /stroke-width="1\.5"/);
  assert.match(svg, /translate\(1880\.0 390\.0\) rotate\(-12\.0\)/);
  assert.match(svg, /<image data-uploaded-image="true"/);
  assert.match(svg, /x="2080\.0" y="620\.0" width="240\.0" height="160\.0"/);
  assert.match(svg, /transform="rotate\(10\.0 2200\.0 700\.0\)"/);
  assert.ok(svg.includes(`href="${imageSrc}"`), 'the trusted raster must be embedded in the immutable print');
  assert.doesNotMatch(svg, />ursprünglich<\/text>/, 'the edited design, not the original cloud, is printed');
  assert.equal((svg.match(/<text /g) || []).length, 2);
  assert.equal((svg.match(/<path data-motif=/g) || []).length, 1);
  assert.equal((svg.match(/<image data-uploaded-image=/g) || []).length, 1);
  assert.doesNotMatch(svg, /<rect\b/);

  const editable = await fetch(`${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/edit`);
  assert.equal(editable.status, 200);
  assert.match(editable.headers.get('cache-control'), /no-store/);
  const editableBody = await editable.json();
  assert.equal(editableBody.productKey, 'white-glossy-mug-duo-11oz');
  assert.equal(editableBody.theme, 'custom');
  assert.equal(Object.hasOwn(editableBody, 'placementKey'), false);
  assert.deepEqual(editableBody.words, words);
  assert.deepEqual(editableBody.designs.default.map((item) => ({
    id: item.id,
    type: item.type || 'text',
    text: item.text,
    icon: item.icon,
    color: item.color,
    fontFamily: item.fontFamily,
  })), [
    { id: 'wort-1', type: 'text', text: 'Unser Wort', icon: undefined, color: '#123456', fontFamily: 'lora' },
    { id: 'wort-2', type: 'text', text: 'für immer', icon: undefined, color: '#abcdef', fontFamily: 'caveat' },
    { id: 'motiv-1', type: 'icon', text: undefined, icon: 'heart', color: '#d90368', fontFamily: undefined },
    { id: 'bild-1', type: 'image', text: undefined, icon: undefined, color: undefined, fontFamily: undefined },
  ]);
  assert.deepEqual(editableBody.designs.default.slice(0, 2).map((item) => ({
    fontWeight: item.fontWeight,
    fontStyle: item.fontStyle,
    underline: item.underline,
    linethrough: item.linethrough,
  })), [
    { fontWeight: 700, fontStyle: 'italic', underline: true, linethrough: true },
    { fontWeight: 400, fontStyle: 'normal', underline: false, linethrough: false },
  ]);
  assert.deepEqual(editableBody.designs.default.find((item) => item.id === 'bild-1'), {
    id: 'bild-1',
    type: 'image',
    src: imageSrc,
    x: 2200,
    y: 700,
    width: 240,
    height: 160,
    angle: 10,
  });

  const unknownFont = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([{
        id: 'wort-fremde-schrift', text: 'bleibt sicher', x: 1300, y: 500,
        fontSize: 100, angle: 0, color: '#123456', fontFamily: 'untrusted-font',
      }]),
    }),
  });
  assert.equal(unknownFont.status, 400);
  assert.equal((await unknownFont.json()).error, 'invalid_design');

  for (const invalidStyle of [
    { fontWeight: 500 },
    { fontWeight: '700' },
    { fontStyle: 'oblique' },
    { underline: 'true' },
    { linethrough: 1 },
  ]) {
    const response = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantity: 2,
        theme: 'pastel',
        words,
        ...oneSurfaceDesign([{
          id: 'invalid-style', text: 'bleibt sicher', x: 1300, y: 500,
          fontSize: 100, angle: 0, color: '#123456', fontFamily: 'classic',
          ...invalidStyle,
        }]),
      }),
    });
    assert.equal(response.status, 400, JSON.stringify(invalidStyle));
    assert.equal((await response.json()).error, 'invalid_design');
  }

  const emojiStyle = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 1,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([{
        id: 'emoji-style', text: '❤️', x: 1300, y: 500, fontSize: 100,
        angle: 0, color: '#123456', fontFamily: 'classic', fontWeight: 700,
        fontStyle: 'italic', underline: true, linethrough: true,
      }]),
    }),
  });
  assert.equal(emojiStyle.status, 201);
  const emojiConfiguration = await emojiStyle.json();
  const emojiEditable = await fetch(`${baseUrl}/api/events/${event.slug}/configurations/${emojiConfiguration.id}/edit`).then(res => res.json());
  assert.deepEqual(emojiEditable.designs.default[0], {
    id: 'emoji-style', type: 'text', text: '❤️', x: 1300, y: 500, angle: 0,
    color: '#123456', fontSize: 100, fontFamily: 'classic', fontWeight: 400,
    fontStyle: 'normal', underline: false, linethrough: false,
  });

  const outside = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([{
        id: 'outside', text: 'zu weit', x: 10, y: 500,
        fontSize: 100, angle: 0, color: '#123456',
      }]),
    }),
  });
  assert.equal(outside.status, 400);
  assert.equal((await outside.json()).error, 'invalid_design');

  const outsideMotif = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([
        { id: 'wort-1', text: 'bleibt', x: 1200, y: 500, fontSize: 100, angle: 0, color: '#123456' },
        { id: 'motiv-rand', type: 'icon', icon: 'heart', x: 30, y: 500, size: 160, angle: 0, color: '#d90368' },
      ]),
    }),
  });
  assert.equal(outsideMotif.status, 400);
  assert.equal((await outsideMotif.json()).error, 'invalid_design');

  const unknownMotif = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([
        { id: 'wort-1', text: 'bleibt', x: 1200, y: 500, fontSize: 100, angle: 0, color: '#123456' },
        { id: 'motiv-fremd', type: 'icon', icon: 'uploaded-script', x: 1500, y: 500, size: 160, angle: 0, color: '#123456' },
      ]),
    }),
  });
  assert.equal(unknownMotif.status, 400);
  assert.equal((await unknownMotif.json()).error, 'invalid_design');

  const forgedImage = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([
        { id: 'wort-1', text: 'bleibt', x: 1200, y: 500, fontSize: 100, angle: 0, color: '#123456' },
        {
          id: 'bild-fremd', type: 'image', src: 'data:image/png;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=',
          x: 1600, y: 500, width: 240, height: 160, angle: 0,
        },
      ]),
    }),
  });
  assert.equal(forgedImage.status, 400);
  assert.equal((await forgedImage.json()).error, 'invalid_design');

  const distortedImage = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([
        { id: 'wort-1', text: 'bleibt', x: 1200, y: 500, fontSize: 100, angle: 0, color: '#123456' },
        { id: 'bild-verzerrt', type: 'image', src: imageSrc, x: 1600, y: 500, width: 240, height: 240, angle: 0 },
      ]),
    }),
  });
  assert.equal(distortedImage.status, 400);
  assert.equal((await distortedImage.json()).error, 'invalid_design');
});
