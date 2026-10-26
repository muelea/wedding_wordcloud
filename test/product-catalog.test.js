'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCTS, getProduct, getPublicProducts } = require('../src/products');
const { catalogPrice } = require('../src/pricing');
const { refreshProductCosts } = require('../scripts/refresh-product-costs');
const fulfillment = require('./fixtures/catalog-eu-fulfillment.json');
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

test('the shared catalog offers only audited variants with EU fulfillment for Germany', () => {
  const eligible = fulfillment.variants.filter(variant =>
    variant.germanyAvailability === 'in stock' && EU_COUNTRIES.has(variant.departureCountry));
  assert.equal(eligible.length, PRODUCTS.length);
  assert.deepEqual(PRODUCTS.map(product => product.printful.variantId).sort((a, b) => a - b),
    eligible.map(variant => variant.variantId).sort((a, b) => a - b));
  assert.deepEqual(getPublicProducts().map(product => product.key).sort(),
    eligible.map(variant => variant.productKey).sort());

  for (const variant of fulfillment.variants.filter(variant => !eligible.includes(variant))) {
    assert.equal(getProduct(variant.productKey), null, variant.productKey);
    assert.throws(() => catalogPrice(variant.variantId), /missing catalog price/);
  }
});

test('the metric poster range includes every Germany-available size and frame color, without unavailable combinations', () => {
  const posters = PRODUCTS.filter(product => product.printful.productId === 268);
  assert.deepEqual(posters.map(product => product.printful.variantId).sort((a, b) => a - b),
    [8947, 8948, 8952, 8953, 8954, 19515, 19516]);
  const frames = PRODUCTS.filter(product => product.printful.productId === 304);
  const bySize = new Map();
  for (const frame of frames) {
    const colors = bySize.get(frame.size.label) || [];
    colors.push(frame.variantLabel.split(' · ').at(-1));
    bySize.set(frame.size.label, colors);
  }
  assert.deepEqual(Object.fromEntries([...bySize].map(([size, colors]) => [size, colors.sort()])), {
    '21 × 30 cm': ['Eiche', 'Schwarz', 'Weiß'],
    '30 × 40 cm': ['Eiche', 'Schwarz', 'Weiß'],
    '30 × 45 cm': ['Schwarz', 'Weiß'],
    '40 × 50 cm': ['Schwarz', 'Weiß'],
    '45 × 61 cm': ['Schwarz'],
    '50 × 70 cm': ['Eiche', 'Weiß'],
    'A2 · 42 × 59,4 cm': ['Eiche', 'Schwarz', 'Weiß'],
    'A1 · 59,4 × 84,1 cm': ['Eiche', 'Schwarz', 'Weiß'],
    '61 × 91 cm': ['Eiche', 'Schwarz', 'Weiß'],
  });
  for (const product of [...posters, ...frames]) {
    assert.match(product.size.label, /cm$/);
    assert.equal(product.previewType, '3d');
    assert.deepEqual(product.orientationOptions.map(option => option.key), ['portrait', 'landscape']);
    assert.ok(catalogPrice(product.printful.variantId).unitGrossCents > 0);
    const verification = fulfillment.variants.find(variant => variant.variantId === product.printful.variantId);
    assert.equal(verification.germanyAvailability, 'in stock');
    assert.ok(EU_COUNTRIES.has(verification.departureCountry));
    if (product.variantLabel?.endsWith(' · Schwarz')) {
      assert.equal(product.previewModel.frameColor, '#202124');
      assert.match(product.description, /schwarzen Holzrahmen/);
      assert.match(product.size.detail, /schwarzer Holzrahmen/);
      assert.doesNotMatch(product.displayName, /weißen|Eichen/);
    }
  }
  for (const id of [9358, 19651]) {
    assert.equal(PRODUCTS.find(product => product.printful.variantId === id), undefined);
    assert.equal(fulfillment.variants.find(variant => variant.variantId === id).germanyAvailability, 'not fulfillable');
  }
});

test('all Germany-available canvases retain their own provider files, metric labels and three distinct groups', () => {
  for (const [id, count, group, depth] of [[3, 46, 'canvas', 3.18], [614, 39, 'framed-canvas', 3.18], [616, 13, 'thin-canvas', 1.905]]) {
    const variants = PRODUCTS.filter(p => p.printful.productId === id);
    assert.equal(variants.length, count);
    for (const product of variants) {
      assert.equal(product.catalogGroup, group);
      assert.equal(product.previewShape, 'canvas');
      assert.equal(product.previewType, '3d');
      assert.equal(product.previewModel.depth, depth);
      assert.match(product.size.label, /^[\d,]+ × [\d,]+ cm$/);
      assert.doesNotMatch(product.variantLabel, /[″"]|\bin\b/);
      const square = product.printFile.width === product.printFile.height;
      assert.equal(product.orientationOptions.length, square ? 0 : 2);
      assert.equal(product.defaultOrientation, square ? 'default' : 'portrait');
      const model = product.previewModel, file = product.printFile;
      assert.ok(Math.abs(model.face.width * file.width - model.width / 2.54 * file.dpi) < 1e-8);
      assert.ok(Math.abs(model.face.height * file.height - model.height / 2.54 * file.dpi) < 1e-8);
      assert.ok(product.designSafeAreas.default.x > model.face.x * file.width);
      assert.equal(fulfillment.variants.find(v => v.variantId === product.printful.variantId).departureCountry, 'ES');
      assert.ok(catalogPrice(product.printful.variantId).unitGrossCents > 0);
    }
  }
  const frames = PRODUCTS.filter(p => p.printful.productId === 614);
  for (const color of ['Schwarz', 'Braun', 'Weiß']) assert.equal(frames.filter(p => p.variantLabel.endsWith(' · ' + color)).length, 13);
  assert.deepEqual([...new Set(frames.map(p => p.size.label))].sort(), PRODUCTS.filter(p => p.printful.productId === 616).map(p => p.size.label).sort());
});

test('supplier cost refresh uses a German reference address for every offered variant', async () => {
  const requested = [];
  const snapshot = await refreshProductCosts({ products: PRODUCTS,
    estimate: async ({ variantId, quantity, recipient }) => {
      assert.equal(recipient.country_code, 'DE');
      assert.equal(recipient.zip, '10115');
      assert.equal(quantity, 1);
      requested.push(variantId);
      return { currency: 'EUR', total: '15.00', shipping: '5.00', tax: '0.00', vat: '0.00' };
    },
  });
  assert.deepEqual(requested, PRODUCTS.map(product => product.printful.variantId));
  assert.equal(snapshot.referenceCountry, 'DE');
  assert.equal(Object.keys(snapshot.variants).length, PRODUCTS.length);
  assert.ok(Object.values(snapshot.variants).every(variant => !variant.referenceCountry));
});
