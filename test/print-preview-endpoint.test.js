'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('canvas');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');
const { renderProviderPng } = require('../src/printRaster');
const { getProduct } = require('../src/products');

test('cart PNG previews match production rendering, stay event-scoped and create no fulfillment artifacts', async t => {
  const { baseUrl, query, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl);
  const other = await createEvent(baseUrl);
  const productKey = 'spiral-notebook-dotted';
  const product = getProduct(productKey);
  assert.ok(product);
  const payload = productDesignPayload(productKey);
  const photo = createCanvas(32, 24);
  photo.getContext('2d').fillStyle = '#ef231a';
  photo.getContext('2d').fillRect(0, 0, 32, 24);
  payload.designs.front.push({ id: 'photo', type: 'image', src: photo.toDataURL(),
    x: 900, y: 1600, width: 160, height: 120, angle: 17 });
  payload.designs.front[0].text = 'Love ❤️';
  payload.designs.front[0].fontWeight = 700;
  payload.designs.back[0].text = 'LOVE';
  const saved = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productKey, theme: 'pastel', words: [['Love', 1]], ...payload }),
  });
  assert.equal(saved.status, 201, await saved.clone().text());
  const { id } = await saved.json();
  const api = `${baseUrl}/api/events/${event.slug}/configurations/${id}`;
  const summary = await fetch(api).then(response => response.json());
  const restored = await fetch(`${api}/edit`).then(response => response.json());
  const storage = require('../src/privateStorage');
  const upload = t.mock.method(storage, 'upload', async () => { throw new Error('preview must not upload'); });
  const previews = require('../src/printArtifacts');
  const originalRender = previews.renderPreviewSurface;
  const render = t.mock.method(previews, 'renderPreviewSurface', originalRender);

  for (const surface of product.printSurfaces) {
    assert.match(summary.printPreviewUrls[surface.key], /\/print\.png\?surface=/);
    const response = await fetch(baseUrl + summary.printPreviewUrls[surface.key]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(png, await renderProviderPng(product, restored.designs[surface.key]),
      'preview pixels and dimensions use the actual provider renderer');
  }
  assert.equal(render.mock.callCount(), 2);
  assert.equal(upload.mock.callCount(), 0);
  for (const table of ['print_artifacts', 'orders']) {
    assert.equal((await query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }

  assert.equal((await fetch(`${baseUrl}/api/events/${other.slug}/configurations/${id}/print.png`)).status, 404);
  assert.equal((await fetch(`${api}/print.png?surface=unknown`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/events/${event.slug}/configurations/${'x'.repeat(16)}/print.png`)).status, 404);
  assert.equal(render.mock.callCount(), 2, 'invalid capabilities never render');

  render.mock.mockImplementation(async () => { throw Object.assign(new Error('busy'), { code: 'PRINT_RENDER_BUSY' }); });
  const busy = await fetch(`${api}/print.png`);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '2');
  assert.deepEqual(await busy.json(), { error: 'print_preview_busy' });
  const limits = require('../src/rateLimits');
  const limiter = t.mock.method(limits, 'consume', () => false);
  assert.equal((await fetch(`${api}/print.png`)).status, 429);
  assert.equal(render.mock.callCount(), 3, 'rate limiting runs before rendering');
  limiter.mock.restore();
  render.mock.restore();
  await query('UPDATE events SET created_at = now() - interval \'366 days\' WHERE slug = $1', [event.slug]);
  assert.equal((await fetch(`${api}/print.png`)).status, 404);
});
