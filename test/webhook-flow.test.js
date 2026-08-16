'use strict';

// Exercises src/routes/webhook.js end-to-end against a *locally signed*
// checkout.session.completed payload — no live Stripe account needed.
// `stripe.webhooks.constructEvent()` (called inside src/stripe.js) verifies
// the signature purely locally (HMAC over the raw body), it never calls out
// to Stripe's API, so `stripe.webhooks.generateTestHeaderString()` lets this
// test sign a payload the same way a real webhook request would be signed,
// closing the "untested against a live Stripe webhook" gap noted in the
// README for the one part of that gap this pass is actually responsible
// for: proving the handler now hands Printful a real, fetchable
// GET /e/:slug/export.svg URL instead of inline SVG markup.
//
// Printful itself stays mocked (per this pass's explicit scope) — this test
// swaps in a spy for printful.createPrintfulOrder() to capture what the
// webhook handler would have sent it, rather than exercising the real
// PRINTFUL_API_KEY-gated mock-logging path (that's covered separately by
// test/checkout-stubs.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const cleanup = () => { socket.off('word-update', onReady); socket.off('connect_error', onErr); };
    const onReady = () => { cleanup(); resolve(socket); };
    const onErr = (err) => { cleanup(); reject(err); };
    socket.once('word-update', onReady);
    socket.once('connect_error', onErr);
  });
}

function submitWord(socket, word) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${word}" to be accepted`)), 2000);
    socket.once('word-accepted', (accepted) => { clearTimeout(timer); resolve(accepted); });
    socket.emit('submit-word', word);
  });
}

test('webhook checkout.session.completed hands Printful a real, fetchable export.svg URL', async (t) => {
  // Dummy but well-formed-looking credentials: constructWebhookEvent() only
  // needs isConfigured() to pass and a webhook secret to verify against —
  // neither requires an actual Stripe account or network call.
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_ID = 'price_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
  delete require.cache[require.resolve('../src/stripe')];
  t.after(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete require.cache[require.resolve('../src/stripe')];
  });

  const { baseUrl, close } = await startTestServer();
  t.after(close);

  // getBaseUrl() (src/baseUrl.js) treats a 127.0.0.1 Host header as "local
  // dev" and falls back to the machine's LAN IP — not reachable here, since
  // the test server (test/helpers.js) binds only to 127.0.0.1. Setting
  // PUBLIC_URL (its highest-priority source, same as a real deployment
  // would) makes the generated export URL point back at this same test
  // server instead.
  process.env.PUBLIC_URL = baseUrl;
  t.after(() => { delete process.env.PUBLIC_URL; });

  const event = await createEvent(baseUrl, { coupleName: 'Webhook Wanda & Signed Sven' });

  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());
  await submitWord(socket, 'füreinander');

  // Spy on printful.createPrintfulOrder() by mutating the cached module's
  // export in place — src/routes/webhook.js holds `const printful =
  // require('../printful')` and calls `printful.createPrintfulOrder(...)`
  // as a property access, so this is visible to it without needing to
  // re-require server.js.
  const printful = require('../src/printful');
  const originalCreate = printful.createPrintfulOrder;
  let captured = null;
  printful.createPrintfulOrder = async (opts) => {
    captured = opts;
    return { printfulOrderId: 'MOCK-SPY', mocked: true };
  };
  t.after(() => { printful.createPrintfulOrder = originalCreate; });

  const payload = JSON.stringify({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_webhook_flow',
        metadata: { eventSlug: event.slug },
        customer_details: {
          name: 'Webhook Wanda',
          address: { line1: 'Teststraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
        },
      },
    },
  });
  const signer = Stripe(process.env.STRIPE_SECRET_KEY);
  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const res = await fetch(`${baseUrl}/webhook/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  assert.equal(res.status, 200);

  assert.ok(captured, 'printful.createPrintfulOrder() must have been called');
  assert.equal(captured.stripeSessionId, 'cs_test_webhook_flow');
  assert.equal(captured.svgUrl, `${baseUrl}/e/${event.slug}/export.svg`);

  // Not just a plausible-looking string — actually fetch it, the way
  // Printful's own order-creation pipeline would, and confirm it serves the
  // submitted word.
  const svgRes = await fetch(captured.svgUrl);
  assert.equal(svgRes.status, 200);
  const svgText = await svgRes.text();
  assert.ok(svgText.includes('füreinander'));
});
