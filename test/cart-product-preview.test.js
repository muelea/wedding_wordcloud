'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Products = require('../public/js/cart-product-preview');
const { getPublicProducts } = require('../src/products');

test('one thumbnail opens the complete overview and retains product identity when a render is unavailable', t => {
  const dom = new JSDOM('<div id="cart"></div>');
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const calls = [];
  const i18n = { t: text => text,
    setText: (node, text) => { node.textContent = text; },
    setAttribute: (node, name, text, params) => node.setAttribute(name,
      text.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key])),
  };
  const product = { displayName: 'Farbige Tasse', variantLabel: '444 ml · Blau', previewType: 'mug', productPhoto: '/mug-blue.jpg' };
  const group = Products.createThumbnails({ document, item: { product }, i18n,
    onOpen: (...args) => calls.push(args) });
  document.getElementById('cart').append(group);
  assert.equal(group.querySelectorAll('button').length, 1);
  assert.equal(group.querySelectorAll('img').length, 1);
  const trigger = group.querySelector('button');
  assert.match(trigger.getAttribute('aria-label'), /Farbige Tasse, 444 ml · Blau/);
  assert.equal(group.querySelector('img').getAttribute('src'), '/mug-blue.jpg');
  trigger.click();
  assert.deepEqual(calls, [['overview', trigger]]);
  const image = group.querySelector('img');
  image.src = '/missing-render.png';
  image.dispatchEvent(new dom.window.Event('error'));
  assert.equal(image.getAttribute('src'), '/mug-blue.jpg');
});

test('cart identity retains the complete localized variant and raw provider photo for every product', () => {
  const products = getPublicProducts();
  const i18n = { t: text => text };
  for (const product of products) {
    assert.ok(Products.variant(product, i18n).includes(product.variantLabel || product.size.label), product.key);
    if (product.productPhoto) assert.equal(Products.photo(product), product.productPhoto, product.key);
    else assert.match(Products.photo(product), /^\/assets\/product-(mockups|thumbnails)\//, product.key);
  }
  const mug = products.find(product => product.key === 'colored-mug-17197');
  assert.equal(Products.variant(mug, { t: text => text.replace('Blau', 'Blue') }), '444 ml · Blue');
});

test('landscape canvas identity uses the actual dimensions and retains the selected frame color', () => {
  const { getPublicProduct, getProduct } = require('../src/products');
  const I18n = require('../src/i18n');
  const i18n = { t: source => I18n.translate(source, 'en') };
  const large = getPublicProduct(getProduct('canvas-19330'), 'landscape');
  assert.equal(Products.variant(large, i18n), '152.4 × 101.6 cm · 3.18 cm deep');
  const frame = getPublicProduct(getProduct('framed-canvas-16041'), 'landscape');
  const identity = Products.variant(frame, i18n);
  assert.match(identity, /^40\.6 × 30\.5 cm · Brown/);
  assert.doesNotMatch(identity, /30\.5 × 40\.6/);
});

test('cart previews use the accepted immutable print URLs and retain separate front and back', () => {
  const product = { printSurfaces: [{ key: 'front' }, { key: 'back' }] };
  const item = Products.configuration({ id: 'saved', printFileUrl: '/saved/print.svg?surface=front' }, product);
  assert.deepEqual(item.printPreviewUrls, { front: '/saved/print.png?surface=front', back: '/saved/print.png?surface=back' });
  assert.deepEqual(item.printFileUrls, { front: '/saved/print.svg?surface=front', back: '/saved/print.svg?surface=back' });
  const single = Products.configuration({ printFileUrl: '/other/print.svg' }, { printSurfaces: [{ key: 'default' }] });
  assert.deepEqual(single.printPreviewUrls, { default: '/other/print.png' });
});

test('local 3D maps the frozen front and back pixels into the existing renderer without changing print coordinates', async t => {
  const dom = new JSDOM('<div id="host"></div>');
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const createElement = document.createElement.bind(document);
  const images = [];
  t.mock.method(document, 'createElement', tag => {
    const element = createElement(tag);
    if (tag === 'img') images.push(element);
    return element;
  });
  let params;
  const viewer = { ready: Promise.resolve(true), resize() {}, destroy() {} };
  const browser = { THREE: {}, Mug3DViewer: { create: options => { params = options; return viewer; } } };
  const product = { printSurfaces: [{ key: 'front' }, { key: 'back' }] };
  const rendered = Products.render3D({ host: document.getElementById('host'), window: browser,
    item: { product, printPreviewUrls: { front: '/frozen-front.png', back: '/frozen-back.png' },
      printFileUrls: { front: '/frozen-front.svg', back: '/frozen-back.svg' } },
  });
  images.forEach(image => image.dispatchEvent(new dom.window.Event('load')));
  assert.equal(await rendered, viewer);
  assert.deepEqual(images.map(image => image.getAttribute('src')), ['/frozen-front.svg', '/frozen-back.svg'],
    'automatic local previews leave the on-demand PNG quota untouched');
  assert.equal(params.product, product);
  const painted = [];
  const ctx = { drawImage: (...args) => painted.push(args) };
  const bounds = { offsetX: 12, offsetY: 34, printWidth: 1800, printHeight: 2400 };
  params.drawTexture(ctx, bounds); params.drawBackTexture(ctx, bounds);
  assert.deepEqual(painted, [[images[0], 12, 34, 1800, 2400], [images[1], 12, 34, 1800, 2400]]);
});
