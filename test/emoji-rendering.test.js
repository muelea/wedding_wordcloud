'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createCanvas, loadImage, Image } = require('canvas');
const fabric = require('fabric/node');
const EmojiData = require('../public/js/emoji-data');
const EmojiCatalog = require('../public/js/emoji-catalog');
const WordCloudCore = require('../public/js/wordcloud-core');
const DesignFonts = require('../src/designFonts');
const { ASSET_ROOT, inlineSvg } = require('../src/emojiAssets');
const { loadBrowserSvg, normalizeBrowserSvg } = require('../src/emojiBrowserAssets');
const { makeEmojiArtworkRouter } = require('../src/routes/emojiArtwork');

test('every bundled emoji preserves its actual browser pixels when inlined for print', async () => {
  const expected = createCanvas(1, 1).getContext('2d');
  const actual = createCanvas(1, 1).getContext('2d');
  const browserImage = new Image(), printImage = new Image();
  const decode = (image, svg) => new Promise((resolve, reject) => {
    image.onload = () => resolve(image); image.onerror = reject; image.src = Buffer.from(svg);
  });
  const failures = [];
  for (const asset of new Set(Object.values(EmojiData.canonicalAssets))) {
    const source = await loadBrowserSvg(asset);
    const image = await decode(browserImage, source);
    // Compare at intrinsic resolution: downsampling a decoded SVG bitmap and
    // rasterizing its vectors at a smaller size have different antialiasing.
    const width = image.width, height = image.height;
    expected.canvas.width = actual.canvas.width = width;
    expected.canvas.height = actual.canvas.height = height;
    WordCloudCore.drawRichText(expected, '', width / 2, height / 2, height, {
      box: { width, height, runs: [{ type: 'emoji', x: 0, width }] },
      emojiImage: () => image,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      inlineSvg({ asset, key: asset }, { x: 0, y: 0, width, height, id: 'parity' }) + '</svg>';
    actual.drawImage(await decode(printImage, svg), 0, 0);
    const a = actual.getImageData(0, 0, width, height).data;
    const b = expected.getImageData(0, 0, width, height).data;
    let error = 0, ink = 0;
    for (let i = 0; i < a.length; i += 4) {
      ink += b[i + 3];
      error += Math.abs(a[i + 3] - b[i + 3]);
      for (let channel = 0; channel < 3; channel++) {
        error += Math.abs(a[i + channel] * a[i + 3] / 255 - b[i + channel] * b[i + 3] / 255);
      }
    }
    if (!ink || error / (width * height * 4) > .1) failures.push({ asset, error: error / (width * height * 4), ink });
  }
  assert.deepEqual(failures, [], 'print must preserve all artwork, inherited paint and flag aspect ratios');
});

function dimensions(source) {
  const tag = source.match(/<svg\b[^>]*>/i)?.[0] || '';
  return ['width', 'height'].map((name) => Number(tag.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1]));
}

test('browser SVG normalization establishes intrinsic dimensions without changing artwork', () => {
  for (const [attributes, expected] of [
    ['viewBox="0 0 128 128"', [128, 128]],
    ['viewBox="-10 5 300 150"', [300, 150]],
    ['viewBox="0,0,300,150" width="600"', [600, 300]],
    ["viewBox='0 0 300 150' height='75px'", [150, 75]],
    ['viewBox="0 0 75 18" width="1400" height="550"', [1400, 550]],
    ['width="1in" height="25.4mm"', [96, 96]],
    ['viewBox="0 0 300 150" width="100%" height="100%"', [300, 150]],
  ]) {
    const source = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${attributes} fill="none"><path d="M0 0h10v10z"/></svg>`;
    const normalized = normalizeBrowserSvg(source);
    assert.deepEqual(dimensions(normalized), expected, attributes);
    assert.match(normalized, /fill="none"/);
    assert.equal(normalized.slice(normalized.indexOf('<path')), source.slice(source.indexOf('<path')));
    assert.equal(normalizeBrowserSvg(normalized), normalized, 'normalization must be idempotent');
  }
  for (const source of ['not SVG', '<svg><path/></svg>', '<svg viewBox="0 0 0 10"></svg>']) {
    assert.throws(() => normalizeBrowserSvg(source));
  }
});

test('every catalog asset has a deterministic dimensioned browser rendition and unchanged vector content', async () => {
  for (const reference of new Set(Object.values(EmojiData.canonicalAssets))) {
    const source = fs.readFileSync(path.join(ASSET_ROOT, reference), 'utf8');
    const normalized = normalizeBrowserSvg(source);
    const size = dimensions(normalized);
    assert.ok(size.every((value) => Number.isFinite(value) && value > 0), reference);
    assert.equal(normalizeBrowserSvg(normalized), normalized, reference);
    // Only root width/height attributes may change, never paths, gradients,
    // masks, namespaces, viewBox or root presentation attributes.
    const withoutSize = (svg) => svg.replace(/<svg\b([^>]*)>/i, (tag) =>
      tag.replace(/\s(?:width|height)\s*=\s*(['"])[\s\S]*?\1/gi, ''));
    assert.equal(withoutSize(normalized), withoutSize(source), reference);
  }
  assert.equal(await loadBrowserSvg('../VERSION'), null);
  assert.equal(await loadBrowserSvg('svg/emoji_u0000.svg'), null);
});

test('browser artwork HTTP contract provides SVG, immutable caching, ETags, HEAD and bounded catalog access', async (t) => {
  const app = express();
  app.use(EmojiCatalog.ASSET_BASE, makeEmojiArtworkRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base + EmojiCatalog.assetUrl(EmojiCatalog.parse('🎲')[0]);
  assert.ok(url.includes('/dimensions-v1/'));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const svg = await response.text();
  assert.deepEqual(dimensions(svg), [128, 128]);
  assert.equal(svg, await loadBrowserSvg('svg/emoji_u1f3b2.svg'));
  const unchanged = await fetch(url, { headers: {
    'If-None-Match': response.headers.get('etag'), 'Cache-Control': 'max-age=0',
  } });
  assert.equal(unchanged.status, 304);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(svg));
  for (const reference of ['svg/missing.svg', 'svg/%2e%2e%2fVERSION', 'flags/LICENSE', 'extra/svg/file.svg']) {
    const bad = await fetch(base + EmojiCatalog.ASSET_BASE + reference);
    assert.equal(bad.status, 404, reference);
    assert.equal(bad.headers.get('cache-control'), 'no-store', reference);
  }
});

function createProbeEnvironment(fabricRuntime = fabric) {
  const images = new Map();
  const emoji = {
    ...EmojiCatalog,
    async preloadTexts(texts) {
      for (const text of texts) for (const run of EmojiCatalog.parse(text)) {
        if (run.type === 'emoji' && !images.has(run.asset)) {
          images.set(run.asset, await loadImage(Buffer.from(await loadBrowserSvg(run.asset))));
        }
      }
    },
    getLoadedImage: (run) => images.get(run.asset),
  };
  const root = { fabric: fabricRuntime, DesignContentBounds: require('../public/js/design-content-bounds'), WolkenworteEmoji: emoji, WordCloudCore, DesignFonts };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  return {
    fabric: fabricRuntime, emoji, WordCloudCore, DesignFonts, createCanvas, MugPrintEditor: root.MugPrintEditor,
  };
}

test('real Fabric emoji pixels and editor lifecycle match the full-image renderer', async () => {
  const probe = require('./browser/emoji-rendering-probe');
  const results = await probe.run(createProbeEnvironment());
  assert.equal(results.length, 35);
  assert.ok(results.every((result) => result.passed));
});

test('the pixel probe rejects a cropped image even when its object geometry is correct', async () => {
  class CroppedImage extends fabric.FabricImage {
    _renderFill(context) {
      context.drawImage(this.getElement(), 0, 0, this.width / 2, this.height / 2,
        -this.width / 2, -this.height / 2, this.width, this.height);
    }
  }
  const probe = require('./browser/emoji-rendering-probe');
  await assert.rejects(() => probe.run(createProbeEnvironment({ ...fabric, FabricImage: CroppedImage })),
    /🎲 at 96: pixel error/);
});
