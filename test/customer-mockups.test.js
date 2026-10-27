'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

test('cart status uses one event-bound snapshot when a job completes during polling', async t => {
  const db = require('../src/db');
  const mockups = require('../src/printfulMockups');
  const {makeRouter} = require('../src/routes/events');
  const jobId='j'.repeat(24),configurationId='c'.repeat(16),now=Date.now();
  const pending={id:jobId,scope:'a'.repeat(64),mode:'customer',eventId:1,configurationId,
    configurationIds:[configurationId],status:'pending',expiresAt:now+60000,nextAt:now,
    sourceObjectKeys:[],items:[{configurationId,mockups:[]}],mockups:[]};
  const completed={...pending,status:'completed',items:[{configurationId,
    mockups:[{url:'https://printful.com/example.png',surfaceKey:'default'}]}]};
  let reads=0;
  t.mock.method(db,'getEventBySlug',async()=>({id:1}));
  t.mock.method(db,'getMockupJob',async()=>structuredClone(++reads===1?pending:completed));
  const service=mockups.createService({scope:'a'.repeat(64),autoStart:false});
  t.mock.method(mockups,'getJob',(...args)=>service.getJob(...args));
  const handler=makeRouter({io:{},port:0}).stack.find(layer=>
    layer.route?.path==='/events/:slug/cart/mockups'&&layer.route.methods.get).route.stack[0].handle;
  const request={params:{slug:'A'.repeat(22)},query:{jobs:jobId},headers:{},socket:{remoteAddress:'127.0.0.1'}};
  const poll=()=>new Promise((resolve,reject)=>handler(request,{
    set(){return this;},status(){return this;},json:resolve,
  },reject));
  const first=await poll();
  assert.equal(reads,1);assert.equal(first.jobs[0].status,'pending');
  const second=await poll();
  assert.equal(reads,2);assert.equal(second.jobs[0].status,'completed');
  assert.equal(second.jobs[0].items[0].mockups.length,1);
  await assert.rejects(service.getJob(jobId,{event_id:2}),error=>error.status===404);
});

test('customer mockup endpoints use saved event designs with durable tracking but without paid artifacts or operator access', async t => {
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
      async getMockupTasks() { return [{ id: 1, status: 'completed', catalog_variant_mockups: [{
        catalog_variant_id: product.printful.variantId,
        mockups: [{ placement: 'default', mockup_url: 'https://printful-upload.s3-accelerate.amazonaws.com/tmp/preview.png' }],
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
  await service.runDue({ maxJobs: 2 });
  const result = await fetch(`${url}/${job.jobId}`).then(response => response.json());
  assert.equal(result.status, 'completed');
  assert.deepEqual(Object.keys(result).sort(), ['attempt', 'errorCode', 'expiresAt', 'jobId', 'mockups', 'nextAttemptAt', 'retryAfter', 'status']);
  assert.deepEqual(result.mockups, [{ url: 'https://printful-upload.s3-accelerate.amazonaws.com/tmp/preview.png' }]);
  assert.equal(removed.length, 0, 'the same private PNG is retained for production');
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
  await query('UPDATE events SET updated_at = now() - interval \'4 months\' WHERE slug = $1', [event.slug]);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${url}/${job.jobId}`)).status, 404);
});
