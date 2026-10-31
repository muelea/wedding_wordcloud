'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Picker = require('../public/js/product-picker');
const Photos = require('../public/js/cart-product-preview');
const { getPublicProducts, getPublicProductFamilies } = require('../src/products');
const products = getPublicProducts(), families = getPublicProductFamilies();
const i18n = { t: (text, params = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key]) };
function harness(t, options = {}) {
  const dom = new JSDOM('<div id="picker"></div>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const host = dom.window.document.getElementById('picker'), confirmed = [], opened = [], navigation = [];
  const picker = Picker.create(host, { products, families, selectedKey: products[0].key, browse: true,
    i18n, photo: Photos.photo, price: p => String(p.price.unitGrossCents),
    onConfirm: p => confirmed.push(p), onPhoto: p => opened.push(p), onNavigate: state => navigation.push(state), ...options });
  const choice = text => {
    const button = [...host.querySelectorAll('.product-picker-choice')].find(b => b.querySelector('span').textContent === text);
    assert.ok(button, text); button.click();
  };
  return { host, picker, confirmed, opened, navigation, choice, window: dom.window };
}

test('every catalog variant round-trips through product options without merging identities or mutating print data', () => {
  const before = JSON.stringify(products);
  for (const product of products) {
    const candidates = products.filter(p => Picker.type(p) === Picker.type(product));
    const state = Picker.optionState(candidates, Picker.record(product).attributes);
    assert.equal(state.product, product, product.key);
    for (const field of state.options) {
      assert.ok(field.values.includes(field.value), product.key);
      assert.ok(field.values.every(value => typeof value === 'string' && value.length > 0));
    }
  }
  assert.equal(JSON.stringify(products), before);
});

test('tech and wall art navigation render short product lists and browsing never confirms a product', t => {
  const h = harness(t);
  assert.equal(h.host.querySelectorAll('img').length, 8);
  h.choice('Technik & Zubehör');
  assert.deepEqual([...h.host.querySelectorAll('.product-picker-choice span:first-of-type')].map(e => e.textContent),
    ['Mauspad', 'Laptophülle', 'Handyhüllen']);
  assert.equal(h.host.querySelectorAll('img').length, 3);
  h.choice('Handyhüllen');
  assert.equal(h.picker.stage, 'options');
  assert.equal(h.host.querySelectorAll('img').length, 1);
  assert.deepEqual(h.confirmed, []);
  h.picker.back(); h.picker.back(); h.choice('Wandbilder');
  assert.deepEqual([...h.host.querySelectorAll('.product-picker-choice span:first-of-type')].map(e => e.textContent),
    ['Mattes Poster', 'Gerahmtes Poster', 'Leinwand']);
  assert.doesNotMatch(h.host.textContent, /undefined/);
});

test('phone model search supports keyboard selection, empty results and Escape without closing its parent', t => {
  const h = harness(t); h.choice('Technik & Zubehör'); h.choice('Handyhüllen');
  h.host.querySelector('[data-option-key="model"] .product-picker-select').click();
  let input = h.host.querySelector('input');
  assert.equal(h.window.document.activeElement, input);
  assert.equal(h.host.querySelectorAll('[role="option"]').length, 29, 'each Apple model appears once across case types and finishes');
  input.value = 'no such model'; input.dispatchEvent(new h.window.Event('input'));
  assert.equal(h.host.querySelectorAll('[role="option"]').length, 0);
  assert.match(h.host.textContent, /Keine passenden Optionen/);
  input.value = 'iPhone 17'; input.dispatchEvent(new h.window.Event('input'));
  assert.ok([...h.host.querySelectorAll('[role="option"]')].every(e => e.textContent.includes('iPhone 17')));
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.ok(input.getAttribute('aria-activedescendant'));
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(Picker.record(h.picker.selected).attributes.model, 'iPhone 17');
  assert.deepEqual(h.confirmed, []);
  h.host.querySelector('[data-option-key="model"] .product-picker-select').click();
  input = h.host.querySelector('input');
  const event = new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  input.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  assert.equal(h.host.querySelector('.product-picker-search').hidden, true);
  assert.equal(h.picker.stage, 'options');
});

test('dependent options resolve only offered cases and frames, including unavailable MagSafe and oak combinations', () => {
  const cases = products.filter(p => Picker.type(p) === 'phone-cases');
  for (const preferred of [
    { brand: 'Apple', model: 'iPhone 11', case: 'MagSafe', finish: 'Matt' },
    { brand: 'Samsung', model: 'Samsung Galaxy S25 Ultra', case: 'MagSafe', finish: 'Matt' },
  ]) {
    const state = Picker.optionState(cases, preferred);
    assert.equal(state.selected.case, 'Tough');
    assert.equal(state.selected.model, preferred.model);
    assert.ok(cases.includes(state.product));
  }
  const frames = products.filter(p => Picker.type(p) === 'framed-poster');
  const state = Picker.optionState(frames, { size: '61 × 91 cm', frame: 'Eiche' });
  assert.equal(state.selected.size, '61 × 91 cm');
  assert.notEqual(state.selected.frame, 'Eiche');
  assert.ok(frames.includes(state.product));
});

test('back navigation remembers pending options and confirmation/photo actions use that exact variant', t => {
  const h = harness(t); h.choice('Kleidung'); h.choice('Unisex-Bio-Baumwoll-Hoodie');
  h.host.querySelector('[data-value="XL"]').click();
  h.host.querySelector('[data-value="Schwarz"]').click();
  const selected = h.picker.selected;
  h.picker.back(); h.choice('Unisex-Bio-Baumwoll-Hoodie');
  assert.equal(h.picker.selected, selected);
  assert.equal(h.host.querySelector('img').getAttribute('src'), Photos.photo(selected));
  h.host.querySelector('.product-picker-photo').click();
  assert.deepEqual(h.opened, [selected]); assert.deepEqual(h.confirmed, []);
  h.host.querySelector('.product-picker-apply').click(); assert.deepEqual(h.confirmed, [selected]);
});

test('a scoped gallery picker exposes only its own product options and retains every offered exact variant', t => {
  for (const entry of Picker.types(products)) for (const product of entry.products) {
    const h = harness(t, { products: entry.products, selectedKey: product.key, browse: false });
    assert.equal(h.picker.selected, product, product.key);
    assert.equal(h.picker.back(), false);
    assert.equal(h.host.querySelector('img').getAttribute('src'), Photos.photo(product));
    h.host.querySelector('.product-picker-apply').click(); assert.equal(h.confirmed[0], product);
    h.window.close();
  }
});

test('gallery options confirm exact orientation without changing the physical variant, and retain it across square sizes', t => {
  for (const group of ['poster', 'framed-poster', 'canvas', 'thin-canvas', 'framed-canvas', 'blanket']) {
    const candidates = products.filter(p => (p.catalogGroup || p.previewShape) === group);
    const original = candidates.find(p => p.orientations.length === 2);
    const h = harness(t, { products: candidates, selectedKey: original.key, selectedOrientation: 'portrait', browse: false });
    assert.ok(h.host.querySelector('[data-option-key="orientation"]'));
    h.host.querySelector('[data-value="landscape"]').click();
    assert.match(h.host.querySelector('.product-picker-summary strong').textContent, /Querformat/);
    h.host.querySelector('.product-picker-apply').click();
    assert.equal(h.confirmed[0], original);
    const square = candidates.find(p => p.printFile.width === p.printFile.height);
    if (square) {
      h.host.querySelector('[data-option-key="size"] .product-picker-select')?.click();
      const clickSize = size => [...h.host.querySelectorAll('[data-option-key="size"] button')]
        .find(button => button.dataset.value === size || button.textContent === size)?.click();
      clickSize(square.size.label);
      assert.equal(h.host.querySelector('[data-option-key="orientation"]'), null);
      h.host.querySelector('[data-option-key="size"] .product-picker-select')?.click();
      clickSize(original.orientations.find(o => o.key === 'landscape').size.label);
      assert.equal(h.host.querySelector('[data-value="landscape"]').getAttribute('aria-pressed'), 'true');
    }
    h.window.close();
  }
});
