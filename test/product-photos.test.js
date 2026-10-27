'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('canvas');
const catalog = require('../src/productPhotoCatalog.json');
const { PRODUCTS, getPublicProduct } = require('../src/products');
const { getProductPhotos } = require('../src/productPhotos');

const root = path.join(__dirname, '..', 'public');

test('every offered product group has a recorded photo audit and locally pinned approved image bytes', () => {
  assert.deepEqual(catalog.audits.map(row => row.productId).sort((a, b) => a - b),
    [...new Set(PRODUCTS.map(product => product.printful.productId))].sort((a, b) => a - b));
  for (const photo of catalog.photos) {
    assert.match(photo.source, /^https:\/\/files\.cdn\.printful\.com\//);
    assert.match(photo.src, /^\/assets\/product-photos\/[a-z0-9-]+\.jpg$/);
    const bytes = fs.readFileSync(path.join(root, photo.src));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), photo.sha256, photo.src);
    assert.match(photo.sourceSha256, /^[a-f0-9]{64}$/);
    assert.ok(photo.width > 500 && photo.height > 500);
    assert.ok(photo.variantIds.length > 0);
  }
});

test('extra photos are bound to the supplier size, color and product instead of leaking across variants', () => {
  for (const photo of catalog.photos) for (const id of photo.variantIds) {
    const variant = catalog.variants[id];
    assert.equal(variant.productId, photo.productId);
    assert.ok(photo.mappings.some(mapping => (!mapping.size || mapping.size === variant.size) &&
      (!mapping.color || mapping.color === variant.color)), `${photo.src}: ${id}`);
    if (photo.reviewedColors) assert.ok(photo.reviewedColors.includes(variant.color));
  }
  for (const product of PRODUCTS) {
    const sources = getProductPhotos(product).map(photo => photo.src);
    for (const photo of catalog.photos) {
      assert.equal(sources.includes(photo.src), photo.productId === product.printful.productId &&
        photo.variantIds.includes(product.printful.variantId), `${product.key}: ${photo.src}`);
    }
  }
});

test('plain garment fronts stay first and each white/black garment includes multiple matching model views', () => {
  for (const product of PRODUCTS.filter(product => product.familyKey === 'clothing')) {
    const photos = getProductPhotos(product);
    assert.equal(photos[0].src, product.productPhoto);
    assert.ok(photos.filter(photo => photo.label === 'Am Model').length >= 2, product.key);
    const variant = catalog.variants[product.printful.variantId];
    for (const source of catalog.photos.filter(photo => photos.some(p => p.src === photo.src))) {
      assert.ok(source.variantIds.includes(product.printful.variantId));
      if (source.isImageTransparent) assert.equal(source.backgroundColor, variant.color === 'White' ? '#ffffff' :
        product.printful.productId === 456 ? '#111111' : '#0b0b0b');
    }
  }
});

test('the 444 ml mug uses the full-resolution centred 15 oz gallery photo', async () => {
  const product = PRODUCTS.find(product => product.printful.variantId === 4830);
  const result = getPublicProduct(product);
  const reference = catalog.photos.find(photo => photo.src === result.productPhoto);
  assert.equal(reference.providerImageId, 1752);
  assert.deepEqual(reference.variantIds, [4830]);
  assert.equal(result.productPhotoPosition, 'center');
  const image = await loadImage(path.join(root, result.productPhoto));
  assert.ok(image.width >= 700 && image.height >= 1000, 'never enlarge the old 275 × 500 catalog thumbnail');
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = image.width, top = image.height, right = 0, bottom = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    if (Math.min(data[i], data[i + 1], data[i + 2]) >= 240) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(Math.abs((left + right) / 2 / image.width - .5) < .04, 'mug is horizontally centred');
  assert.ok(Math.abs((top + bottom) / 2 / image.height - .5) < .04, 'mug is vertically centred');
  const [x, y, width, height] = result.productPhotos[0].frame;
  assert.ok(x * image.width <= left && (x + width) * image.width >= right);
  assert.ok(y * image.height <= top && (y + height) * image.height >= bottom, 'display frame retains rim, handle and base');
});

test('public photo galleries use local URLs, bounded display frames and the exact selected reference image', () => {
  for (const product of PRODUCTS) {
    const result = getPublicProduct(product);
    assert.equal(result.productPhoto, result.productPhotos[0].src);
    assert.equal(new Set(result.productPhotos.map(photo => photo.src)).size, result.productPhotos.length);
    for (const photo of result.productPhotos) {
      assert.ok(fs.existsSync(path.join(root, photo.src)));
      assert.equal(photo.source, undefined, 'browsing never loads supplier metadata or remote photos');
      const [x, y, width, height] = photo.frame;
      assert.ok([x, y, width, height].every(Number.isFinite));
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
      assert.ok(x + width <= 1.0001 && y + height <= 1.0001);
    }
  }
  const coaster = getPublicProduct(PRODUCTS.find(product => product.printful.productId === 611));
  assert.match(coaster.productPhotos[0].src, /611-11198/);
  assert.ok(coaster.productPhotos.some(photo => /611-11197/.test(photo.src)));
});

test('reviewed copies resolve to one variant-matched photo even when filenames and JPEG bytes differ', () => {
  let copies = 0;
  for (const photo of catalog.photos) for (const copy of photo.duplicates || []) {
    copies++;
    const bytes = fs.readFileSync(path.join(root, copy.src));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), copy.sha256,
      `${copy.src}: changed photo bytes require a new duplicate review`);
    for (const product of PRODUCTS.filter(p => photo.productId === p.printful.productId &&
      photo.variantIds.includes(p.printful.variantId))) {
      const photos = getProductPhotos(product);
      assert.ok(photos.some(p => p.src === photo.src));
      assert.ok(!photos.some(p => p.src === copy.src), product.key);
    }
  }
  assert.equal(copies, catalog.duplicateAudit.duplicatePairs);
  assert.equal(catalog.duplicateAudit.variants, PRODUCTS.length);
  const oak = PRODUCTS.find(p => p.printful.variantId === 11791);
  assert.deepEqual(getProductPhotos(oak).map(p => p.src), ['/assets/product-photos/304-7854.jpg']);
  const unrelatedVariant = { ...oak, printful: { ...oak.printful, variantId: -1 } };
  assert.equal(getProductPhotos(unrelatedVariant)[0].src, oak.productPhoto,
    'duplicate replacement must never introduce a photo from a different variant');
});

test('every offered variant has visually distinct photos, including differently encoded copies', async () => {
  const rasters = new Map(), compared = new Set();
  async function raster(src) {
    if (!rasters.has(src)) {
      const image = await loadImage(path.join(root, src));
      const canvas = createCanvas(96, 96), context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, 96, 96);
      context.drawImage(image, 0, 0, 96, 96);
      rasters.set(src, context.getImageData(0, 0, 96, 96).data);
    }
    return rasters.get(src);
  }
  for (const product of PRODUCTS) {
    const photos = getProductPhotos(product);
    for (let i = 0; i < photos.length; i++) for (let j = i + 1; j < photos.length; j++) {
      const key = [photos[i].src, photos[j].src].sort().join('|');
      if (compared.has(key)) continue;
      compared.add(key);
      const a = await raster(photos[i].src), b = await raster(photos[j].src);
      let difference = 0, samples = 0;
      for (let p = 0; p < a.length; p += 4) {
        if (Math.min(a[p], a[p + 1], a[p + 2], b[p], b[p + 1], b[p + 2]) >= 240) continue;
        for (let channel = 0; channel < 3; channel++) {
          difference += Math.abs(a[p + channel] - b[p + channel]); samples++;
        }
      }
      assert.ok(difference / (samples || 1) >= 2, `${product.key}: duplicate photographs ${key}`);
    }
  }
});
