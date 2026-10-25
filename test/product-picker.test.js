'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { getPublicProducts, getPublicProductFamilies } = require('../src/products');

const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
function pageFunction(name) {
  const start = template.search(new RegExp('    function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return template.slice(start, template.indexOf('\n    }', start) + '\n    }'.length);
}
function fixture(t, presentation = 'popover') {
  const markup = template.match(/<dialog class="product-dialog[\s\S]*?<\/dialog>/)[0];
  const dom = new JSDOM(markup + '<h2 id="mobile-canvas-panel-title"></h2>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const productDialog = document.getElementById('product-dialog');
  productDialog.dataset.presentation = presentation;
  productDialog.setAttribute('open', '');
  const products = getPublicProducts(), productFamilies = getPublicProductFamilies();
  const product = products.find(candidate => candidate.familyKey === 'mugs');
  assert.ok(product);
  const confirmed = [];
  const context = vm.createContext({
    document, productDialog, products, productFamilies, product,
    productOptions: document.getElementById('product-options'),
    variantPanel: document.getElementById('variant-panel'),
    variantOptions: document.getElementById('variant-options'),
    pendingProductKey: product.key, pendingFamilyKey: product.familyKey,
    selectedFamilyKey: product.familyKey, startingAnotherProduct: false,
    workspace: { positionChooser() {} }, requestAnimationFrame: callback => callback(),
    renderSelectedProduct() {}, localizedNumber: String, WolkenworteI18n: { formatNumber: String,
      formatCurrency: (cents, currency) => new Intl.NumberFormat('de', { style: 'currency', currency }).format(cents / 100) },
    t: text => text, setText: (element, text) => { element.textContent = text; },
    setTranslatedAttribute: (element, attribute, text) => element.setAttribute(attribute, text),
    confirmProductDialog: () => confirmed.push(context.dialogSelectedProduct().key),
  });
  vm.runInContext(['dialogSelectedProduct', 'dialogSelectedFamilyKey', 'updateProductOptionSelection',
    'productsInFamily', 'productDetail', 'productPriceText', 'productPickerIsStepped', 'showProductStep',
    'selectDialogProduct', 'selectDialogFamily', 'buildVariantOptions', 'buildProductOptions']
    .map(pageFunction).join('\n'), context);
  context.buildProductOptions();
  context.showProductStep('families');
  return { dom, document, context, confirmed, product, products };
}

test('product dropdown navigates families without applying a product, and Back restores focus', t => {
  const { dom, document, context, confirmed, product } = fixture(t);
  const families = [...context.productOptions.children];
  assert.ok(families.every(option => option.getAttribute('role') === 'button'));
  families[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.activeElement, families[1]);
  assert.equal(context.productDialog.dataset.mobileStep, 'families');
  assert.equal(context.pendingProductKey, product.key);
  families[1].click();
  assert.equal(context.productDialog.dataset.mobileStep, 'variants');
  assert.equal(context.productOptions.hidden, true);
  assert.equal(context.variantPanel.hidden, false);
  assert.equal(document.getElementById('product-dialog-back').hidden, false);
  assert.ok(context.variantOptions.children.length > 0, 'single-variant families still allow an explicit choice');
  context.showProductStep('families');
  assert.equal(document.activeElement, families[1]);
  assert.equal(context.product.key, product.key);
  assert.deepEqual(confirmed, []);
});

test('desktop applies the clicked variant exactly once; mobile retains its explicit confirmation', t => {
  for (const presentation of ['popover', 'embedded']) {
    const { context, confirmed, products } = fixture(t, presentation);
    context.productOptions.querySelector('[data-family-key="mugs"]').click();
    const variants = products.filter(candidate => candidate.familyKey === 'mugs');
    const next = variants[1];
    context.variantOptions.querySelector(`[data-product-key="${next.key}"]`).click();
    assert.equal(context.pendingProductKey, next.key);
    assert.equal(context.variantOptions.querySelector('[aria-checked="true"]').dataset.productKey, next.key);
    assert.deepEqual(confirmed, presentation === 'popover' ? [next.key] : []);
    assert.equal(context.productDialog.querySelector('.product-dialog-footer').hidden, presentation === 'popover');
  }
});
