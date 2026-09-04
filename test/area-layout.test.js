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
const { SCREENSHOT_WORDS, REPORTED_WORDS, EMOJI_WORDS, GAP_WORDS, FIVE_WORDS, AREA_CASES } = require('./support/area-layout-cases');
const { largestEmptyFraction, occupiedFraction, envelope } = require('./support/layout-space');

const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
const automaticSource = template.slice(template.indexOf('    function buildAutomaticDesign('),
  template.indexOf('    function cloneDesign('));
const context = createCanvas(1, 1).getContext('2d');
const apply = (design, product) => Layout.applyLayoutAction(design, product.layoutGeometry['fit-area'],
  context, { fontFamily: item => Fonts.cssFamily(item.fontFamily) });

function automatic(product, words) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(automaticSource + '\nbuildAutomaticDesign()', {
    product, activeSurface: product.printSurfaces[0].key, productView: () => product, words, WordCloudCore: Core, DesignFonts: Fonts, DesignLayout: Layout,
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
    product.printFile.height, product.designSafeAreas?.[product.printSurfaces?.[0]?.key] || product.designSafeMargin), label + ': printable');
  const boxes = design.map(bounds);
  boxes.forEach((box, index) => boxes.slice(0, index).forEach(other => {
    assert.ok(box.x1 >= other.x2 || box.x2 <= other.x1 || box.y1 >= other.y2 || box.y2 <= other.y1,
      label + ': no overlapping element boxes');
  }));
}

test('the reported mug uses every corner and keeps its emoji separated', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  for (const words of [REPORTED_WORDS, EMOJI_WORDS]) {
    const design = automatic(product, words);
    assert.equal(design.length, words.length);
    assertSafe(design, product, 'reported layout');
    assert.deepEqual(apply(design, product), design, 'repeat clicks do not reshuffle the improved design');
    const emoji = design.filter(item => Core.isEmojiOnly(item.text));
    for (let i = 0; i < emoji.length; i++) {
      for (let j = 0; j < i; j++) {
        assert.ok(Math.hypot((emoji[i].x - emoji[j].x) / slot.width,
          (emoji[i].y - emoji[j].y) / slot.height) > .25, 'emoji should not form a local cluster');
      }
    }
    if (words !== REPORTED_WORDS) continue;
    const boxes = design.map(bounds);
    for (const x of [slot.x, slot.x + slot.width * .75]) {
      for (const y of [slot.y, slot.y + slot.height * .75]) {
        const covered = boxes.reduce((sum, box) => sum +
          Math.max(0, Math.min(x + slot.width / 4, box.x2) - Math.max(x, box.x1)) *
          Math.max(0, Math.min(y + slot.height / 4, box.y2) - Math.max(y, box.y1)), 0);
        assert.ok(covered / (slot.width * slot.height / 16) > .45,
          'each corner must participate; a good average cannot mask an empty corner');
      }
    }
  }
});

test('filled corners cannot outweigh a large internal hole at equal word coverage', () => {
  const boxes = positions => positions.flatMap(x => positions.map(y =>
    ({ x1: x, x2: x + 20, y1: y, y2: y + 20 })));
  const hollow = boxes([0, 20, 60, 80]);
  const balanced = boxes([0, 80 / 3, 160 / 3, 80]);
  const area = { x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.equal(occupiedFraction(hollow, area), occupiedFraction(balanced, area));
  assert.ok(Core.cornerCoverage(hollow, 100, 100) > Core.cornerCoverage(balanced, 100, 100));
  assert.equal(largestEmptyFraction(hollow, area), .2);
  assert.ok(largestEmptyFraction(balanced, area) < .07);
  assert.ok(Core.layoutQuality(balanced, 100, 100).score > Core.layoutQuality(hollow, 100, 100).score);
  assert.equal(Core.isLayoutBalanced(Core.layoutQuality(hollow, 100, 100), hollow.length), false);
});

test('the reported gaps stay closed in automatic print designs and repeated fill-area actions', () => {
  for (const key of ['white-glossy-mug-duo-11oz', 'cork-back-coaster', 'matte-poster-30x40cm']) {
    const product = getProduct(key);
    const slot = product.layoutGeometry['fit-area'][0];
    for (const words of [GAP_WORDS, FIVE_WORDS]) {
      const design = automatic(product, words);
      const label = `${key}/${words.length}`;
      assert.equal(design.length, words.length, label);
      assertSafe(design, product, label);
      const boxes = design.map(bounds);
      const area = words === FIVE_WORDS ? envelope(boxes)
        : { x1: slot.x, y1: slot.y, x2: slot.x + slot.width, y2: slot.y + slot.height };
      assert.ok(largestEmptyFraction(boxes, area) < (words === FIVE_WORDS ? .14 : .035),
        label + ': no large uninterrupted empty region');
      assert.ok(occupiedFraction(boxes, {
        x1: slot.x + slot.width * .25, x2: slot.x + slot.width * .75,
        y1: slot.y + slot.height * .25, y2: slot.y + slot.height * .75,
      }) > .5, label + ': the centre participates');
      assert.deepEqual(apply(JSON.parse(JSON.stringify(design)), product), design,
        label + ': saved/reloaded designs remain stable');
    }
  }
});

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

test('automatic front and back designs are filled, independent copies', () => {
  for (const key of ['all-over-basic-pillow-18in', 'spiral-notebook-dotted']) {
    const product = getProduct(key);
    const design = automatic(product, REPORTED_WORDS);
    const start = template.indexOf('    function cloneDesign(');
    const end = template.indexOf('    function getAllSurfaceDesigns(', start);
    const page = vm.createContext({ product, activeSurface: 'default', surfaceStates: new Map(),
      buildSurfaceControls() {},
      buildAutomaticDesign: side => automatic({ ...product,
        layoutGeometry: { ...product.layoutGeometry, 'fit-area': [{ ...product.designSafeAreas[side], optimize: true }] },
      }, REPORTED_WORDS),
    });
    vm.runInContext(template.slice(start, end), page);
    page.resetSurfaceStates({ design, history: ['initial'], historyIndex: 0 });
    for (const [side, state] of page.surfaceStates) {
      assert.deepEqual(state.design.map(item => item.text).sort(), design.map(item => item.text).sort());
      assertSafe(state.design, { ...product, printSurfaces: [{ key: side }] }, key + '/' + side);
    }
    const front = page.surfaceStates.get('front').design;
    const back = page.surfaceStates.get('back').design;
    front[0].text = 'edited front';
    front.pop();
    assert.equal(back.length, REPORTED_WORDS.length);
    assert.notEqual(back[0].text, front[0].text, 'editing one side leaves the other intact');
  }
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
