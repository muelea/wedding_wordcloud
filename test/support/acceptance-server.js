'use strict';

// Only the local acceptance runner mounts test/. Dockerfile excludes this
// entire directory. Real application routes, validation, DB transactions,
// rendering and signed webhooks run unchanged; external providers are fixtures.
if (process.env.WW_BROWSER_ACCEPTANCE !== '1' ||
    new URL(process.env.DATABASE_URL || '').hostname !== '127.0.0.1' ||
    process.env.DATABASE_SCHEMA !== 'acceptance' ||
    process.env.STRIPE_TEST_SECRET_KEY !== 'sk_test_acceptance_fixture_only' ||
    process.env.PRINTFUL_ALLOW_ORDER_WRITES !== 'false') {
  throw new Error('Refusing to start browser acceptance outside its isolated pod.');
}

const crypto = require('node:crypto');
const express = require('express');
const Stripe = require('stripe');
const printful = require('../../src/printful');
const sessions = new Map();
const idempotencyKeys = new Map();
let priceMultiplier = 1;
let estimateFailure = false;
let orderWrites = 0;
let checkoutCalls = 0;
let estimateDelay = 0;
let checkoutDelay = 0;

printful.getShippingCountries = async () => [
  { code: 'DE', name: 'Germany', region: 'europe', states: [] },
  { code: 'FR', name: 'France', region: 'europe', states: [] },
  { code: 'US', name: 'United States', region: 'americas', states: [
    { code: 'CA', name: 'California' }, { code: 'NY', name: 'New York' },
  ] },
];
printful.getShippingRates = async (options) => require('./printful-fixtures').shippingEstimate(options);
printful.estimateOrderCosts = async (options) => {
  if (estimateDelay) await new Promise(resolve => setTimeout(resolve, estimateDelay));
  if (estimateFailure) throw new printful.PrintfulApiError('PRINTFUL_UNAVAILABLE', 'Test: Preisdienst nicht erreichbar.', 502);
  const quantity = options.items?.reduce((sum, item) => sum + item.quantity, 0) || options.quantity || 1;
  const subtotal = Math.round(quantity * 7 * priceMultiplier * 100) / 100;
  const shipping = 4.49;
  const vat = Math.round((subtotal + shipping) * .19 * 100) / 100;
  return { currency: 'EUR', subtotal, shipping, tax: 0, vat, total: subtotal + shipping + vat };
};
printful.createPrintfulOrder = async () => {
  orderWrites += 1;
  throw new Error('Acceptance must never request real fulfillment.');
};
// Replace only the external SDK transport. The real src/stripe adapter builds
// metadata, amounts, locales, expiry and return URLs, just as in production.
class AcceptanceStripe extends Stripe {
  constructor(...args) {
    super(...args);
    this.checkout.sessions.create = async (request, options = {}) => {
      if (checkoutDelay) await new Promise(resolve => setTimeout(resolve, checkoutDelay));
      const previous = idempotencyKeys.get(options.idempotencyKey);
      if (previous) return sessions.get(previous);
      checkoutCalls += 1;
      const id = `cs_test_acceptance_${crypto.randomBytes(12).toString('hex')}`;
      const session = { ...request, id, url: `/api/acceptance/checkout/${id}`,
        status: 'open', payment_status: 'unpaid',
        amount_total: request.line_items.reduce((sum, item) => sum + item.quantity * item.price_data.unit_amount, 0),
        currency: request.line_items[0].price_data.currency };
      sessions.set(id, session);
      if (options.idempotencyKey) idempotencyKeys.set(options.idempotencyKey, id);
      return session;
    };
    this.checkout.sessions.retrieve = async id => {
      if (!sessions.has(id)) throw new Error('Unknown acceptance session.');
      return sessions.get(id);
    };
    this.checkout.sessions.expire = async id => {
      const session = await this.checkout.sessions.retrieve(id);
      if (session.status !== 'complete') session.status = 'expired';
      return session;
    };
  }
}
require.cache[require.resolve('stripe')].exports = AcceptanceStripe;

const application = require('../../server');
const db = require('../../src/db');
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '2kb' }));
const page = (title, body) => `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;margin:32px;max-width:900px}button,a{display:inline-block;margin:6px;padding:12px}pre{white-space:pre-wrap}aside{padding:16px;background:#fff0cc}</style><body><aside>Isolierte Linux-Abnahme · Keine echten Zahlungen oder Aufträge</aside><h1>${title}</h1>${body}</body></html>`;
const asyncHandler = action => (req, res, next) => Promise.resolve(action(req, res)).catch(next);

router.get('/', (req, res) => res.type('html').send(page('Browser-Abnahme', `
  <p>Produktionslaufzeit, tatsächliche Anwendungsseiten und eingeschränkte Postgres-Rolle. Preis- und Zahlungsanbieter sind simuliert; Webhooks werden echt signiert und geprüft.</p>
  <a href="/">Anwendung öffnen</a><a href="/api/acceptance/state">Datenzustand prüfen</a>
  <form method="post" action="/api/acceptance/provider"><button name="mode" value="normal">Normale Preise</button><button name="mode" value="increase">Preis erhöhen</button><button name="mode" value="fail">Preisdienst ausfallen lassen</button><button name="mode" value="slow">Preisantwort verzögern</button><button name="mode" value="stall">Preisantwort über Timeout verzögern</button><button name="mode" value="checkout-slow">Zahlungsantwort über Timeout verzögern</button></form>
`)));
router.post('/provider', (req, res) => {
  if (!['normal', 'increase', 'fail', 'slow', 'stall', 'checkout-slow'].includes(req.body.mode)) return res.sendStatus(400);
  estimateFailure = req.body.mode === 'fail';
  priceMultiplier = req.body.mode === 'increase' ? 1.5 : 1;
  estimateDelay = req.body.mode === 'slow' ? 8000 : req.body.mode === 'stall' ? 25000 : 0;
  checkoutDelay = req.body.mode === 'checkout-slow' ? 25000 : 0;
  return res.redirect('/api/acceptance/');
});
router.get('/state', asyncHandler(async (req, res) => {
  const pool = db.getPool();
  const [counts, orders, jobs] = await Promise.all([
    pool.query('SELECT (SELECT count(*)::int FROM events) AS events, (SELECT count(*)::int FROM configurations) AS configurations, current_user AS runtime_role'),
    pool.query('SELECT id, status, mode, fulfillment_status FROM orders ORDER BY id LIMIT 100'),
    pool.query('SELECT id, status, provider_message_id FROM email_jobs ORDER BY id LIMIT 100'),
  ]);
  res.json({ platform: process.platform, node: process.version, ...counts.rows[0],
    checkoutCalls, orderWrites, orders: orders.rows, emailJobs: jobs.rows });
}));
router.get('/checkout/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.sendStatus(404);
  const returnUrl = new URL(session.cancel_url);
  const cancel = returnUrl.pathname + returnUrl.search;
  res.type('html').send(page('Simulierte Testzahlung', `<p>Es werden keine Zahlungsdaten abgefragt und keine externen Anbieter kontaktiert.</p><form method="post" action="/api/acceptance/checkout/${session.id}/pay"><button>Testzahlung bestätigen</button></form><a href="${cancel}">Zahlung abbrechen</a>`));
});
router.post('/checkout/:id/pay', asyncHandler(async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.sendStatus(404);
  const payload = JSON.stringify({ id: `evt_${session.id}`, type: 'checkout.session.completed', livemode: false,
    data: { object: { id: session.id, metadata: session.metadata, amount_total: session.amount_total,
      currency: session.currency, payment_status: 'paid', payment_intent: `pi_${session.id}`,
      customer_details: { email: 'acceptance@example.invalid' } } } });
  const signature = new Stripe('sk_test_acceptance_fixture_only').webhooks.generateTestHeaderString({
    payload, secret: process.env.STRIPE_TEST_HOSTED_WEBHOOK_SECRET,
  });
  const response = await fetch('http://127.0.0.1:8080/webhook/stripe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
  const result = await response.json();
  if (!response.ok || result.ignored) throw new Error('Signed acceptance payment was not accepted.');
  session.status = 'complete'; session.payment_status = 'paid';
  const returnUrl = new URL(session.success_url.replace('{CHECKOUT_SESSION_ID}', session.id));
  res.redirect(returnUrl.pathname + returnUrl.search);
}));
router.use((error, req, res, next) => {
  console.error('Acceptance fixture:', error.message);
  res.status(500).json({ error: 'acceptance_fixture_failed' });
});
// The real app intentionally delegates unknown /api routes; no production
// router, middleware, validation or API response is replaced by this fixture.
application.app.use('/api/acceptance', router);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => application.shutdown(signal).then(() => process.exit(0)));
}
application.start().catch(error => { console.error(error.message); process.exitCode = 1; });
