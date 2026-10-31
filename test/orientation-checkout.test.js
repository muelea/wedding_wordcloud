'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload, stripeTaxPaymentSession } = require('./helpers');

test('opposite orientations of one blanket variant retain distinct approvals, frozen files, checkout labels and paid reorder snapshots', async t => {
  const app = await startTestServer(); t.after(app.close);
  const db = require('../src/db'), printful = require('../src/printful'), stripe = require('../src/stripe');
  const mockups = require('../src/printfulMockups'), artifacts = require('../src/printArtifacts');
  const storage = require('../src/privateStorage'), { getProduct, resolveProductOrientation } = require('../src/products');
  const base = getProduct('throw-blanket-30x40in');
  const event = await createEvent(app.baseUrl), api = `${app.baseUrl}/api/events/${event.slug}`;
  const objects = new Map(), tasks = new Map(), submissions = [];
  let now = Date.now(), renders = 0;
  const adapter = {
    async upload(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async download(key) { return objects.get(key); },
    async remove(key) { objects.delete(key); },
    async createSignedUrl(key) { return `https://storage.example.test/${key}`; },
  };
  storage.setAdapterForTests(adapter); t.after(() => storage.resetAdapterForTests());
  const service = mockups.createService({ autoStart: false, now: () => now, storageClient: adapter,
    renderPng: async product => {
      renders++;
      return Buffer.from(`immutable-${product.orientation}-${product.printFile.width}x${product.printFile.height}`);
    },
    printfulClient: {
      async getCatalogProductMockupStyles() {
        return ['portrait', 'landscape'].map((orientation, index) => {
          const product = resolveProductOrientation(base, orientation);
          return { placement: 'default', technique: 'sublimation', print_area_type: 'simple',
            print_area_width: product.printFile.width / 150, print_area_height: product.printFile.height / 150,
            mockup_styles: [{ id: index + 100, category_name: 'Flat', restricted_to_variants: [base.printful.variantId] }] };
        });
      },
      async createMockupTasks(payload) {
        submissions.push(payload);
        assert.equal(payload.products.length, 1, 'the same variant must not be ambiguously batched');
        const product = payload.products[0], id = tasks.size + 1;
        tasks.set(id, { id, status: 'completed', catalog_variant_mockups: [{ catalog_variant_id: base.printful.variantId,
          mockups: [{ placement: 'default', style_id: product.mockup_style_ids[0],
            mockup_url: `https://printful-upload.s3-accelerate.amazonaws.com/tmp/orientation-${id}.png` }] }] });
        return [{ id, status: 'pending' }];
      },
      async getMockupTasks(ids) { return ids.map(id => tasks.get(id)); },
    },
  });
  mockups.setAdapterForTests(service); t.after(async () => { mockups.resetAdapterForTests(); await service.stop(); });
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  t.mock.method(printful, 'getShippingCountries', async () => [{ code: 'DE', name: 'Germany', states: [] }]);
  t.mock.method(printful, 'estimateOrderCosts', async () => ({ currency: 'EUR', subtotal: 20, shipping: 5, vat: 4.75, tax: 0, total: 29.75 }));
  t.mock.method(stripe, 'createCheckoutSession', async ({ order, persistCustomer }) => {
    await persistCustomer('cus_orientations');
    return { id: 'cs_test_orientations', url: 'https://checkout.stripe.test/orientations', taxCents: 0, shippingTaxCents: 0,
      totalCents: Number(order.items_cents) + Number(order.shipping_cents), expiresAt: new Date(Date.now() + 1800000).toISOString() };
  });
  const post = async (path, body) => {
    const response = await fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Wolkenworte-Guest-Id': 'a'.repeat(32), 'X-Wolkenworte-Preview': 'product-mockup' }, body: JSON.stringify(body) });
    const result = await response.json(); return { status: response.status, body: result };
  };
  const configurations = [];
  for (const orientation of ['portrait', 'landscape']) {
    const saved = await post('/configurations', { productKey: base.key, orientation, theme: 'pastel', words: [['Liebe', 1]],
      ...productDesignPayload(base.key, orientation) });
    assert.equal(saved.status, 201, JSON.stringify(saved.body)); configurations.push(saved.body);
  }
  const configurationIds = configurations.map(item => item.id);
  const queued = await post('/cart/mockups', { configurationIds, requestId: 'o'.repeat(24) });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  for (let i = 0; i < 5; i++) { now += 31000; await service.runDue({ maxJobs: 10 }); }
  const jobs = (await app.query('SELECT data FROM mockup_jobs')).rows.map(row => row.data);
  assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.status === 'completed'));
  assert.deepEqual(submissions.map(payload => payload.products[0].orientation).sort(), ['horizontal', 'vertical']);
  assert.deepEqual(submissions.map(payload => payload.products[0].mockup_style_ids[0]).sort(), [100, 101]);
  const prepared = (await app.query('SELECT * FROM prepared_print_files')).rows;
  assert.equal(prepared.length, 2); assert.equal(new Set(prepared.map(file => file.spec_hash)).size, 2);
  const quoted = await post('/cart/estimate-costs', { configurationIds, shipments: [{
    recipient: { name: 'Orientation Test', address1: 'Testweg 1', city: 'Berlin', zip: '10115', country_code: 'DE' },
    items: configurationIds.map(configurationId => ({ configurationId, quantity: 1 })),
  }] });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  const checkout = { configurationIds, quoteId: quoted.body.quote.id, intent: 'pay',
    mockupApproval: { version: 1, accepted: true, jobIds: jobs.map(job => job.id) } };
  const paidLink = await post('/cart/checkout', checkout);
  assert.equal(paidLink.status, 200, JSON.stringify(paidLink.body));
  let order = await db.getOrderByQuoteId(checkout.quoteId);
  const before = await db.getOrderItems(order.id);
  assert.deepEqual(before.map(item => JSON.parse(item.configuration_snapshot_json).orientation).sort(), ['landscape', 'portrait']);
  const frozenLabels = JSON.stringify(order.checkout_request_json);
  assert.match(frozenLabels, /Hochformat/); assert.match(frozenLabels, /Querformat/);
  await db.recordSuccessfulPayment({ stripeEventId: 'evt_orientations', eventType: 'checkout.session.completed',
    stripeSessionId: order.stripe_session_id, paymentIntentId: 'pi_orientations', livemode: false,
    buyerEmail: 'buyer@example.test', ...stripeTaxPaymentSession({ order, sessionId: order.stripe_session_id,
      customerId: 'cus_orientations', taxCents: 0 }) });
  order = await db.getOrderById(order.id);
  assert.ok(order.paid_at);
  const files = await artifacts.ensureOrderArtifacts(order, before);
  assert.equal(files.length, 2); assert.equal(renders, 2, 'payment does not render approved files again');
  for (const file of files) assert.ok(prepared.some(source => source.object_key === file.object_key && source.sha256 === file.sha256));
  const payload = require('../src/fulfillment').buildPrintfulPayload({ order, orderItems: before, artifacts: files, mode: 'live',
    shipment: (await db.getOrderShipments(order.id))[0] });
  assert.ok(payload.items.every(item => item.variant_id === base.printful.variantId));
  assert.equal(new Set(payload.items.map(item => item.files[0].url)).size, 2);
  const email = require('../src/emailTemplates').buildEmailSnapshot({ kind: 'order_confirmation', order,
    orderItems: before, shipments: [], locale: 'de' });
  assert.match(email.textBody, /Hochformat/); assert.match(email.textBody, /Querformat/);
  const reorder = await post('/orders/reorder', { sessionId: order.stripe_session_id, requestId: 'b'.repeat(32) });
  assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
  const copies = await db.getEventConfigurations(event.slug, reorder.body.configurations.map(item => item.id));
  assert.deepEqual(copies.map(item => item.orientation).sort(), ['landscape', 'portrait']);
  assert.deepEqual(await db.getOrderItems(order.id), before);
});
