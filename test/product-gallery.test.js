'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { Gallery, groupProducts, shouldOpen } = require('../public/js/product-gallery');
const { getPublicProducts } = require('../src/products');

const products = getPublicProducts();
const translate = (source, values = {}) => source.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
const snapshot = product => ({ productKey: product.key, orientation: product.defaultOrientation,
  theme: 'konfetti', customColors: ['#ed2446'], words: [['Liebe', 3]],
  designs: Object.fromEntries(product.printSurfaces.map((surface, index) => [surface.key,
    [{ id: 'word', text: 'Liebe', x: 100 + index, y: 120, fontSize: 40, color: '#ed2446' }]])) });

function harness(t, options = {}) {
  const dom = new JSDOM('<section><div data-gallery-filters></div><div data-gallery-grid></div></section>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  options.observe?.(dom.window);
  const prepared = [], painted = [], chosen = [], added = [], viewers = [];
  const gallery = new Gallery({
    element: dom.window.document.querySelector('section'), products,
    prepare: async (product, opts) => { prepared.push(product.key); return options.prepare ? options.prepare(product, opts) : snapshot(product); },
    getView: product => product,
    configureFlat() {},
    paintFlat: (canvas, product, design, side) => painted.push({ product, design, side }),
    createMug: params => {
      const viewer = { params, resizes: 0, destroyed: false,
        resize() { this.resizes++; }, destroy() { this.destroyed = true; } };
      viewers.push(viewer);
      options.viewer?.(viewer);
      return viewer;
    },
    onChoose: async design => { chosen.push(design); await options.onChoose?.(design); },
    onAdd: async design => {
      added.push(design);
      return options.onAdd ? options.onAdd(design) : { ...design, editingOrderItemId: 'Cart00001', needsCartUpdate: false };
    },
    isInCart: options.isInCart,
    i18n: { t: translate, setText: (element, text, values) => { element.textContent = translate(text, values); },
      setAttribute: (element, key, text, values) => element.setAttribute(key, translate(text, values)) },
  });
  t.after(() => { gallery.destroy(); dom.window.close(); });
  return { gallery, window: dom.window, prepared, painted, chosen, added, viewers,
    settle: async () => { await gallery.queue; await Promise.resolve(); },
    card: shape => gallery.cards.find(card => (card.product.previewType === 'mug' ? 'mug' : card.product.previewShape) === shape),
  };
}

test('the gallery covers every catalog variant in distinct product groups', () => {
  const groups = groupProducts(products);
  assert.equal(groups.length, new Set(products.map(product => product.catalogGroup || (product.previewType === 'mug' ? 'mug' : product.previewShape))).size);
  assert.deepEqual(groups.flat().map(product => product.key).sort(), products.map(product => product.key).sort());
  assert.equal(groups.find(group => group[0].previewType === 'mug').length, 3);
  assert.equal(groups.find(group => group[0].previewShape === 'poster').length, 4);
  assert.equal(groups.find(group => group[0].previewShape === 'framed-poster').length, 5);
  assert.equal(groups.find(group => group[0].catalogGroup === 'colored-mug').length, 11);
});

test('only a first visit from a populated live cloud enters the gallery', () => {
  const entry = { directDesign: false, words: [['Liebe', 1]], query: new URLSearchParams(), draft: null };
  assert.equal(shouldOpen(entry), true);
  assert.equal(shouldOpen({ ...entry, directDesign: true }), false);
  assert.equal(shouldOpen({ ...entry, words: [] }), false);
  assert.equal(shouldOpen({ ...entry, draft: { productKey: 'retained' } }), false);
  for (const key of ['edit', 'cart', 'accountDesign', 'draft']) {
    assert.equal(shouldOpen({ ...entry, query: new URLSearchParams(`${key}=chosen`) }), false, key);
  }
});

test('an explicit gallery location survives a saved draft while editor entry links take priority', () => {
  const entry = { directDesign: false, words: [['Liebe', 1]], draft: { workingDesignId: 'retained' },
    query: new URLSearchParams('view=products&draft=retained') };
  assert.equal(shouldOpen(entry), true);
  assert.equal(shouldOpen({ ...entry, directDesign: true }), false);
  for (const key of ['edit', 'cart', 'accountDesign']) {
    const query = new URLSearchParams(entry.query);
    query.set(key, 'chosen');
    assert.equal(shouldOpen({ ...entry, query }), false, key);
  }
});

test('every preview paints its own product and selecting it hands over the exact complete design', async t => {
  const h = harness(t);
  await h.settle();
  assert.equal(h.prepared.length, groupProducts(products).length);
  assert.equal(h.painted.length, groupProducts(products).filter(group => !['mug','3d'].includes(group[0].previewType)).length);
  assert.ok(h.gallery.cards.every(card => !card.customize.disabled));
  const notebook = h.card('notebook');
  const preview = h.viewers.find(viewer => viewer.params.product.key === notebook.product.key).params;
  assert.deepEqual(preview.designs.front, notebook.snapshot.designs.front);
  assert.deepEqual(preview.designs.back, notebook.snapshot.designs.back);
  await h.gallery.choose(notebook);
  assert.deepEqual(h.chosen[0], notebook.snapshot);
  assert.deepEqual(Object.keys(h.chosen[0].designs), ['front', 'back']);
  assert.notEqual(h.chosen[0], notebook.snapshot);
  h.chosen[0].designs.front[0].x = 999;
  h.chosen[0].words[0][0] = 'Edited';
  assert.equal(notebook.snapshot.designs.front[0].x, 100);
  assert.equal(notebook.snapshot.words[0][0], 'Liebe');
});

test('size changes are previewed independently, cached, and stale work cannot replace the chosen size', async t => {
  const h = harness(t);
  const mug = h.card('mug');
  const second = mug.variants[1], third = mug.variants[2];
  const older = h.gallery.load(mug, second);
  const latest = h.gallery.load(mug, third);
  await Promise.all([older, latest]);
  assert.equal(h.prepared.includes(second.key), false, 'a superseded queued size is never calculated');
  assert.equal(mug.snapshot.productKey, third.key);
  const formatPrice = product => new Intl.NumberFormat('de', { style: 'currency', currency: product.price.currency })
    .format(product.price.unitGrossCents / 100);
  assert.equal(mug.price.textContent, formatPrice(third), 'stale variant work cannot replace the selected price');
  assert.equal(mug.product.key, third.key);
  await h.gallery.load(mug, mug.variants[0]);
  assert.equal(mug.price.textContent, formatPrice(mug.variants[0]));
  await h.gallery.load(mug, third);
  assert.equal(mug.price.textContent, formatPrice(third), 'cached designs retain their own catalog price');
  assert.equal(h.prepared.filter(key => key === third.key).length, 1);
  await h.gallery.choose(mug);
  assert.equal(h.chosen[0].productKey, third.key);
});

test('reference photos follow the selected variant for mugs and flat products', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const photos = new Set();
  for (const variant of mug.variants) {
    await h.gallery.load(mug, variant);
    assert.equal(mug.photo.hidden, false);
    assert.equal(mug.photo.getAttribute('src'), variant.productPhoto);
    assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname, '../public', variant.productPhoto)));
    assert.equal(mug.photo.alt, `Produktfoto: ${variant.displayName}, ${variant.size.label}`);
    assert.equal(mug.photo.style.objectFit, variant.productPhotoFit);
    assert.equal(mug.photo.style.objectPosition, variant.productPhotoPosition);
    photos.add(variant.productPhoto);
  }
  assert.equal(photos.size, 3);
  assert.ok(h.gallery.cards.filter(card => card.product.previewType === 'flat' && card.variants.length > 1).every(card => !card.photoButton.hidden), 'flat product options also show their real reference image');
});

test('every product has the same variant summary and only multiple variants offer a menu', async t => {
  const h = harness(t);
  await h.settle();
  for (const card of h.gallery.cards) {
    assert.equal(card.sizes.hidden, false, card.product.key);
    assert.equal(card.photoButton.parentElement, card.sizes);
    assert.equal(card.variantLabel.textContent, card.product.variantLabel || card.product.size.label);
    assert.equal(card.detail.hidden, true, 'the variant appears once, in its summary row');
    const summary = card.sizes.querySelector('.product-gallery-variant-summary');
    assert.equal(summary.tagName, card.variants.length > 1 ? 'BUTTON' : 'DIV');
    assert.equal(Boolean(summary.querySelector('.product-variant-chevron')), card.variants.length > 1);
    if (card.variants.length === 1) {
      const before = structuredClone(card.snapshot);
      summary.click();
      h.gallery.openVariants(card);
      assert.equal(h.gallery.variantDialog.dialog.open, false);
      assert.equal(summary.hasAttribute('aria-haspopup'), false);
      card.photoButton.click();
      assert.equal(h.gallery.photoDialog.photo.getAttribute('src'), card.photo.getAttribute('src'));
      assert.equal(h.gallery.photoDialog.dialog.open, true);
      h.gallery.photoDialog.dialog.close();
      assert.deepEqual(card.snapshot, before);
    }
  }
  assert.equal(h.chosen.length, 0);
  assert.equal(h.added.length, 0);
});

test('compact prices keep their localized explanation available without changing a design', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug'), coaster = h.card('coaster');
  const before = structuredClone(mug.snapshot);
  const panel = h.gallery.priceInfo;
  assert.equal(mug.price.parentElement, mug.priceRow);
  assert.equal(mug.priceNote.parentElement, mug.priceRow);
  assert.equal(mug.priceInfoButton.parentElement, mug.priceRow);
  assert.equal(panel.hidden, true);
  mug.priceInfoButton.focus(); mug.priceInfoButton.click();
  assert.equal(panel.hidden, false);
  assert.equal(mug.priceInfoButton.getAttribute('aria-expanded'), 'true');
  assert.equal(mug.priceInfoButton.getAttribute('aria-describedby'), panel.id);
  assert.equal(h.window.document.activeElement, mug.priceInfoButton);
  const { translate: localized } = require('../src/i18n');
  for (const locale of ['de', 'en', 'fr', 'it', 'es', 'tr']) {
    h.gallery.i18n = { t: source => localized(source, locale), getLocale: () => locale,
      setText: (node, source, values) => { node.textContent = localized(source, locale, values); },
      setAttribute: (node, key, source, values) => node.setAttribute(key, localized(source, locale, values)) };
    h.gallery.localize();
    assert.equal(mug.priceNote.textContent, localized('inkl. MwSt., zzgl. Versand · DE', locale));
    assert.equal(panel.textContent, localized('Inkl. 19 % MwSt., zzgl. Versand. Preis für Deutschland; andere Lieferländer können abweichen.', locale));
  }
  coaster.priceInfoButton.click();
  assert.equal(mug.priceInfoButton.getAttribute('aria-expanded'), 'false');
  assert.equal(coaster.priceInfoButton.getAttribute('aria-expanded'), 'true');
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true);
  coaster.priceInfoButton.click();
  h.window.document.body.click();
  assert.equal(panel.hidden, true, 'clicking outside dismisses the explanation');
  mug.priceInfoButton.click();
  h.window.document.dispatchEvent(new h.window.Event('scroll'));
  assert.equal(panel.hidden, true, 'scrolling cannot leave an orphaned explanation');
  mug.priceInfoButton.click(); h.gallery.suspend();
  assert.equal(panel.hidden, true);
  assert.equal(mug.priceInfoButton.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(mug.snapshot, before);
  assert.equal(h.chosen.length, 0);
  assert.equal(h.added.length, 0);
  h.gallery.destroy(); assert.equal(panel.isConnected, false);
});

test('rich variant choices show exact photos and prices, enlarge independently, and retain keyboard focus', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug'), before = structuredClone(mug.snapshot);
  mug.variantToggle.click();
  const { dialog, list } = h.gallery.variantDialog;
  assert.equal(dialog.open, true);
  assert.equal(mug.variantToggle.getAttribute('aria-expanded'), 'true');
  const choices = [...list.querySelectorAll('.product-variant-choice')];
  const photos = [...list.querySelectorAll('.product-variant-photo')];
  for (const [index, product] of mug.variants.entries()) {
    assert.equal(choices[index].dataset.productKey, product.key);
    assert.equal(choices[index].querySelector('strong').textContent, product.size.label);
    assert.equal(choices[index].querySelector('.product-variant-price').textContent, h.gallery.priceFor(product));
    assert.equal(photos[index].querySelector('img').getAttribute('src'), product.productPhoto);
  }
  assert.equal(h.window.document.activeElement, choices[0]);
  choices[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(h.window.document.activeElement, choices[2]);
  choices[2].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(h.window.document.activeElement, choices[0]);
  photos[2].click();
  assert.equal(h.gallery.photoDialog.dialog.open, true);
  assert.equal(h.gallery.photoDialog.photo.getAttribute('src'), mug.variants[2].productPhoto);
  assert.equal(dialog.open, true);
  assert.deepEqual(mug.snapshot, before, 'enlarging another variant cannot change artwork or size');
  h.gallery.photoDialog.dialog.close();
  assert.equal(h.window.document.activeElement, photos[2]);
  choices[2].click();
  await h.settle();
  assert.equal(dialog.open, false);
  assert.equal(mug.variantToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.window.document.activeElement, mug.variantToggle);
  assert.equal(mug.product.key, mug.variants[2].key);
  assert.equal(mug.snapshot.productKey, mug.variants[2].key);
  assert.equal(mug.price.textContent, h.gallery.priceFor(mug.variants[2]));
  assert.equal(h.chosen.length, 0);
  assert.equal(h.added.length, 0);
  mug.variantToggle.click();
  h.gallery.suspend();
  assert.equal(dialog.open, false);
  h.gallery.destroy();
  assert.equal(dialog.isConnected, false);
});

test('the reference photo opens its selected size in a modal without choosing or changing a design', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const { dialog, title, photo } = h.gallery.photoDialog;
  for (const variant of mug.variants) {
    await h.gallery.load(mug, variant);
    const before = structuredClone(mug.snapshot);
    mug.photoButton.click();
    assert.equal(dialog.open, true);
    assert.equal(h.window.document.activeElement, title, 'opening does not put a focus frame around the close button');
    assert.equal(mug.photoButton.getAttribute('aria-controls'), dialog.id);
    assert.equal(mug.photoButton.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(photo.getAttribute('src'), variant.productPhoto);
    assert.equal(photo.style.objectFit, variant.productPhotoFit);
    assert.equal(photo.style.objectPosition, variant.productPhotoPosition);
    assert.equal(title.textContent, `${variant.displayName} · ${variant.size.label}`);
    assert.equal(photo.alt, `Produktfoto: ${variant.displayName}, ${variant.size.label}`);
    photo.click();
    assert.equal(dialog.open, true, 'clicking the photo itself keeps the modal open');
    dialog.querySelector('button').click();
    assert.equal(dialog.open, false);
    assert.equal(h.window.document.activeElement, mug.photoButton);
    assert.deepEqual(mug.snapshot, before);
  }
  assert.equal(h.chosen.length, 0);
  assert.equal(h.added.length, 0);
  mug.photoButton.click();
  dialog.dispatchEvent(new h.window.MouseEvent('click', { clientX: -1, clientY: -1 }));
  assert.equal(dialog.open, false, 'clicking outside the modal dismisses it');
});

test('leaving or disposing the gallery closes and removes its photo modal', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const { dialog } = h.gallery.photoDialog;
  mug.photoButton.click();
  h.gallery.suspend();
  assert.equal(dialog.open, false);
  mug.photoButton.click();
  assert.equal(dialog.open, false);
  await h.gallery.resume();
  mug.photoButton.click();
  assert.equal(dialog.open, true);
  h.gallery.destroy();
  assert.equal(dialog.open, false);
  assert.equal(dialog.isConnected, false);
});

test('scrolling and deliberate size choices overtake offscreen queued products', async t => {
  let observe, releaseFirst, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let first = true;
  const h = harness(t, {
    observe: window => { window.IntersectionObserver = class {
      constructor(callback) { observe = callback; }
      observe() {} disconnect() {}
    }; },
    prepare: product => {
      if (!first) return snapshot(product);
      first = false; markStarted();
      return new Promise(resolve => { releaseFirst = () => resolve(snapshot(product)); });
    },
  });
  await started;
  const last = h.card('notebook'), mug = h.card('mug');
  observe([{ target: last.stage, isIntersecting: true }]);
  const chosenSize = mug.variants[2];
  const selected = h.gallery.load(mug, chosenSize);
  releaseFirst();
  await selected; await h.settle();
  assert.deepEqual(h.prepared.slice(0, 3), [mug.variants[0].key, chosenSize.key, last.product.key]);
  assert.equal(mug.snapshot.productKey, chosenSize.key);
});

test('gallery previews use the editor print precision before drawing and handing over artwork', async t => {
  const sources = [];
  const h = harness(t, { prepare: product => {
    const source = snapshot(product);
    for (const design of Object.values(source.designs)) {
      Object.assign(design[0], { x: 100.14, y: 120.16, fontSize: 191.84000000000003 });
    }
    sources.push(source);
    return source;
  } });
  await h.settle();
  const notebook = h.card('notebook');
  const painted = h.viewers.find(viewer => viewer.params.product.key === notebook.product.key).params.design;
  assert.deepEqual([painted[0].x, painted[0].y, painted[0].fontSize], [100.1, 120.2, 191.8]);
  await h.gallery.choose(notebook);
  assert.deepEqual(h.chosen[0].designs.front, painted);
  assert.equal(sources[0].designs.default[0].fontSize, 191.84000000000003, 'preparation does not mutate its source');
});

test('preview clicks and drags never choose a product; Customize is explicit', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  for (const [type, clientX] of [['pointerdown', 10], ['pointermove', 50], ['pointerup', 50], ['click', 50]]) {
    mug.preview.dispatchEvent(new h.window.MouseEvent(type, { bubbles: true, clientX, clientY: 10, detail: 1 }));
  }
  assert.equal(h.chosen.length, 0);
  mug.preview.click();
  await Promise.resolve();
  assert.equal(h.chosen.length, 0);
  assert.equal(mug.preview.tagName, 'DIV');
  mug.preview.dispatchEvent(new h.window.KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
  assert.equal(h.chosen.length, 0);
  mug.customize.click(); await Promise.resolve();
  assert.equal(h.chosen.length, 1);
});

test('a duplicate selection cannot create two editing sessions', async t => {
  let finish;
  const h = harness(t, { onChoose: () => new Promise(resolve => { finish = resolve; }) });
  await h.settle();
  const first = h.gallery.choose(h.card('poster'));
  await h.gallery.choose(h.card('tote'));
  assert.equal(h.chosen.length, 1);
  assert.ok(h.gallery.cards.every(card => card.customize.disabled));
  finish(); await first;
});

test('a failed layout leaves an explicit retry and does not prevent other products from loading', async t => {
  let fail = true;
  const h = harness(t, { prepare: product => {
    if (fail && product.previewShape === 'tote') throw new Error('layout');
    return snapshot(product);
  } });
  await h.settle();
  const bag = h.card('tote');
  assert.equal(bag.snapshot, null);
  assert.equal(bag.customize.disabled, true);
  assert.equal(bag.retry.hidden, false);
  assert.equal(bag.status.classList.contains('is-loading'), false, 'errors remain visible beneath the actions');
  assert.equal(h.card('notebook').customize.disabled, false);
  fail = false;
  bag.retry.click(); await h.settle();
  assert.equal(bag.snapshot.productKey, bag.product.key);
  assert.equal(bag.customize.disabled, false);
});

test('capacity failures require a deliberate smaller-text choice before enabling purchase or editing', async t => {
  const decisions = [];
  const h = harness(t, { prepare: async (product, opts) => {
    if (product.key === products[0].key) {
      decisions.push(opts.allowSmallText);
      if (!opts.allowSmallText) throw new Error('print_capacity');
      return { ...snapshot(product), currentDesignEdited: true };
    }
    return snapshot(product);
  } });
  await h.settle();
  const card = h.gallery.cards[0];
  assert.equal(card.snapshot, null);
  assert.equal(card.add.disabled, true);
  assert.equal(card.customize.disabled, true);
  assert.match(card.status.textContent, /mindestens 10 pt/);
  assert.equal(card.retry.textContent, 'Mit kleiner Schrift gestalten');
  card.retry.click(); await h.settle();
  assert.deepEqual(decisions, [false, true]);
  assert.equal(card.snapshot.currentDesignEdited, true);
  assert.equal(card.customize.disabled, false);
});

test('size changes keep loading feedback in the preview and clear it on completion', async t => {
  let finish;
  const h = harness(t, { prepare: product => product.size.label === '444 ml'
    ? new Promise(resolve => { finish = () => resolve(snapshot(product)); }) : snapshot(product) });
  await h.settle();
  const mug = h.card('mug');
  const pending = h.gallery.load(mug, mug.variants[1]);
  assert.equal(mug.status.classList.contains('is-loading'), true);
  assert.equal(mug.preview.getAttribute('aria-busy'), 'true');
  assert.equal(mug.stage.dataset.ready, 'false');
  assert.equal(mug.add.disabled, true);
  while (!finish) await new Promise(setImmediate);
  finish(); await pending;
  assert.equal(mug.stage.dataset.ready, 'true');
  assert.equal(mug.preview.getAttribute('aria-busy'), 'false');
  assert.equal(mug.status.hidden, true);
  assert.equal(mug.add.disabled, false);
});

test('the gallery waits for original mesh geometry before hiding its loading feedback', async t => {
  const h = harness(t, { viewer: viewer => { viewer.loading = true; } });
  await h.settle();
  const card = h.card('mug'), viewer = h.viewers.find(item => item.params.product.key === card.product.key);
  assert.equal(card.stage.dataset.ready, 'false');
  assert.equal(card.status.hidden, false);
  viewer.loading = false;
  viewer.params.onStatus('ready');
  assert.equal(card.stage.dataset.ready, 'true');
  assert.equal(card.status.hidden, true);
});

test('a lost 3D context stays in error until retry and gallery disposal releases its viewer', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const countBeforeRetry = h.viewers.length;
  h.viewers[0].params.onStatus('error');
  h.gallery.render(mug);
  assert.equal(mug.retry.hidden, false);
  assert.equal(mug.stage.dataset.ready, 'error');
  mug.retry.click();
  assert.equal(h.viewers[0].destroyed, true);
  assert.equal(h.viewers.length, countBeforeRetry + 1);
  assert.equal(mug.retry.hidden, true);
  h.gallery.destroy();
  assert.ok(h.viewers.every(viewer => viewer.destroyed));
  assert.equal(h.gallery.entries.size, 0);
  await h.gallery.choose(mug);
  assert.equal(h.chosen.length, 0);
});

test('adding from the gallery approves the exact selected size and both sides without opening the editor', async t => {
  const h = harness(t);
  await h.settle();
  const card = h.card('notebook');
  const expected = structuredClone(card.snapshot);
  await h.gallery.add(card);
  assert.deepEqual(h.added, [expected]);
  assert.notEqual(h.added[0], expected);
  assert.equal(h.chosen.length, 0);
  assert.equal(card.add.textContent, 'Im Warenkorb');
  assert.equal(card.add.disabled, true);
  await h.gallery.add(card);
  assert.equal(h.added.length, 1, 'an accepted design cannot be added twice by a repeated click');
  await h.gallery.choose(card);
  assert.equal(h.chosen[0].editingOrderItemId, 'Cart00001');
  assert.deepEqual(h.chosen[0].designs, expected.designs);
});

test('a cart save locks selection and sizes until it completes', async t => {
  let finish;
  const h = harness(t, { onAdd: design => new Promise(resolve => { finish = () => resolve({ ...design,
    editingOrderItemId: 'Cart00001', needsCartUpdate: false }); }) });
  await h.settle();
  const pending = h.gallery.add(h.card('poster'));
  assert.equal(h.card('poster').add.textContent, 'In den Warenkorb');
  assert.equal(h.card('poster').add.getAttribute('aria-busy'), 'true');
  await h.gallery.add(h.card('tote'));
  await h.gallery.choose(h.card('mug'));
  assert.equal(h.added.length, 1);
  assert.equal(h.chosen.length, 0);
  assert.ok(h.gallery.cards.every(card => card.customize.disabled && card.add.disabled &&
    (!card.variantToggle || card.variantToggle.disabled)));
  finish(); await pending;
  assert.equal(h.card('poster').add.getAttribute('aria-busy'), 'false');
  assert.equal(h.card('tote').add.disabled, false);
});

test('failed cart saves remain in the gallery and can be retried', async t => {
  let fail = true;
  const h = harness(t, { onAdd: design => {
    if (fail) throw new Error('offline');
    return { ...design, editingOrderItemId: 'Cart00001', needsCartUpdate: false };
  } });
  await h.settle();
  const card = h.card('pillow');
  await h.gallery.add(card);
  assert.equal(card.status.hidden, false);
  assert.equal(card.add.disabled, false);
  assert.equal(card.add.getAttribute('aria-busy'), 'false');
  assert.equal(card.add.textContent, 'In den Warenkorb');
  assert.equal(h.chosen.length, 0);
  fail = false;
  await h.gallery.add(card);
  assert.equal(card.status.hidden, true);
  assert.equal(card.add.disabled, true);
});

test('returning from the editor restores its edited preview while other layouts stay cached', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const edited = structuredClone(mug.snapshot);
  edited.designs.default[0].text = 'Our edited design';
  edited.workingDesignId = 'working-copy';
  const viewersBeforeSuspend = h.viewers.length;
  h.gallery.suspend();
  assert.equal(h.viewers[0].destroyed, true);
  h.gallery.render(mug);
  assert.equal(h.viewers.length, viewersBeforeSuspend, 'hidden gallery cannot recreate its WebGL context');
  await h.gallery.resume(edited);
  assert.deepEqual(mug.snapshot, edited);
  assert.equal(h.prepared.length, groupProducts(products).length, 'returning does not repack any product');
  await h.gallery.choose(mug);
  assert.deepEqual(h.chosen[0], edited);
  assert.equal(h.viewers.length, viewersBeforeSuspend + 1);
});

test('a removed cart product becomes explicitly addable again when returning to the gallery', async t => {
  let inCart = true;
  const h = harness(t, { isInCart: () => inCart });
  await h.settle();
  const card = h.card('tote');
  await h.gallery.add(card);
  assert.equal(card.add.disabled, true);
  h.gallery.suspend();
  inCart = false;
  await h.gallery.resume();
  assert.equal(card.add.disabled, false);
  assert.equal(card.add.textContent, 'In den Warenkorb');
});

test('category filters include both posters, retain designs and remain selected after editor return', async t => {
  const h = harness(t);
  await h.settle();
  assert.equal(h.gallery.category, 'all');
  h.gallery.filters.querySelector('[data-category="poster"]').click();
  assert.deepEqual(h.gallery.cards.filter(card => !card.element.hidden).map(card => card.product.previewShape), ['poster', 'framed-poster']);
  assert.equal(h.viewers[0].destroyed, true, 'filtering out the mug releases its WebGL viewer');
  const card = h.card('poster');
  const expected = structuredClone(card.snapshot);
  h.gallery.suspend();
  await h.gallery.resume(expected);
  assert.equal(h.gallery.category, 'poster');
  assert.equal(h.gallery.filters.querySelector('[aria-pressed="true"]').dataset.category, 'poster');
  h.gallery.filter('all');
  assert.equal(h.gallery.cards.filter(card => !card.element.hidden).length, groupProducts(products).length);
  assert.equal(h.prepared.length, groupProducts(products).length, 'filters never repack a design');
  assert.deepEqual(card.snapshot, expected);
});

test('the bags filter includes both all-over and organic cotton totes with every variant', async t => {
  const h = harness(t);
  await h.settle();
  h.gallery.filters.querySelector('[data-category="tote"]').click();
  const cards = h.gallery.cards.filter(card => !card.element.hidden);
  assert.deepEqual(cards.map(card => card.product.previewShape), ['tote', 'eco-tote']);
  assert.deepEqual(cards.flatMap(card => card.variants.map(product => product.key)).sort(),
    products.filter(product => product.familyKey === 'bags').map(product => product.key).sort());
  assert.ok(cards.every(card => card.product.previewType === '3d' && card.viewer));
});

test('all tote reference photos contain the complete portrait image in thumbnails and enlargement', async t => {
  const h = harness(t); await h.settle();
  const card = h.card('tote');
  for (const product of card.variants) {
    assert.equal(product.productPhotoFit, 'contain', product.key);
    h.gallery.openPhoto(card, product);
    assert.equal(h.gallery.photoDialog.photo.style.objectFit, 'contain', product.key);
    assert.ok(h.gallery.photoDialog.photo.src.endsWith(product.productPhoto || product.previewMockup.assets.default));
    h.gallery.photoDialog.dialog.close();
  }
});

test('paired card buttons add on the left and customize on the right; all mug choices use metric capacities', async t => {
  const h = harness(t);
  await h.settle();
  const card = h.card('mug');
  assert.deepEqual([...card.add.parentElement.children], [card.add, card.customize]);
  assert.equal(card.customize.tagName, 'BUTTON');
  card.variantToggle.click();
  assert.deepEqual([...h.gallery.variantDialog.list.querySelectorAll('strong')].map(node => node.textContent), ['325 ml', '444 ml', '591 ml']);
  h.gallery.variantDialog.dialog.close();
  card.customize.click();
  await Promise.resolve();
  assert.equal(h.chosen.length, 1);
  assert.equal(h.added.length, 0);
});
