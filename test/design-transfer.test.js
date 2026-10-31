'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('canvas');
const Transfer = require('../public/js/design-transfer');
const Session = require('../public/js/configurator-session');
const Fonts = require('../src/designFonts');
const Bounds = require('../public/js/design-content-bounds');
const { PRODUCTS, getProduct, resolveProductOrientation } = require('../src/products');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');

const context = createCanvas(1, 1).getContext('2d');
const photo = createCanvas(2, 1).toDataURL();
const options = { fontFamily: item => Fonts.cssFamily(item.fontFamily) };
const clone = value => JSON.parse(JSON.stringify(value));
const area = { x: 0, y: 0, width: 1000, height: 1000 };
const word = (id, text, x = 400, y = 400) => ({ id, text, x, y, fontSize: 70,
  angle: 0, color: '#123456', fontFamily: 'classic', fontWeight: 400, fontStyle: 'normal',
  underline: false, linethrough: false });
const source = (design, productKey = 'mug', orientation = 'default', safeArea = area) => ({
  productKey, orientation, surfaces: [{ key: 'default', area: safeArea, design }],
});
const target = (productKey, safeArea = area, orientation = 'default') => ({
  productKey, orientation, surfaces: [{ key: 'default', area: safeArea }],
});
const prepare = (state, from, to, extra = {}) => Transfer.prepare(state, from, to, context, { ...options, ...extra });
const productSurface = (productKey, orientation, design) => {
  const product = resolveProductOrientation(getProduct(productKey), orientation);
  return { productKey, orientation, surfaces: product.printSurfaces.map(surface => {
    const area = product.designSafeAreas[surface.key];
    return { key: surface.key, area, printFile: product.printFile,
      slots: product.printSurfaces.length > 1 ? [{ ...area, optimize: true }] : product.layoutGeometry['fit-area'],
      ...(design ? { design } : {}) };
  }) };
};
const coverage = (design, safeArea) => {
  const box = Bounds.union(design.map(item => Bounds.bounds(item, context)));
  return { width: box.width / safeArea.width, height: box.height / safeArea.height };
};

test('blanket size and orientation changes refill even when a sparse destination layout is remembered', async () => {
  const contents = ['Liebe', 'Freude', 'Familie', 'Glück', 'Lachen', 'Tanzen', 'Zusammen', 'Zukunft', '❤️', 'Reisen', 'Treue', 'Wärme']
    .map((text, i) => word(String(i), text, 400, 400));
  let from = productSurface('throw-blanket-50x60in', 'portrait', contents);
  const original = clone(contents);
  let state = null;
  for (const [productKey, orientation] of [
    ['throw-blanket-30x40in', 'portrait'], ['throw-blanket-30x40in', 'landscape'],
    ['throw-blanket-50x60in', 'landscape'], ['throw-blanket-50x60in', 'portrait'],
    ['throw-blanket-30x40in', 'portrait'],
  ]) {
    const to = productSurface(productKey, orientation);
    // A real older draft can remember an underfilled destination. Applying
    // that size must use the current contents and fill, never restore it.
    state = Transfer.capture(state, { ...to, surfaces: to.surfaces.map(s => ({ ...s, design: original })) });
    const result = await Transfer.prepareAsync(state, from, to, context, { ...options, printDpi: 150 });
    const design = result.designs.default, fill = coverage(design, to.surfaces[0].area);
    assert.deepEqual(design.map(item => item.text), contents.map(item => item.text));
    assert.ok(fill.width > .8 && fill.height > .8, `${productKey}/${orientation}: ${JSON.stringify(fill)}`);
    assert.ok(isPrintDesignWithinBounds(design, to.surfaces[0].printFile.width,
      to.surfaces[0].printFile.height, to.surfaces[0].area));
    state = result.state;
    from = { ...to, surfaces: to.surfaces.map(s => ({ ...s, design })) };
  }
  assert.deepEqual(contents, original, 'source artwork and its styles are never mutated');
});

test('identical print geometry keeps the current manual arrangement across colour and finish variants', () => {
  const design = [word('manual', 'Unser Wort', 250, 350)];
  const from = { ...source(design, 'black'), surfaces: [{ ...source(design).surfaces[0],
    printFile: { width: 1000, height: 1000, dpi: 300 }, slots: [{ ...area, optimize: true }] }] };
  const to = { ...target('white'), surfaces: [{ ...target('white').surfaces[0],
    printFile: { width: 1000, height: 1000, dpi: 300 }, slots: [{ ...area, optimize: true }] }] };
  const old = Transfer.capture(null, source([word('manual', 'Old', 700, 700)], 'white'));
  assert.deepEqual(prepare(old, from, to).designs.default, design, 'an old destination cannot replace current placement');
});

test('changed print resolution or layout slots trigger refill even when the safe rectangle is unchanged', () => {
  const design = [word('manual', 'Liebe', 300, 300), word('added', 'Freude', 600, 600)];
  const from = { ...source(design), surfaces: [{ ...source(design).surfaces[0],
    printFile: { width: 1200, height: 1200, dpi: 150 } }] };
  for (const change of [
    { printFile: { width: 1200, height: 1200, dpi: 300 } },
    { printFile: from.surfaces[0].printFile, slots: [{ x: 0, y: 0, width: 450, height: 1000, optimize: true }] },
  ]) {
    const to = { ...target('other'), surfaces: [{ ...target('other').surfaces[0], ...change }] };
    const result = prepare(null, from, to).designs.default;
    assert.notDeepEqual(result, design);
    if (change.slots) {
      const bounds = Bounds.union(result.map(item => Bounds.bounds(item, context)));
      assert.ok(bounds.left >= 0 && bounds.left + bounds.width <= 450, 'the actual target slot is filled');
    }
  }
});

test('every product and orientation carries edited text, emoji, motifs and photos inside its print boundaries', () => {
  const design = [
    { ...word('edited', 'Unser Tag'), fontFamily: 'montserrat', fontWeight: 700, fontStyle: 'italic',
      underline: true, linethrough: true, colorLocked: true },
    word('added-emoji', '❤️', 600, 500),
    { id: 'photo', type: 'image', src: photo, x: 300, y: 650,
      width: 200, height: 100, angle: 15 },
    { id: 'motif', type: 'icon', icon: 'heart', x: 600, y: 700, size: 80, angle: 0, color: '#abcdef' },
  ];
  const original = clone(design);
  for (const product of PRODUCTS) {
    for (const orientation of product.orientationOptions.length ? product.orientationOptions.map(option => option.key) : ['default']) {
      const resolved = resolveProductOrientation(product, orientation);
      const to = { productKey: product.key, orientation,
        surfaces: resolved.printSurfaces.map(surface => ({ key: surface.key,
          area: resolved.designSafeAreas[surface.key] })) };
      const transferred = prepare(null, source(design), to);
      for (const surface of to.surfaces) {
        const result = transferred.designs[surface.key];
        assert.deepEqual(result.map(item => item.id), design.map(item => item.id), product.key);
        assert.ok(isPrintDesignWithinBounds(result, resolved.printFile.width, resolved.printFile.height,
          surface.area), `${product.key}/${orientation}/${surface.key}`);
        assert.equal(result[0].text, 'Unser Tag');
        for (const property of ['fontFamily', 'fontWeight', 'fontStyle', 'underline', 'linethrough', 'color', 'colorLocked']) {
          assert.equal(result[0][property], design[0][property], property);
        }
        assert.equal(result[1].text, '❤️');
        assert.equal(result[2].src, design[2].src);
        assert.ok(Math.abs(result[2].width - result[2].height * 2) <= .2, 'photos keep their aspect ratio within print precision');
        assert.equal(result[3].icon, 'heart');
      }
    }
  }
  assert.deepEqual(design, original, 'conversion does not mutate the source design');
});

test('switching back refills the area with current additions, deletions and text styles', () => {
  const initial = [word('keep', 'Liebe', 250, 250), word('delete', 'Entfernen', 600, 600)];
  const posterArea = { x: 0, y: 0, width: 2000, height: 3000 };
  const poster = prepare(null, source(initial), target('poster', posterArea));
  const edited = [
    { ...poster.designs.default[0], text: 'Freude', x: 1200, y: 900, color: '#abcdef', fontWeight: 700 },
    word('new', '🎉', 800, 1500),
  ];
  const back = prepare(poster.state, source(edited, 'poster', 'default', posterArea), target('mug'));
  assert.deepEqual(back.designs.default.map(item => item.id), ['keep', 'new']);
  assert.equal(back.designs.default[0].text, 'Freude');
  assert.equal(back.designs.default[0].color, '#abcdef');
  assert.equal(back.designs.default[0].fontWeight, 700);
  assert.ok(back.designs.default[0].fontSize > initial[0].fontSize, 'the old sparse arrangement is not restored');
  assert.ok(isPrintDesignWithinBounds(back.designs.default, 1000, 1000, area));
  const again = prepare(back.state, source(back.designs.default), target('poster', posterArea));
  assert.deepEqual(again.designs.default.map(item => item.text), ['Freude', '🎉']);
  assert.ok(isPrintDesignWithinBounds(again.designs.default, 2000, 3000, posterArea));
});

test('orientation round trips refill instead of restoring sparse manual placement, and deleted designs stay empty', () => {
  const portrait = [word('rotated', 'Liebe', 400, 500)];
  portrait[0].angle = 24;
  const landscapeArea = { x: 0, y: 0, width: 1500, height: 1000 };
  const landscape = prepare(null, source(portrait, 'poster', 'portrait'), target('poster', landscapeArea, 'landscape'));
  const back = prepare(landscape.state, source(landscape.designs.default, 'poster', 'landscape', landscapeArea),
    target('poster', area, 'portrait'));
  assert.equal(back.designs.default[0].text, portrait[0].text);
  assert.ok(back.designs.default[0].fontSize > portrait[0].fontSize);
  assert.ok(isPrintDesignWithinBounds(back.designs.default, 1000, 1000, area));
  const empty = prepare(back.state, source([], 'poster', 'portrait'), target('mug'));
  assert.deepEqual(empty.designs.default, [], 'deleting everything never regenerates baseline words');
});

test('front and back map separately, and hidden back contents survive one-sided products and reloads', async () => {
  const front = [word('same-id', 'Vorne')];
  const rear = [word('same-id', 'Hinten')];
  const two = { productKey: 'tote', orientation: 'default', surfaces: [
    { key: 'front', area, design: front }, { key: 'back', area, design: rear },
  ] };
  const mug = prepare(null, two, target('mug'));
  assert.deepEqual(mug.designs.default, front);
  assert.equal(mug.retainedBack, true);
  const records = new Map();
  const store = Session.createDraftStore('event', { backend: {
    get: async key => records.get(key), put: async record => records.set(record.key, clone(record)),
    delete: async key => records.delete(key),
  } });
  await store.save({ productKey: 'mug', theme: 'konfetti', words: [['Original', 1]],
    designs: mug.designs, productDesignState: mug.state, currentDesignEdited: true });
  const draft = await store.loadActive();
  const updatedFront = [{ ...draft.designs.default[0], text: 'Neues vorne' }];
  const back = prepare(draft.productDesignState, source(updatedFront), {
    productKey: 'tote', surfaces: [{ key: 'front', area }, { key: 'back', area }],
  });
  assert.equal(back.designs.front[0].text, 'Neues vorne');
  assert.deepEqual(back.designs.back, rear, 'hidden back is neither replaced with front nor merged into it');
});

test('a first two-sided product copies current artwork to both faces and their edits become independent', () => {
  const first = prepare(null, source([word('word', 'Liebe')]), {
    productKey: 'tote', surfaces: [{ key: 'front', area }, { key: 'back', area }],
  });
  assert.deepEqual(first.designs.front, first.designs.back);
  first.designs.back[0].text = 'Rückseite';
  const mug = prepare(first.state, { productKey: 'tote', surfaces: [
    { key: 'front', area, design: first.designs.front }, { key: 'back', area, design: first.designs.back },
  ] }, target('mug'));
  assert.equal(mug.designs.default[0].text, 'Liebe');
  assert.equal(mug.state.surfaces[1].design[0].text, 'Rückseite');
});

test('another design is an independent copy and ignores older destination arrangements', () => {
  const first = [word('word', 'Liebe', 250, 250)];
  const poster = prepare(null, source(first), target('poster'));
  const changed = [{ ...poster.designs.default[0], x: 650, y: 650 }];
  const stateBefore = clone(poster.state);
  const independent = prepare(poster.state, source(changed, 'poster'), target('mug'), { independent: true });
  assert.deepEqual(independent.designs.default, changed);
  assert.equal(independent.state.layouts.length, 0);
  assert.deepEqual(poster.state, stateBefore);
});

test('automatic conversion lays out the edited element set without losing objects or styles', () => {
  const design = [word('added', 'Freude', 200, 200), word('emoji', '❤️', 500, 500)];
  design[0].fontWeight = 700;
  const product = getProduct('cork-back-coaster');
  const converted = prepare(null, source(design), target(product.key, product.designSafeAreas.default));
  assert.deepEqual(converted.designs.default.map(item => item.id), ['added', 'emoji']);
  assert.equal(converted.designs.default[0].fontWeight, 700);
  assert.ok(isPrintDesignWithinBounds(converted.designs.default, product.printFile.width, product.printFile.height,
    product.designSafeAreas.default));
});

test('layout records are bounded and never duplicate embedded images', () => {
  const design = [{ id: 'photo', type: 'image', src: 'data:image/png;base64,pixels',
    x: 500, y: 500, width: 200, height: 100, angle: 0 }];
  let state = null;
  for (let index = 0; index < Transfer.MAX_LAYOUTS + 5; index++) {
    state = Transfer.capture(state, source(design, `product-${index}`));
  }
  assert.equal(state.layouts.length, Transfer.MAX_LAYOUTS);
  assert.equal(JSON.stringify(state).split(design[0].src).length - 1, 1);
  assert.equal(Transfer.normalizeState(null).layouts.length, 0, 'legacy drafts start a fresh transfer history');
});
