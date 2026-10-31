'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('canvas');
require('../src/designFonts');
const overlap = require('../public/js/artwork-overlap');
const core = require('../public/js/wordcloud-core');
const fonts = require('../public/js/design-fonts');
const emoji = require('../public/js/emoji-catalog');
const { loadBrowserSvg } = require('../src/emojiBrowserAssets');

const word = (id, text = 'O', extras = {}) => ({ id, text, x: 200, y: 200,
  fontSize: 180, fontFamily: 'classic', color: '#000000', angle: 0, ...extras });
const picture = (id, extras = {}) => ({ id, type: 'image', src: id, x: 200, y: 200,
  width: 100, height: 100, angle: 0, ...extras });
function image(width = 100, paint = ctx => ctx.fillRect(0, 0, width, width)) {
  const canvas = createCanvas(width, width);
  paint(canvas.getContext('2d'));
  return canvas;
}
function checker(images = new Map(), extras = {}) {
  return overlap.create({ createCanvas, assets: { image: src => images.get(src) }, ...extras });
}

test('overlapping text bounds and an image inside a letter hole are harmless', async () => {
  const images = new Map([['dot', image(10)]]);
  const check = checker(images);
  const o = word('o');
  const dot = picture('dot', { width: 10, height: 10, y: 195 });
  const ctx = createCanvas(1, 1).getContext('2d');
  const a = overlap.bounds(o, ctx), b = overlap.bounds(dot, ctx);
  assert.ok(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
  assert.equal((await check.check([o, dot])).findings.length, 0);
  assert.equal((await check.check([o, word('copy')])).findings.length, 1);
  assert.equal((await check.check([word('upper', 'A', { y: 100, fontSize: 100 }),
    word('lower', 'A', { y: 190, fontSize: 100 })])).findings.length, 0);
});

test('word spaces and transparent PNG margins do not cause warnings', async () => {
  const images = new Map([['dot', image(10)], ['left', image(100, ctx => ctx.fillRect(0, 40, 20, 20))],
    ['right', image(100, ctx => ctx.fillRect(80, 40, 20, 20))]]);
  const check = checker(images);
  assert.equal((await check.check([word('spaces', 'A        B'), picture('dot', { width: 10, height: 10 })])).findings.length, 0);
  assert.equal((await check.check([picture('left'), picture('right')])).findings.length, 0);
  assert.equal((await check.check([picture('left'), picture('right', { x: 120 })])).findings.length, 1);
});

test('checks actual rotated artwork, opaque image backgrounds and narrow text strokes', async () => {
  const images = new Map([['first', image()], ['second', image()], ['line', image(1)]]);
  const check = checker(images);
  assert.equal((await check.check([picture('first', { angle: 45, width: 120, height: 15 }),
    picture('second', { angle: 45, x: 240, y: 160, width: 120, height: 15 })])).findings.length, 0);
  assert.equal((await check.check([picture('first', { angle: 45 }), picture('second', { angle: -30 })])).findings.length, 1);
  assert.equal((await check.check([word('text'), picture('first')])).findings.length, 1);
  assert.equal((await check.check([word('small', 'iii', { fontSize: 8 }),
    word('small-copy', 'iii', { fontSize: 8 })])).findings.length, 1);
});

test('glyph overhangs remain overlap candidates with browser and Pango metric conventions', async () => {
  const dot = image(1);
  const check = checker(new Map([['dot', dot]]));
  const canvas = createCanvas(800, 800), ctx = canvas.getContext('2d');
  for (const font of fonts.FONTS) {
    const item = word('overhang', 'j', { x: 400, y: 400, fontSize: 200, fontFamily: font.key });
    ctx.clearRect(0, 0, 800, 800); overlap.drawItem(ctx, item);
    const pixels = ctx.getImageData(0, 0, 800, 800).data;
    let point = null;
    for (let x = 0; x < 800 && !point; x++) for (let y = 0; y < 800; y++) {
      if (pixels[(y * 800 + x) * 4 + 3] >= 200) { point = { x: x + .5, y: y + .5 }; break; }
    }
    assert.ok(point);
    const result = await check.check([item, picture('dot', { ...point, width: 1, height: 1 })]);
    assert.equal(result.findings.length, 1, `${font.key}: overlapping the painted overhang must be detected`);
    const browserMetrics = {
      canvas: {},
      get font() { return ctx.font; }, set font(value) { ctx.font = value; },
      get textAlign() { return ctx.textAlign; }, set textAlign(value) { ctx.textAlign = value; },
      get textBaseline() { return ctx.textBaseline; }, set textBaseline(value) { ctx.textBaseline = value; },
      measureText(text) {
        const metrics = ctx.measureText(text);
        return { ...metrics, actualBoundingBoxLeft: -metrics.actualBoundingBoxLeft };
      },
    };
    assert.deepEqual(overlap.bounds(item, browserMetrics), overlap.bounds(item, ctx),
      `${font.key}: browser and server conventions produce identical candidate rectangles`);
  }
});

test('font style, text decorations, undo-like snapshots and deleted elements invalidate masks', async () => {
  const check = checker();
  for (const font of fonts.FONTS) for (const style of [{}, { fontWeight: 700 }, { fontStyle: 'italic' },
    { underline: true }, { linethrough: true }]) {
    const a = word('first', 'Glück', { fontFamily: font.key, angle: 37, ...style });
    const b = word('second', 'Glück', { fontFamily: font.key, angle: 37, ...style });
    assert.equal((await check.check([a, b])).findings.length, 1, `${font.key} ${JSON.stringify(style)}`);
    assert.equal((await check.check([a, { ...b, x: 1000 }])).findings.length, 0);
    assert.equal((await check.check([a, b])).findings.length, 1);
    assert.equal((await check.check([a])).findings.length, 0);
  }
});

test('pinned emoji artwork and mixed text use their painted shape, ignoring emoji frames', async () => {
  const run = emoji.parse('❤️')[0];
  const heart = await loadImage(Buffer.from(await loadBrowserSvg(run.asset)));
  const dot = image(4);
  const check = overlap.create({ createCanvas, assets: { image: () => dot, emojiImage: () => heart } });
  const a = word('heart', '❤️', { fontSize: 100 });
  assert.equal((await check.check([a, picture('dot', { x: 153, y: 153, width: 4, height: 4 })])).findings.length, 0);
  assert.equal((await check.check([a, picture('dot', { width: 4, height: 4 })])).findings.length, 1);
  assert.equal((await check.check([word('mixed', 'Glück ❤️'), word('mixed-copy', 'Glück ❤️')])).findings.length, 1);
});

test('large canvases yield, cancel, bound caches and cap dense finding lists', async () => {
  let clock = 0, yields = 0;
  const check = checker(new Map([['empty', image(100, () => {})], ['full', image()]]), {
    now: () => clock += 9, yieldTask: async () => { yields++; },
  });
  const huge = picture('empty', { width: 10000, height: 10000 });
  const cancelled = await check.check([huge, picture('full', { width: 10000, height: 10000 })],
    { cancelled: () => yields >= 600 });
  assert.equal(cancelled, null);
  assert.ok(check.cacheSize() <= overlap.MAX_CACHED_TILES);
  const dense = Array.from({ length: 1200 }, (_, i) => word(`word-${i}`, 'i', { fontSize: 12 }));
  const result = await check.check(dense);
  assert.equal(result.findings.length, overlap.MAX_FINDINGS);
  assert.equal(result.truncated, true);
  const spaced = Array.from({ length: 1200 }, (_, i) => word(`word-${i}`, 'i', { x: i * 200 }));
  assert.equal((await check.check(spaced)).findings.length, 0);
  assert.ok(yields > 0);
});

test('shared artwork renderer keeps the existing preview text geometry', () => {
  const actual = createCanvas(400, 400), expected = createCanvas(400, 400);
  const item = word('styled', 'Glück', { fontSize: 90, angle: 17, fontWeight: 700, fontStyle: 'italic', underline: true });
  overlap.drawItem(actual.getContext('2d'), item, {}, .5);
  const ctx = expected.getContext('2d');
  ctx.translate(item.x * .5, item.y * .5);
  ctx.rotate(item.angle * Math.PI / 180);
  core.drawRichText(ctx, item.text, 0, 0, item.fontSize * .5, { ...item, fontFamily: fonts.cssFamily(item.fontFamily) });
  assert.deepEqual(actual.toBuffer(), expected.toBuffer());
});

test('exact finding counts are not labelled as truncated and faint PNG fringes are ignored', async () => {
  const faint = image(100, ctx => { ctx.globalAlpha = .05; ctx.fillRect(0, 0, 100, 100); });
  const check = checker(new Map([['faint', faint], ['solid', image()]]));
  assert.equal((await check.check([picture('faint'), picture('solid')])).findings.length, 0);
  const result = await check.check([word('a'), word('b')], { limit: 1 });
  assert.equal(result.findings.length, 1);
  assert.equal(result.truncated, false);
});

test('missing emoji artwork cannot report a clean design and render errors restore the canvas transform', async () => {
  const check = checker();
  await assert.rejects(check.check([word('heart', '❤️'), word('copy', '❤️')]), /Emoji artwork is not loaded/);
  assert.equal((await check.check([word('first'), word('second')])).findings.length, 1);
  const canvas = createCanvas(20, 20), ctx = canvas.getContext('2d');
  overlap.drawItem(ctx, picture('not-loaded'), { allowMissing: true });
  assert.ok(ctx.getImageData(0, 0, 20, 20).data.every(value => value === 0));
  assert.equal(ctx.getTransform().e, 0);
  assert.equal(ctx.getTransform().f, 0);
});
