'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('canvas');
const { FabricImage, StaticCanvas } = require('fabric/node');
const { renderProviderPng } = require('../src/printRaster');
const { PRODUCTS, resolveProductOrientation } = require('../src/products');
const { MAX_DESIGN_ELEMENTS } = require('../public/js/cloud-limits');
const DesignFonts = require('../src/designFonts');

const product = { printFile: { width: 256, height: 256 }, designSafeMargin: 0 };

function sourceImage(mimeType, color = '#ef231a') {
  const canvas = createCanvas(32, 24);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mimeType);
}

function imageItem(src, overrides = {}) {
  return { id: 'photo', type: 'image', src, x: 128, y: 128,
    width: 120, height: 80, angle: 0, ...overrides };
}

async function pixels(bytes) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.getContext('2d');
}

for (const mimeType of ['image/png', 'image/jpeg']) {
  test(`provider PNG includes actual uploaded ${mimeType} pixels`, async () => {
    const context = await pixels(await renderProviderPng(product, [imageItem(sourceImage(mimeType))]));
    const center = context.getImageData(128, 128, 1, 1).data;
    assert.equal(center[3], 255, 'a valid image must never silently become transparent');
    assert.ok(center[0] > 220 && center[1] < 50 && center[2] < 50);
    assert.equal(context.getImageData(5, 5, 1, 1).data[3], 0, 'print background stays transparent');
  });
}

test('provider PNG preserves image rotation, transparency and interleaved layer order', async () => {
  const transparent = createCanvas(32, 24);
  transparent.getContext('2d').fillStyle = '#1256eb';
  transparent.getContext('2d').fillRect(0, 0, 16, 24);
  const text = { id: 'word', type: 'text', text: 'W', x: 128, y: 128,
    fontSize: 70, angle: 0, color: '#000000', fontFamily: 'classic' };
  const red = imageItem(sourceImage('image/png'));
  const overlay = imageItem(transparent.toDataURL(), { id: 'overlay', width: 60, height: 80, angle: 90 });
  const context = await pixels(await renderProviderPng(product, [text, red, text, overlay]));
  assert.equal(context.getImageData(128, 105, 1, 1).data[3], 255);
  assert.ok(context.getImageData(128, 105, 1, 1).data[2] > 220, 'rotated top image covers lower layers');
  assert.ok(context.getImageData(85, 128, 1, 1).data[0] > 220, 'lower image remains visible');
  const textOnly = await pixels(await renderProviderPng(product, [text]));
  let coveredTextPixels = 0;
  for (let y = 140; y < 160; y += 1) {
    for (let x = 100; x < 155; x += 1) {
      if (textOnly.getImageData(x, y, 1, 1).data[3] === 255) {
        const pixel = context.getImageData(x, y, 1, 1).data;
        if (pixel[0] < 10 && pixel[1] < 10 && pixel[2] < 10) coveredTextPixels += 1;
      }
    }
  }
  assert.ok(coveredTextPixels > 20, 'text between images retains its exact layer');
});

test('provider rendering rejects an undecodable upload instead of producing an incomplete print', async () => {
  const bytes = Buffer.from(sourceImage('image/png').split(',')[1], 'base64');
  // Retain plausible dimensions/chunks while corrupting the compressed image data.
  const idat = bytes.indexOf(Buffer.from('IDAT'));
  bytes.fill(0xff, idat + 4, idat + 12);
  await assert.rejects(renderProviderPng(product, [imageItem(`data:image/png;base64,${bytes.toString('base64')}`)]));
});

function patternedSource(mimeType) {
  const canvas = createCanvas(40, 30);
  const context = canvas.getContext('2d');
  for (const [color, x, y] of [
    ['#ff0000', 0, 0], ['#00ff00', 20, 0], ['#0000ff', 0, 15], ['#ffff00', 20, 15],
  ]) {
    context.fillStyle = color;
    context.fillRect(x, y, 20, 15);
  }
  return canvas.toDataURL(mimeType);
}

async function fabricImagePixels(design) {
  const canvas = new StaticCanvas(null, {
    width: product.printFile.width, height: product.printFile.height, enableRetinaScaling: false,
  });
  try {
    for (const item of design) {
      const image = await FabricImage.fromURL(item.src);
      image.set({ left: item.x, top: item.y, originX: 'center', originY: 'center',
        angle: item.angle, scaleX: item.width / image.width, scaleY: item.height / image.height });
      canvas.add(image);
    }
    canvas.renderAll();
    return canvas.getContext().getImageData(0, 0, 256, 256).data;
  } finally {
    await canvas.dispose();
  }
}

function assertMatchesFabric(actual, expected, label) {
  let error = 0;
  let intersection = 0;
  let union = 0;
  for (let n = 0; n < actual.length; n += 4) {
    const actualAlpha = actual[n + 3] / 255;
    const expectedAlpha = expected[n + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      error += Math.abs(actual[n + channel] * actualAlpha - expected[n + channel] * expectedAlpha);
    }
    error += Math.abs(actual[n + 3] - expected[n + 3]);
    // Use visibility rather than a 50% threshold: 127 vs 128 alpha is normal
    // rounding for a half-transparent source, not a missing image region.
    if (actualAlpha > .05 || expectedAlpha > .05) union += 1;
    if (actualAlpha > .05 && expectedAlpha > .05) intersection += 1;
  }
  // Fabric and the PNG renderer resample transformed edges slightly differently.
  // Compare premultiplied color and coverage, so transparent RGB is irrelevant.
  assert.ok(error / actual.length < 1.5, `${label}: mean pixel error ${error / actual.length}`);
  assert.ok(intersection / union > .985, `${label}: coverage agreement ${intersection / union}`);
}

for (const mimeType of ['image/png', 'image/jpeg']) {
  for (const width of [32, 119.6, 200]) {
    test(`${mimeType} at width ${width}: ten rotations match the Fabric editor`, async () => {
      const src = patternedSource(mimeType);
      for (const angle of [-179, -135, -90, -45, -17, 0, 17, 45, 90, 179]) {
        const design = [imageItem(src, { width, height: width * .75, x: 128.3, y: 128.7, angle })];
        const context = await pixels(await renderProviderPng(product, design));
        assertMatchesFabric(context.getImageData(0, 0, 256, 256).data,
          await fabricImagePixels(design), `${mimeType}/${width}/${angle}`);
      }
    });
  }
}

test('four different overlapping sources and rotated duplicates match Fabric in both stacking orders', async () => {
  const translucent = sourceImage('image/png', 'rgba(0,0,255,.5)');
  const sources = [patternedSource('image/jpeg'), sourceImage('image/png', '#008800'),
    translucent, patternedSource('image/png')];
  const design = sources.map((src, index) => imageItem(src, { id: `source-${index}`,
    x: 100 + index * 15, y: 100 + index * 12, width: 100, height: 75,
    angle: [-45, 17, 90, -135][index] }));
  design.push(imageItem(sources[0], { id: 'copy-1', x: 80, y: 170, width: 64, height: 48, angle: -17 }));
  design.push(imageItem(sources[2], { id: 'copy-2', x: 165, y: 75, width: 64, height: 48, angle: 45 }));
  for (const layers of [design, [...design].reverse()]) {
    const context = await pixels(await renderProviderPng(product, layers));
    assertMatchesFabric(context.getImageData(0, 0, 256, 256).data, await fabricImagePixels(layers), 'six layers');
  }
});

test('overlap uses source-over alpha blending and the last image wins', async () => {
  const red = imageItem(sourceImage('image/png', '#ff0000'));
  const blue = imageItem(sourceImage('image/png', 'rgba(0,0,255,.5)'), { id: 'blue' });
  const green = imageItem(sourceImage('image/jpeg', '#00ff00'), { id: 'green' });
  const blended = await pixels(await renderProviderPng(product, [red, blue]));
  const rgba = Array.from(blended.getImageData(128, 128, 1, 1).data);
  assert.ok(Math.abs(rgba[0] - 128) <= 1 && rgba[1] === 0 && Math.abs(rgba[2] - 127) <= 1);
  assert.equal(rgba[3], 255);
  const covered = await pixels(await renderProviderPng(product, [red, blue, green]));
  const top = covered.getImageData(128, 128, 1, 1).data;
  assert.ok(top[0] < 3 && top[1] > 250 && top[2] < 3 && top[3] === 255);
});

test('transparent PNG holes reveal the exact lower layer and empty transparency remains empty', async () => {
  const source = createCanvas(32, 24);
  source.getContext('2d').fillStyle = '#0000ff';
  source.getContext('2d').fillRect(0, 0, 32, 24);
  source.getContext('2d').clearRect(8, 6, 16, 12);
  const hole = imageItem(source.toDataURL(), { id: 'hole' });
  const red = imageItem(sourceImage('image/png', '#ff0000'));
  const empty = imageItem(createCanvas(32, 24).toDataURL(), { id: 'empty' });
  const context = await pixels(await renderProviderPng(product, [red, hole, empty]));
  assert.deepEqual(Array.from(context.getImageData(128, 128, 1, 1).data), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(context.getImageData(80, 100, 1, 1).data), [0, 0, 255, 255]);
  const transparent = await pixels(await renderProviderPng(product, [empty]));
  assert.ok(transparent.getImageData(0, 0, 256, 256).data.every((value) => value === 0));
});

test('images at every safe-area edge print completely and crossing the edge is rejected', async () => {
  const bounded = { ...product, designSafeMargin: 8 };
  const src = patternedSource('image/png');
  const width = 60;
  const height = 45;
  const halfBound = (width + height) / (2 * Math.sqrt(2));
  const near = 8 + halfBound + .01;
  const far = 256 - near;
  const design = [[near, near], [far, near], [near, far], [far, far]].map(([x, y], index) =>
    imageItem(src, { id: `edge-${index}`, x, y, width, height, angle: 45 }));
  const context = await pixels(await renderProviderPng(bounded, design));
  for (const { x, y } of design) assert.equal(context.getImageData(Math.round(x), Math.round(y), 1, 1).data[3], 255);
  for (const [x, y, w, h] of [[0, 0, 256, 8], [0, 248, 256, 8], [0, 0, 8, 256], [248, 0, 8, 256]]) {
    const data = context.getImageData(x, y, w, h).data;
    assert.ok(data.every((value, index) => index % 4 !== 3 || value === 0));
  }
  await assert.rejects(renderProviderPng(bounded, [{ ...design[0], x: near - 1 }]), /invalid design/);
});

test('a bad PNG or JPEG anywhere in a multiple-image design aborts the whole render', async () => {
  const png = Buffer.from(sourceImage('image/png').split(',')[1], 'base64');
  const idat = png.indexOf(Buffer.from('IDAT'));
  png.fill(0xff, idat + 4, idat + 12);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 24, 0, 32,
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
  const good = imageItem(sourceImage('image/png'));
  for (const [mimeType, bytes] of [['image/png', png], ['image/jpeg', jpeg]]) {
    const bad = imageItem(`data:${mimeType};base64,${bytes.toString('base64')}`, { id: 'bad' });
    for (const design of [[bad, good], [good, bad], [good, bad, { ...good, id: 'copy' }]]) {
      await assert.rejects(renderProviderPng(product, design), { code: 'PRINT_IMAGE_INVALID' });
    }
  }
});

test('an image between styled text, emoji and motifs leaves all vector pixels unchanged outside the image', async () => {
  const current = { printFile: { width: 512, height: 512 }, designSafeMargin: 0 };
  const vectors = DesignFonts.FONTS.map((font, index) => ({ id: `word-${font.key}`, type: 'text',
    text: 'A ❤️', fontFamily: font.key, fontSize: 45, fontWeight: 700, fontStyle: 'italic',
    underline: true, linethrough: true, color: '#123456', x: 250, y: 55 + index * 90, angle: index % 2 ? -17 : 17 }));
  vectors.push({ id: 'heart', type: 'icon', icon: 'heart', size: 80, color: '#d90368', x: 420, y: 270, angle: -27 });
  const photo = imageItem(patternedSource('image/jpeg'), { x: 60, y: 240, width: 64, height: 48 });
  const mixed = [vectors[0], photo, ...vectors.slice(1)];
  const baseline = (await pixels(await renderProviderPng(current, vectors))).getImageData(110, 0, 402, 512).data;
  const actual = (await pixels(await renderProviderPng(current, mixed))).getImageData(110, 0, 402, 512).data;
  assert.deepEqual(actual, baseline, 'image compositing must not change fonts, emoji, motifs or their styles');
});

test('very wide, tall and near-limit source images remain decodable and correctly oriented', async () => {
  for (const [width, height, printWidth, printHeight] of [
    [1024, 24, 240, 24], [24, 1024, 24, 240], [4096, 3906, 128, 128 * 3906 / 4096],
  ]) {
    const source = createCanvas(width, height);
    const context = source.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#0000ff';
    context.fillRect(0, 0, width / 2, height);
    const output = await pixels(await renderProviderPng(product, [imageItem(source.toDataURL('image/png'), {
      width: printWidth, height: printHeight,
    })]));
    const left = output.getImageData(Math.round(128 - printWidth / 4), 128, 1, 1).data;
    const right = output.getImageData(Math.round(128 + printWidth / 4), 128, 1, 1).data;
    assert.deepEqual(Array.from(left), [0, 0, 255, 255]);
    assert.deepEqual(Array.from(right), [255, 0, 0, 255]);
  }
});

test('parallel renders keep each design separate and reject external or malformed image sources', async () => {
  const cases = ['#ff0000', '#00ff00', '#0000ff'].map((color, index) =>
    [imageItem(sourceImage('image/png', color), { x: 40 + index * 80, width: 32, height: 24 })]);
  const outputs = await Promise.all(cases.map(design => renderProviderPng(product, design)));
  for (const [index, bytes] of outputs.entries()) {
    const context = await pixels(bytes);
    for (let position = 0; position < cases.length; position += 1) {
      const pixel = context.getImageData(40 + position * 80, 128, 1, 1).data;
      assert.equal(pixel[3], position === index ? 255 : 0);
    }
  }
  for (const src of ['https://example.invalid/photo.png', 'data:image/png;base64,invalid',
    'data:image/svg+xml;base64,PHN2Zy8+']) {
    await assert.rejects(renderProviderPng(product, [imageItem(src)]), /invalid design/);
  }
});

test('maximum allowed image copies remain present and repeated rendering is deterministic', async () => {
  const src = sourceImage('image/png', '#ff0000');
  const design = Array.from({ length: MAX_DESIGN_ELEMENTS }, (_, index) =>
    imageItem(src, { id: `copy-${index}`, width: 32, height: 24,
      x: 32 + (index % 8) * 24, y: 32 + (Math.floor(index / 8) % 8) * 24 }));
  const first = await renderProviderPng(product, design);
  assert.deepEqual(first, await renderProviderPng(product, design));
  const context = await pixels(first);
  for (const x of [32, 200]) for (const y of [32, 200]) {
    assert.deepEqual(Array.from(context.getImageData(x, y, 1, 1).data), [255, 0, 0, 255]);
  }
});

test('image output retains full resolution on every catalog orientation and print surface', async () => {
  const sources = [sourceImage('image/png', '#ff0000'), sourceImage('image/jpeg', '#00ff00'),
    sourceImage('image/png', '#0000ff'), sourceImage('image/jpeg', '#ffff00')];
  const expectedColors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (const base of PRODUCTS) {
    for (const orientation of base.orientationOptions.length ? base.orientationOptions : [{ key: 'default' }]) {
      const current = resolveProductOrientation(base, orientation.key);
      for (const surface of current.printSurfaces) {
        const area = current.designSafeAreas[surface.key];
        const design = sources.map((src, index) => imageItem(src, { id: `image-${index}`,
          x: area.x + area.width / 2 + (index - 1.5) * 120,
          y: area.y + area.height / 2, width: 64, height: 48, angle: index % 2 ? -17 : 17 }));
        const output = await loadImage(await renderProviderPng(current, design));
        assert.equal(output.width, current.printFile.width);
        assert.equal(output.height, current.printFile.height);
        const probe = createCanvas(1, 1).getContext('2d');
        for (const [index, item] of design.entries()) {
          probe.clearRect(0, 0, 1, 1);
          probe.drawImage(output, Math.round(item.x), Math.round(item.y), 1, 1, 0, 0, 1, 1);
          const color = probe.getImageData(0, 0, 1, 1).data;
          assert.equal(color[3], 255, `${current.key}/${orientation.key}/${surface.key}/${index}`);
          expectedColors[index].forEach((value, channel) => assert.ok(Math.abs(color[channel] - value) < 3));
        }
      }
    }
  }
});
