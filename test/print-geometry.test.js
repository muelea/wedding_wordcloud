'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const { createCanvas, loadImage } = require('canvas');
const { PRODUCTS, getProduct, getPublicProduct, resolveProductOrientation } = require('../src/products');
const { isPrintDesignWithinBounds, buildProductPrintSvg } = require('../src/mugPrint');
const { renderProviderPng } = require('../src/printRaster');
const Layout = require('../public/js/design-layout');
const Fonts = require('../src/designFonts');
const Core = require('../public/js/wordcloud-core');
const snapshot = require('./fixtures/printful-geometry.json');
const ctx = createCanvas(1, 1).getContext('2d');
const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
function pageFunction(name) {
  const start = template.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1);
  return template.slice(start, template.indexOf('\n    }', start) + 6);
}
function page(productKey) {
  const context = vm.createContext({ product: getPublicProduct(getProduct(productKey)),
    activeSurface: 'front', selectedOrientation: 'default', selectedTheme: 'konfetti',
    document: { createElement: () => createCanvas(1, 1) },
    words: [['liebe', 1], ['glück', 1], ['gemeinsam', 1], ['🎉', 1], ['😍', 1], ['2026', 1]],
    WordCloudCore: Core, DesignLayout: Layout, DesignFonts: Fonts,
    CloudLimits: require('../public/js/cloud-limits'), makePaletteAssigner: Core.makePaletteAssigner,
    getPalette: () => ({ colors: ['#ee2244', '#0055ff', '#009944'] }),
  });
  vm.runInContext(['productView', 'buildAutomaticDesign'].map(pageFunction).join('\n'), context);
  return context;
}
const heart = (x, y) => ({ id: 'heart', type: 'icon', icon: 'heart', size: 48,
  x, y, angle: 0, color: '#0055ff' });

test('all catalog print files and placements match the checked Printful API snapshot', () => {
  assert.deepEqual(PRODUCTS.map(p => p.key).sort(), snapshot.products.map(p => p.productKey).sort());
  for (const record of snapshot.products) {
    const product = getProduct(record.productKey);
    assert.equal(product.printful.productId, record.productId);
    assert.equal(product.printful.variantId, record.variant.variant_id);
    for (const surface of product.printSurfaces) {
      assert.equal(product.printful.printfileId, record.variant.placements[surface.key]);
    }
    for (const orientation of product.orientationOptions.length ? product.orientationOptions : [{ key: 'default' }]) {
      const view = resolveProductOrientation(product, orientation.key);
      const expected = [record.printfile.width, record.printfile.height];
      const actual = [view.printFile.width, view.printFile.height];
      if (record.printfile.can_rotate) { expected.sort((a,b) => a-b); actual.sort((a,b) => a-b); }
      assert.deepEqual(actual, expected, `${product.key}/${orientation.key}`);
      assert.equal(view.printFile.dpi, record.printfile.dpi);
      for (const area of Object.values(view.designSafeAreas)) {
        assert.ok(area.x >= 0 && area.y >= 0 && area.width > 0 && area.height > 0);
        assert.ok(area.x + area.width <= view.printFile.width && area.y + area.height <= view.printFile.height);
        for (const [x,y] of [[area.x+24,area.y+24], [area.x+area.width-24,area.y+area.height-24]]) {
          assert.ok(isPrintDesignWithinBounds([heart(x,y)], view.printFile.width, view.printFile.height, area));
          assert.equal(isPrintDesignWithinBounds([heart(area.x+23,y)], view.printFile.width, view.printFile.height, area), false);
        }
      }
    }
  }
});

test('flat preview artwork uses the full-file mapping of its exact Printful overlay', () => {
  for (const record of snapshot.products) {
    const product = getProduct(record.productKey);
    for (const remote of record.previews) {
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../public', remote.localAsset))).digest('hex'), remote.sha256);
      const canvas = product.previewMockup.canvases?.[remote.placement] || product.previewMockup.canvas;
      for (const [field, value, total] of [
        ['left',remote.print_area_left,remote.template_width], ['top',remote.print_area_top,remote.template_height],
        ['width',remote.print_area_width,remote.template_width], ['height',remote.print_area_height,remote.template_height],
      ]) assert.ok(Math.abs(canvas[field] - value / total * 100) < .00001, `${record.productKey}/${remote.placement}/${field}`);
    }
  }
});

test('official safe guides reserve notebook binding, textile seams and poster trim', () => {
  const notebook = getProduct('spiral-notebook-dotted');
  const front = notebook.designSafeAreas.front, back = notebook.designSafeAreas.back;
  assert.ok(front.x >= 201 && front.x + front.width <= 1620);
  assert.ok(back.x >= 128 && back.x + back.width <= 1546);
  for (const area of [front,back]) assert.ok(area.y >= 170 && area.y + area.height <= 2444);
  assert.equal(front.width, back.width);
  assert.equal(front.height, back.height);
  for (const [key,safeWidth,safeHeight] of [
    ['throw-blanket-50x60in',55*150,45*150],
    ['all-over-basic-pillow-18in',17*150,17*150],
    ['all-over-tote-black-handles',13*150,11*150],
  ]) for (const area of Object.values(getProduct(key).designSafeAreas)) {
    assert.ok(area.width <= safeWidth && area.height <= safeHeight, key);
  }
  for (const product of PRODUCTS.filter(p => p.familyKey === 'posters')) {
    const area = product.designSafeAreas.default;
    assert.ok(area.x >= 1.25 / 2.54 * 300 && area.y >= 1.25 / 2.54 * 300);
    assert.ok(product.printFile.width - area.x - area.width >= 1.25 / 2.54 * 300);
    assert.ok(product.printFile.height - area.y - area.height >= 1.25 / 2.54 * 300);
  }
});

test('handle-free drinkware keeps a three-pixel join while preserving vertical bounds and exact print pixels', async () => {
  const variants = [
    ['wine-tumbler', 50], ['water-bottle-10798', 50], ['water-bottle-16030', 50],
    ['steel-tumbler-15005', 70], ['steel-tumbler-15004', 70],
  ];
  const marker = createCanvas(24, 24), source = marker.getContext('2d');
  source.fillStyle = '#0055ff'; source.fillRect(0, 0, 24, 24);
  for (const [key, verticalMargin] of variants) {
    const product = getProduct(key), { width, height } = product.printFile;
    const area = product.designSafeAreas.default;
    assert.deepEqual(area, { x: 3, y: verticalMargin, width: width - 6, height: height - verticalMargin * 2 });
    assert.deepEqual(getPublicProduct(product).designSafeAreas.default, area);
    assert.deepEqual(product.layoutGeometry['fit-area'], [{ ...area, optimize: true }]);
    const design = [15, width - 15].map((x, index) => ({ id: `edge-${index}`, type: 'image',
      src: marker.toDataURL(), x, y: verticalMargin + 12, width: 24, height: 24, angle: 0 }));
    assert.ok(isPrintDesignWithinBounds(design, width, height, area));
    for (const [index, changes] of [[0, { x: 14.9 }], [1, { x: width - 14.9 }],
      [0, { y: verticalMargin + 11.9 }], [0, { y: height - verticalMargin - 11.9 }]]) {
      const outside = design.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item);
      assert.equal(isPrintDesignWithinBounds(outside, width, height, area), false, key + ': strict side/top/bottom boundary');
    }
    const bytes = await renderProviderPng(product, design), image = await loadImage(bytes);
    assert.equal(image.width, width); assert.equal(image.height, height);
    const output = createCanvas(width, height).getContext('2d'); output.drawImage(image, 0, 0);
    const pixel = x => [...output.getImageData(x, verticalMargin + 12, 1, 1).data];
    for (const x of [0, 1, 2, width - 3, width - 2, width - 1]) assert.equal(pixel(x)[3], 0);
    for (const x of [3, 26, width - 27, width - 4]) assert.deepEqual(pixel(x), [0, 85, 255, 255]);
    const existing = [heart(width / 2, height / 2)];
    assert.deepEqual(await renderProviderPng(product, existing),
      await renderProviderPng({ ...product, designSafeMargin: verticalMargin }, existing),
      key + ': older accepted artwork is not stretched or repositioned');
    const automatic = page(key).buildAutomaticDesign();
    assert.ok(isPrintDesignWithinBounds(automatic, width, height, area), key + ': automatic layout uses the same rectangle');
  }
  assert.equal(getProduct('enamel-mug').designSafeMargin, 35);
  assert.equal(getProduct('white-glossy-mug-duo-11oz').designSafeMargin, 24);
  assert.equal(getProduct('travel-mug-16440').designSafeMargin, 45);
});

test('automatic front/back layouts and preview mapping use the selected side', async () => {
  const p = page('spiral-notebook-dotted');
  const designs = {};
  for (const side of ['front', 'back']) {
    p.activeSurface = side;
    const view = p.productView();
    assert.equal(view.key, 'spiral-notebook-dotted');
    assert.deepEqual(view.safeArea, p.product.designSafeAreas[side]);
    assert.deepEqual(view.previewMockup.canvas, p.product.previewMockup.canvases[side]);
    designs[side] = p.buildAutomaticDesign();
    assert.equal(designs[side].length, p.words.length);
    assert.ok(isPrintDesignWithinBounds(designs[side],1725,2625,view.safeArea));
  }
  // Execute the actual copy handler, including its offset correction.
  let workingDesign = designs.back;
  Object.assign(p, { surfaceStates: new Map([['front', {design:designs.front}], ['back', {design:designs.back}]]),
    orderActionPending: false, leavingPage: false, askDesignReplacement: async () => true,
    storeActiveSurfaceState() {}, mugEditor: {
      recordHistory() {}, setDesign(design) { workingDesign = design; },
      getState: () => ({ design: workingDesign }), setFeedback() {},
    }, markDirty() {}, renderAll() {} });
  vm.runInContext(['cloneDesign','cloneEditorState'].map(pageFunction).join('\n'), p);
  const start = template.indexOf("    surfaceCopy.addEventListener('click', async () => {");
  assert.notEqual(start, -1);
  const body = template.slice(start,template.indexOf('\n    });',start)+8);
  let copy;
  p.surfaceCopy = { addEventListener: (_, handler) => { copy = handler; } };
  vm.runInContext(body, p);
  await copy();
  const copied = p.surfaceStates.get('back').design;
  assert.ok(isPrintDesignWithinBounds(copied,1725,2625,p.product.designSafeAreas.back));
  assert.equal(copied[0].x, designs.front[0].x - 73);
  assert.equal(copied[0].fontSize, designs.front[0].fontSize);
  const poster = page('matte-poster-30x40cm');
  poster.selectedOrientation = 'landscape';
  assert.equal(poster.productView().key, 'matte-poster-30x40cm');
  assert.equal(poster.productView().safeArea.width, 4724 - 308);
});

test('older approved artwork stays unchanged while its reopened draft fits the new safe area', () => {
  const product = getProduct('spiral-notebook-dotted');
  const design = [heart(120,300), heart(1500,2300)];
  const before = JSON.stringify(design);
  assert.equal(isPrintDesignWithinBounds(design,1725,2625,product.designSafeAreas.front), false);
  const oldSvg = buildProductPrintSvg(product,design);
  const fitted = Layout.fitDesignToSafeArea(design,product.designSafeAreas.front,ctx,
    {fontFamily:item=>Fonts.cssFamily(item.fontFamily)});
  assert.equal(fitted.adjusted,true);
  assert.ok(isPrintDesignWithinBounds(fitted.design,1725,2625,product.designSafeAreas.front));
  assert.equal(JSON.stringify(design),before);
  assert.equal(buildProductPrintSvg(product,design),oldSvg);
  const unchanged = Layout.fitDesignToSafeArea(fitted.design,product.designSafeAreas.front,ctx);
  assert.equal(unchanged.adjusted,false);
  assert.equal(unchanged.design,fitted.design);
});
