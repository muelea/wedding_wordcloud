'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

test('ambiguous uploads and interrupted activation reuse one file without rendering or uploading again', async t => {
  const { baseUrl, close, query } = await startTestServer();
  t.after(close);
  const db = require('../src/db');
  const preparation = require('../src/printPreparation');
  const { getProduct, resolveProductOrientation } = require('../src/products');
  const event = await createEvent(baseUrl);
  const product = resolveProductOrientation(getProduct('cork-back-coaster'), 'default');
  const design = { version: 2, surfaces: productDesignPayload(product.key).designs };
  const configuration = await db.createConfiguration({ eventId: (await db.getEventBySlug(event.slug)).id,
    productKey: product.key, printfulVariantId: product.printful.variantId, quantity: 1, unitPriceCents: 0,
    theme: 'pastel', words: [['liebe',1]], design, printWidth: product.printFile.width, printHeight: product.printFile.height });
  let renders = 0, uploads = 0;
  const objects = new Map();
  const options = { renderPng: async () => { renders++; return Buffer.from('exact frozen PNG bytes'); }, storageClient: {
    async upload(key, bytes) { uploads++; objects.set(key, bytes); throw new Error('successful response lost'); },
    async download(key) { if (!objects.has(key)) throw new Error('missing'); return objects.get(key); },
  } };
  const first = (await preparation.prepare(configuration, product, design, options))[0];
  assert.equal(first.status,'active'); assert.equal(renders,1); assert.equal(uploads,1);
  assert.equal((await preparation.prepare(configuration,product,design,options))[0].id,first.id);
  await query("UPDATE prepared_print_files SET status='uploading',lease_until=NULL WHERE id=$1",[first.id]);
  const resumed = (await preparation.prepare(configuration,product,design,options))[0];
  assert.equal(resumed.id,first.id); assert.equal(resumed.sha256,first.sha256);
  assert.equal(renders,1); assert.equal(uploads,1); assert.equal(objects.size,1);
  await assert.rejects(preparation.prepare(configuration,product,{...design,surfaces:{}},options),{code:'PRINT_SPEC_CHANGED'});
  assert.equal(renders,1,'a changed specification cannot silently replace the frozen source');
});
