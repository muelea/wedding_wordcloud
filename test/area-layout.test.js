'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createCanvas } = require('canvas');
const Core = require('../public/js/wordcloud-core');
const Layout = require('../public/js/design-layout');
const Fonts = require('../src/designFonts');
const { PRODUCTS, getProduct, resolveProductOrientation } = require('../src/products');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');
const { SCREENSHOT_WORDS, AREA_CASES } = require('./support/area-layout-cases');

const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
const automaticSource = template.slice(template.indexOf('    function buildAutomaticDesign()'),
  template.indexOf('    function cloneDesign('));
const context = createCanvas(1, 1).getContext('2d');
const apply = (design, product) => Layout.applyLayoutAction(design, product.layoutGeometry['fit-area'],
  context, { fontFamily: item => Fonts.cssFamily(item.fontFamily) });

function automatic(product, words) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(automaticSource + '\nbuildAutomaticDesign()', {
    productView: () => product, words, WordCloudCore: Core, DesignFonts: Fonts, DesignLayout: Layout,
    document: { createElement: () => createCanvas(1, 1) }, selectedTheme: 'konfetti',
    getPalette: () => ({ colors: ['#2455f5', '#ed2446', '#18a84b', '#efbf00', '#f77500', '#e600b8'] }),
    makePaletteAssigner: Core.makePaletteAssigner,
    CloudLimits: require('../public/js/cloud-limits'),
  })));
}

function bounds(item) {
  const box = item.type === 'image' ? { width: item.width, height: item.height }
    : item.type === 'icon' ? { width: item.size, height: item.size }
    : Core.measureTextBox(item.text, item.fontSize, context, Fonts.cssFamily(item.fontFamily));
  const angle = (item.angle || 0) * Math.PI / 180;
  const width = box.width * Math.abs(Math.cos(angle)) + box.height * Math.abs(Math.sin(angle));
  const height = box.height * Math.abs(Math.cos(angle)) + box.width * Math.abs(Math.sin(angle));
  return { x1: item.x - width / 2, x2: item.x + width / 2,
    y1: item.y - height / 2, y2: item.y + height / 2 };
}

function assertSafe(design, product, label) {
  assert.ok(isPrintDesignWithinBounds(design, product.printFile.width,
    product.printFile.height, product.designSafeMargin), label + ': printable');
  const boxes = design.map(bounds);
  boxes.forEach((box, index) => boxes.slice(0, index).forEach(other => {
    assert.ok(box.x1 >= other.x2 || box.x2 <= other.x1 || box.y1 >= other.y2 || box.y2 <= other.y1,
      label + ': no overlapping element boxes');
  }));
}

test('the actual start layout survives repeated fit-area clicks on every product and orientation', () => {
  for (const base of PRODUCTS) {
    for (const orientation of base.orientationOptions.length ? base.orientationOptions : [{ key: 'default' }]) {
      const product = resolveProductOrientation(base, orientation.key);
      for (const [index, words] of AREA_CASES.entries()) {
        const label = `${product.key}/${orientation.key}/${index}`;
        const initial = automatic(product, words);
        assert.equal(initial.length, words.length, label);
        assertSafe(initial, product, label);
        let current = initial;
        for (let click = 0; click < 3; click++) {
          current = apply(JSON.parse(JSON.stringify(current)), product);
          assert.deepEqual(current, initial, label + ': no reshuffle or size drift');
        }
      }
    }
  }
});

test('fit-area preserves all fonts, edits, rotations, duplicates, emoji and image proportions', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const image = createCanvas(3, 2).toDataURL();
  for (const font of Fonts.FONTS) {
    const input = SCREENSHOT_WORDS.map(([text], index) => ({ id: 'word-' + index,
      text, x: 200, y: 200, fontSize: 50 + index * 2, angle: index % 5 === 4 ? -90 : index % 3 * 5,
      fontFamily: font.key, fontWeight: index % 2 ? 700 : 400,
      fontStyle: index % 3 ? 'normal' : 'italic', underline: index % 4 === 0,
      linethrough: index % 6 === 0, color: '#2455f5' }));
    input.push({ ...input[0], id: 'duplicate', text: '❤️ Liebe 👨‍👩‍👧‍👦' },
      { id: 'icon', type: 'icon', icon: 'heart', x: 200, y: 200, size: 60, angle: 15, color: '#ed2446' },
      { id: 'image', type: 'image', src: image, x: 200, y: 200, width: 90, height: 60, angle: -10 });
    const output = apply(input, product);
    assertSafe(output, product, font.key);
    assert.equal(output.length, input.length);
    output.forEach((item, index) => {
      for (const key of ['id', 'text', 'fontFamily', 'fontWeight', 'fontStyle', 'underline',
        'linethrough', 'color', 'angle', 'src', 'type']) {
        assert.equal(item[key], input[index][key], `${font.key}: preserve ${key}`);
      }
    });
    const uploaded = output.find(item => item.type === 'image');
    assert.ok(Math.abs(uploaded.width / uploaded.height - 1.5) < .001);
    assert.deepEqual(apply(output, product), output, font.key + ': repeated click is stable');
  }
});

test('no-op placement keeps the saved state and undo history untouched', () => {
  const source = template.slice(template.indexOf('    function applyPlacementToCurrentDesign('),
    template.indexOf('    function activateOrientation('));
  const product = getProduct('white-glossy-mug-duo-11oz');
  const design = automatic(product, SCREENSHOT_WORDS);
  let writes = 0;
  const result = vm.runInNewContext(source + '\napplyPlacementToCurrentDesign("fit-area")', {
    mugEditor: { setState: () => { writes++; } }, storeActiveSurfaceState() {},
    productView: () => product, productSurfaces: () => [{ key: 'default' }],
    surfaceStates: new Map([['default', { design, history: ['untouched'], historyIndex: 0 }]]),
    document: { createElement: () => createCanvas(1, 1) }, DesignLayout: Layout, DesignFonts: Fonts,
    CloudLimits: require('../public/js/cloud-limits'),
  });
  assert.equal(result, false);
  assert.equal(writes, 0);
  assert.match(template, /if \(!applyPlacementToCurrentDesign\(layout.key\)\) return;\s*markDirty\(\)/);
});

test('a capacity-sized cloud remains complete, printable and repeatable', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const words = Array.from({ length: 500 }, (_, index) => ['wort' + index, 1 + index * 7 % 20]);
  const initial = automatic(product, words);
  assert.equal(initial.length, 500);
  assert.ok(initial.every(item => item.fontSize >= 1), 'no later Fabric minimum-size clamping');
  assertSafe(initial, product, 'capacity');
  assert.deepEqual(apply(initial, product), initial);
});

test('500 long words fit a small print surface without minimum-size inflation or dropped text', () => {
  const product = getProduct('cork-back-coaster');
  const words = Array.from({ length: 500 }, (_, index) => [
    'w'.repeat(27) + String(index).padStart(3, '0'), 1 + index * 7 % 20,
  ]);
  const initial = automatic(product, words);
  assert.equal(initial.length, words.length);
  assert.ok(initial.some(item => item.fontSize < 12), 'the old technical floor would distort this design');
  assert.ok(initial.every(item => item.fontSize >= 1));
  assertSafe(initial, product, 'long words on a coaster');
  assert.deepEqual(apply(initial, product), initial);
});

test('rounded mixed-font packing reaches a fixed point across varied aspect ratios', () => {
  let seed = 37;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let sample = 0; sample < 80; sample++) {
    const width = 800 + random() * 2200;
    const height = 800 + random() * 2200;
    const count = 1 + Math.floor(random() * 45);
    const design = Array.from({ length: count }, (_, index) => ({ id: String(index),
      text: ['Liebe', 'Zusammen', 'i', 'WWW', 'Glück', '❤️', 'Freundschaft'][index % 7] + index,
      fontSize: 24 + random() * 120, fontFamily: Fonts.FONTS[index % 5].key,
      fontWeight: index % 2 ? 700 : 400, fontStyle: index % 3 ? 'normal' : 'italic',
      underline: index % 4 === 0, linethrough: index % 6 === 0,
      angle: index % 5 === 4 ? -90 : 0, x: 200, y: 200, color: '#2455f5',
    }));
    const product = { printFile: { width: width + 60, height: height + 60 }, designSafeMargin: 24,
      layoutGeometry: { 'fit-area': [{ x: 30, y: 30, width, height, optimize: true }] } };
    const packed = apply(design, product);
    assertSafe(packed, product, 'mixed-font sample ' + sample);
    assert.deepEqual(apply(packed, product), packed, 'stable sample ' + sample);
  }
});
