'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const Products = require('../public/js/cart-product-preview');
const Picker = require('../public/js/product-picker');
const catalog = require('../src/products');
const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
function source(name) {
  const start = template.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, name);
  return template.slice(start, template.indexOf('\n    }', start) + 6);
}

test('the product trigger closes its tracked chooser after native light-dismiss, like the colour trigger', t => {
  const dom = new JSDOM('<button id="change-product" aria-expanded="false"></button>');
  t.after(() => dom.window.close());
  const changeProductButton = dom.window.document.getElementById('change-product');
  let visible = false, opens = 0, closes = 0;
  const productDialog = { open: false, matches: () => visible };
  const workspace = { active: null,
    close() { closes++; visible = false; this.active = null; changeProductButton.setAttribute('aria-expanded', 'false'); },
  };
  const context = vm.createContext({ changeProductButton, productDialog, workspace,
    startingAnotherProduct: false,
    openProductDialog() {
      opens++; visible = true; workspace.active = { panel: productDialog, trigger: changeProductButton };
      changeProductButton.setAttribute('aria-expanded', 'true');
    },
  });
  vm.runInContext(source('closeProductDialog'), context);
  const start = template.indexOf("    changeProductButton.addEventListener('click',");
  vm.runInContext(template.slice(start, template.indexOf('\n    productDialogClose.addEventListener', start)), context);
  changeProductButton.click();
  assert.equal(visible, true);
  assert.equal(changeProductButton.getAttribute('aria-expanded'), 'true');
  visible = false; // Native Popover dismissal happens before the trigger's click.
  changeProductButton.click();
  assert.equal(visible, false);
  assert.equal(opens, 1, 'the second click must not reopen the dismissed picker');
  assert.equal(closes, 1);
  assert.equal(changeProductButton.getAttribute('aria-expanded'), 'false');
  changeProductButton.click();
  assert.equal(opens, 2);
  assert.equal(visible, true);
});

test('the selected product thumbnail reuses the gallery reference photo for every exact variant', t => {
  const dom = new JSDOM('<span id="selected-product-price"></span>');
  t.after(() => dom.window.close());
  const document = dom.window.document, products = catalog.getPublicProducts();
  const context = vm.createContext({ document, WolkenworteCartProductPreview: Products,
    selectedOrientation: 'default',
    t: value => value, setText: (element, text) => { element.textContent = text; },
    selectedProductSummary: () => '', productPriceText: () => '', updateToolbarSummaries() {},
    selectedProductThumb: document.createElement('img'), selectedProductName: document.createElement('strong'),
    productInfoButton: document.createElement('button'), mobileSelectedProductName: document.createElement('strong'),
    selectedProductDetail: document.createElement('span'), mobileSelectedProductDetail: document.createElement('span'),
  });
  vm.runInContext(source('renderSelectedProduct'), context);
  const before = JSON.stringify(products);
  for (const product of products) {
    context.product = product; context.renderSelectedProduct();
    assert.equal(context.selectedProductThumb.getAttribute('src'), Products.photo(product), product.key);
    context.selectedProductThumb.src = 'data:image/png;base64,current-design';
    context.renderSelectedProduct();
    assert.equal(context.selectedProductThumb.getAttribute('src'), 'data:image/png;base64,current-design',
      'refreshing product labels must retain its rendered design thumbnail');
  }
  assert.equal(JSON.stringify(products), before);
});

test('editor thumbnails reuse the current rendered design after edits settle and reject stale product previews', t => {
  const dom = new JSDOM('<img>'); t.after(() => dom.window.close());
  const timers = new Map(); let sequence = 0, renders = 0;
  const selectedProductThumb = dom.window.document.querySelector('img');
  const context = vm.createContext({ selectedProductThumb, selectedProductThumbnailTimer: null,
    editorElement: { hidden: false }, selectedOrientation: 'default', previewState: 'ready',
    setTimeout(callback) { timers.set(++sequence, callback); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    WolkenworteProductGallery: { productThumbnail: canvas => canvas.image },
    flatCanvas: { image: 'data:image/png;base64,flat-design' },
  });
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); };
  vm.runInContext(source('scheduleSelectedProductThumbnail'), context);
  for (const previewType of ['mug', '3d', 'photo']) {
    context.product = { key: previewType, previewType };
    context.mug3D = { productKey: previewType, orientation: 'default',
      canvas: { image: 'data:image/png;base64,old-design' }, render() { renders++; } };
    context.scheduleSelectedProductThumbnail(); context.scheduleSelectedProductThumbnail();
    assert.equal(timers.size, 1, 'repeated drag frames coalesce into one thumbnail');
    context.mug3D.canvas.image = `data:image/png;base64,latest-${previewType}`;
    flush();
    assert.equal(selectedProductThumb.getAttribute('src'), `data:image/png;base64,latest-${previewType}`);
    const before = selectedProductThumb.src;
    context.mug3D.productKey = 'previous-product';
    context.scheduleSelectedProductThumbnail(); flush();
    assert.equal(selectedProductThumb.src, before, 'a previous variant cannot overwrite the current thumbnail');
    context.mug3D.productKey = previewType; context.mug3D.orientation = 'previous-orientation';
    context.scheduleSelectedProductThumbnail(); flush(); assert.equal(selectedProductThumb.src, before);
  }
  assert.equal(renders, 3, 'capture uses the existing renderer only once per settled update');
  context.product = { key: 'poster', previewType: 'flat' };
  context.scheduleSelectedProductThumbnail(); flush();
  assert.equal(selectedProductThumb.getAttribute('src'), 'data:image/png;base64,flat-design');
  context.editorElement.hidden = true; context.flatCanvas.image = 'data:image/png;base64,hidden';
  context.scheduleSelectedProductThumbnail(); flush();
  assert.equal(selectedProductThumb.getAttribute('src'), 'data:image/png;base64,flat-design');
});

test('the editor delegates browsing to the shared picker and transfers only the explicitly confirmed product', t => {
  const dom = new JSDOM('<button id="change-product"></button><dialog><h2 id="product-dialog-title"></h2><p id="product-dialog-description"></p><button id="product-dialog-back"></button><div class="product-dialog-footer"></div><div id="product-options"></div></dialog>');
  t.after(() => dom.window.close());
  const document = dom.window.document, product = catalog.getPublicProducts()[0], confirmed = [];
  const context = vm.createContext({ document, product, products: catalog.getPublicProducts(),
    productFamilies: catalog.getPublicProductFamilies(), pendingProductKey: product.key, productPicker: null,
    productOptions: document.getElementById('product-options'), productDialog: document.querySelector('dialog'),
    variantPanel: { hidden: false }, workspace: { close() {}, positionChooser() {},
      show(panel) { this.active = { panel }; } },
    changeProductButton: document.getElementById('change-product'), productDialogDone: document.createElement('button'),
    mobileDevice: false, startingAnotherProduct: false, editingOrderItemId: null,
    selectedFamilyKey: product.familyKey, requestAnimationFrame: callback => callback(),
    WolkenworteProductPicker: Picker, WolkenworteCartProductPreview: Products,
    WolkenworteI18n: { t: value => value }, productPriceText: () => '€1',
    setText: (element, text) => { element.textContent = text; }, cartProductPreview: { openPhotos() {} },
    openPickerProductInfo() {},
    selectDialogProduct: candidate => confirmed.push(candidate), confirmProductDialog() {}, updateProductOptionSelection() {},
  });
  context.productDialog.showPopover = () => {};
  for (const name of ['buildProductOptions', 'openProductDialog']) vm.runInContext(source(name), context);
  context.openProductDialog();
  assert.equal(context.workspace.active.panel, context.productDialog);
  const clickChoice = label => [...document.querySelectorAll('.product-picker-choice')].find(b => b.querySelector('span').textContent === label).click();
  clickChoice('Technik & Zubehör'); clickChoice('Laptophülle');
  document.querySelector('[data-value="15″"]').click();
  assert.deepEqual(confirmed, []);
  assert.doesNotMatch(document.body.textContent, /undefined/);
  document.querySelector('.product-picker-apply').click();
  assert.equal(confirmed[0].key, 'laptop-sleeve-10985');
  assert.equal(context.product, product, 'staging options does not replace the active editor product');
});

test('closing product details resumes the same editor picker, staged options, scroll and focus', t => {
  const dom = new JSDOM('<button id="change-product"></button><dialog><button id="product-dialog-back"></button><div class="product-dialog-footer"></div><div id="product-options"></div></dialog>');
  t.after(() => dom.window.close());
  const document = dom.window.document, productDialog = document.querySelector('dialog');
  const changeProductButton = document.getElementById('change-product');
  let resets = 0, restoredMobile = 0, opened, visible = true;
  const workspace = {
    active: { panel: productDialog, trigger: changeProductButton, mode: 'popover' },
    close(focus) { assert.equal(focus, false); visible = false; this.active = null; },
    show(panel, trigger, popover) {
      assert.equal(panel, productDialog); assert.equal(trigger, changeProductButton); assert.equal(popover, true);
      visible = true; this.active = { panel, trigger, mode: 'popover' };
    },
    mobileCanvas: { restorePicker() { restoredMobile++; } },
  };
  const context = vm.createContext({ document, productDialog, workspace, changeProductButton,
    productOptions: document.getElementById('product-options'), productPicker: null, productDetailsReturn: null,
    productDialogCloseReason: 'cancel', startingAnotherProduct: true,
    resetProductDialogSelection() { resets++; }, updateProductOptionSelection() {},
    cartProductPreview: { openPhotos(candidate, trigger) { opened = { candidate, trigger }; } },
  });
  for (const name of ['openPickerProductInfo', 'restorePickerAfterDetails', 'finishProductDialogClose']) {
    vm.runInContext(source(name), context);
  }
  context.productPicker = Picker.create(context.productOptions, {
    products: catalog.getPublicProducts(), families: catalog.getPublicProductFamilies(),
    selectedKey: 'white-glossy-mug-duo-11oz', browse: true, i18n: { t: value => value },
    photo: Products.photo, price: () => '€1', onPhoto: context.openPickerProductInfo,
  });
  const choice = label => [...document.querySelectorAll('.product-picker-choice')].find(b => b.querySelector('span').textContent === label).click();
  choice('Tassen'); choice('Tasse mit farbiger Innenseite');
  document.querySelector('[data-value="444 ml"]').click();
  const picker = context.productPicker, selected = picker.selected;
  const content = document.querySelector('.product-picker-content'); content.scrollTop = 57;
  const trigger = document.querySelector('.product-picker-photo'); trigger.click();
  assert.equal(opened.candidate, selected);
  assert.equal(visible, false, 'the auto popover is suspended before showModal dismisses it');
  context.finishProductDialogClose(false); // Native closed-toggle arrives while details is open.
  assert.equal(resets, 0); assert.equal(restoredMobile, 0);
  assert.equal(context.startingAnotherProduct, true);
  content.scrollTop = 0;
  context.restorePickerAfterDetails();
  assert.equal(visible, true);
  assert.equal(context.productPicker, picker, 'resuming must not rebuild the picker');
  assert.equal(picker.stage, 'options'); assert.equal(picker.selected, selected);
  assert.equal(content.scrollTop, 57);
  assert.equal(document.activeElement, trigger);
  document.querySelector('[data-value="Blau"]').click();
  assert.notEqual(picker.selected.key, selected.key, 'another colour can be inspected at the same level');
  const secondTrigger = document.querySelector('.product-picker-photo'); secondTrigger.click();
  context.finishProductDialogClose(false); context.restorePickerAfterDetails();
  assert.equal(document.activeElement, secondTrigger);
  assert.equal(picker.stage, 'options'); assert.equal(resets, 0);
  context.finishProductDialogClose(false);
  assert.equal(resets, 1, 'ordinary cancellation still resets pending product selection');
  assert.equal(context.startingAnotherProduct, false);
});

test('details retain an underlying modal or embedded picker without reopening it, and recover from a preview error', t => {
  const dom = new JSDOM('<button></button><dialog><div class="product-picker-content"></div></dialog>');
  t.after(() => dom.window.close());
  const productDialog = dom.window.document.querySelector('dialog'), trigger = dom.window.document.querySelector('button');
  const workspace = { close() { assert.fail('a modal or embedded picker must stay open'); },
    show() { assert.fail('a modal or embedded picker must not reopen'); } };
  const context = vm.createContext({ productDialog, workspace, productPicker: {}, productDetailsReturn: null,
    cartProductPreview: { openPhotos() {} } });
  for (const name of ['openPickerProductInfo', 'restorePickerAfterDetails']) vm.runInContext(source(name), context);
  for (const mode of ['modal', 'embedded']) {
    workspace.active = { panel: productDialog, trigger, mode };
    context.openPickerProductInfo({}, trigger); context.restorePickerAfterDetails();
    assert.equal(context.productDetailsReturn, null); assert.equal(dom.window.document.activeElement, trigger);
  }
  context.cartProductPreview.openPhotos = () => { throw new Error('preview unavailable'); };
  assert.throws(() => context.openPickerProductInfo({}, trigger), /preview unavailable/);
  assert.equal(context.productDetailsReturn, null, 'a failed preview cannot leave picker cancellation suspended');
});

test('product details show the current side, retained sides and exact orientation without storing or saving edits', () => {
  const products = catalog.getPublicProducts();
  for (const product of [products.find(p => p.key === 'spiral-notebook-dotted'), products.find(p => p.orientations.length > 1)]) {
    const latest = [{ text: 'Unsaved edit', x: 120, y: 160, fontSize: 44 }];
    const surfaceStates = new Map(product.printSurfaces.map(surface => [surface.key,
      { design: [{ text: `Retained ${surface.key}`, x: 180, y: 240, fontSize: 32 }] }]));
    const activeSurface = product.printSurfaces.at(-1).key;
    const selectedOrientation = product.orientations.at(-1)?.key || 'default';
    const before = JSON.stringify({ product, states: [...surfaceStates], latest });
    const renders = [], opened = [], infoButton = {};
    let closed = 0;
    const context = vm.createContext({ product, selectedOrientation, activeSurface, surfaceStates,
      workspaceReady: true, restorationFailed: false, productTransitionPending: false,
      workspace: { close(restoreFocus) { assert.equal(restoreFocus, false); closed++; } },
      productInfoButton: infoButton, getCurrentDesign: () => latest,
      renderPreviewArtwork(view, design) {
        renders.push({ view, design });
        return `data:image/png;base64,${renders.length}`;
      },
      cartProductPreview: { open: (item, trigger) => opened.push({ item, trigger }) },
      getAllSurfaceDesigns() { throw new Error('details must not store the active side'); },
      fetch() { throw new Error('details must not create a saved configuration'); },
    });
    for (const name of ['productView', 'openCurrentProductInfo']) vm.runInContext(source(name), context);
    context.openCurrentProductInfo();
    assert.equal(closed, 1);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].trigger, infoButton, 'the shared dialog restores focus to the thumbnail');
    assert.equal(opened[0].item.product.key, product.key);
    assert.equal(opened[0].item.product.orientation, selectedOrientation);
    assert.deepEqual(Object.keys(opened[0].item.printPreviewUrls), product.printSurfaces.map(p => p.key));
    for (const [index, surface] of product.printSurfaces.entries()) {
      assert.equal(renders[index].design, surface.key === activeSurface ? latest : surfaceStates.get(surface.key).design);
      assert.equal(renders[index].view.orientation, selectedOrientation);
    }
    assert.equal(JSON.stringify({ product, states: [...surfaceStates], latest }), before);
    context.productTransitionPending = true;
    context.openCurrentProductInfo();
    assert.equal(opened.length, 1, 'an in-progress product switch cannot open stale product details');
  }
});

test('gallery and product details share a bounded local artwork rendering without altering print dimensions', () => {
  const canvases = [], drawn = [], design = [{ text: 'Current artwork', x: 81, y: 42 }];
  const context = vm.createContext({ document: { createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = { getContext: () => ({ scale() {} }), toDataURL: () => 'data:image/png;base64,preview' };
    canvases.push(canvas); return canvas;
  } }, drawDesign: (canvas, x, y, scale, items) => drawn.push(items) });
  vm.runInContext(source('renderPreviewArtwork'), context);
  for (const printFile of [{ width: 18000, height: 9000 }, { width: 1600, height: 3200 }, { width: 600, height: 400 }]) {
    const before = JSON.stringify(printFile);
    assert.match(context.renderPreviewArtwork({ printFile }, design), /^data:image\/png;/);
    const canvas = canvases.at(-1);
    assert.ok(Math.max(canvas.width, canvas.height) <= 1200);
    assert.ok(Math.abs(canvas.width / canvas.height - printFile.width / printFile.height) < .005);
    assert.equal(drawn.at(-1), design);
    assert.equal(JSON.stringify(printFile), before);
  }
});
