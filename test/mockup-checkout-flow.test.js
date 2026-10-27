'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { startTestServer, createEvent, productDesignPayload, stripeTaxPaymentSession } = require('./helpers');
const Preview = require('../public/js/order-preview');

async function waitFor(check) {
  for (let count = 0; count < 2000; count++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The checkout preview flow did not settle');
}

test('shipping previews recover from an outage and expired approval through payment and exact production files', async t => {
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_preview_flow';
  process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET = 'whsec_preview_flow';
  const app = await startTestServer();
  t.after(app.close);
  const db = require('../src/db'), mockups = require('../src/printfulMockups');
  const printful = require('../src/printful'), stripe = require('../src/stripe');
  const artifacts = require('../src/printArtifacts'), storage = require('../src/privateStorage');
  const event = await createEvent(app.baseUrl), api = `${app.baseUrl}/api/events/${event.slug}`;
  const objects = new Map(), providerTasks = new Map();
  let renders = 0, uploads = 0, submissions = 0, sessions = 0, time = Date.now();
  const storageAdapter = {
    async upload(key, bytes) { uploads++; objects.set(key, Buffer.from(bytes)); },
    async download(key) { if (!objects.has(key)) throw new Error('missing'); return objects.get(key); },
    async remove(key) { objects.delete(key); },
    async createSignedUrl(key) { return `https://storage.example.test/${key}`; },
  };
  storage.setAdapterForTests(storageAdapter); t.after(() => storage.resetAdapterForTests());
  const service = mockups.createService({ autoStart: false, now: () => time, storageClient: storageAdapter,
    renderPng: async (...args) => { renders++; return artifacts.renderPreviewSurface(...args); },
    printfulClient: {
      async getCatalogProductMockupStyles(id, placements) {
        const product = require('../src/products').PRODUCTS.find(value => value.printful.productId === id);
        return placements.map((placement, index) => ({ placement, technique: product.printful.technique,
          print_area_type: 'simple', mockup_styles: [{ id: index + 1 }] }));
      },
      async createMockupTasks(payload) {
        if (++submissions === 1) throw Object.assign(new Error('busy'), { providerStatus: 429, retryAfter: 40 });
        return payload.products.map(product => {
          const id = providerTasks.size + 1;
          providerTasks.set(id, { id, status: 'completed', catalog_variant_mockups: [{
            catalog_variant_id: product.catalog_variant_ids[0], mockups: product.placements.map((placement, index) => ({
              placement: placement.placement, style_id: index + 1,
              mockup_url: `https://printful-upload.s3-accelerate.amazonaws.com/tmp/flow-${id}-${index}.png`,
            })),
          }] });
          return { id, status: 'pending' };
        });
      },
      async getMockupTasks(ids) { return ids.map(id => providerTasks.get(id)).reverse(); },
    },
  });
  mockups.setAdapterForTests(service); t.after(async () => { mockups.resetAdapterForTests(); await service.stop(); });
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  t.mock.method(printful, 'getShippingCountries', async () => [{ code: 'DE', name: 'Germany', states: [] }]);
  t.mock.method(printful, 'estimateOrderCosts', async () => ({ currency: 'EUR', subtotal: 20, shipping: 5, vat: 4.75, tax: 0, total: 29.75 }));
  t.mock.method(stripe, 'createCheckoutSession', async ({ order, persistCustomer }) => {
    sessions++; await persistCustomer('cus_previewflow');
    return { id: 'cs_test_preview_flow', url: 'https://checkout.stripe.test/preview-flow', taxCents: 0,
      shippingTaxCents: 0, totalCents: Number(order.items_cents) + Number(order.shipping_cents),
      expiresAt: new Date(Date.now() + 1800000).toISOString() };
  });
  const post = async (path, body) => {
    const response = await fetch(api + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Wolkenworte-Guest-Id': 'a'.repeat(32),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const configurations = [];
  for (const productKey of ['cork-back-coaster', 'all-over-basic-pillow-18in']) {
    const saved = await post('/configurations', { productKey, quantity: 1, theme: 'pastel', words: [['liebe', 1]], ...productDesignPayload(productKey) });
    assert.equal(saved.status, 201); configurations.push(saved.body);
  }
  const configurationIds = configurations.map(item => item.id);
  const quoted = await post('/cart/estimate-costs', { configurationIds, shipments: [{
    recipient: { name: 'Preview Flow', address1: 'Testweg 5', city: 'Berlin', zip: '10115', country_code: 'DE' },
    items: configurationIds.map(configurationId => ({ configurationId, quantity: 1 })),
  }] });
  assert.equal(quoted.status, 200);
  const checkout = { configurationIds, quoteId: quoted.body.quote.id, intent: 'pay' };
  const prepared = await post('/cart/checkout', { ...checkout, intent: 'prepare' });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.quote.checkoutPrepared, true); assert.equal(prepared.body.url, undefined);
  assert.equal((await post('/cart/checkout', checkout)).status, 409);

  const html = await fetch(`${app.baseUrl}/e/${event.slug}/shipping?configurations=${configurationIds.join(',')}`).then(response => response.text());
  const dom = new JSDOM(html, { url: app.baseUrl, pretendToBeVisual: true });
  const browser = dom.window, root = browser.document.querySelector('#order-preview');
  const button = browser.document.querySelector('#checkout-button'), consent = root.querySelector('input');
  t.after(() => { browser.dispatchEvent(new browser.Event('pagehide')); dom.window.close(); });
  browser.WolkenworteProductMockups = require('../public/js/product-mockup-preview');
  const requests = [];
  let offline = false, statusFailures = 0, polling = 0;
  browser.fetch = async (url, options = {}) => {
    if (!options.method && offline) { statusFailures++; throw new Error('offline'); }
    const response = await fetch(new URL(url, app.baseUrl), { ...options, signal: undefined });
    requests.push({ url, options, status: response.status });
    if (!options.method) polling++;
    return response;
  };
  const i18n = { setText(node, text, params = {}) { node.textContent = text.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key]); },
    setAttribute(node, name, value) { node.setAttribute(name, value); } };
  let client;
  client = Preview.create(root, { window: browser, endpoint: api + '/cart/mockups', guestId: 'a'.repeat(32), i18n,
    onChange() { button.disabled = !client?.value(); } });
  const loaded = await fetch(`${api}/configurations?ids=${configurationIds.join(',')}`).then(response => response.json());
  client.sync(loaded.configurations);
  await waitFor(() => polling > 0);
  await service.runDue();
  const rows = (await app.query('SELECT data FROM mockup_jobs')).rows;
  assert.equal(rows[0].data.errorCode, 'mockup_rate_limited');
  assert.equal(button.disabled, true); assert.equal(root.querySelector('.order-preview-spinner').hidden, false);
  offline = true;
  // Connection recovery interrupts backoff, while keeping the accepted job IDs.
  for (let attempt = 0; attempt < 10; attempt++) {
    browser.dispatchEvent(new browser.Event('online'));
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 3100 : 5));
  }
  assert.ok(statusFailures >= 8);
  time += 40251; await service.runDue({ maxJobs: 10 });
  offline = false; browser.dispatchEvent(new browser.Event('online'));
  await waitFor(() => root.querySelectorAll('.order-preview-images img').length === 3);
  const images = [...root.querySelectorAll('.order-preview-images img')];
  images.slice(0, 2).forEach(image => image.dispatchEvent(new browser.Event('load')));
  assert.equal(consent.disabled, true, 'the final printed side must actually load');
  images[2].dispatchEvent(new browser.Event('load'));
  assert.equal(consent.disabled, false); assert.equal(button.disabled, true);
  consent.checked = true; consent.dispatchEvent(new browser.Event('change'));
  assert.equal(button.disabled, false);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  const oldApproval = client.value();

  // The server remains authoritative if expiry happens just before payment.
  await app.query("UPDATE mockup_jobs SET expires_at=now()-interval '1 second', data=jsonb_set(data,'{expiresAt}',to_jsonb($1::bigint)) WHERE id=ANY($2::text[])", [Date.now() - 1000, oldApproval.jobIds]);
  const rejected = await post('/cart/checkout', { ...checkout, mockupApproval: oldApproval });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'mockup_approval_required');
  client.reset();
  await waitFor(() => requests.filter(request => request.options.method === 'POST').length === 2);
  assert.equal(button.disabled, true); assert.equal(consent.checked, false);
  images.forEach(image => { image.dispatchEvent(new browser.Event('error')); image.dispatchEvent(new browser.Event('load')); });
  assert.equal(button.disabled, true, 'late events cannot approve the replacement');
  time += 30501; await service.runDue({ maxJobs: 10 });
  browser.dispatchEvent(new browser.Event('online'));
  await waitFor(() => root.querySelectorAll('.order-preview-images img').length === 3);
  root.querySelectorAll('.order-preview-images img').forEach(image => image.dispatchEvent(new browser.Event('load')));
  assert.equal(button.disabled, true, 'renewal never preselects customer consent');
  consent.checked = true; consent.dispatchEvent(new browser.Event('change'));
  const approval = client.value(); assert.ok(approval); assert.notDeepEqual(approval.jobIds, oldApproval.jobIds);
  const paidLink = await post('/cart/checkout', { ...checkout, mockupApproval: approval });
  assert.equal(paidLink.status, 200, JSON.stringify(paidLink.body));
  assert.equal(paidLink.body.url, 'https://checkout.stripe.test/preview-flow'); assert.equal(sessions, 1);
  assert.equal(renders, 3); assert.equal(uploads, 3);
  let order = await db.getOrderByQuoteId(checkout.quoteId);
  assert.deepEqual(order.mockup_approval_json.jobIds, approval.jobIds);
  const session = stripeTaxPaymentSession({ order, sessionId: order.stripe_session_id, customerId: 'cus_previewflow', taxCents: 0 }).checkoutSession;
  const payload = JSON.stringify({ id: 'evt_preview_flow', type: 'checkout.session.completed', livemode: false,
    data: { object: { ...session, payment_intent: 'pi_preview_flow', metadata: {
      orderId: String(order.id), quoteId: order.quote_id, configurationId: order.configuration_id,
      configurationIds: configurationIds.join(','), eventSlug: event.slug, checkoutMode: 'test',
    } } } });
  const signature = new (require('stripe'))('sk_test_preview_flow').webhooks.generateTestHeaderString({
    payload, secret: process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET,
  });
  const paid = await fetch(`${app.baseUrl}/webhook/stripe`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'stripe-signature': signature,
  }, body: payload });
  assert.equal(paid.status, 200, await paid.text());
  order = await db.getOrderById(order.id); assert.ok(order.paid_at);
  const frozen = await artifacts.ensureOrderArtifacts(order, await db.getOrderItems(order.id));
  for (const file of frozen) {
    const response = await fetch(`${app.baseUrl}/api/print-files/${file.id}/${file.access_nonce}`);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), objects.get(file.object_key));
  }
  assert.equal(renders, 3, 'production reuses the exact approved pixels');
  assert.equal(uploads, 3, 'recovery and payment do not duplicate frozen files');
});
