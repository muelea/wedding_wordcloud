'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const Preview = require('../public/js/print-preview');
const ProductPreviews = require('../public/js/cart-product-preview');
const { Gallery, groupProducts, shouldOpen } = require('../public/js/product-gallery');
const { getPublicProducts } = require('../src/products');

const Orientation = require('../public/js/product-orientation');
const products = getPublicProducts();
const translate = (source, values = {}) => source.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
const snapshot = product => ({ productKey: product.key, orientation: product.defaultOrientation,
  theme: 'konfetti', customColors: ['#ed2446'], words: [['Liebe', 3]],
  designs: Object.fromEntries(product.printSurfaces.map((surface, index) => [surface.key,
    [{ id: 'word', text: 'Liebe', x: 100 + index, y: 120, fontSize: 40, color: '#ed2446' }]])) });

function harness(t, options = {}) {
  const markup = fs.readFileSync(require.resolve('../views/partials/print-preview.ejs'), 'utf8');
  const dom = new JSDOM('<section><div data-gallery-filters></div><div data-gallery-grid></div></section>' + markup, { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  options.observe?.(dom.window);
  const prepared = [], painted = [], chosen = [], added = [], viewers = [];
  const i18n = { t: translate, setText: (element, text, values) => { element.textContent = translate(text, values); },
    setAttribute: (element, key, text, values) => element.setAttribute(key, translate(text, values)) };
  const previewDialog = dom.window.document.getElementById('print-preview');
  const previewModels = [], artwork = [];
  const preview = Preview.create(previewDialog, { window: dom.window, i18n,
    render3D: async options => { previewModels.push(options); return { resize() {}, destroy() {} }; },
    renderPhoto: async options => { previewModels.push(options); return { resize() {}, destroy() {} }; },
  });
  const createViewer = params => {
    const viewer = { params, resizes: 0, destroyed: false,
      resize() { this.resizes++; }, destroy() { this.destroyed = true; } };
    viewers.push(viewer);
    options.viewer?.(viewer);
    return viewer;
  };
  const gallery = new Gallery({
    element: dom.window.document.querySelector('section'), products: options.products || products,
    prepare: async (product, opts) => { prepared.push(product.key); return options.prepare ? options.prepare(product, opts) : { ...snapshot(product), orientation: opts.orientation }; },
    getView: options.getView || Orientation.view,
    transfer: options.transfer,
    preview,
    renderArtwork: (product, design, side) => {
      artwork.push({ product, design, side });
      return `/gallery/${product.key}/${side}.png`;
    },
    configureFlat() {},
    paintFlat: (canvas, product, design, side) => painted.push({ product, design, side }),
    createMug: createViewer,
    createPhoto: createViewer,
    onChoose: async design => { chosen.push(design); await options.onChoose?.(design); },
    onAdd: async design => {
      added.push(design);
      return options.onAdd ? options.onAdd(design) : { ...design, editingOrderItemId: 'Cart00001', needsCartUpdate: false };
    },
    onImpression: options.onImpression, onView: options.onView, onSelect: options.onSelect,
    mobile: options.mobile,
    isInCart: options.isInCart,
    i18n,
  });
  t.after(() => { gallery.destroy(); dom.window.close(); });
  return { gallery, window: dom.window, prepared, painted, chosen, added, viewers, previewDialog, previewModels, artwork,
    settle: async () => { await gallery.queue; await Promise.resolve(); },
    card: shape => gallery.cards.find(card => (card.product.previewType === 'mug' ? 'mug' : card.product.previewShape) === shape),
  };
}

test('the gallery covers every catalog variant in distinct product groups', () => {
  const groups = groupProducts(products);
  assert.equal(groups.length, new Set(products.map(product => product.catalogGroup || (product.previewType === 'mug' ? 'mug' : product.previewShape))).size);
  assert.deepEqual(groups.flat().map(product => product.key).sort(), products.map(product => product.key).sort());
  assert.equal(groups.find(group => group[0].previewType === 'mug').length, 3);
  assert.equal(groups.find(group => group[0].previewShape === 'poster').length, 7);
  assert.equal(groups.find(group => group[0].previewShape === 'framed-poster').length, 21);
  assert.equal(groups.find(group => group[0].catalogGroup === 'colored-mug').length, 11);
  assert.equal(groups.find(group => group[0].catalogGroup === 'canvas').length, 46);
  assert.equal(groups.find(group => group[0].catalogGroup === 'thin-canvas').length, 13);
  assert.equal(groups.find(group => group[0].catalogGroup === 'framed-canvas').length, 39);
});

test('gallery orientation choices keep preview, customization, direct cart and retained editor labels in agreement', async t => {
  const h = harness(t, { products: products.filter(p => p.previewShape === 'blanket') });
  await h.settle();
  const card = h.card('blanket');
  assert.equal(card.snapshot.orientation, 'portrait', 'new blanket cards start in portrait');
  assert.ok(card.view.printFile.width < card.view.printFile.height);
  h.gallery.openVariants(card);
  const list = h.gallery.variantDialog.list;
  list.querySelector('[data-value="portrait"]').click();
  list.querySelector('.product-picker-apply').click();
  await h.settle();
  assert.equal(card.snapshot.orientation, 'portrait');
  assert.ok(card.viewer.params.product.printFile.width < card.viewer.params.product.printFile.height);
  assert.match(card.variantLabel.textContent, /^127 × 153 cm · Hochformat$/);
  await h.gallery.choose(card);
  assert.equal(h.chosen.at(-1).orientation, 'portrait');
  await h.gallery.add(card);
  assert.equal(h.added.at(-1).orientation, 'portrait');
  const retained = { ...card.snapshot, orientation: 'landscape' };
  await h.gallery.resume(retained);
  assert.equal(card.snapshot.orientation, 'landscape');
  assert.match(card.variantLabel.textContent, /^153 × 127 cm · Querformat$/);
  h.gallery.openVariants(card);
  assert.equal(list.querySelector('[data-value="landscape"]').getAttribute('aria-pressed'), 'true');
  assert.ok(h.gallery.entries.has(`${card.product.key}:portrait`));
  assert.ok(h.gallery.entries.has(`${card.product.key}:landscape`));
});

test('gallery switches transfer edited content and preserve its cart target instead of rebuilding live words', async t => {
  const transfers = [];
  const h = harness(t, { products: products.filter(p => p.previewShape === 'blanket'),
    transfer: async (source, product, orientation) => {
      transfers.push({ source, product, orientation });
      return { ...source, productKey: product.key, orientation, needsCartUpdate: true };
    } });
  await h.settle();
  const card = h.card('blanket');
  const edited = { ...card.snapshot, orientation: 'landscape', currentDesignEdited: true, editingOrderItemId: 'OriginalCart',
    workingDesignId: 'w'.repeat(32), designs: { default: [{ id: 'personal', text: 'Mein Text', x: 200, y: 200 }] } };
  await h.gallery.resume(edited);
  await h.gallery.load(card, card.product, true, false, 'portrait');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].source.designs.default[0].text, 'Mein Text');
  assert.equal(card.snapshot.editingOrderItemId, 'OriginalCart');
  assert.equal(card.snapshot.orientation, 'portrait');
  assert.equal(card.snapshot.needsCartUpdate, true);
  assert.equal(h.prepared.length, 1, 'manual content does not re-enter the automatic live-word layout');
});

test('rapid gallery orientation switches retain edited contents while a preceding transfer is still running', async t => {
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  let count = 0;
  const h = harness(t, { products: products.filter(p => p.previewShape === 'blanket'),
    transfer: async (source, product, orientation) => {
      if (++count === 1) { started(); await new Promise(resolve => { release = resolve; }); }
      return { ...source, productKey: product.key, orientation, needsCartUpdate: true };
    } });
  await h.settle();
  const card = h.card('blanket');
  await h.gallery.resume({ ...card.snapshot, orientation: 'landscape', currentDesignEdited: true,
    designs: { default: [{ id: 'personal', text: 'Behalten', x: 200, y: 200 }] } });
  const portrait = h.gallery.load(card, card.product, true, false, 'portrait');
  await running;
  const landscape = h.gallery.load(card, card.product, true, false, 'landscape');
  release(); await Promise.all([portrait, landscape]);
  assert.equal(card.snapshot.orientation, 'landscape');
  assert.equal(card.snapshot.designs.default[0].text, 'Behalten');
  assert.equal(h.prepared.length, 1);
});

test('ordinary product entries always enter the gallery, including saved drafts and empty direct designs', () => {
  const entry = { directDesign: false, words: [['Liebe', 1]], query: new URLSearchParams(), draft: null };
  assert.equal(shouldOpen(entry), true);
  assert.equal(shouldOpen({ ...entry, directDesign: true }), true);
  assert.equal(shouldOpen({ ...entry, words: [] }), true);
  assert.equal(shouldOpen({ ...entry, draft: { productKey: 'retained' } }), true);
  assert.equal(shouldOpen({ ...entry, query: new URLSearchParams('cart=1') }), true);
  for (const key of ['edit', 'accountDesign', 'draft']) {
    assert.equal(shouldOpen({ ...entry, query: new URLSearchParams(`${key}=chosen`) }), false, key);
  }
});

test('clothing offers three garment groups and all 38 exact size and colour choices through the cart', async t => {
  const h = harness(t); await h.settle(); h.gallery.filter('clothing');
  const cards = h.gallery.cards.filter(card => !card.element.hidden);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map(card => card.product.previewShape), ['t-shirt', 'sweatshirt', 'hoodie']);
  for (const [kind, count] of [['t-shirt', 18], ['sweatshirt', 10], ['hoodie', 10]]) {
    const card = h.card(kind), choices = products.filter(p => p.previewShape === kind);
    assert.equal(choices.length, count);
    const selected = choices.find(p => p.size.label === '2XL · Schwarz');
    await h.gallery.load(card, selected);
    assert.equal(card.product.key, selected.key);
    assert.equal(card.photo.getAttribute('src'), selected.productPhoto);
    await h.gallery.add(card);
    assert.equal(h.added.at(-1).productKey, selected.key);
    assert.deepEqual(Object.keys(h.added.at(-1).designs), ['front']);
  }
});

test('an explicit gallery location survives a saved draft while editor entry links take priority', () => {
  const entry = { directDesign: false, words: [['Liebe', 1]], draft: { workingDesignId: 'retained' },
    query: new URLSearchParams('view=products&draft=retained') };
  assert.equal(shouldOpen(entry), true);
  assert.equal(shouldOpen({ ...entry, directDesign: true }), true);
  for (const key of ['edit', 'accountDesign']) {
    const query = new URLSearchParams(entry.query);
    query.set(key, 'chosen');
    assert.equal(shouldOpen({ ...entry, query }), false, key);
  }
});

test('a blank product can be customized but cannot enter the cart before it has a design', async t => {
  const h=harness(t,{prepare:async product=>({...snapshot(product),
    designs:Object.fromEntries(product.printSurfaces.map(surface=>[surface.key,[]]))})});
  await h.settle();
  const card=h.card('mug');
  assert.equal(card.customize.disabled,false);
  assert.equal(card.add.disabled,true);
  await h.gallery.add(card);assert.equal(h.added.length,0);
  await h.gallery.choose(card);assert.equal(h.chosen.length,1);
});

test('every preview paints its own product and selecting it hands over the exact complete design', async t => {
  const h = harness(t);
  await h.settle();
  assert.equal(h.prepared.length, groupProducts(products).length);
  assert.equal(h.painted.length, groupProducts(products).filter(group => !['mug','3d','photo'].includes(group[0].previewType)).length);
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

test('every clothing size uses the photo renderer, exact artwork and neutral controls without constructing a 3D model', async t => {
  const h = harness(t, { products: products.filter(product => product.familyKey === 'clothing') });
  const create3D = t.mock.method(h.gallery, 'createMug', () => { throw new Error('unexpected 3D garment'); });
  await h.settle();
  for (const card of h.gallery.cards) for (const variant of card.variants) {
    const previous = card.viewer;
    await h.gallery.load(card, variant);
    assert.equal(card.viewer.params.product.key, variant.key);
    assert.equal(card.viewer.params.product.previewType, 'photo');
    assert.deepEqual(card.viewer.params.design, card.snapshot.designs.front);
    assert.equal(card.flat.hidden, true);
    assert.equal(card.host.hidden, false);
    assert.equal(card.host.tabIndex, -1);
    assert.doesNotMatch(card.host.getAttribute('aria-label'), /Stoff|Drehen/);
    if (previous) {
      assert.equal(previous.destroyed, true);
      previous.params.onStatus('error');
      assert.equal(card.failed, false, 'an old size cannot replace the selected photo with an error');
    }
    h.gallery.openPreview(card);
    await Promise.resolve();
    assert.equal(h.previewModels.at(-1).item.product.key, variant.key);
    assert.deepEqual(Object.keys(h.previewModels.at(-1).item.printPreviewUrls), ['front']);
    h.previewDialog.close();
  }
  assert.equal(create3D.mock.callCount(), 0);
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
    assert.match(mug.photoButton.getAttribute('aria-label'), new RegExp(variant.size.label));
    photos.add(variant.productPhoto);
  }
  assert.equal(photos.size, 3);
  assert.ok(h.gallery.cards.filter(card => card.product.previewType === 'flat' && card.variants.length > 1).every(card => !card.photoButton.hidden), 'flat product options also show their real reference image');
});

test('every metric poster variant keeps its own photo, price and exact product identity through customization', async t => {
  const h = harness(t);
  await h.settle();
  for (const shape of ['poster', 'framed-poster']) {
    const card = h.card(shape);
    for (const variant of card.variants) {
      await h.gallery.load(card, variant);
      assert.equal(card.photo.getAttribute('src'), variant.productPhoto || variant.previewMockup.assets.default);
      assert.equal(card.variantLabel.textContent, Orientation.summary(variant, { t: value => value }, { detail: false }));
      assert.equal(card.price.textContent, new Intl.NumberFormat('de', { style: 'currency', currency: 'EUR' })
        .format(variant.price.unitGrossCents / 100));
      assert.equal(card.viewer.params.product.key, variant.key);
      assert.deepEqual(card.viewer.params.product.printFile, variant.printFile);
      await h.gallery.choose(card);
      assert.equal(h.chosen.at(-1).productKey, variant.key);
      assert.equal(h.chosen.at(-1).orientation, 'portrait');
    }
  }
  assert.equal(h.chosen.length, 28);
});

test('the canvas filter exposes all three ranges and every size/color keeps its own photo and approved cart identity', async t => {
  const h = harness(t);
  await h.settle();
  h.gallery.filters.querySelector('[data-category="canvas"]').click();
  const cards = h.gallery.cards.filter(card => !card.element.hidden);
  assert.deepEqual(cards.map(card => card.product.catalogGroup), ['canvas', 'framed-canvas', 'thin-canvas']);
  for (const card of cards) for (const variant of card.variants) {
    await h.gallery.load(card, variant);
    assert.equal(card.photo.getAttribute('src'), variant.productPhoto);
    assert.equal(card.variantLabel.textContent, Orientation.summary(variant, { t: value => value }, { detail: false }));
    assert.equal(card.viewer.params.product.key, variant.key);
    await h.gallery.add(card);
    assert.equal(h.added.at(-1).productKey, variant.key);
    assert.equal(h.added.at(-1).orientation, variant.defaultOrientation);
  }
  assert.equal(h.added.length, 98);
});

test('every product has the same variant summary and only multiple variants offer a menu', async t => {
  const h = harness(t);
  await h.settle();
  for (const card of h.gallery.cards) {
    assert.equal(card.sizes.hidden, false, card.product.key);
    assert.equal(card.photoButton.parentElement, card.sizes);
    assert.equal(card.variantLabel.textContent, Orientation.summary(card.product, { t: value => value }, { detail: false }));
    assert.equal(card.detail.hidden, true, 'the variant appears once, in its summary row');
    const summary = card.sizes.querySelector('.product-gallery-variant-summary');
    assert.equal(summary.tagName, card.variants.length > 1 || card.product.orientations.length > 1 ? 'BUTTON' : 'DIV');
    assert.equal(Boolean(summary.querySelector('.product-variant-chevron')), card.variants.length > 1);
    if (card.variants.length === 1) {
      const before = structuredClone(card.snapshot);
      summary.click();
      h.gallery.openVariants(card);
      assert.equal(h.gallery.variantDialog.dialog.open, false);
      assert.equal(summary.hasAttribute('aria-haspopup'), false);
      card.photoButton.click();
      assert.equal(h.previewDialog.querySelector('[data-preview-photo-artwork] img').getAttribute('src'), ProductPreviews.photo(card.product));
      assert.equal(h.previewDialog.open, true);
      h.previewDialog.close();
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

test('variant options preview exact photos and prices without rebuilding the gallery until confirmation', async t => {
  const h = harness(t); await h.settle();
  const mug = h.card('mug'), before = structuredClone(mug.snapshot);
  mug.variantToggle.click();
  const { dialog, list } = h.gallery.variantDialog;
  assert.equal(dialog.open, true);
  const preparedBefore = h.prepared.length;
  list.querySelector('[data-value="591 ml"]').click();
  assert.equal(dialog.open, true);
  assert.equal(h.prepared.length, preparedBefore);
  assert.deepEqual(mug.snapshot, before);
  assert.equal(list.querySelector('.product-picker-summary strong').textContent, '591 ml');
  assert.equal(list.querySelector('.product-picker-summary span').textContent, h.gallery.priceFor(mug.variants[2]));
  const photo = list.querySelector('.product-picker-photo');
  assert.equal(photo.querySelector('img').getAttribute('src'), mug.variants[2].productPhoto);
  photo.click();
  assert.equal(h.previewDialog.open, true);
  assert.equal(h.previewDialog.querySelector('[data-preview-photo-artwork] img').getAttribute('src'), mug.variants[2].productPhoto);
  assert.equal(h.previewDialog.querySelector('[data-preview-view="model"]').hidden, true);
  h.previewDialog.close(); assert.equal(h.window.document.activeElement, photo);
  list.querySelector('.product-picker-apply').click(); await h.settle();
  assert.equal(dialog.open, false);
  assert.equal(mug.variantToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.window.document.activeElement, mug.variantToggle);
  assert.equal(mug.product.key, mug.variants[2].key);
  assert.equal(mug.snapshot.productKey, mug.variants[2].key);
  assert.equal(h.chosen.length, 0); assert.equal(h.added.length, 0);
  mug.variantToggle.click(); h.gallery.suspend(); assert.equal(dialog.open, false);
});

test('the gallery gives variant forms a definite height with bounded scrolling on desktop and mobile', async t => {
  const h = harness(t); await h.settle(); h.card('mug').variantToggle.click();
  const { dialog, header, list } = h.gallery.variantDialog;
  const content = list.querySelector('.product-picker-content'), actions = list.querySelector('.product-picker-actions');
  Object.defineProperty(header, 'offsetHeight', { value: 70 });
  Object.defineProperty(actions, 'offsetHeight', { value: 140 });
  let intrinsicHeight = 110;
  Object.defineProperty(content, 'scrollHeight', { get() {
    assert.equal(content.style.flex, '0 0 auto', 'measure intrinsic content without the zero flex basis');
    return intrinsicHeight;
  } });
  content.style.flex = '1 1 0px';
  h.gallery.positionVariants();
  assert.equal(dialog.style.height, '322px', 'header, options and footer each receive their own space');
  assert.equal(content.style.flex, '1 1 0px', 'restore the scrollable flex content after measuring');
  intrinsicHeight = 1000; h.gallery.positionVariants();
  assert.equal(dialog.style.height, '744px');
  Object.defineProperty(h.window, 'innerWidth', { value: 390 });
  Object.defineProperty(h.window, 'innerHeight', { value: 600 });
  h.gallery.positionVariants();
  assert.equal(dialog.style.height, '480px', 'the mobile sheet leaves space outside its bounded options');
  assert.equal(dialog.style.maxHeight, '480px');
});

test('opening and filtering phone models resizes the gallery picker instead of squeezing the results', async t => {
  const h = harness(t); await h.settle();
  const phone = h.gallery.cards.find(card => card.product.previewModel?.kind === 'case' && card.variants.length > 8);
  h.gallery.openVariants(phone);
  const { dialog, header, list } = h.gallery.variantDialog;
  Object.defineProperty(header, 'offsetHeight', { value: 70 });
  Object.defineProperty(list.querySelector('.product-picker-actions'), 'offsetHeight', { value: 140 });
  Object.defineProperty(list.querySelector('.product-picker-content'), 'scrollHeight', { get() {
    return list.querySelector('.product-picker-search').hidden ? 160 :
      list.querySelectorAll('[role="option"]').length > 1 ? 450 : 220;
  } });
  h.gallery.positionVariants(); assert.equal(dialog.style.height, '372px');
  list.querySelector('[data-option-key="model"] .product-picker-select').click();
  assert.equal(dialog.style.height, '662px', 'opening the model list expands its parent to fit the search and other fields');
  const input = list.querySelector('input');
  input.value = 'iPhone 11 Pro Max'; input.dispatchEvent(new h.window.Event('input'));
  assert.equal(dialog.style.height, '432px', 'filtering reduces unused space without cropping matching results');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(dialog.style.height, '372px', 'closing search restores the compact form');
  assert.equal(dialog.open, true);
});

test('the gallery thumbnail opens the shared overview with its exact variant and every design side without saving', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const dialog = h.previewDialog, title = dialog.querySelector('[data-preview-title]');
  for (const variant of mug.variants) {
    await h.gallery.load(mug, variant);
    const before = structuredClone(mug.snapshot);
    mug.photoButton.click();
    await Promise.resolve();
    const photo = dialog.querySelector('[data-preview-photo-artwork] img');
    assert.equal(dialog.open, true);
    assert.equal(h.window.document.activeElement, title, 'opening does not put a focus frame around the close button');
    assert.equal(mug.photoButton.getAttribute('aria-controls'), dialog.id);
    assert.equal(mug.photoButton.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(photo.getAttribute('src'), variant.productPhoto);
    assert.equal(title.textContent, variant.displayName);
    assert.equal(dialog.querySelector('[data-preview-detail]').textContent, Orientation.summary(variant, { t: value => value }, { detail: false }));
    assert.equal(dialog.querySelector('[data-preview-artwork] img').getAttribute('src'), `/gallery/${variant.key}/${mug.surface}.png`);
    assert.deepEqual(h.previewModels.at(-1).item.printPreviewUrls, Object.fromEntries(
      variant.printSurfaces.map(side => [side.key, `/gallery/${variant.key}/${side.key}.png`])));
    assert.deepEqual(h.artwork.filter(entry => entry.product.key === variant.key).map(entry => entry.design),
      variant.printSurfaces.map(side => before.designs[side.key]));
    assert.equal(h.gallery.photoDialog.dialog.open, false, 'the former photo-only modal is not used');
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

test('leaving or disposing the gallery closes its shared overview while retaining the cart dialog', async t => {
  const h = harness(t);
  await h.settle();
  const mug = h.card('mug');
  const dialog = h.previewDialog;
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
  assert.equal(dialog.isConnected, true);
});

test('a variant that is still preparing cannot open the previous variant artwork', async t => {
  let finish;
  const variants = products.filter(product => product.previewType === 'mug');
  const h = harness(t, { products: variants, prepare: product => product.key === variants[1].key
    ? new Promise(resolve => { finish = () => resolve(snapshot(product)); }) : snapshot(product) });
  await h.settle();
  const mug = h.card('mug');
  mug.photoButton.click(); h.previewDialog.close();
  const loading = h.gallery.load(mug, variants[1]);
  assert.equal(mug.photoButton.disabled, true);
  h.gallery.openPreview(mug);
  assert.equal(h.previewDialog.open, false);
  while (!finish) await new Promise(setImmediate);
  finish(); await loading;
  mug.photoButton.click();
  assert.equal(h.previewDialog.querySelector('[data-preview-artwork] img').getAttribute('src'),
    `/gallery/${variants[1].key}/${mug.surface}.png`);
  assert.equal(h.added.length, 0);
});

test('the gallery overview retains edited front and back artwork and switches sides without saving', async t => {
  const product = products.find(product => product.previewType === '3d' && product.printSurfaces.length === 2);
  const h = harness(t, { products: [product] });
  await h.settle();
  const retained = snapshot(product);
  product.printSurfaces.forEach((side, index) => Object.assign(retained.designs[side.key][0], {
    text: `Edited side ${index}`, x: 213.4 + index, color: '#123456',
  }));
  await h.gallery.resume(retained);
  const card = h.gallery.cards[0];
  card.photoButton.click();
  await Promise.resolve();
  for (const side of product.printSurfaces) {
    h.previewDialog.querySelector(`[data-surface="${side.key}"]`).click();
    assert.equal(h.previewDialog.querySelector('[data-preview-artwork] img').getAttribute('src'),
      `/gallery/${product.key}/${side.key}.png`);
  }
  assert.deepEqual(h.artwork.map(entry => entry.design), product.printSurfaces.map(side => retained.designs[side.key]));
  assert.deepEqual(card.snapshot, retained);
  assert.equal(h.previewModels.length, 1, 'switching the flat design side retains the same 3D viewer');
  assert.equal(h.chosen.length, 0);
  assert.equal(h.added.length, 0);
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

test('gallery cart updates preserve existing text nodes throughout an add', async t => {
  let finish;
  const h = harness(t, { onAdd: design => new Promise(resolve => { finish = () => resolve({ ...design,
    editingOrderItemId: 'Cart00001', needsCartUpdate: false }); }) });
  await h.settle();
  const hoodie = h.card('hoodie');
  const textNodes = h.gallery.cards.flatMap(card =>
    [card.name, card.price, card.priceNote, card.variantLabel, card.add]
      .filter(Boolean).map(element => ({ element, node: element.firstChild })));
  const pending = h.gallery.add(hoodie);
  const changedNodes = () => textNodes.filter(({ element, node }) => element.firstChild !== node);
  assert.equal(changedNodes().length, 0, 'locking the gallery must retain text used by browser scroll anchors');
  finish();
  await pending;
  assert.deepEqual(changedNodes().map(({ element }) => element), [hoodie.add],
    'only the accepted product\'s changed cart label replaces text');
  const acceptedLabel = hoodie.add.firstChild;
  h.gallery.updateActions();
  assert.equal(hoodie.add.firstChild, acceptedLabel, 'unchanged cart refreshes retain the accepted label too');
  const { translate: localized } = require('../src/i18n');
  h.gallery.i18n = { ...h.gallery.i18n, t: source => localized(source, 'en'),
    setText: (element, source) => { element.textContent = localized(source, 'en'); } };
  h.gallery.localize();
  assert.equal(hoodie.add.textContent, localized('Im Warenkorb', 'en'), 'language changes still refresh cart labels');
  assert.equal(h.card('t-shirt').add.textContent, localized('In den Warenkorb', 'en'));
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
    assert.equal(h.previewDialog.querySelector('[data-preview-photo-card]').hidden, false);
    assert.ok(h.previewDialog.querySelector('[data-preview-photo-artwork] img').src.endsWith(product.productPhoto || product.previewMockup.assets.default));
    h.previewDialog.close();
  }
});

test('paired card buttons add on the left and customize on the right; all mug choices use metric capacities', async t => {
  const h = harness(t);
  await h.settle();
  const card = h.card('mug');
  assert.deepEqual([...card.add.parentElement.children], [card.add, card.customize]);
  assert.equal(card.customize.tagName, 'BUTTON');
  card.variantToggle.click();
  assert.deepEqual([...h.gallery.variantDialog.list.querySelectorAll('[data-option-key="volume"] .product-picker-option')].map(node => node.textContent), ['325 ml', '444 ml', '591 ml']);
  h.gallery.variantDialog.dialog.close();
  card.customize.click();
  await Promise.resolve();
  assert.equal(h.chosen.length, 1);
  assert.equal(h.added.length, 0);
});

function previewObservers() {
  const callbacks = {}, idle = new Map();
  let sequence = 0;
  callbacks.idleCount = () => idle.size;
  callbacks.idle = () => {
    const next = idle.entries().next().value;
    if (next) { idle.delete(next[0]); next[1]({ timeRemaining: () => 20 }); }
  };
  return { callbacks, observe(window) {
    window.requestIdleCallback = callback => { idle.set(++sequence, callback); return sequence; };
    window.cancelIdleCallback = id => idle.delete(id);
    window.IntersectionObserver = class {
      constructor(callback) { callbacks.intersection = callback; }
      observe() {} disconnect() {}
    };
    window.ResizeObserver = class {
      constructor(callback) { callbacks.resize = callback; }
      observe() {} disconnect() {}
    };
  } };
}

test('scrolling defers new 3D models and reuses nearby viewers without repacking', async t => {
  const observations = previewObservers();
  const h = harness(t, observations); await h.settle();
  const [first, second] = h.gallery.cards.filter(card => ['mug', '3d'].includes(card.product.previewType));
  const visible = (card, isIntersecting) => ({ target: card.stage, isIntersecting });
  observations.callbacks.intersection([visible(first, true)]);
  observations.callbacks.idle();
  const viewer = first.viewer;
  assert.ok(viewer);
  const resizes = viewer.resizes;
  h.window.dispatchEvent(new h.window.WheelEvent('wheel', { deltaY: 100 }));
  observations.callbacks.intersection([visible(first, false), visible(second, true)]);
  assert.equal(second.viewer, null, 'scroll frames never construct models');
  assert.equal(first.viewer, viewer, 'leaving the viewport retains the nearby viewer');
  assert.equal(viewer.destroyed, false);
  observations.callbacks.idle();
  assert.equal(second.viewer, null, 'wheel input cancels model work before a scroll event arrives');
  await new Promise(resolve => h.window.setTimeout(resolve, 390));
  observations.callbacks.idle();
  assert.ok(second.viewer, 'the settled viewport gets its interactive preview');
  observations.callbacks.intersection([visible(second, false), visible(first, true)]);
  assert.equal(first.viewer, viewer);
  assert.equal(viewer.resizes, resizes, 'unchanged viewport dimensions need no redraw');
  h.window.devicePixelRatio = 2;
  h.gallery.render(first);
  assert.equal(viewer.resizes, resizes + 1, 'a display-density change still refreshes the renderer');
  assert.equal(h.viewers.length, 2);
  assert.equal(h.prepared.length, groupProducts(products).length, 'scrolling never recomputes designs');
  h.window.dispatchEvent(new h.window.Event('scroll'));
  h.gallery.suspend();
  await new Promise(resolve => h.window.setTimeout(resolve, 390));
  assert.ok(h.viewers.every(viewer => viewer.destroyed));
  assert.equal(h.viewers.length, 2, 'a pending scroll timer cannot recreate the suspended gallery');
});

test('3D retention evicts the oldest offscreen viewer and releases all retained contexts on suspend', async t => {
  const observations = previewObservers();
  const copied = [];
  const h = harness(t, { observe(window) {
    observations.observe(window);
    window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage: canvas => copied.push(canvas) });
  }, viewer(viewer) {
    viewer.canvas = viewer.params.host.ownerDocument.createElement('canvas');
    viewer.canvas.width = 128; viewer.canvas.height = 96;
    viewer.render = () => {};
    viewer.inputs = 0;
    const handle = () => { viewer.inputs++; };
    const host = viewer.params.host, destroy = viewer.destroy.bind(viewer);
    host.addEventListener('pointerdown', handle);
    host.addEventListener('keydown', handle);
    viewer.destroy = () => { host.removeEventListener('pointerdown', handle); host.removeEventListener('keydown', handle); destroy(); };
  } }); await h.settle();
  const cards = h.gallery.cards.filter(card => ['mug', '3d'].includes(card.product.previewType)).slice(0, 8);
  const snapshots = cards.map(card => structuredClone(card.snapshot));
  for (const [index, card] of cards.entries()) {
    observations.callbacks.intersection([
      ...(index ? [{ target: cards[index - 1].stage, isIntersecting: false }] : []),
      { target: card.stage, isIntersecting: true },
    ]);
    observations.callbacks.idle();
    assert.ok(h.gallery.cards.filter(card => card.viewer).length <= 6);
  }
  assert.ok(h.viewers[0].destroyed && h.viewers[1].destroyed);
  assert.equal(h.viewers[2].destroyed, false);
  assert.equal(cards[0].previousPreview.hidden, false, 'an evicted view retains its rendered bitmap');
  assert.equal(cards[0].previousPreview.width, 128);
  assert.equal(cards[0].previousPreview.height, 96);
  assert.equal(cards[0].previousPreview.style.opacity, '1');
  assert.equal(copied[0], h.viewers[0].canvas);
  const created = h.viewers.length;
  observations.callbacks.intersection([{ target: cards.at(-1).stage, isIntersecting: false },
    { target: cards[0].stage, isIntersecting: true }]);
  observations.callbacks.idle();
  assert.equal(h.viewers.length, created, 'revisiting an evicted card uses its bitmap without constructing WebGL');
  assert.equal(cards[0].viewer, null);
  cards[0].host.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, button: 2 }));
  assert.equal(cards[0].viewer, null, 'secondary clicks do not build models');
  cards[0].host.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  assert.equal(h.viewers.length, created + 1);
  assert.equal(cards[0].viewer.inputs, 1, 'the first drag reaches the viewer constructed during capture');
  assert.equal(cards[0].previousPreview.hidden, true);
  observations.callbacks.intersection([{ target: cards[0].stage, isIntersecting: false },
    { target: cards[1].stage, isIntersecting: true }]);
  cards[1].host.dispatchEvent(new h.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
  assert.equal(cards[1].viewer.inputs, 1, 'the first keyboard action also reaches the restored viewer');
  assert.deepEqual(cards.map(card => card.snapshot), snapshots);
  h.gallery.suspend();
  assert.ok(h.viewers.every(viewer => viewer.destroyed));
  assert.ok(h.gallery.cards.every(card => !card.viewer));
});

test('first-time 3D previews build one per idle turn and suspend cancels the remaining work', async t => {
  const observations = previewObservers();
  const h = harness(t, observations); await h.settle();
  const cards = h.gallery.cards.slice(0, 3);
  observations.callbacks.intersection(cards.map(card => ({ target: card.stage, isIntersecting: true })));
  assert.equal(h.viewers.length, 0);
  assert.equal(observations.callbacks.idleCount(), 1);
  observations.callbacks.idle();
  assert.equal(h.viewers.length, 1, 'one callback never constructs a whole row');
  assert.equal(observations.callbacks.idleCount(), 1);
  h.gallery.suspend();
  assert.equal(observations.callbacks.idleCount(), 0);
  observations.callbacks.idle();
  assert.equal(h.viewers.length, 1);
  assert.equal(h.gallery.previewQueue.size, 0);
});

test('the idle queue waits for one provider model to finish before starting another', async t => {
  const observations = previewObservers(), finish = [];
  const h = harness(t, { ...observations, viewer(viewer) {
    viewer.loading = true;
    viewer.ready = new Promise(resolve => finish.push(resolve));
  } }); await h.settle();
  observations.callbacks.intersection(h.gallery.cards.slice(0, 3).map(card => ({ target: card.stage, isIntersecting: true })));
  observations.callbacks.idle();
  assert.equal(h.viewers.length, 1);
  assert.equal(observations.callbacks.idleCount(), 0, 'async loads and shader uploads cannot form a concurrent burst');
  h.viewers[0].loading = false; finish[0](true); await Promise.resolve();
  observations.callbacks.idle();
  assert.equal(h.viewers.length, 2);
  observations.callbacks.intersection([{ target: h.gallery.cards[1].stage, isIntersecting: false }]);
  assert.equal(h.viewers[1].destroyed, true, 'a pending offscreen model never needs to upload textures');
  h.gallery.suspend(); finish[1](false); await Promise.resolve();
  assert.equal(observations.callbacks.idleCount(), 0, 'late completion cannot restart a suspended queue');
});

test('a tall viewport keeps six WebGL viewers even when nine cards are visible', async t => {
  const observations = previewObservers();
  const h = harness(t, { observe(window) {
    observations.observe(window);
    window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  }, viewer(viewer) {
    viewer.canvas = viewer.params.host.ownerDocument.createElement('canvas');
    viewer.render = () => {};
  } }); await h.settle();
  const cards = h.gallery.cards.slice(0, 9);
  observations.callbacks.intersection(cards.map(card => ({ target: card.stage, isIntersecting: true })));
  for (let i = 0; i < 9; i++) {
    observations.callbacks.idle();
    if (i === 0) cards[0].host.classList.add('dragging');
    assert.ok(cards.filter(card => card.viewer).length <= 6);
  }
  assert.ok(cards[0].viewer, 'a model currently being dragged is retained');
  assert.equal(cards.filter(card => card.viewer).length, 6);
  assert.equal(cards.filter(card => !card.previousPreview.hidden).length, 3);
  assert.ok(cards.every(card => card.stage.dataset.ready === 'true'));
  const created = h.viewers.length;
  cards.forEach(card => h.gallery.render(card));
  observations.callbacks.idle();
  assert.equal(h.viewers.length, created, 'visible bitmap previews do not compete to recreate their contexts');
});

test('flat previews paint only visible changed cards instead of every resize notification', async t => {
  const observations = previewObservers();
  const h = harness(t, { ...observations, products: groupProducts(products).slice(2, 4)
    .map(group => ({ ...group[0], previewType: 'flat' })) }); await h.settle();
  const flat = h.gallery.cards.filter(card => !['mug', '3d'].includes(card.product.previewType));
  const [first, second] = flat;
  assert.equal(h.painted.length, 0, 'offscreen flat canvases are not painted');
  observations.callbacks.intersection([{ target: first.stage, isIntersecting: true }, { target: second.stage, isIntersecting: true }]);
  assert.equal(h.painted.length, 2);
  h.gallery.render(first); h.gallery.render(second);
  assert.equal(h.painted.length, 2, 'same size and design do not repaint');
  Object.defineProperty(first.stage, 'clientWidth', { value: 360 });
  observations.callbacks.resize([{ target: first.stage }]);
  await new Promise(resolve => h.window.requestAnimationFrame(resolve));
  assert.equal(h.painted.length, 3);
  assert.equal(h.painted.at(-1).product.key, first.product.key);
  observations.callbacks.intersection([{ target: first.stage, isIntersecting: false }]);
  h.gallery.render(first, true);
  assert.equal(h.painted.length, 3, 'leaving the viewport does not paint');
});

test('gallery analytics measures visible products after consent, once per variant, and deliberate choices', async t => {
  let consented = false;
  const impressions = [], viewed = [], selected = [];
  const h = harness(t, { products: [products.find(p=>p.previewType==='mug'), products.find(p=>p.previewShape==='poster')],
    onImpression: product => { if (!consented) return false; impressions.push(product.key); return true; },
    onView: product => viewed.push(product.key), onSelect: product => selected.push(product.key),
  });
  await h.settle();
  assert.deepEqual(impressions, []);
  consented = true;
  h.gallery.cards[1].visible = false;
  h.gallery.reportImpressions(); h.gallery.reportImpressions();
  assert.deepEqual(impressions, [h.gallery.cards[0].product.key]);
  h.gallery.cards[1].visible = true;
  h.gallery.reportImpressions();
  assert.equal(impressions.length, 2);
  h.gallery.openPreview(h.gallery.cards[0]);
  assert.deepEqual(viewed, [h.gallery.cards[0].product.key]);
  await h.gallery.choose(h.gallery.cards[0]);
  assert.deepEqual(selected, [h.gallery.cards[0].product.key]);
  h.gallery.suspend(); h.gallery.reportedItems.clear(); h.gallery.reportImpressions();
  assert.equal(impressions.length, 2, 'hidden gallery never records new impressions');
  await h.gallery.resume(snapshot(h.gallery.cards[0].product));
  assert.deepEqual(selected, [h.gallery.cards[0].product.key], 'restoring a gallery is not a customer selection');
});

function mobileObservers() {
  const observations = previewObservers(), intersections = [];
  return { mobile: true, callbacks: observations.callbacks, intersections,
    observe(window) {
      observations.observe(window);
      window.IntersectionObserver = class {
        constructor(callback, options) { this.callback = callback; this.options = options; this.observed = new Set(); intersections.push(this); }
        observe(target) { this.observed.add(target); }
        unobserve(target) { this.observed.delete(target); }
        disconnect() { this.observed.clear(); this.disconnected = true; }
      };
    },
    enter(index, cards, isIntersecting = true) {
      intersections[index].callback(cards.map(card => ({ target: card.stage, isIntersecting })));
    },
  };
}

test('mobile prepares and paints nearby cards without spending work on the distant catalog or reporting offscreen impressions', async t => {
  const observations = mobileObservers(), impressions = [];
  const h = harness(t, { ...observations, onImpression: product => { impressions.push(product.key); return true; } });
  await h.settle();
  assert.equal(h.prepared.length, 0);
  assert.equal(h.gallery.cards[0].name.textContent, h.gallery.cards[0].product.displayName, 'catalog details do not wait for artwork');
  assert.deepEqual(observations.intersections[1].options, { rootMargin: `${h.window.innerHeight}px 0px` });
  const [first, next] = h.gallery.cards;
  observations.enter(0, [first]);
  observations.enter(1, [first, next]);
  await h.settle();
  assert.deepEqual(h.prepared, [first.product.key, next.product.key]);
  assert.equal(next.visible, false);
  assert.equal(observations.callbacks.idleCount(), 1);
  observations.callbacks.idle(); observations.callbacks.idle();
  assert.equal(h.viewers.length, 2, 'the next screen already has its exact rendered product');
  assert.deepEqual(impressions, [first.product.key], 'preloading does not invent visible impressions');
  const distant = h.gallery.cards.find(card => card.product.key === 'mouse-pad');
  observations.enter(0, [first], false); observations.enter(1, [first, next], false);
  observations.enter(0, [distant]); observations.enter(1, [distant]);
  await h.settle(); observations.callbacks.idle();
  assert.deepEqual(h.prepared, [first.product.key, next.product.key, distant.product.key]);
  assert.equal(distant.stage.dataset.ready, 'true');
  await h.gallery.choose(distant);
  assert.deepEqual(h.chosen[0], distant.snapshot, 'mobile hands over the same complete design');
});

test('mobile keeps a three-context budget, retains revisited previews, and observes filters and editor return', async t => {
  const observations = mobileObservers();
  const h = harness(t, observations);
  const cards = h.gallery.cards.slice(0, 4);
  observations.enter(1, cards); await h.settle();
  for (let index = 0; index < cards.length; index++) observations.callbacks.idle();
  assert.equal(h.viewers.length, 4);
  assert.equal(cards.filter(card => card.viewer).length, 3);
  h.gallery.filter('tech');
  const mouse = h.gallery.cards.find(card => card.product.key === 'mouse-pad');
  assert.ok(observations.intersections[1].observed.has(mouse.stage));
  h.gallery.suspend();
  observations.enter(1, [mouse]);
  await h.settle(); assert.equal(mouse.started, undefined, 'hidden editor does not start gallery work');
  await h.gallery.resume(); await h.settle(); observations.callbacks.idle();
  assert.equal(mouse.snapshot.productKey, mouse.product.key);
  assert.equal(mouse.stage.dataset.ready, 'true');
  h.gallery.destroy();
  assert.ok(observations.intersections.every(observer => observer.disconnected));
});

test('mobile scrolling pauses new artwork and cooperative layout work, and disposal releases waiting work', async t => {
  const observations = mobileObservers(), waits = [];
  const h = harness(t, { ...observations, prepare: (product, options) => {
    waits.push(options.waitForIdle);
    return snapshot(product);
  } });
  h.window.dispatchEvent(new h.window.Event('touchmove'));
  observations.enter(1, [h.gallery.cards[0]]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.prepared.length, 0, 'a fling must not start another layout');
  await new Promise(resolve => setTimeout(resolve, 160));
  await h.settle();
  assert.equal(waits.length, 1);
  h.window.dispatchEvent(new h.window.Event('scroll'));
  let resumed = false;
  const waiting = waits[0]().then(() => { resumed = true; });
  await Promise.resolve(); assert.equal(resumed, false);
  h.gallery.suspend();
  await waiting;
  assert.equal(h.gallery.preparationWaiters.size, 0, 'editor requests must not deadlock behind a shared paused layout');
  await waits[0]();
  await h.gallery.resume();
  h.window.dispatchEvent(new h.window.Event('scroll'));
  const closing = waits[0]();
  h.gallery.destroy();
  await closing;
  assert.equal(h.gallery.preparationWaiters.size, 0);
});

test('leaving the mobile preload margin releases a pending mesh after the visibility callback has already run', async t => {
  const observations = mobileObservers();
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const h = harness(t, { ...observations, viewer: viewer => { viewer.loading = true; viewer.ready = ready; } });
  const card = h.gallery.cards[0];
  observations.enter(0, [card]); observations.enter(1, [card]);
  await h.settle(); observations.callbacks.idle();
  const viewer = card.viewer;
  observations.enter(0, [card], false);
  assert.equal(viewer.destroyed, false, 'a nearby mesh may finish before it enters the screen');
  observations.enter(1, [card], false);
  assert.equal(viewer.destroyed, true);
  assert.equal(h.gallery.previewActive, null);
  assert.equal(card.viewer, null);
  finish();
});
