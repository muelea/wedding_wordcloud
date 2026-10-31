'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createCanvas } = require('canvas');
const Fonts = require('../src/designFonts');
const { getPublicProducts } = require('../src/products');
const Transfer = require('../public/js/design-transfer');
const Core = require('../public/js/wordcloud-core');
const Bounds = require('../public/js/design-content-bounds');
const Quality = require('../public/js/text-print-quality');
const { isPrintDesignWithinBounds, buildProductPrintSvg } = require('../src/mugPrint');
const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
const products = getPublicProducts();
const measurement = createCanvas(1, 1).getContext('2d');

function pageFunction(name) {
  const start = template.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1);
  return template.slice(start, template.indexOf('\n    }', start) + 6);
}

// Exercise the real page callbacks: no duplicated transfer policy in a test
// factory, no database/provider writes, and the same registered print fonts.
function galleryCallbacks() {
  let callbacks;
  const noop = () => {};
  const page = vm.createContext({
    products, product: products[0], selectedOrientation: 'default', activeSurface: 'default',
    productGallery: null, liveWords: [['Seed must not replace edits', 1]], words: [],
    selectedTheme: 'konfetti', customColors: ['#123456'], directDesign: false, mobileDevice: false,
    editorElement: {}, galleryElement: {}, content: {}, loading: {},
    updateGalleryLocation: noop, updateProductBackLink: noop, updateHeaderCart: noop, loadOrderItems: () => [],
    getPalette: () => ({ colors: ['#123456', '#abcdef'] }),
    ProductOrientation: require('../public/js/product-orientation'), DesignTransfer: Transfer, DesignFonts: Fonts,
    ensureDesignFonts: async () => {}, WolkenworteEmoji: { preloadTexts: async () => {} },
    printLayoutJobs: () => ({ pack: Core.layoutBoxesInArea }), mugEditor: null,
    document: { createElement: () => createCanvas(1, 1) },
    AUTOMATIC_LAYOUT_VERSION: 'refill-current', WolkenworteI18n: {},
    WolkenworteProductGallery: { Gallery: class { constructor(options) { callbacks = options; } } },
    configureProductMockup: noop, paintFlatProductPreview: noop, cartProductPreview: noop,
    renderPreviewArtwork: noop, openGalleryDesign: noop, addGalleryDesign: noop,
  });
  vm.runInContext(['productView', 'showProductGallery'].map(pageFunction).join('\n'), page);
  page.showProductGallery();
  return callbacks;
}

function snapshot(product) {
  return { productKey: product.key, orientation: product.defaultOrientation, currentDesignEdited: true,
    editingOrderItemId: 'ExistingCart', words: [['Old seed', 1]],
    designs: Object.fromEntries(product.printSurfaces.map((surface, index) => {
      const area = product.designSafeAreas[surface.key];
      return [surface.key, ['Liebe', 'Freude', 'Familie', 'Glück', 'Lachen', 'Tanzen', 'Zusammen', 'Zukunft', '❤️', 'Reisen', 'Treue', 'Wärme']
        .map((text, i) => ({ id: `${index}-${i}`, text, x: area.x + area.width / 2, y: area.y + area.height / 2,
          fontSize: 70, angle: 0, fontFamily: 'classic', fontWeight: 400, fontStyle: 'normal',
          color: index ? '#abcdef' : '#123456', colorLocked: true }))];
    })) };
}

test('real gallery callbacks refill edited/cart artwork for blankets, posters and all canvas styles', async () => {
  const callbacks = galleryCallbacks();
  for (const group of ['blanket', 'poster', 'framed-poster', 'canvas', 'thin-canvas', 'framed-canvas']) {
    const variants = products.filter(p => p.catalogGroup === group && p.orientations.length === 2);
    const original = snapshot(variants[0]);
    const candidate = variants.find(p => p.key !== original.productKey) || variants[0];
    const before = structuredClone(original);
    const result = await callbacks.transfer(original, candidate, 'landscape');
    const view = callbacks.getView(candidate, 'landscape');
    const design = result.designs[view.printSurfaces[0].key];
    const box = Bounds.union(design.map(item => Bounds.bounds(item, measurement)));
    assert.ok(box.width / view.safeArea.width > .8 && box.height / view.safeArea.height > .8, group);
    assert.deepEqual(Array.from(design, item => item.text), original.designs[variants[0].printSurfaces[0].key].map(item => item.text));
    assert.ok(design.every(item => item.color === '#123456' && item.colorLocked));
    assert.equal(result.editingOrderItemId, original.editingOrderItemId);
    assert.equal(result.needsCartUpdate, true);
    assert.ok(isPrintDesignWithinBounds(design, view.printFile.width, view.printFile.height, view.safeArea));
    assert.deepEqual(Quality.findings(design, view.printFile.dpi), []);
    assert.deepEqual(original, before, 'conversion never changes an approved source');
  }
});

test('gallery refill capacity failures retain the source and the explicit small-text retry still works', async () => {
  const callbacks = galleryCallbacks();
  const original = snapshot(products.find(p => p.catalogGroup === 'blanket'));
  original.designs.default = Array.from({ length: 150 }, (_, i) => ({ ...original.designs.default[0],
    id: String(i), text: 'Lieblingsmenschen' }));
  const before = structuredClone(original);
  const coaster = products.find(p => p.previewShape === 'coaster');
  await assert.rejects(callbacks.transfer(original, coaster, 'default'), /print_capacity/);
  assert.deepEqual(original, before);
  const retried = await callbacks.transfer(original, coaster, 'default', { allowSmallText: true });
  assert.equal(retried.designs.default.length, 150);
  assert.equal(retried.editingOrderItemId, original.editingOrderItemId);
  assert.equal(retried.needsCartUpdate, true);
});

test('refilled portrait and landscape artwork saves, reopens and freezes the exact print geometry', async t => {
  const app = await require('./helpers').startTestServer(); t.after(() => app.close());
  const event = await require('./helpers').createEvent(app.baseUrl);
  const callbacks = galleryCallbacks();
  const large = products.find(p => p.key === 'throw-blanket-50x60in');
  const small = products.find(p => p.key === 'throw-blanket-30x40in');
  const original = snapshot(large);
  const frozen = [];
  for (const orientation of ['portrait', 'landscape']) {
    const refilled = await callbacks.transfer(original, small, orientation);
    const view = callbacks.getView(small, orientation);
    const response = await fetch(`${app.baseUrl}/api/events/${event.slug}/configurations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...refilled, theme: 'pastel', words: [['Liebe', 1]] }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const saved = await response.json();
    const restored = await fetch(`${app.baseUrl}/api/events/${event.slug}/configurations/${saved.id}/edit`).then(r => r.json());
    assert.equal(restored.orientation, orientation);
    assert.equal(restored.product.printFile.width, view.printFile.width);
    assert.equal(restored.product.printFile.height, view.printFile.height);
    restored.designs.default.forEach((item, index) => {
      for (const field of ['text', 'x', 'y', 'fontSize', 'angle', 'color', 'fontFamily']) {
        assert.equal(item[field], refilled.designs.default[index][field], field);
      }
    });
    const svg = await fetch(app.baseUrl + saved.printFileUrl).then(r => r.text());
    assert.equal(svg, buildProductPrintSvg(view, refilled.designs.default));
    frozen.push({ url: app.baseUrl + saved.printFileUrl, svg });
  }
  for (const { url, svg } of frozen) assert.equal(await fetch(url).then(r => r.text()), svg,
    'approving a different format never changes an earlier immutable print file');
});
