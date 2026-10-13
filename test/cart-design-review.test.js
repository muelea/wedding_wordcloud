'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createCanvas, loadImage } = require('canvas');
const Review = require('../public/js/cart-design-review');
const { translate } = require('../src/i18n');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const design = (colour, overrides = {}) => ({ productKey: 'mug', orientation: 'default', theme: 'custom',
  designs: { front: [{ id: 'word', text: 'Liebe', color: colour, x: 50, y: 50, fontSize: 24 }],
    back: [{ id: 'back', text: 'Danke', color: colour, x: 50, y: 50, fontSize: 24 }] }, ...overrides });
function fixture(t, extra = {}) {
  const dom = new JSDOM('<ul id="review"></ul><dialog><h2 tabindex="-1"></h2><button data-cart-comparison-close>Close</button><div data-cart-comparison-body></div></dialog>');
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const dialog = document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  const calls = { loaded: [], rendered: [], edited: [] };
  const before = design('#ff0000');
  const review = Review.create({ document, container: document.querySelector('ul'), detailDialog: dialog,
    load: async id => { calls.loaded.push(id); return before; },
    render: async (snapshot, surface) => { calls.rendered.push({ snapshot, surface }); return 'data:image/png;base64,cHJldmlldw=='; },
    describe: snapshot => snapshot.productKey,
    surfaces: () => [{ key: 'front', label: 'Vorderseite' }, { key: 'back', label: 'Rückseite' }],
    setText: (node, source, params) => { node.textContent = translate(source, 'en', params); },
    onEdit: id => calls.edited.push(id), ...extra });
  t.after(() => review.dispose());
  return { document, dialog, calls, review, before };
}

test('cart comparison renders both exact versions and print sides without replacing the working design', async t => {
  const h = fixture(t), current = design('#0000ff', { editingOrderItemId: 'a' });
  const unchanged = JSON.stringify(current);
  h.review.show({ items: [{ id: 'a' }], drafts: [current], currentId: 'a' });
  await settle();
  assert.deepEqual(h.calls.loaded, ['a']);
  assert.equal(h.document.querySelectorAll('.cart-review-item-heading button').length, 0, 'the active design has no redundant edit link');
  assert.equal(h.document.querySelectorAll('.cart-review-artwork img').length, 2);
  assert.equal(h.calls.rendered[0].snapshot, h.before);
  assert.equal(h.calls.rendered[1].snapshot, current);
  assert.match(h.document.querySelector('.cart-review-effect').textContent, /No extra item/);
  const back = h.document.querySelectorAll('.cart-review-surfaces button')[1];
  back.click(); await settle();
  assert.equal(back.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.calls.rendered.slice(2).map(call => call.surface.key), ['back', 'back']);
  h.document.querySelector('.cart-review-enlarge').click(); await settle();
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.querySelectorAll('.cart-review-artwork img').length, 2);
  assert.equal(h.dialog.querySelectorAll('.cart-review-surfaces button')[1].getAttribute('aria-pressed'), 'true', 'enlargement keeps the print side being compared');
  h.dialog.querySelector('[data-cart-comparison-close]').click();
  assert.equal(h.dialog.open, false);
  assert.equal(JSON.stringify(current), unchanged);
});

test('mixed reviews identify replacements and additions and open only the requested parked design', async t => {
  const h = fixture(t);
  h.review.show({ items: [{ id: 'a' }, { id: 'b' }], drafts: [design('#222222', { editingOrderItemId: 'a' })],
    currentId: 'b', addition: design('#333333', { productKey: 'poster' }) });
  await settle();
  const rows = h.document.querySelectorAll('li');
  assert.equal(rows.length, 2);
  assert.match(rows[1].querySelector('.cart-review-effect').textContent, /Adds an extra item/);
  assert.equal(rows[1].querySelectorAll('figure').length, 1);
  rows[0].querySelector('.cart-review-item-heading button').click();
  assert.deepEqual(h.calls.edited, ['a']);
});

test('a failed comparison can be retried and closing a review cancels stale reads', async t => {
  let tries = 0, release, signal;
  const h = fixture(t, { load: async (id, requestSignal) => {
    signal = requestSignal;
    if (++tries === 1) throw new Error('offline');
    return new Promise(resolve => { release = resolve; });
  } });
  h.review.show({ items: [{ id: 'a' }], drafts: [design('#111111', { editingOrderItemId: 'a' })], currentId: 'a' });
  await settle();
  assert.match(h.document.querySelector('ul').textContent, /Comparison could not be loaded/);
  h.document.querySelector('.cart-review-link').click(); await settle();
  h.review.dispose();
  assert.equal(signal.aborted, true);
  release(design('#222222')); await settle();
  assert.equal(h.document.querySelector('ul').children.length, 0);
  assert.equal(h.calls.rendered.length, 0);
});

test('change summaries distinguish recolouring from geometry and ignore generated element IDs', () => {
  const before = design('#ff0000'), after = design('#ff0000');
  after.designs.front[0].id = 'new';
  after.designs.front[0].colorLocked = true;
  assert.deepEqual(Review.changes(before, after), []);
  assert.deepEqual(Review.changes(before, design('#0000ff')), ['Farben geändert']);
  after.designs.front[0].x = 75;
  assert.deepEqual(Review.changes(before, after), ['Design geändert']);
  assert.deepEqual(Review.changes(before, { ...before, productKey: 'poster', orientation: 'landscape' }), ['Produkt geändert', 'Ausrichtung geändert']);
});

test('preview failures can be retried and a newly added print side is explicit', async t => {
  let attempts = 0;
  const h = fixture(t, {
    load: async () => design('#ff0000', { productKey: 'one-sided' }),
    surfaces: snapshot => snapshot.productKey === 'one-sided' ? [{ key: 'front', label: 'Vorderseite' }]
      : [{ key: 'front', label: 'Vorderseite' }, { key: 'back', label: 'Rückseite' }],
    render: async () => { if (++attempts === 1) throw new Error('image unavailable'); return 'data:image/png;base64,cHJldmlldw=='; },
  });
  h.review.show({ items: [{ id: 'a' }], drafts: [design('#222222', { editingOrderItemId: 'a' })], currentId: 'a' });
  await settle();
  assert.match(h.document.querySelector('[data-version="before"]').textContent, /Preview could not be loaded/);
  h.document.querySelector('[data-version="before"] button').click();await settle();
  assert.equal(h.document.querySelectorAll('.cart-review-artwork img').length, 2);
  h.document.querySelectorAll('.cart-review-surfaces button')[1].click();await settle();
  assert.match(h.document.querySelector('[data-version="before"]').textContent, /No print side/);
  assert.ok(h.document.querySelector('[data-version="after"] img'));
});

test('comparison rendering uses snapshot pixels, preserves print proportions and bounds the bitmap', async () => {
  const canvases = [];
  const document = { fonts: {}, createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = createCanvas(1, 1); canvases.push(canvas); return canvas;
  } };
  const runtime = { DesignFonts: { normalizeKey: key => key, loadFont: async () => {} },
    WolkenworteEmoji: { preloadTexts: async () => {}, getLoadedImage: () => null },
    ArtworkOverlap: { drawItem(ctx, item, assets, scale) {
      ctx.fillStyle = item.color; ctx.fillRect(item.x * scale, item.y * scale, 100 * scale, 100 * scale);
    } } };
  for (const colour of ['#ff0000', '#0000ff']) {
    const src = await Review.renderArtwork({ document, runtime, snapshot: design(colour), surface: { key: 'front' },
      view: { printFile: { width: 2400, height: 1200 } }, signal: new AbortController().signal });
    const image = await loadImage(src);
    assert.equal(image.width, 1200); assert.equal(image.height, 600);
    const pixel = [...canvases.at(-1).getContext('2d').getImageData(40, 40, 1, 1).data];
    assert.deepEqual(pixel, colour === '#ff0000' ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  }
});
