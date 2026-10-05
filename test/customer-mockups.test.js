'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

test('customer mockup endpoints use saved event designs without database artifacts or operator access', async t => {
  const { baseUrl, query, close } = await startTestServer();
  t.after(close);
  const mockups = require('../src/printfulMockups');
  const printful = require('../src/printful');
  const product = require('../src/products').getProduct('cork-back-coaster');
  const event = await createEvent(baseUrl);
  const other = await createEvent(baseUrl);
  async function save() {
    const response = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productKey: product.key, theme: 'pastel', words: [['liebe', 1]],
        ...productDesignPayload(product.key) }),
    });
    assert.equal(response.status, 201);
    return response.json();
  }
  const first = await save();
  const second = await save();
  const uploaded = [];
  const removed = [];
  let providerCreates = 0;
  const service = mockups.createService({ customer: true,
    renderPng: async (storedProduct, design) => {
      assert.equal(storedProduct.key, product.key);
      assert.equal(design[0].text, 'liebe');
      return Buffer.from('mock production bytes');
    },
    storageClient: { async upload(key) { uploaded.push(key); }, async remove(key) { removed.push(key); },
      async createSignedUrl() { return 'https://storage.example.test/source'; } },
    printfulClient: {
      async getCatalogProductMockupStyles() {
        return [{ placement: 'default', technique: product.printful.technique,
          mockup_styles: [{ id: 1 }] }];
      },
      async createMockupTasks(payload) {
        providerCreates++;
        assert.equal(payload.mockup_width_px, 1000);
        assert.deepEqual(payload.products[0].catalog_variant_ids, [product.printful.variantId]);
        return [{ id: 1, status: 'pending' }];
      },
      async getMockupTasks() { return [{ status: 'completed', catalog_variant_mockups: [{
        catalog_variant_id: product.printful.variantId,
        mockups: [{ mockup_url: 'https://printful-upload.s3-accelerate.amazonaws.com/tmp/preview.png' }],
      }] }]; },
    },
  });
  t.after(() => service.stop());
  t.mock.method(mockups, 'createCustomerMockup', (...args) => service.createForConfiguration(...args));
  t.mock.method(mockups, 'getCustomerMockup', (...args) => service.getJob(...args));
  const configured = t.mock.method(printful, 'isConfigured', () => true);
  const headers = { 'Content-Type': 'application/json', 'X-Wolkenworte-Preview': 'product-mockup' };
  const url = baseUrl + first.mockupUrl;
  assert.equal((await fetch(url, { method: 'POST' })).status, 400);
  const created = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ productKey: 'untrusted', url: 'https://attacker.test/file' }) });
  assert.equal(created.status, 202, await created.clone().text());
  assert.equal(created.headers.get('cache-control'), 'private, no-store');
  const job = await created.json();
  assert.equal((await fetch(baseUrl + second.mockupUrl + '/' + job.jobId)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/events/${other.slug}/configurations/${first.id}/mockups/${job.jobId}`)).status, 404);
  const result = await fetch(`${url}/${job.jobId}`).then(response => response.json());
  assert.equal(result.status, 'completed');
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'jobId', 'mockups', 'status']);
  assert.deepEqual(result.mockups, [{ url: 'https://printful-upload.s3-accelerate.amazonaws.com/tmp/preview.png' }]);
  assert.deepEqual(removed, uploaded);
  await fetch(url, { method: 'POST', headers });
  assert.equal(providerCreates, 1, 'a repeated request reuses the saved design job');
  assert.equal((await query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM print_artifacts')).rows[0].n, 0);
  assert.equal((await fetch(`${baseUrl}/api/operator/printful-mockups/${job.jobId}`)).status, 404);
  configured.mock.mockImplementation(() => false);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 501);
  configured.mock.mockImplementation(() => true);
  t.mock.method(mockups, 'createCustomerMockup', async () => {
    throw new mockups.PrintfulMockupError('mockup_rate_limited', 'private provider message', 429, { retryAfter: 40 });
  });
  const busy = await fetch(url, { method: 'POST', headers });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '40');
  assert.deepEqual(await busy.json(), { error: 'mockup_rate_limited', retryAfter: 40 });
  await query('UPDATE events SET created_at = now() - interval \'366 days\' WHERE slug = $1', [event.slug]);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${url}/${job.jobId}`)).status, 404);
});
