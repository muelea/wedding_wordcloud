'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('canvas');
const Core = require('../public/js/wordcloud-core');
const Layout = require('../public/js/design-layout');
const Quality = require('../public/js/text-print-quality');
const Fonts = require('../src/designFonts');
const Transfer = require('../public/js/design-transfer');
const { getProduct } = require('../src/products');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');
const words = require('../marketing/clouds/classic-wedding.json').words.map(({ word, count }) => [word, count]);
const context = () => createCanvas(1, 1).getContext('2d');
const options = dpi => ({ printDpi: dpi, fontFamily: item => Fonts.cssFamily(item.fontFamily) });
function source(ctx) {
  return Core.measureWords(words, ctx).map((item, index) => ({ id: `word-${index}`, text: item.word,
    fontSize: item.fontPx, x: 700, y: 1200, angle: 0, fontFamily: 'classic', color: '#123456' }));
}
function safe(design, product, ctx) {
  assert.ok(isPrintDesignWithinBounds(design, product.printFile.width, product.printFile.height,
    product.designSafeAreas[product.printSurfaces[0].key]));
  const boxes = design.map(item => {
    const b = Core.styledTextBox(Core.measureTextBox(item.text, item.fontSize, ctx, Fonts.cssFamily(item.fontFamily), item), item);
    const r = (item.angle || 0) * Math.PI / 180;
    return { x: item.x, y: item.y, w: b.width * Math.abs(Math.cos(r)) + b.height * Math.abs(Math.sin(r)),
      h: b.width * Math.abs(Math.sin(r)) + b.height * Math.abs(Math.cos(r)) };
  });
  boxes.forEach((b, i) => boxes.slice(0, i).forEach(a => assert.ok(
    Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2)));
}

test('10 pt is a physical boundary at 150 and 300 DPI; non-text artwork is excluded', () => {
  for (const dpi of [150, 300]) {
    const design = [10, 9.9, 7.9, 5.9].map((pt, index) => ({ id: `${index}`, text: 'Liebe', fontSize: pt * dpi / 72 }));
    design.push({ id: 'emoji', text: '❤️', fontSize: 1 }, { type: 'image', width: 24, height: 24 }, { type: 'icon', size: 48 });
    assert.deepEqual(Quality.findings(design, dpi).map(f => [f.id, f.level]), [['3', 'tiny'], ['2', 'low'], ['1', 'small']]);
    assert.equal(Quality.evaluate(design, dpi).small, 3);
  }
});

test('dense phone-case and coaster layouts keep all words at 10 pt, separate and repeatable', () => {
  for (const key of ['tough-case-20308', 'cork-back-coaster']) {
    const product = getProduct(key), ctx = context(), input = source(ctx), before = structuredClone(input);
    const opts = options(product.printFile.dpi);
    const design = Layout.optimizeDesign(input, product.layoutGeometry['fit-area'], ctx, opts);
    assert.deepEqual(input, before);
    assert.deepEqual(design.map(i => i.id), input.map(i => i.id));
    assert.equal(Quality.findings(design, opts.printDpi).length, 0);
    safe(design, product, ctx);
    const rounded = design.map(i => Object.fromEntries(Object.entries(i).map(([k, v]) => [k,
      typeof v === 'number' ? Math.round(v * 10) / 10 : v])));
    assert.equal(Quality.findings(rounded, opts.printDpi).length, 0);
    assert.deepEqual(Layout.optimizeDesign(rounded, product.layoutGeometry['fit-area'], ctx, opts), rounded);
  }
});

test('readability constraints preserve mixed fonts and styles with identical async output', async () => {
  const product = getProduct('tough-case-20308'), ctx = context();
  const input = source(ctx).slice(0, 18).map((item, index) => ({ ...item,
    fontFamily: Fonts.FONTS[index % 5].key, fontWeight: index % 2 ? 700 : 400,
    fontStyle: index % 3 ? 'normal' : 'italic', underline: index % 4 === 0 }));
  const opts = options(300), slots = product.layoutGeometry['fit-area'];
  const expected = Layout.optimizeDesign(input, slots, ctx, opts);
  const result = await Layout.optimizeDesignAsync(input, slots, ctx, { ...opts,
    yieldControl: async () => {}, pack: async (...args) => Core.layoutBoxesInArea(...args) });
  assert.deepEqual(result, expected);
  assert.equal(Quality.findings(result, 300).length, 0);
  result.forEach((item, index) => {
    for (const key of ['id', 'text', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'underline']) {
      assert.equal(item[key], input[index][key]);
    }
  });
  safe(result, product, ctx);
});

test('insufficient capacity fails without mutating or omitting words; explicit smaller type remains possible', async () => {
  const input = Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, text: `Wort ${i}`, fontSize: 100, x: 10, y: 10, angle: 0 }));
  const before = structuredClone(input), slots = [{ x: 0, y: 0, width: 100, height: 100, optimize: true }], ctx = context();
  assert.throws(() => Layout.optimizeDesign(input, slots, ctx, options(300)), /print_capacity/);
  await assert.rejects(Layout.optimizeDesignAsync(input, slots, ctx, { ...options(300), yieldControl: async () => {} }), /print_capacity/);
  assert.deepEqual(input, before);
  const override = Layout.optimizeDesign(input, slots, ctx, { fontFamily: options(300).fontFamily });
  assert.equal(override.length, input.length);
  assert.ok(Quality.findings(override, 300).length);
});

test('manual product transfer keeps deliberate small text; automatic transfer enforces the target DPI', () => {
  const area = { x: 0, y: 0, width: 600, height: 500 };
  const input = [{ id: 'a', text: 'Liebe', fontSize: 20, x: 300, y: 250, angle: 0, fontFamily: 'classic' }];
  const from = { productKey: 'source', surfaces: [{ key: 'front', area, design: input }] };
  const to = { productKey: 'target', surfaces: [{ key: 'front', area }] };
  const ctx = context();
  const manual = Transfer.prepare(null, from, to, ctx, options(300));
  assert.equal(manual.designs.front[0].fontSize, 20);
  const automatic = Transfer.prepare(null, from, to, ctx, { ...options(300), automatic: true });
  assert.equal(Quality.findings(automatic.designs.front, 300).length, 0);
});

test('constrained Fill retains uploaded images and motifs with their proportions', () => {
  const product = getProduct('tough-case-20308'), ctx = context();
  const input = source(ctx).slice(0, 20).concat([
    { id: 'photo', type: 'image', src: createCanvas(24, 12).toDataURL(), width: 900, height: 450, x: 700, y: 1200, angle: 0 },
    { id: 'motif', type: 'icon', icon: 'heart', size: 120, x: 700, y: 1200, angle: 0, color: '#123456' },
  ]);
  const result = Layout.optimizeDesign(input, product.layoutGeometry['fit-area'], ctx, options(300));
  assert.deepEqual(result.map(item => item.id), input.map(item => item.id));
  assert.equal(Quality.findings(result, 300).length, 0);
  const photo = result.find(item => item.id === 'photo');
  assert.equal(photo.src, input.at(-2).src);
  assert.ok(Math.abs(photo.width / photo.height - 2) < .01);
  assert.ok(isPrintDesignWithinBounds(result, product.printFile.width, product.printFile.height,
    product.designSafeAreas.default));
});
