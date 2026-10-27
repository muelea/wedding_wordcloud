'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload, stripeTaxPaymentSession } = require('./helpers');
const { createCanvas, loadImage } = require('canvas');
const { richArtwork } = require('./support/print-content-fixture');



test('basket previews, explicit approval, signed payment and production reuse the exact same stored PNGs', async t => {
  process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET = 'whsec_approval_fixture';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_approval_fixture';
  const { baseUrl, close, query } = await startTestServer();
  t.after(close);
  const db = require('../src/db');
  const printful = require('../src/printful');
  const storage = require('../src/privateStorage');
  const mockups = require('../src/printfulMockups');
  const stripe = require('../src/stripe');
  const printArtifacts = require('../src/printArtifacts');
  const { PRODUCTS } = require('../src/products');
  const event = await createEvent(baseUrl);
  const other = await createEvent(baseUrl);
  const api = `${baseUrl}/api/events/${event.slug}`;
  const objects = new Map();
  let renders = 0, uploads = 0, creations = 0, time = Date.now(), throttle = true;
  const tasks = new Map(), submissions = [];
  const adapter = {
    async upload(key, bytes) { uploads++; if (objects.has(key)) throw new Error('exists'); objects.set(key, Buffer.from(bytes)); },
    async download(key) { if (!objects.has(key)) throw new Error('missing'); return objects.get(key); },
    async remove(key) { objects.delete(key); },
    async createSignedUrl(key) { return `https://storage.example.test/${key}`; },
  };
  storage.setAdapterForTests(adapter);
  t.after(() => storage.resetAdapterForTests());
  const service = mockups.createService({ autoStart: false, now: () => time, storageClient: adapter,
    renderPng: async (...args) => { renders++; return printArtifacts.renderPreviewSurface(...args); },
    printfulClient: {
      async getCatalogProductMockupStyles(id, placements) {
        const product = PRODUCTS.find(product => product.printful.productId === id);
        return placements.map((placement, index) => ({ placement, technique: product.printful.technique,
          print_area_type: 'simple', mockup_styles: [{ id: index + 1 }] }));
      },
      async createMockupTasks(payload) {
        submissions.push(payload);
        if (throttle) { throttle = false; throw Object.assign(new Error('busy'), { providerStatus: 429, retryAfter: 40 }); }
        assert.equal(new Set(payload.products.flatMap(product => product.catalog_variant_ids)).size, payload.products.length);
        return payload.products.map(product => {
          const id = tasks.size + 1;
          tasks.set(id, { id, status: 'completed', catalog_variant_mockups: [{
            catalog_variant_id: product.catalog_variant_ids[0], mockups: product.placements.map(placement => ({
              placement: placement.placement, mockup_url: `https://printful-upload.s3-accelerate.amazonaws.com/tmp/${id}-${placement.placement}.png`,
            })),
          }] });
          return { id, status: 'pending' };
        });
      },
      async getMockupTasks(ids) { return ids.map(id => tasks.get(id)).reverse(); },
    },
  });
  mockups.setAdapterForTests(service);
  t.after(() => { mockups.resetAdapterForTests(); return service.stop(); });
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  t.mock.method(printful, 'getShippingCountries', async () => [{ code: 'DE', name: 'Germany', states: [] }]);
  t.mock.method(printful, 'estimateOrderCosts', async () => ({ currency: 'EUR', subtotal: 20, shipping: 5, vat: 4.75, tax: 0, total: 29.75 }));
  t.mock.method(stripe, 'createCheckoutSession', async ({ order, persistCustomer }) => {
    creations++;
    await persistCustomer('cus_approval');
    return { id: 'cs_test_approval', url: 'https://checkout.stripe.test/approval', taxCents: 0,
      shippingTaxCents: 0, totalCents: Number(order.items_cents) + Number(order.shipping_cents),
      expiresAt: new Date(Date.now() + 1800000).toISOString() };
  });
  const post = async (url, body, headers = {}) => {
    const response = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Wolkenworte-Guest-Id': 'a'.repeat(32), ...headers,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const configurations = [];
  for (const [index, productKey] of ['white-glossy-mug-duo-11oz','white-glossy-mug-duo-11oz','cork-back-coaster','all-over-basic-pillow-18in','cork-back-coaster'].entries()) {
    const design = productDesignPayload(productKey);
    for (const surface of Object.values(design.designs)) surface[0].text = index === 1 ? 'glück' : 'liebe';
    if (index === 0) design.designs.default = richArtwork();
    if (index === 3) {
      for (const [surfaceKey, color] of [['front', '#ff0000'], ['back', '#00ff00']]) {
        const image = createCanvas(32, 24);
        image.getContext('2d').fillStyle = color;
        image.getContext('2d').fillRect(0, 0, 32, 24);
        design.designs[surfaceKey].push({ id: `side-${surfaceKey}`, type: 'image', src: image.toDataURL(),
          x: 1425, y: 1700, width: 160, height: 120, angle: 27 });
      }
    }
    const saved = await post(`${api}/configurations`, { productKey, quantity: 1, theme: 'pastel', words: [['liebe', 1]], ...design });
    assert.equal(saved.status, 201, JSON.stringify(saved.body)); configurations.push(saved.body);
  }
  const configurationIds = configurations.map(item => item.id);
  const shipments = [{ recipient: { name: 'Preview Test', address1: 'Testweg 5', city: 'Berlin', zip: '10115', country_code: 'DE' },
    items: configurationIds.map((configurationId,index) => ({ configurationId, quantity: index === 4 ? 0 : 1 })) }];
  const quoted = await post(`${api}/cart/estimate-costs`, { configurationIds, shipments });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  const checkout = { configurationIds, quoteId: quoted.body.quote.id };
  const prepared = await post(`${api}/cart/checkout`, { ...checkout, intent: 'prepare' });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.quote.checkoutPrepared, true);
  assert.equal(prepared.body.url, undefined);
  const blocked = await post(`${api}/cart/checkout`, { ...checkout, intent: 'pay' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'mockup_approval_required');

  const requested = await post(`${api}/cart/mockups`, { configurationIds: configurationIds.slice(0,4), requestId: 'r'.repeat(24) }, { 'X-Wolkenworte-Preview': 'product-mockup' });
  assert.equal(requested.status, 202, JSON.stringify(requested.body));
  assert.equal(requested.body.jobs.length, 2, 'same-variant different artwork is safely dispatched separately');
  const jobs = requested.body.jobs.map(job => job.jobId);
  const approval = { accepted: true, version: 1, jobIds: jobs };
  assert.equal((await post(`${api}/cart/checkout`, { ...checkout, mockupApproval: approval })).status, 409, 'queued work cannot be approved');
  for (let index = 0; index < 5; index++) { await service.runDue({ maxJobs: 12 }); time += 61000; }
  const results = await fetch(`${api}/cart/mockups?jobs=${jobs.join(',')}`).then(response => response.json());
  assert.ok(results.jobs.every(job => job.status === 'completed'), JSON.stringify(results));
  assert.equal(results.jobs.flatMap(job => job.items).length, 4);
  assert.equal(results.jobs.flatMap(job => job.items).find(item => item.configurationId === configurations[3].id).mockups.length, 2);
  assert.equal(renders, 5, 'one render per print surface, including a throttled retry');
  assert.equal(uploads, 5);
  assert.equal(objects.size, 5);
  assert.equal(submissions.filter(payload => payload.products.length === 3).length, 2, 'the mixed batch retries automatically');
  assert.equal((await fetch(`${baseUrl}/api/events/${other.slug}/cart/mockups?jobs=${jobs.join(',')}`)).status, 404);
  assert.equal((await post(`${api}/cart/checkout`, { ...checkout, mockupApproval: { ...approval, jobIds: [jobs[0]] } })).status, 409);
  assert.equal((await post(`${api}/cart/checkout`, { ...checkout, mockupApproval: { ...approval, accepted: false } })).status, 409);
  const paidLink = await post(`${api}/cart/checkout`, { ...checkout, intent: 'pay', mockupApproval: approval });
  assert.equal(paidLink.status, 200, JSON.stringify(paidLink.body));
  assert.equal(paidLink.body.url, 'https://checkout.stripe.test/approval');
  assert.equal((await post(`${api}/cart/checkout`, { ...checkout, mockupApproval: approval })).status, 200, 'return from a cancelled payment reuses the same session');
  assert.equal(creations, 1);
  let order = await db.getOrderByQuoteId(checkout.quoteId);
  assert.deepEqual(order.mockup_approval_json.configurationIds, configurationIds.slice(0,4).sort());
  assert.equal(order.mockup_approval_json.fileIds.length, 5);

  // A new immutable design ID cannot inherit another design's approval, even
  // when the application already prepared a reusable payment Session for it.
  const replacement = await post(`${api}/configurations`, { productKey: 'cork-back-coaster', quantity: 1,
    theme: 'pastel', words: [['neu',1]], ...productDesignPayload('cork-back-coaster') });
  assert.equal(replacement.status,201);
  const changedIds = [replacement.body.id, ...configurationIds.slice(1)];
  const changedShipments = structuredClone(shipments);
  changedShipments[0].items[0].configurationId = replacement.body.id;
  const changedQuoteResponse = await post(`${api}/cart/estimate-costs`, {configurationIds:changedIds,shipments:changedShipments});
  const changedQuote = await db.getEventCartCheckoutQuote(event.slug, changedIds, changedQuoteResponse.body.quote.id);
  const changedOrder = (await db.createCheckoutOrder({eventId:order.event_id,configurationId:changedIds[0],quote:changedQuote})).order;
  await db.attachStripeSession(changedOrder.id,{id:'cs_test_changed_approval',url:'https://checkout.stripe.test/changed'});
  const stale = await post(`${api}/cart/checkout`, {configurationIds:changedIds,quoteId:changedQuote.id,mockupApproval:approval});
  assert.equal(stale.status,409); assert.equal(stale.body.error,'mockup_approval_required');
  const singleQuoteResponse = await post(`${api}/configurations/${replacement.body.id}/estimate-costs`, {recipient:shipments[0].recipient});
  const singleQuote = await db.getEventCheckoutQuote(event.slug,replacement.body.id,singleQuoteResponse.body.quote.id);
  const singleOrder = (await db.createCheckoutOrder({eventId:order.event_id,configurationId:replacement.body.id,quote:singleQuote})).order;
  await db.attachStripeSession(singleOrder.id,{id:'cs_test_single_approval',url:'https://checkout.stripe.test/single'});
  for(const body of [{quoteId:singleQuote.id},{quoteId:singleQuote.id,mockupApproval:approval}]) {
    const denied = await post(`${api}/configurations/${replacement.body.id}/checkout`, body);
    assert.equal(denied.status,409); assert.equal(denied.body.error,'mockup_approval_required');
  }

  const session = stripeTaxPaymentSession({ order, sessionId: order.stripe_session_id, customerId: 'cus_approval', taxCents: 0 }).checkoutSession;
  const payload = JSON.stringify({ id: 'evt_approval_paid', type: 'checkout.session.completed', livemode: false,
    data: { object: { ...session, payment_intent: 'pi_approval', metadata: { orderId: String(order.id), quoteId: order.quote_id, configurationId: order.configuration_id,
      configurationIds: JSON.parse(order.configuration_ids_json).join(','), eventSlug: event.slug, checkoutMode: 'test' } } } });
  const signer = new (require('stripe'))('sk_test_approval_fixture');
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET });
  const paid = await fetch(`${baseUrl}/webhook/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
  assert.equal(paid.status, 200, await paid.text());
  order = await db.getOrderById(order.id);
  assert.ok(order.paid_at);
  const orderItems = await db.getOrderItems(order.id);
  const artifacts = await printArtifacts.ensureOrderArtifacts(order, orderItems);
  await printArtifacts.ensureOrderArtifacts(order, orderItems);
  assert.equal(renders, 5, 'production never renders the approved design again');
  assert.equal(uploads, 5, 'production never copies or uploads the PNG again');
  const production = require('../src/fulfillment').buildPrintfulPayload({ order, orderItems, artifacts, mode: 'draft', shipment: (await db.getOrderShipments(order.id))[0] });
  const sourceKeys = new Set(submissions.flatMap(payload => payload.products.flatMap(product => product.placements.map(placement => new URL(placement.layers[0].url).pathname.slice(1)))));
  for (const artifact of artifacts) {
    assert.ok(sourceKeys.has(artifact.object_key));
    const response = await fetch(`${baseUrl}/api/print-files/${artifact.id}/${artifact.access_nonce}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, objects.get(artifact.object_key));
    const item = orderItems.find(item => String(item.id) === String(artifact.order_item_id));
    const snapshot = JSON.parse(item.configuration_snapshot_json);
    const image = await loadImage(bytes);
    assert.equal(image.width, snapshot.printWidth);
    assert.equal(image.height, snapshot.printHeight);
    const pixels = createCanvas(image.width, image.height).getContext('2d');
    pixels.drawImage(image, 0, 0);
    if (item.configuration_id === configurations[0].id) {
      const frozen = snapshot.design.surfaces.default;
      assert.equal(frozen.filter(item => item.id.startsWith('audit-') && item.type === 'text').length, 81);
      for (const word of frozen.filter(item => item.id.startsWith('audit-') && item.id !== 'audit-flags' && item.type === 'text')) {
        const cell = pixels.getImageData(word.x - 72, word.y - 40, 144, 80).data;
        let painted = 0;
        for (let offset = 3; offset < cell.length; offset += 4) if (cell[offset]) painted++;
        assert.ok(painted > 100, `${word.id}: approved text/emoji cell disappeared`);
      }
      for (const [x, expected] of [[800, [255, 0, 0]], [1200, [0, 255, 0]]]) {
        const actual = pixels.getImageData(x, 810, 1, 1).data;
        assert.equal(actual[3], 255);
        expected.forEach((channel, index) => assert.ok(Math.abs(actual[index] - channel) <= 2));
      }
    }
    if (item.configuration_id === configurations[3].id) {
      const actual = pixels.getImageData(1425, 1700, 1, 1).data;
      assert.equal(actual[artifact.surface_key === 'front' ? 0 : 1], 255,
        'front and back keep their own uploaded artwork through payment and fulfillment');
    }
  }
  assert.ok(production.items.every(item => item.files.every(file => file.url.includes('/api/print-files/'))));
  assert.equal((await query('SELECT count(*)::int AS n FROM prepared_print_files')).rows[0].n, 5);
  const singlePreview = await post(`${api}/cart/mockups`, {configurationIds:[replacement.body.id]}, {'X-Wolkenworte-Preview':'product-mockup'});
  assert.equal(singlePreview.status,202);
  const singleJobs = singlePreview.body.jobs.map(job=>job.jobId);
  await service.runDue({maxJobs:6});
  const singleApproved = await post(`${api}/configurations/${replacement.body.id}/checkout`, {
    quoteId:singleQuote.id,mockupApproval:{accepted:true,version:1,jobIds:singleJobs},
  }, {'X-Wolkenworte-Guest-Id':'b'.repeat(32)}); // Negative cases exhausted the first browser's checkout budget.
  assert.equal(singleApproved.status,200,JSON.stringify(singleApproved.body));
  assert.equal(singleApproved.body.url,'https://checkout.stripe.test/single');
});
