'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCTS, getProduct, getPublicProduct, getPublicProducts } = require('../src/products');
const { metricText, getProductInformation } = require('../src/productInformation');
const { refreshProductInformation, LOCALES } = require('../scripts/refresh-product-information');
const snapshot = require('../src/productInformationSnapshot.json');
const locales = ['de', 'en', 'es', 'fr', 'it', 'tr'];

test('every offered product exposes locally sourced descriptions in every site language', () => {
  for (const product of getPublicProducts()) {
    assert.deepEqual(Object.keys(product.information).sort(), [...locales].sort(), product.key);
    for (const [locale, text] of Object.entries(product.information)) {
      assert.ok(text.length > 70, `${product.key}: ${locale}`);
      assert.doesNotMatch(text, /\b(?:oz|lbs?|US gal|mil)\b/, `${product.key}: metric ${locale}`);
      assert.doesNotMatch(text, /<\/?(?:script|iframe|p|br)\b/i);
    }
  }
  assert.equal(Object.keys(snapshot.products).length, new Set(PRODUCTS.map(product => product.printful.productId)).size);
  assert.match(snapshot.source, /GET \/v2\/catalog-products/);
});

test('a colored mug describes only the chosen capacity and its physical dimensions in all languages', () => {
  const mug = getPublicProduct(getProduct('colored-mug-17197'));
  for (const text of Object.values(mug.information)) {
    assert.match(text, /444 ml/);
    assert.match(text, /11[.,]9 cm/);
    assert.match(text, /8[.,]5 cm/);
    assert.doesNotMatch(text, /325 ml|9[.,]6 cm|\b11 oz\b/);
  }
  assert.match(mug.information.en, /Colored rim, inside, and handle/);
  assert.match(getPublicProduct(getProduct('white-glossy-mug-20oz')).information.en, /591 ml mug dimensions: 10.9 cm/);
});

test('travel mug descriptions retain only the selected lid and dimensions plus the hot-drink warning', () => {
  const small = getPublicProduct(getProduct('travel-mug-16440')).information;
  const large = getPublicProduct(getProduct('travel-mug-19514')).information;
  for (const locale of locales) {
    assert.doesNotMatch(small[locale], /1183|1[. ]183|26[.,]5/);
    assert.doesNotMatch(large[locale], /739/);
  }
  assert.match(small.en, /plastic press-in lid/);
  assert.doesNotMatch(small.en, /straw|screw-on/);
  assert.match(large.en, /plastic straw and screw-on lid/);
  assert.doesNotMatch(large.en, /press-in/);
  assert.match(small.en, /prevent steam pressure buildup/);
  assert.match(large.en, /prevent steam pressure buildup/);
  assert.match(large.tr, /Buhar|buhar/);
});

test('framed posters show the matching wood and only applicable size instructions', () => {
  const oak = getPublicProduct(getProduct('framed-poster-11791')).information.en;
  const black = getPublicProduct(getProduct('framed-matte-poster-black-30x40cm')).information.en;
  assert.match(oak, /solid oak/); assert.doesNotMatch(oak, /alder/);
  assert.match(black, /alder/); assert.doesNotMatch(black, /Oak frame/);
  assert.doesNotMatch(oak, /A4|How to attach hooks/);
  const landscape = getPublicProduct(getProduct('framed-poster-9359'), 'landscape').information.en;
  const portrait = getPublicProduct(getProduct('framed-poster-9359'), 'portrait').information.en;
  assert.match(landscape, /How to attach hooks/);
  assert.doesNotMatch(portrait, /How to attach hooks/);
  const base = getPublicProduct(getProduct('framed-poster-9359'));
  const view = require('../public/js/product-orientation').view;
  assert.match(view(base, 'landscape').information.en, /How to attach hooks/);
  assert.doesNotMatch(view(base, 'portrait').information.en, /How to attach hooks/);
  const a4 = getPublicProducts().find(product => product.key.startsWith('matte-poster-') && product.size.label === '21 × 30 cm');
  assert.match(a4.information.en, /A4/);
});

test('metric copy preserves punctuation, paragraph boundaries and important care instructions', () => {
  assert.equal(metricText('Made in China\n\n25 oz (739 ml) size:'), 'Made in China\n\n739 ml size:');
  assert.equal(metricText('4.69″ (11.9 cm) in height, 3.35″ (8.5 cm) in diameter'), '11.9 cm in height, 8.5 cm in diameter');
  assert.equal(metricText('10,3 mil'), '0,26 mm');
  assert.match(getPublicProduct(getProduct('steel-tumbler-15005')).information.en, /Not dishwasher or microwave safe. Hand-wash only/);
  assert.match(getPublicProduct(getProduct('enamel-mug')).information.en, /Don't heat liquids or food directly/);
  assert.match(getPublicProduct(getProduct('water-bottle-10798')).information.en, /over 24 hours/);
  assert.equal(getProductInformation({ printful: { productId: 999999 } }), null);
});

test('clothing descriptions show the selected garment measurements in every language', () => {
  const hoodie = getPublicProduct(getProduct('hoodie-12403')).information;
  for (const locale of locales) {
    assert.match(hoodie[locale], /\(M\)/);
    assert.match(hoodie[locale], /59 cm/);
    assert.match(hoodie[locale], /74 cm/);
    assert.match(hoodie[locale], locale === 'en' ? /66\.5 cm/ : /66,5 cm/);
  }
  const largest = getPublicProduct(getProduct('t-shirt-17235')).information.en;
  assert.match(largest, /\(5XL\)/); assert.match(largest, /77\.5 cm/); assert.match(largest, /84 cm/);
});

test('the explicit refresh fetches each underlying product once per provider locale, independently of variant count', async () => {
  const calls = [];
  const now = new Date('2026-10-25T12:00:00Z');
  const result = await refreshProductInformation({ products: PRODUCTS, now,
    fetchProduct: async (id, locale) => { calls.push([id, locale]); return { id, name: `Product ${id}`, description: `Description ${locale}` }; },
  });
  const count = new Set(PRODUCTS.map(product => product.printful.productId)).size;
  assert.equal(calls.length, count * Object.keys(LOCALES).length);
  assert.equal(new Set(calls.map(call => call.join(':'))).size, calls.length);
  assert.equal(result.checkedAt, now.toISOString());
  assert.equal(result.products[403].descriptions.de, 'Description de_DE');
  await assert.rejects(refreshProductInformation({ products: [PRODUCTS[0]],
    fetchProduct: async id => ({ id, description: '' }),
  }), /Missing catalog description/);
});
