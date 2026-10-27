'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createCanvas } = require('canvas');
const Layout = require('../public/js/design-layout');
const Core = require('../public/js/wordcloud-core');
const Fonts = require('../src/designFonts');
const Transfer = require('../public/js/design-transfer');
const parityCases = require('./support/print-layout-parity-cases');
const reference = require('./support/print-layout-reference.json');

const context = () => createCanvas(1, 1).getContext('2d');
const fontFamily = item => Fonts.cssFamily(item.fontFamily);
const design = Array.from({ length: 17 }, (_, index) => ({ id: `word-${index}`,
  text: ['Liebe', 'Gemeinsam alt werden', 'Glück', '❤️', 'WWW', 'i'][index % 6],
  x: 500, y: 500, fontSize: 110 - index * 2, angle: index === 0 ? 23 : 0,
  color: '#123456', fontFamily: Fonts.FONTS[index % Fonts.FONTS.length].key,
  fontWeight: index % 2 ? 700 : 400, fontStyle: index % 3 ? 'normal' : 'italic',
  underline: index % 4 === 0, linethrough: index % 5 === 0,
}));

test('cold-load optimizations retain the original complete search decisions with portable font metrics', () => {
  for (const [index, input] of parityCases.cases().entries()) {
    const expected = reference.cases[index];
    assert.equal(input.count, expected.count); assert.deepEqual(input.slots, expected.slots);
    const result = Layout.optimizeDesign(input.design, input.slots, parityCases.context(), { fontFamily });
    const json = JSON.stringify(result, (_, value) => typeof value === 'number'
      ? Math.round(value * 1e8) / 1e8 : value);
    assert.equal(createHash('sha256').update(json).digest('hex'), expected.sha256,
      `${input.count} styled elements in ${input.slots[0].width} × ${input.slots[0].height}`);
  }
});

test('async fill uses page-measured boxes and returns the identical mixed-font print design', async () => {
  for (const slots of [[{ x: 36, y: 36, width: 2628, height: 978, optimize: true }],
    [{ x: 150, y: 150, width: 2550, height: 2550, optimize: true }]]) {
    const original = structuredClone(design);
    const expected = Layout.optimizeDesign(design, slots, context(), { fontFamily });
    let packs = 0;
    const pack = Object.assign(async (boxes, width, height) => {
        packs++;
        assert.ok(boxes.every(box => Object.keys(box).sort().join(',') === 'emoji,height,priority,width'));
        await new Promise(resolve => setImmediate(resolve));
        return Core.layoutBoxesInArea(boxes, width, height);
      }, { concurrency: 4 });
    const actual = await Layout.optimizeDesignAsync(design, slots, context(), { fontFamily, pack, timeSliceMs: 4 });
    assert.ok(packs > 0);
    assert.deepEqual(actual, expected);
    assert.deepEqual(design, original);
    assert.deepEqual(await Layout.applyLayoutActionAsync(actual, slots, context(), { fontFamily }), actual,
      'an unchanged async fill is still a fixed point');
  }
});

test('cancelled asynchronous filling cannot return a partially arranged design', async () => {
  const controller = new AbortController();
  await assert.rejects(Layout.optimizeDesignAsync(design,
    [{ x: 0, y: 0, width: 1500, height: 1000, optimize: true }], context(), { fontFamily,
      signal: controller.signal,
      pack: async (...args) => { controller.abort(); return Core.layoutBoxesInArea(...args); },
    }), /layout_cancelled/);
});

test('async product transfer preserves the complete synchronous result and separate sides', async () => {
  const area = { x: 0, y: 0, width: 1000, height: 1000 };
  const source = { productKey: 'source', surfaces: [{ key: 'default', area, design }] };
  const target = { productKey: 'target', surfaces: ['front', 'back'].map(key => ({ key,
    area: { x: 150, y: 150, width: 1800, height: 1800 } })) };
  const options = { fontFamily, automatic: true };
  const expected = Transfer.prepare(null, source, target, context(), options);
  const actual = await Transfer.prepareAsync(null, source, target, context(), {
    ...options, pack: async (...args) => Core.layoutBoxesInArea(...args),
  });
  assert.deepEqual(actual, expected);
  actual.designs.front[0].text = 'edited front';
  assert.notEqual(actual.designs.back[0].text, actual.designs.front[0].text);
});
