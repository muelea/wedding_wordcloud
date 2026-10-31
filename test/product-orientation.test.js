'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCTS, getProduct, getPublicProduct, resolveProductOrientation } = require('../src/products');
const Orientation = require('../public/js/product-orientation');
const { specification } = require('../src/printPreparation');
const { compatibleStyle } = require('../src/printfulMockups');
const { buildPrintfulPayload } = require('../src/fulfillment');

test('both blanket sizes start in portrait while explicit and legacy landscape designs keep their geometry', () => {
  for (const key of ['throw-blanket-50x60in', 'throw-blanket-30x40in']) {
    const base = getProduct(key), initial = getPublicProduct(base);
    assert.equal(base.defaultOrientation, 'portrait');
    assert.equal(initial.orientation, 'portrait');
    assert.ok(initial.printFile.width < initial.printFile.height);
    assert.ok(initial.previewModel.width < initial.previewModel.height);
    assert.equal(initial.previewMockup?.rotation || 0, base.previewMockup ? 90 : 0);
    assert.equal(Orientation.selected(initial).key, 'portrait');
    assert.equal(resolveProductOrientation(base).orientation, 'portrait');
    assert.deepEqual(resolveProductOrientation(base, 'landscape').printFile, base.printFile);
    assert.deepEqual(resolveProductOrientation(base, 'default').printFile, base.printFile);
    assert.equal(Orientation.selected(initial, 'default').key, 'landscape');
  }
});

test('every supported orientation has matching dimensions, preview proportions and trusted safe areas', () => {
  let states = 0;
  for (const base of PRODUCTS) {
    for (const option of base.orientationOptions.length ? base.orientationOptions : [{ key: 'default' }]) {
      const product = resolveProductOrientation(base, option.key);
      states++;
      if (option.key !== 'default') {
        assert.equal(product.printFile.width > product.printFile.height, option.key === 'landscape', base.key);
        assert.equal(product.previewModel.width > product.previewModel.height, option.key === 'landscape', base.key);
        const [width, height] = product.size.label.match(/\d+(?:[.,]\d+)?(?=\s*×)|\d+(?:[.,]\d+)?(?=\s*cm)/g).map(n => Number(n.replace(',', '.')));
        assert.equal(width > height, option.key === 'landscape', base.key);
      }
      for (const area of Object.values(product.designSafeAreas)) {
        assert.ok(area.x >= 0 && area.y >= 0 && area.x + area.width <= product.printFile.width &&
          area.y + area.height <= product.printFile.height, base.key);
      }
      const publicProduct = getPublicProduct(base, option.key);
      assert.deepEqual(Orientation.view(getPublicProduct(base), option.key).printFile, publicProduct.printFile);
      assert.equal(Orientation.summary(product), Orientation.summary(publicProduct));
    }
  }
  assert.equal(states, 448);
});

test('legacy blanket defaults retain their complete original specification and private fulfillment files', () => {
  for (const key of ['throw-blanket-50x60in', 'throw-blanket-30x40in']) {
    const base = getProduct(key), legacy = resolveProductOrientation(base, 'default');
    const design = { version: 2, surfaces: { default: [{ id: 'kept', text: 'Original', x: 900, y: 900, fontSize: 60 }] } };
    assert.equal(legacy.orientation, 'default');
    assert.equal(specification(legacy, design), specification({ ...base, orientation: 'default' }, design));
    assert.deepEqual(legacy.printFile, base.printFile);
    assert.deepEqual(legacy.previewModel, base.previewModel);
    assert.deepEqual(legacy.designSafeAreas, base.designSafeAreas);
    assert.equal(Orientation.selected(getPublicProduct(base), 'default').key, 'landscape');
    const items = ['default', 'portrait', 'landscape'].map((orientation, index) => ({
      id: index + 1, shipment_index: 0, item_index: index, configuration_id: `configuration-${index}`,
      printful_variant_id: base.printful.variantId, quantity: 1,
      configuration_snapshot_json: JSON.stringify({ version: 1, productKey: key, orientation, design }),
    }));
    const artifacts = items.map(item => ({ order_item_id: item.id, surface_key: 'default',
      id: `artifact-${item.id}`, access_nonce: 'private-capability' }));
    const payload = buildPrintfulPayload({ order: { id: 1, shipping_json: JSON.stringify({ name: 'Test',
      address1: 'Testweg 1', city: 'Berlin', zip: '10115', country_code: 'DE' }) }, orderItems: items, artifacts, mode: 'live' });
    assert.ok(payload.items.every(item => item.variant_id === base.printful.variantId));
    assert.equal(new Set(payload.items.map(item => item.files[0].url)).size, 3);
    assert.ok(payload.items.every(item => item.files[0].url.includes('/api/print-files/artifact-')));
    assert.equal(resolveProductOrientation(base, 'diagonal'), null);
  }
});

test('blanket mockup styles match the exact native or transposed provider area and never fall back to the opposite orientation', () => {
  for (const [key, horizontalId, verticalId] of [
    ['throw-blanket-50x60in', 3051, 3052], ['throw-blanket-30x40in', 27022, 27021],
  ]) {
    const base = getProduct(key);
    // Read-only Printful catalog metadata checked on 2026-10-31.
    const rows = [[horizontalId, base.printFile.width, base.printFile.height],
      [verticalId, base.printFile.height, base.printFile.width]].map(([id, width, height]) => ({
      placement: 'default', technique: 'sublimation', print_area_type: 'simple',
      print_area_width: width / 150, print_area_height: height / 150,
      mockup_styles: [{ id, category_name: 'Flat', restricted_to_variants: [base.printful.variantId] }],
    }));
    assert.equal(compatibleStyle(rows, resolveProductOrientation(base, 'landscape'), 'default').id, horizontalId);
    assert.equal(compatibleStyle(rows, resolveProductOrientation(base, 'portrait'), 'default').id, verticalId);
    assert.throws(() => compatibleStyle(rows.slice(0, 1), resolveProductOrientation(base, 'portrait'), 'default'), /passenden Mockup-Stil/);
  }
});
